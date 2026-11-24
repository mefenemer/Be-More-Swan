// src/utils/render-cost.ts — logs every Remotion Lambda render's compute ONCE, however it ends (docs/cost-logging-audit.md).
//
// A render that finishes, or fails with a fatal error, reports done (remotion-lambda.ts renderProgress) and is logged with
// Remotion's own `costs.accruedSoFar`. A render we GIVE UP on (the poll ran out of time, or a poll / database call threw)
// carries on spending on Lambda but never reports done to us, so it used to log nothing. `abandon()` asks Remotion once
// more what it has spent and logs that, or the last figure we saw if Remotion can't be reached. Since the render may
// still be running, this can understate the final bill. It is the best figure we can get without a second worker.
//
// Used by both render loops: src/utils/video-render.ts (Video Producer) and render-post-video-background.ts (posts).

import { renderProgress, type RenderProgress, type StartedRender } from '../lib/remotion-lambda';
import { logRenderCost, type AiUsageParams } from './ai-usage';

type UsageCtx = Omit<AiUsageParams, 'model' | 'inputTokens' | 'outputTokens' | 'costUsdOverride'>;

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
        if (!this.open) return;
        if (p.costUsd != null) this.lastCost = p.costUsd;
        if (p.done) {
            this.open = null;
            await this.log(p.costUsd ?? this.lastCost, this.ctx);
        }
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
        await this.log(cost, this.ctx);
    }
}
