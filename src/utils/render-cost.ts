// src/utils/render-cost.ts — logs every Remotion Lambda render's compute ONCE, however it ends (docs/cost-logging-audit.md).
//
// A render that finishes, or fails with a fatal error, reports done (remotion-lambda.ts renderProgress) and is logged with
// Remotion's own `costs.accruedSoFar`. A render we GIVE UP on (the poll ran out of time, or a poll / database call threw)
// carries on spending on Lambda but never reports done to us, so it used to log nothing. `abandon()` asks Remotion once
// more what it has spent and logs that, or the last figure we saw if Remotion can't be reached. Since the render may
// still be running, this can understate the final bill. It is the best figure we can get without a second worker.
//
// A worker KILLED outright (a deploy, a platform fault) can't log anything. Its job row is left 'rendering' with the
// render's id on it, so the stuck sweeps (video-producer.ts sweepStuckProjects, render-post-video-background.ts
// sweepKilledPostRenders) call logOrphanedRenderCost once they win the claim on that row. Every render's row carries
// its own session id (`<base>:<renderId>`), so the sweep can tell whether the worker logged before it died.
//
// Used by both render loops: src/utils/video-render.ts (Video Producer) and render-post-video-background.ts (posts).

import { eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiUsageLog } from '../../db/schema';
import { renderProgress, type RenderProgress, type StartedRender } from '../lib/remotion-lambda';
import { logRenderCost, type AiUsageParams } from './ai-usage';

type UsageCtx = Omit<AiUsageParams, 'model' | 'inputTokens' | 'outputTokens' | 'costUsdOverride'>;
type Db = ReturnType<typeof getDb>;

/** The session id one render's cost row carries: the caller's label plus Remotion's render id. Pure. */
export function renderSessionId(base: string | null | undefined, renderId: string): string {
    return `${base || 'remotion-render'}:${renderId}`.slice(0, 255);
}

/**
 * A render whose worker died before logging it: log what Remotion says it cost, unless a row for that render already
 * exists (the worker logged, then died before closing the job). The caller must have just won the claim on the job
 * row, so two sweeps can't both get here. A render Remotion can't report on logs nothing. Never throws.
 */
export async function logOrphanedRenderCost(
    db: Db, r: StartedRender, ctx: UsageCtx,
    progressOf: (r: StartedRender) => Promise<RenderProgress> = renderProgress,
    log: typeof logRenderCost = logRenderCost,
): Promise<boolean> {
    try {
        const sessionId = renderSessionId(ctx.sessionId, r.renderId);
        const [already] = await db.select({ id: aiUsageLog.id }).from(aiUsageLog).where(eq(aiUsageLog.sessionId, sessionId)).limit(1);
        if (already) return false;
        const p = await progressOf(r);
        if (p.costUsd == null) return false;
        await log(p.costUsd, { ...ctx, sessionId });
        return true;
    } catch (err) {
        console.warn('[render-cost] killed render not logged:', err instanceof Error ? err.message : err);
        return false;
    }
}

export class RenderCostMeter {
    private open: StartedRender | null = null;
    private lastCost: number | null = null;

    /** `progressOf` and `log` are the real Remotion read and cost write; tests pass stand-ins. */
    constructor(
        private readonly ctx: UsageCtx,
        private readonly progressOf: (r: StartedRender) => Promise<RenderProgress> = renderProgress,
        private readonly log: typeof logRenderCost = logRenderCost,
    ) {}

    /** A render was started (the first, or the retry). Any render still open is given up on first. */
    async started(r: StartedRender): Promise<void> {
        await this.abandon();
        this.open = r;
        this.lastCost = null;
    }

    /** One poll's answer. A finished (or fatally failed) render is logged here, once. */
    async seen(p: RenderProgress): Promise<void> {
        const r = this.open;
        if (!r) return;
        if (p.costUsd != null) this.lastCost = p.costUsd;
        if (p.done) {
            this.open = null;
            await this.log(p.costUsd ?? this.lastCost, this.ctxFor(r));
        }
    }

    /** The usage context for one render: its own session id, so a stuck sweep can see it was logged. */
    private ctxFor(r: StartedRender): UsageCtx {
        return { ...this.ctx, sessionId: renderSessionId(this.ctx.sessionId, r.renderId) };
    }

    /** We stop following the open render: log what it has spent so far. Never throws. Does nothing when none is open. */
    async abandon(): Promise<void> {
        const r = this.open;
        if (!r) return;
        this.open = null;
        let cost = this.lastCost;
        try {
            const p = await this.progressOf(r);
            if (p.costUsd != null) cost = Math.max(cost ?? 0, p.costUsd);
        } catch { /* Remotion unreachable: the last figure we saw */ }
        await this.log(cost, this.ctxFor(r));
    }
}
