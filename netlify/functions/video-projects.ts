// netlify/functions/video-projects.ts
// The Video Producer's projects (docs/video-producer-plan.md §5): brief → storyboard → finished post.
//
//   GET                                   → { projects: [...] }           (this workspace, newest first)
//   GET  ?id=N                            → { project }
//   POST { action:'create', assistantId, brief }        → plans in the background → { project }
//        brief.footageAssetIds + brief.footageConsent    → reviews the owner's own footage first ('reviewing'),
//                                                          FOOTAGE_REVIEW_TASKS when a video is new to it (footage-review.ts)
//   POST { action:'plan_from_review', id, ticks:{e1:true,…}, notes? } → the storyboard from the ticked edits (free)
//   POST { action:'replan', id, feedback? }              → re-plans with the owner's notes
//   POST { action:'edit_scene', id, sceneId, patch }    → changes one scene (re-checked by the rules)
//   POST { action:'build', id }                          → holds the estimate, builds in the background
//   POST { action:'change', id }                         → "Change it" on a ready video: a new version (free), video-producer.ts newVersion
//        replan / edit_scene on a READY video do the same first, then act on the new version (chat parity)
//   POST { action:'rerender', id }                       → a render_failed video: render the saved timeline again (free)
//   POST { action:'approve_script', id }                → the voiceover script approved on its own, before any picture (free)
//   POST { action:'rewrite_script', id, feedback? }     → the words rewritten, every scene's picture kept (free)
//   POST { action:'set_options', id, musicMood?, musicAssetId?, anotherTrack?, look?, lowerThird? } → music (a mood,
//        none, or a track from My Content), colour look and
//        name-caption style, changed without re-planning (free; a ready video gets a new version first)
//   POST { action:'add_note', id, atS, text }           → a note on a moment of a ready video, tied to its scene
//   POST { action:'delete_note', id, noteId }
//   POST { action:'notes_to_version', id }              → a new version that turns those notes into scene edits (free)
//   POST { action:'reshape', id, shapes? }              → the same video in the other shapes (free when nothing
//                                                          paid needs making — then it starts making at once)
//   GET  ?tracks=1                                      → the workspace's own tracks (generated / uploaded) for the Music picker
//   GET  ?performance=1&assistantId=N                   → the Results tab's four figures (src/lib/video-results.ts)
//   GET  ?calendar=1&assistantId=N&from&to              → the Calendar tab: videos started and finished, by day
//   POST { action:'cancel', id }
//   POST { action:'from_post', postId }                 → "Make a video version" of a post (video-handoff.ts):
//                                                          plans a storyboard for the active Video Producer
//   GET  ?producer=1                                    → { producer: { id, name } | null } — is the button offered?
//   GET  ?teammates=1                                   → { social, blog } — the ACTIVE Social Media Manager and Blog
//                                                          Writer a finished video can be handed to (studio plan Phase 4), or null
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
import { holdBuild, projectView, readBrief, libraryPictures, sweepStuckProjects, withSetupDefaults, startProject, wakeVideoWorker, wakeRenderWorker, newVersion, sceneLooks, makeOtherShapes, videoResultsFor, type ProjectTimeline } from '../../src/utils/video-producer';
import { enforceStoryboard, isVideoShape, SCENE_SOURCES, type Storyboard, type VideoBrief } from '../../src/lib/storyboard';
import { addNote, readNotes, sceneTimes } from '../../src/lib/video-notes';
import { isMusicChoice } from '../../src/lib/video-music';
import { ownMusicTrack, ownMusicTracks } from '../../src/utils/video-music-asset';
import { isVideoLook } from '../../src/lib/video-look';
import { isLowerThirdStyle, readNameCaption } from '../../src/lib/lower-third';
import { contentAssets } from '../../db/schema';
import { randomUUID } from 'crypto';
import { activeVideoProducer, activeAssistantInRole, videoFromPost } from '../../src/utils/video-handoff';
import { asOwnVideos, canAffordReview, footageStatus, loadFootage } from '../../src/utils/footage-review';
import { FOOTAGE_REVIEW_TASKS, tightenStoryboard, type FootageReview } from '../../src/lib/footage';
import { TASK_LIMIT_MESSAGE } from '../../src/utils/work-metering';
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
        if (event.queryStringParameters?.teammates) {
            const [social, blog] = await Promise.all([
                activeAssistantInRole(db, orgId, 'social_media_manager'),
                activeAssistantInRole(db, orgId, 'blog_writer'),
            ]);
            return json(200, { social, blog });
        }
        const qs = event.queryStringParameters ?? {};
        // The Music picker's "A track from My Content": the workspace's generated and uploaded tracks.
        if (qs.tracks) return json(200, { tracks: (await ownMusicTracks(db, orgId)).map(({ storageKey: _k, ...t }) => t) });
        // The Results tab (registry metricsSource 'video'): what a studio makes, not post engagement.
        if (qs.performance) {
            const aid = Number(qs.assistantId);
            if (!Number.isInteger(aid) || aid <= 0) return json(400, { error: 'assistantId is required.' });
            const metrics = await videoResultsFor(db, orgId, aid);
            return json(200, { hasData: metrics.made > 0, metrics });
        }
        // The Calendar tab (registry calendarItems 'videos'): each video on the day it was started and
        // the day its finished file was saved. Read-only, like every dated item.
        if (qs.calendar) {
            const aid = Number(qs.assistantId);
            const from = new Date(String(qs.from || '')), to = new Date(String(qs.to || ''));
            if (!Number.isInteger(aid) || aid <= 0 || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return json(400, { error: 'assistantId, from and to are required.' });
            const rows = await db.select({ id: videoProjects.id, title: videoProjects.title, status: videoProjects.status, createdAt: videoProjects.createdAt, version: videoProjects.version, readyAt: contentAssets.createdAt })
                .from(videoProjects)
                .leftJoin(contentAssets, and(eq(contentAssets.id, videoProjects.outputAssetId), eq(contentAssets.organisationId, orgId)))
                .where(and(eq(videoProjects.organisationId, orgId), eq(videoProjects.aiAssistantId, aid)))
                .orderBy(desc(videoProjects.createdAt)).limit(300);
            const items: Array<{ id: number; kind: string; title: string; at: string; done: boolean }> = [];
            const inRange = (d: Date | null) => !!d && d >= from && d < to;
            for (const r of rows) {
                const title = r.version > 1 ? `${r.title} (version ${r.version})` : r.title;
                if (inRange(r.createdAt) && r.status !== 'cancelled') items.push({ id: r.id, kind: 'video_started', title, at: r.createdAt.toISOString(), done: false });
                if (r.readyAt && inRange(r.readyAt)) items.push({ id: r.id, kind: 'video_ready', title, at: r.readyAt.toISOString(), done: true });
            }
            return json(200, { items });
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
        const footage = parsed.brief.footageAssetIds ?? [];
        if (footage.length) {
            // The owner says the people and music in their videos may be used (plan §6) — every review.
            if ((body.brief as Record<string, unknown> | undefined)?.footageConsent !== true) {
                return json(400, { error: 'Tick “I have permission to use the people and music in these videos” first.' });
            }
            const status = await footageStatus(db, orgId, footage);
            if (status.length !== footage.length) return json(404, { error: 'One of those videos isn’t one of your own uploads.' });
            if (status.some((x) => x.needsReading)) return json(409, { error: 'Some of those videos haven’t been read yet. Press “Review my footage” again.' });
            if (!await canAffordReview(db, orgId, footage)) return json(402, { error: 'insufficient_credits', unit: 'tasks', cost: FOOTAGE_REVIEW_TASKS, message: TASK_LIMIT_MESSAGE });
        }
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
    let row = Number.isInteger(id) ? await load(id) : null;
    if (!row) return json(404, { error: 'Video not found.' });

    // A finished video is never changed in place (D-S1: every version is kept). "Change it", and a
    // replan or scene edit on a ready video — from the tab or a chat card — first make a new version.
    if (action === 'change') {
        if (row.status !== 'ready' || !row.storyboard) return json(409, { error: 'Only a finished video can be changed into a new version.' });
        return json(201, { project: await projectView(db, orgId, await newVersion(db, row)) });
    }

    // ── Notes on moments of a finished video ──
    if (action === 'add_note') {
        if (row.status !== 'ready') return json(409, { error: 'Notes go on a finished video.' });
        const text = typeof body.text === 'string' ? body.text : '';
        if (text.trim()) {
            const blocked = await enforcePromptModeration({ text, userId, organisationId: orgId, source: 'video-projects' });
            if (blocked) return blocked;
        }
        const tl = row.timeline as ProjectTimeline | null;
        // A chat card may name a scene by number instead of a time: the note goes on its start.
        const n = Number(body.sceneNumber);
        const times = sceneTimes(tl);
        const atS = body.atS == null && Number.isInteger(n) && n > 0 && times[n - 1] ? times[n - 1].startS + 0.1 : Number(body.atS);
        const added = addNote(readNotes(row.momentNotes), { id: randomUUID().slice(0, 8), atS, text, times, by: userId, now: new Date(), durationS: tl?.durationS ?? null });
        if ('error' in added) return json(400, { error: added.error });
        await db.update(videoProjects).set({ momentNotes: added.notes, updatedAt: new Date() }).where(eq(videoProjects.id, row.id));
        return json(200, { note: added.note, project: await projectView(db, orgId, (await load(row.id))!) });
    }
    if (action === 'delete_note') {
        const notes = readNotes(row.momentNotes).filter((n) => n.id !== body.noteId);
        await db.update(videoProjects).set({ momentNotes: notes, updatedAt: new Date() }).where(eq(videoProjects.id, row.id));
        return json(200, { project: await projectView(db, orgId, (await load(row.id))!) });
    }
    if (action === 'notes_to_version') {
        if (row.status !== 'ready' || !row.storyboard) return json(409, { error: 'Notes become a new version of a finished video.' });
        const notes = readNotes(row.momentNotes);
        if (!notes.some((n) => n.sceneId)) return json(409, { error: 'Leave a note on a moment of the video first.' });
        // The notes move to the new version, which acts on them; the finished one keeps none.
        const v = await newVersion(db, row, { status: 'planning', momentNotes: notes });
        await db.update(videoProjects).set({ momentNotes: [], updatedAt: new Date() }).where(eq(videoProjects.id, row.id));
        await wakeVideoWorker({ projectId: v.id, action: 'plan', mode: 'notes' }, headers);
        return json(202, { project: await projectView(db, orgId, v) });
    }

    // ── The same video in the other shapes ──
    if (action === 'reshape') {
        if (row.status !== 'ready' || !row.storyboard) return json(409, { error: 'Finish the video first, then make it in the other shapes.' });
        const shapes = (Array.isArray(body.shapes) ? body.shapes : []).filter(isVideoShape);
        const r = await makeOtherShapes(db, row, { userId, shapes, headers });
        return json(r.made.length ? 202 : 200, { made: await Promise.all(r.made.map((x) => projectView(db, orgId, x))), skipped: r.skipped });
    }

    if ((action === 'replan' || action === 'edit_scene' || action === 'rewrite_script' || action === 'set_options' || action === 'approve_script') && row.status === 'ready' && row.storyboard) {
        if (action === 'approve_script') return json(409, { error: 'This video is already made.' });
        row = await newVersion(db, row);
    }
    if ((action === 'replan' || action === 'edit_scene' || action === 'rewrite_script' || action === 'set_options') && row.status === 'rendering') {
        return json(409, { error: 'The finished video is rendering — wait a moment, then change it.' });
    }

    // ── Script first: the words approved, or rewritten, before any picture is made ──
    if (action === 'approve_script') {
        if (!['planned', 'failed'].includes(row.status) || !row.storyboard) return json(409, { error: 'There is no storyboard waiting to be checked.' });
        const sb = { ...(row.storyboard as Storyboard), scriptApprovedAt: new Date().toISOString() };
        await db.update(videoProjects).set({ storyboard: sb, updatedAt: new Date() }).where(eq(videoProjects.id, row.id));
        return json(200, { project: await projectView(db, orgId, (await load(row.id))!) });
    }
    if (action === 'rewrite_script') {
        if (!['planned', 'failed'].includes(row.status) || !row.storyboard) return json(409, { error: 'There is no storyboard waiting to be checked.' });
        const feedback = typeof body.feedback === 'string' ? body.feedback.trim().slice(0, 600) : '';
        if (feedback) {
            const blocked = await enforcePromptModeration({ text: feedback, userId, organisationId: orgId, source: 'video-projects' });
            if (blocked) return blocked;
        }
        // Words only: scene assets stay (planProject mode 'script' keeps every picture).
        await db.update(videoProjects).set({ status: 'planning', note: null, editCount: row.editCount + 1, updatedAt: new Date() }).where(eq(videoProjects.id, row.id));
        await wakeVideoWorker({ projectId: row.id, action: 'plan', feedback, mode: 'script' }, headers);
        return json(202, { project: await projectView(db, orgId, (await load(row.id))!) });
    }

    // ── Music, colour look and name-caption style: no re-plan, nothing re-sourced ──
    if (action === 'set_options') {
        // A failed render can be changed too: its timeline is made again by "Make the video", which is
        // free when every scene and the voiceover are already made. Without this a video whose music
        // file had gone could only "Try the render again" — and fail the same way (2026-11-10).
        if (!['planned', 'failed', 'render_failed'].includes(row.status) || !row.storyboard) return json(409, { error: 'This video can’t be changed right now.' });
        const brief = { ...(row.brief as VideoBrief) };
        const sb = { ...(row.storyboard as Storyboard) };
        // A track from My Content: checked to be this workspace's own music before it is kept.
        if (body.musicAssetId != null) {
            const own = await ownMusicTrack(db, orgId, Number(body.musicAssetId));
            if (!own) return json(400, { error: 'That track isn’t in your My Content.' });
            brief.musicMood = 'mine'; brief.musicAssetId = own.assetId; sb.music = null;
        } else if (isMusicChoice(body.musicMood) && body.musicMood !== 'mine' && body.musicMood !== brief.musicMood) {
            brief.musicMood = body.musicMood; brief.musicAssetId = null; sb.music = null;
        }
        // "Another track": the same mood, a new track made at "Make the video" (charged then, shown on
        // the button). Also how a version whose music failed tries again.
        if (body.anotherTrack === true) { if (sb.music?.trackId) brief.avoidTrackId = sb.music.trackId; sb.music = null; }
        if (isVideoLook(body.look)) brief.look = body.look;
        if (isLowerThirdStyle(body.lowerThird)) brief.lowerThird = body.lowerThird;
        const back = row.status === 'render_failed' ? { status: 'planned', note: null } : {};
        await db.update(videoProjects).set({ brief, storyboard: sb, ...back, updatedAt: new Date() }).where(eq(videoProjects.id, row.id));
        return json(200, { project: await projectView(db, orgId, (await load(row.id))!) });
    }

    if (action === 'plan_from_review') {
        if (row.status !== 'reviewed' && !(row.status === 'planned' && row.footageReview) && !(row.status === 'failed' && row.footageReview)) {
            return json(409, { error: 'This video has no footage review to plan from.' });
        }
        const review = structuredClone(row.footageReview) as FootageReview;
        const ticks = (body.ticks && typeof body.ticks === 'object' ? body.ticks : {}) as Record<string, unknown>;
        // Only what the owner ticked is applied (plan §4.3): an id absent from `ticks` counts as unticked.
        for (const sgn of review.suggestions) sgn.ticked = ticks[sgn.id] === true;
        const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 600) : '';
        if (notes) {
            const blocked = await enforcePromptModeration({ text: notes, userId, organisationId: orgId, source: 'video-projects' });
            if (blocked) return blocked;
        }
        await db.update(videoProjects).set({ status: 'planning', footageReview: review, note: null, sceneAssets: {}, voiceoverAssetId: null, updatedAt: new Date() })
            .where(eq(videoProjects.id, row.id));
        await wakeVideoWorker({ projectId: row.id, action: 'plan', feedback: notes || null }, headers);
        return json(202, { project: await projectView(db, orgId, (await load(row.id))!) });
    }

    if (action === 'replan') {
        if (row.status === 'planning' || row.status === 'building' || row.status === 'reviewing') return json(409, { error: 'It is already working on this video.' });
        if (row.status === 'reviewed') return json(409, { error: 'Tick the edits you want first, then press “Make the storyboard”.' });
        const feedback = typeof body.feedback === 'string' ? body.feedback.trim().slice(0, 600) : '';
        if (feedback) {
            const blocked = await enforcePromptModeration({ text: feedback, userId, organisationId: orgId, source: 'video-projects' });
            if (blocked) return blocked;
        }
        // A new plan means new scenes: what was sourced for the old ones no longer fits.
        await db.update(videoProjects).set({ status: 'planning', note: null, sceneAssets: {}, voiceoverAssetId: null, editCount: row.editCount + 1, updatedAt: new Date() })
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
        // What the scene SHOWS before the edit: only a change to it re-sources the scene. New words on
        // screen over the same clip keep the clip (they're an overlay) — except on a branded card,
        // whose words are drawn into the picture (staging, 2026-11-09: a words-only edit swapped the stock clip).
        const looks = sceneLooks;
        const before = looks(scene);
        let voiceChanged = false;
        if (typeof patch.voiceover === 'string' && patch.voiceover !== scene.voiceover) { scene.voiceover = patch.voiceover; voiceChanged = true; }
        if (typeof patch.onScreenText === 'string') scene.onScreenText = patch.onScreenText;
        if (typeof patch.source === 'string' && (SCENE_SOURCES as readonly string[]).includes(patch.source)) scene.source = patch.source as typeof scene.source;
        if (typeof patch.keywords === 'string') scene.keywords = patch.keywords;
        if (typeof patch.prompt === 'string') scene.prompt = patch.prompt;
        if (patch.assetId != null) scene.assetId = Number(patch.assetId);
        if (typeof patch.tighten === 'boolean') { if (patch.tighten) delete scene.tighten; else scene.tighten = false; }
        if (patch.inS != null) scene.inS = Number(patch.inS);
        if (patch.outS != null) scene.outS = Number(patch.outS);
        // A name caption on the scene ({ name, role }), or null / an empty name to take it off.
        if ('nameCaption' in patch) { const nc = readNameCaption(patch.nameCaption); if (nc) scene.nameCaption = nc; else delete scene.nameCaption; }
        // Changed words need approving again (script first).
        if (voiceChanged) sb.scriptApprovedAt = null;
        const text = [scene.voiceover, scene.onScreenText, scene.prompt, scene.keywords].filter(Boolean).join('\n');
        if (text) {
            const blocked = await enforcePromptModeration({ text, userId, organisationId: orgId, source: 'video-projects' });
            if (blocked) return blocked;
        }
        const brief = row.brief as VideoBrief;
        const footage = await loadFootage(db, orgId, brief.footageAssetIds ?? []);
        const enforced = enforceStoryboard(sb, brief, await libraryPictures(db, orgId), asOwnVideos(footage));
        // A changed cut, or "Keep as filmed", is tightened again from the review's words.
        const tightened = footage.length ? tightenStoryboard(enforced.storyboard, brief, footage) : { storyboard: enforced.storyboard, changes: [] };
        const storyboard = tightened.storyboard;
        const changes = [...enforced.changes, ...tightened.changes];
        const assets = { ...(row.sceneAssets as Record<string, number>) };
        const after = storyboard.scenes.find((s) => s.id === scene.id);
        if (!after || looks(after) !== before) delete assets[scene.id];   // re-sourced on the next build
        await db.update(videoProjects).set({
            storyboard, changes, sceneAssets: assets, status: 'planned', editCount: row.editCount + 1,
            // The voiceover is one track for the whole script — any line changing re-records it.
            ...(voiceChanged ? { voiceoverAssetId: null } : {}),
            updatedAt: new Date(),
        }).where(eq(videoProjects.id, row.id));
        return json(200, { project: await projectView(db, orgId, (await load(row.id))!) });
    }

    if (action === 'build') {
        if (!['planned', 'failed'].includes(row.status) || !row.storyboard) return json(409, { error: 'This video is not ready to make.' });
        const hold = await holdBuild(db, orgId, row.storyboard as Storyboard, row.brief as VideoBrief, row);
        if (!hold.ok) return json(402, { error: 'insufficient_credits', cost: hold.cost, balance: hold.balance, unit: hold.unit });
        // Campaign orders and the weekly autopilot plan a storyboard with no person behind it
        // (createdBy null); whoever presses "Make the video" owns what it makes. Without this the
        // worker refused it seconds later ("…no longer has an account") and it bounced back.
        await db.update(videoProjects).set({ status: 'building', createdBy: row.createdBy ?? userId, creditHold: hold.credits, startedAt: new Date(), note: null, updatedAt: new Date() })
            .where(eq(videoProjects.id, row.id));
        await wakeVideoWorker({ projectId: row.id, action: 'build' }, headers);
        return json(202, { project: await projectView(db, orgId, (await load(row.id))!) });
    }

    if (action === 'rerender') {
        if (row.status !== 'render_failed' || !row.timeline) return json(409, { error: 'There is nothing to render again for this video.' });
        await db.update(videoProjects).set({ status: 'rendering', createdBy: row.createdBy ?? userId, renderId: null, note: null, updatedAt: new Date() })
            .where(eq(videoProjects.id, row.id));
        await wakeRenderWorker(row.id, headers);
        return json(202, { project: await projectView(db, orgId, (await load(row.id))!) });
    }

    if (action === 'cancel') {
        if (row.status === 'building') return json(409, { error: 'It is making this video right now — wait for it to finish.' });
        if (row.status === 'reviewing') return json(409, { error: 'It is watching your footage right now — wait a moment.' });
        if (row.status === 'rendering') return json(409, { error: 'The finished video is rendering — wait a moment.' });
        await db.update(videoProjects).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(videoProjects.id, row.id));
        return json(200, { ok: true });
    }

    return json(400, { error: 'Unknown action.' });
});
