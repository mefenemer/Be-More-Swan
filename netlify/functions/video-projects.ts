// netlify/functions/video-projects.ts
// The Video Producer's projects (docs/video-producer-plan.md §5): brief → storyboard → finished post.
//
//   GET                                   → { projects: [...] }           (this workspace, newest first)
//   GET  ?id=N                            → { project }
//   POST { action:'create', assistantId, brief }        → plans in the background → { project }
//   POST { action:'replan', id, feedback? }              → re-plans with the owner's notes
//   POST { action:'edit_scene', id, sceneId, patch }    → changes one scene (re-checked by the rules)
//   POST { action:'build', id }                          → holds the estimate, builds in the background
//   POST { action:'cancel', id }
//   POST { action:'from_post', postId }                 → "Make a video version" of a post (video-handoff.ts):
//                                                          plans a storyboard for the active Video Producer
//   GET  ?producer=1                                    → { producer: { id, name } | null } — is the button offered?
//
// Planning is free (one model call, like any draft). Building spends: the estimate is on the project
// before the click, held at the click, settled scene by scene (src/utils/video-producer.ts).
// Gate (owner decision D5, recommended 2026-10-31): the same as AI video — an assistant type with
// `ai_video_generation` AND a plan that includes video.

import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, videoProjects } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { orgHasAssistantFeature, featureUnavailableResponse } from '../../src/utils/assistant-capabilities';
import { getActiveTierKeyByOrg } from '../../src/utils/plan-features';
import { tierCanGenerateVideo } from '../../src/utils/ai-credits';
import { enforcePromptModeration } from '../../src/utils/moderation';
import { holdBuild, projectView, readBrief, libraryPictures, sweepStuckProjects, withSetupDefaults, startProject, wakeVideoWorker } from '../../src/utils/video-producer';
import { enforceStoryboard, SCENE_SOURCES, type Storyboard, type VideoBrief } from '../../src/lib/storyboard';
import { activeVideoProducer, videoFromPost } from '../../src/utils/video-handoff';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export default withLambda(async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;
    const headers = event.headers as Record<string, string | undefined>;

    const load = async (id: number) => {
        const [row] = await db.select().from(videoProjects)
            .where(and(eq(videoProjects.id, id), eq(videoProjects.organisationId, orgId))).limit(1);
        return row ?? null;
    };

    if (event.httpMethod === 'GET') {
        // The Review Queue asks before it offers "Make a video version": an active Video Producer AND
        // a plan that makes videos (the same gate the POST below applies).
        if (event.queryStringParameters?.producer) {
            const producer = await activeVideoProducer(db, orgId);
            const can = !!producer && tierCanGenerateVideo(await getActiveTierKeyByOrg(db, orgId));
            return json(200, { producer: can ? { id: producer!.id, name: producer!.name } : null });
        }
        await sweepStuckProjects(db, orgId).catch((err) => console.error('[video-projects] sweep failed:', err));
        const id = Number(event.queryStringParameters?.id);
        if (Number.isInteger(id) && id > 0) {
            const row = await load(id);
            return row ? json(200, { project: await projectView(db, orgId, row) }) : json(404, { error: 'Video not found.' });
        }
        // ?assistantId=N narrows to one assistant's videos (its Videos tab); still org-scoped first.
        const forAssistant = Number(event.queryStringParameters?.assistantId);
        const rows = await db.select().from(videoProjects)
            .where(Number.isInteger(forAssistant) && forAssistant > 0
                ? and(eq(videoProjects.organisationId, orgId), eq(videoProjects.aiAssistantId, forAssistant))
                : eq(videoProjects.organisationId, orgId))
            .orderBy(desc(videoProjects.createdAt)).limit(50);
        return json(200, { projects: await Promise.all(rows.map((r) => projectView(db, orgId, r))) });
    }
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
    const action = String(body.action || '');

    // The gate, before anything is planned or spent.
    if (!tierCanGenerateVideo(await getActiveTierKeyByOrg(db, orgId))) {
        return json(403, { error: 'video_requires_upgrade', message: 'Videos are on the Busywork Buster and Digital Employee plans.' });
    }
    if (!await orgHasAssistantFeature(db, orgId, 'ai_video_generation')) {
        return featureUnavailableResponse('None of your assistants can make videos.');
    }

    if (action === 'create') {
        const assistantId = Number(body.assistantId);
        if (!Number.isInteger(assistantId)) return json(400, { error: 'assistantId is required.' });
        const [a] = await db.select({ id: aiAssistants.id, onboardingContext: aiAssistants.onboardingContext }).from(aiAssistants)
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId))).limit(1);
        if (!a) return json(404, { error: 'Assistant not found.' });
        // What the brief leaves out comes from the assistant's setup (assistant-onboarding-schemas.js
        // video_producer) — a chat card that names no voice gets the voice the owner chose at hire.
        const parsed = readBrief(withSetupDefaults(body.brief, a.onboardingContext));
        if ('error' in parsed) return json(400, { error: parsed.error });
        const blocked = await enforcePromptModeration({ text: `${parsed.brief.message}\n${parsed.brief.cta ?? ''}`, userId, organisationId: orgId, source: 'video-projects' });
        if (blocked) return blocked;
        const started = await startProject(db, {
            organisationId: orgId, assistantId, createdBy: userId, brief: body.brief, onboardingContext: a.onboardingContext, origin: 'user', headers,
        });
        if (!started.ok) return json(400, { error: started.error });
        return json(202, { project: await projectView(db, orgId, started.row) });
    }

    if (action === 'from_post') {
        const postId = Number(body.postId);
        if (!Number.isInteger(postId) || postId <= 0) return json(400, { error: 'postId is required.' });
        const made = await videoFromPost(db, { organisationId: orgId, userId, postId, headers });
        if (!made.ok) return json(made.status, { error: made.error });
        return json(made.created ? 202 : 200, {
            created: made.created, assistantId: made.assistantId, assistantName: made.assistantName,
            project: await projectView(db, orgId, made.project),
        });
    }

    const id = Number(body.id);
    const row = Number.isInteger(id) ? await load(id) : null;
    if (!row) return json(404, { error: 'Video not found.' });

    if (action === 'replan') {
        if (row.status === 'planning' || row.status === 'building') return json(409, { error: 'It is already working on this video.' });
        const feedback = typeof body.feedback === 'string' ? body.feedback.trim().slice(0, 600) : '';
        if (feedback) {
            const blocked = await enforcePromptModeration({ text: feedback, userId, organisationId: orgId, source: 'video-projects' });
            if (blocked) return blocked;
        }
        // A new plan means new scenes: what was sourced for the old ones no longer fits.
        await db.update(videoProjects).set({ status: 'planning', note: null, sceneAssets: {}, voiceoverAssetId: null, updatedAt: new Date() })
            .where(eq(videoProjects.id, row.id));
        await wakeVideoWorker({ projectId: row.id, action: 'plan', feedback }, headers);
        return json(202, { project: await projectView(db, orgId, (await load(row.id))!) });
    }

    if (action === 'edit_scene') {
        if (!['planned', 'failed'].includes(row.status) || !row.storyboard) return json(409, { error: 'This video can no longer be changed here — open the post to edit it.' });
        const sb = structuredClone(row.storyboard) as Storyboard;
        const scene = sb.scenes.find((s) => s.id === body.sceneId);
        if (!scene) return json(404, { error: 'Scene not found.' });
        const patch = (body.patch && typeof body.patch === 'object' ? body.patch : {}) as Record<string, unknown>;
        let voiceChanged = false;
        if (typeof patch.voiceover === 'string' && patch.voiceover !== scene.voiceover) { scene.voiceover = patch.voiceover; voiceChanged = true; }
        if (typeof patch.onScreenText === 'string') scene.onScreenText = patch.onScreenText;
        if (typeof patch.source === 'string' && (SCENE_SOURCES as readonly string[]).includes(patch.source)) scene.source = patch.source as typeof scene.source;
        if (typeof patch.keywords === 'string') scene.keywords = patch.keywords;
        if (typeof patch.prompt === 'string') scene.prompt = patch.prompt;
        if (patch.assetId != null) scene.assetId = Number(patch.assetId);
        const text = [scene.voiceover, scene.onScreenText, scene.prompt, scene.keywords].filter(Boolean).join('\n');
        if (text) {
            const blocked = await enforcePromptModeration({ text, userId, organisationId: orgId, source: 'video-projects' });
            if (blocked) return blocked;
        }
        const { storyboard, changes } = enforceStoryboard(sb, row.brief as VideoBrief, await libraryPictures(db, orgId));
        const assets = { ...(row.sceneAssets as Record<string, number>) };
        delete assets[scene.id];   // this scene is re-sourced on the next build
        await db.update(videoProjects).set({
            storyboard, changes, sceneAssets: assets, status: 'planned',
            // The voiceover is one track for the whole script — any line changing re-records it.
            ...(voiceChanged ? { voiceoverAssetId: null } : {}),
            updatedAt: new Date(),
        }).where(eq(videoProjects.id, row.id));
        return json(200, { project: await projectView(db, orgId, (await load(row.id))!) });
    }

    if (action === 'build') {
        if (!['planned', 'failed'].includes(row.status) || !row.storyboard) return json(409, { error: 'This video is not ready to make.' });
        const hold = await holdBuild(db, orgId, row.storyboard as Storyboard, row.brief as VideoBrief);
        if (!hold.ok) return json(402, { error: 'insufficient_credits', cost: hold.cost, balance: hold.balance, unit: hold.unit });
        await db.update(videoProjects).set({ status: 'building', creditHold: hold.credits, startedAt: new Date(), note: null, updatedAt: new Date() })
            .where(eq(videoProjects.id, row.id));
        await wakeVideoWorker({ projectId: row.id, action: 'build' }, headers);
        return json(202, { project: await projectView(db, orgId, (await load(row.id))!) });
    }

    if (action === 'cancel') {
        if (row.status === 'building') return json(409, { error: 'It is making this video right now — wait for it to finish.' });
        await db.update(videoProjects).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(videoProjects.id, row.id));
        return json(200, { ok: true });
    }

    return json(400, { error: 'Unknown action.' });
});
