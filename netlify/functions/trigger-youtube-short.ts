// netlify/functions/trigger-youtube-short.ts
// Draft one YouTube Short NOW, instead of waiting for the weekly slot.
//
//   POST { assistantId, contextPrompt? }
//     Auth: aura_session (requireTenant). The assistant must belong to the caller's org.
//
//   202 { jobId, drained }                    — queued; `drained` says whether the queue was poked
//   409 { code: 'YOUTUBE_NOT_CONNECTED' }     — no live YouTube connection for this org
//   503 { code: 'RENDER_UNAVAILABLE' }        — Remotion/R2 not configured in this environment
//
// ── Why this exists, given the composer can already do it ───────────────────────────────────────
// Selecting YouTube alone in the composer produces the same job shape (generate-post sets
// platform:'youtube', platforms:null, no group id), so the Short path is reachable from the UI
// today. What this adds is the two things that make it a VERIFICATION tool rather than a feature:
// it refuses up front when the renderer is missing — the composer would happily draft a card that
// can never become a video — and it pokes the queue so the whole path runs in about a minute.
// That second part matters most on staging, which is a branch deploy: Netlify runs scheduled
// functions only on production, so process-content-jobs never fires there and the job would sit
// queued until the GitHub Actions cron came round.
//
// It is deliberately org-scoped rather than admin-only: the draft it produces lands in the caller's
// own Review Queue, needs their approval like any other, and uploads unlisted.

import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, aiBlueprints } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { enqueueYoutubeShortJob } from '../../src/utils/schedule-gap-fill';
import { resolveLiveSocialConnections } from '../../src/utils/live-social-connections';
import { isPlatformOptedInForAssistant } from '../../src/utils/assistant-platform-selection';
import { assembleBlueprint } from '../../src/utils/blueprint';
import { remotionConfigured } from '../../src/lib/remotion-lambda';
import { r2IsConfigured } from '../../src/lib/media-persist';
import { withLambda } from '@netlify/aws-lambda-compat';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/**
 * Poke the queue so the caller sees a draft in a minute rather than at the next cron tick.
 *
 * Fire-and-observe: the drain can legitimately run longer than we are willing to wait, so we abort
 * the CLIENT after 5s and report success anyway. Aborting our end does not stop the server — the
 * request has already left — so the drain finishes regardless. What we must not do is skip the
 * await entirely: Lambda freezes the environment when the handler returns, and a request that never
 * left the box would leave the job sitting there with the caller told it was running.
 */
async function pokeQueue(baseUrl: string | null): Promise<boolean> {
    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!baseUrl || !secret) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        await fetch(`${baseUrl}/.netlify/functions/run-content-jobs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            signal: controller.signal,
        });
        return true;
    } catch (err) {
        // An abort here means the drain is still running, which is the expected case.
        return (err as Error)?.name === 'AbortError';
    } finally {
        clearTimeout(timer);
    }
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;

    let body: { assistantId?: number };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON.' }); }

    const assistantId = Number(body.assistantId);
    if (!Number.isInteger(assistantId)) return json(400, { error: 'assistantId required.' });

    const [assistant] = await db
        .select({
            id: aiAssistants.id,
            onboardingContext: aiAssistants.onboardingContext,
            configuration: aiAssistants.configuration,
        })
        .from(aiAssistants)
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
        .limit(1);
    if (!assistant) return json(404, { error: 'Assistant not found.' });

    const platformScope = {
        organisationId: orgId,
        onboardingContext: assistant.onboardingContext,
        configuration: assistant.configuration,
    };

    // Refuse BEFORE drafting, for the same reason the weekly enqueuer does: a Short's last step is
    // becoming a video, and without a renderer we would spend a model call to produce a card that
    // can never publish. This is the check the composer route does NOT make.
    if (!remotionConfigured() || !r2IsConfigured()) {
        return json(503, {
            error: 'Video rendering is not configured in this environment, so a Short cannot be produced.',
            code: 'RENDER_UNAVAILABLE',
        });
    }

    // Connected and switched on are two different questions, and the workspace can be connected
    // while THIS assistant is not ticked for YouTube. Refuse with a message that names the switch,
    // so the answer is actionable rather than a bare refusal about an account that is plainly
    // linked. Opt-in, matching the weekly enqueuer: an untouched assistant is not ticked.
    if (!(await isPlatformOptedInForAssistant(db, platformScope, 'youtube'))) {
        return json(409, {
            error: 'YouTube is switched off for this assistant. Turn on “Use for this assistant” on the YouTube card in its Connections tab first.',
            code: 'YOUTUBE_DISABLED_FOR_ASSISTANT',
        });
    }

    const live = await resolveLiveSocialConnections(db, orgId);
    if (!live.has('youtube')) {
        return json(409, {
            error: 'Connect a YouTube account before drafting a Short.',
            code: 'YOUTUBE_NOT_CONNECTED',
        });
    }

    // Latest blueprint, compiled on the spot if this assistant has never had one — same fallback
    // generate-post and the gap-fill cron use, so a self-serve assistant isn't a dead end here.
    let [bp] = await db
        .select({ id: aiBlueprints.id })
        .from(aiBlueprints)
        .where(and(eq(aiBlueprints.assistantId, assistantId), eq(aiBlueprints.organisationId, orgId)))
        .orderBy(desc(aiBlueprints.compiledAt))
        .limit(1);
    if (!bp) {
        try {
            const result = await assembleBlueprint(assistantId, String(userId), 'auto-on-demand');
            bp = { id: result.blueprint.id };
        } catch (err) {
            console.error('[trigger-youtube-short] blueprint compile failed:', err);
            return json(409, { error: 'This assistant has no compiled blueprint yet.', code: 'NO_BLUEPRINT' });
        }
    }

    // Tomorrow, not now: the draft still needs approving, and a publish_date in the past would put
    // it straight into the publisher's "due" window the moment someone approved it.
    const targetPublishDate = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const jobId = await enqueueYoutubeShortJob(db, {
        blueprintId: bp.id,
        assistantId,
        organisationId: orgId,
        userId,
        targetPublishDate,
        triggerType: 'on_demand',
    });

    const drained = await pokeQueue(resolveBaseUrl(event.headers as Record<string, string | undefined>));

    return json(202, {
        jobId,
        drained,
        message: drained
            ? 'Short queued and the drafting queue was poked — check the Review Queue shortly.'
            : 'Short queued. It will be drafted on the next queue drain.',
    });
});
