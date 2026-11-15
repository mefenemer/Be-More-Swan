// netlify/functions/run-trigger-poll-background.ts
// Buying triggers Phase 1 (docs/buying-triggers-plan.md §5): the daily read of the FSA's new food and
// drink premises (src/utils/trigger-engine.ts runFsaPoll). Background function: 15 minutes, of which
// the run uses at most 13.
//
// Started by dispatch-trigger-polls.ts (scheduled, production), run-trigger-poll-dispatch.ts (staging,
// via staging-crons.yml) and Admin ▸ Buying triggers ▸ "Run now" (admin-triggers.ts).
//
// AUTH: shared secret (CRON_TRIGGER_SECRET) as `Authorization: Bearer <secret>`. Fails closed when unset.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { runFsaPoll } from '../../src/utils/trigger-engine';

export default withLambda(async (event) => {
    const secret = process.env.CRON_TRIGGER_SECRET;
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (!secret || auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        console.warn('[run-trigger-poll-background] refused: ' + (!secret ? 'CRON_TRIGGER_SECRET unset' : 'bad secret'));
        return { statusCode: 401, body: 'Unauthorized' };
    }
    try {
        const result = await runFsaPoll(getDb());
        console.log('[run-trigger-poll-background]', JSON.stringify(result));
    } catch (err) {
        console.error('[run-trigger-poll-background] failed', err);
    }
    return { statusCode: 200, body: '' };
});
