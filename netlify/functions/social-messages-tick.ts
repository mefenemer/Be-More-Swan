// netlify/functions/social-messages-tick.ts — every 15 minutes, for Facebook + Instagram messages
// (docs/meta-messages-plan.md, Phase 2; src/utils/social-messages.ts runMessagesTick):
//   · one "4 hours left" reminder per waiting conversation per reply window (Meta allows 24h);
//   · message text older than 90 days is blanked (owner decision D6) — rows and counts stay.
// Sends nothing to anyone outside the workspace.
//
// ⚠️ Netlify runs scheduled functions on PRODUCTION only, and answers a direct URL call to one with a
// bare 403 before this handler runs. Staging is poked through run-social-messages-tick.ts instead.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { runMessagesTick } from '../../src/utils/social-messages';
import { isMissingTable } from '../../src/utils/meta-messaging';
import { mayRunScheduled } from '../../src/utils/scheduled-run-auth';

export const config = { schedule: '*/15 * * * *' };

/** Shared with run-social-messages-tick.ts (staging's trigger). Never throws. */
export async function socialMessagesTick(): Promise<{ reminded: number; purged: number; skipped?: string }> {
    try {
        const r = await runMessagesTick(getDb());
        console.log('[social-messages-tick]', r);
        return r;
    } catch (err) {
        // Before db/z-social-messages(-2).sql is applied there is nothing to do — not an outage.
        if (isMissingTable(err) || (err as { cause?: { code?: string } })?.cause?.code === '42703') return { reminded: 0, purged: 0, skipped: 'not_set_up' };
        console.error('[social-messages-tick] failed', err instanceof Error ? err.message : err);
        return { reminded: 0, purged: 0, skipped: 'error' };
    }
}

export default withLambda(async (event) => {
    if (!mayRunScheduled(event)) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    const result = await socialMessagesTick();
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
});
