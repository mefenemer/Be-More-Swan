// netlify/functions/run-lead-sweeps.ts
// On-demand HTTP trigger for the Lead Generator's three nightly jobs. Netlify runs scheduled
// functions ONLY on the production deploy, so staging (a branch deploy of `staging`) never fires
// them — which meant all three had never run anywhere but production, and their first automated
// execution would have been against every live tenant at once:
//
//   • lead-retention-sweep  — writes to EVERY stale lead in the estate, and now also sends the
//                             expiry warning. The highest-blast-radius job in the role.
//   • lead-enrichment-sweep — the only cron here that spends money per lead with nobody watching
//                             (its own LEAD_ENRICH_SWEEP_ENABLED gate still applies; a disabled
//                             sweep reports `skipped` rather than doing anything).
//   • suppression-sync      — what stops cold outreach reaching a tenant's own customers.
//
// All three in ONE endpoint deliberately. They are all nightly, all idempotent and all cheap when
// there is nothing to do, and the staging cron workflow's cost is per ENDPOINT (one HTTP call, one
// Neon wake-up) — three separate wrappers would triple the wake-ups to run the same three queries.
// Order matters and mirrors netlify.toml: retention first, so a lead that is going to be retired
// tonight is retired BEFORE the enrichment sweep pays to research it.
//
// Mirrors run-discovery-jobs.ts / run-sequence-sends.ts / run-account-memory.ts.
//
// AUTH: shared secret (CRON_TRIGGER_SECRET) as `Authorization: Bearer <secret>`. Fails closed when
// unset — the enrichment sweep spends real money, so an open version is a cost hole.
//
// POST /.netlify/functions/run-lead-sweeps  → 200 { ok, retention, enrichment, suppression }

import { withLambda } from '@netlify/aws-lambda-compat';
import { sweepLeadRetention } from './lead-retention-sweep';
import { sweepLeadEnrichment } from './lead-enrichment-sweep';
import { syncSuppressionLists } from './suppression-sync';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-lead-sweeps] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== secret) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };

    // ⚠️ Each sweep is caught SEPARATELY and the failure reported in its own slot. One 500 covering
    // all three would tell the workflow that nothing ran when two of them had, and the elapsed-time
    // gate in staging-crons.yml stamps success per ENDPOINT — so a single-failure-fails-all shape
    // would keep re-running the two that already worked every tick.
    const out: Record<string, unknown> = {};
    let failed = false;

    for (const [name, run] of [
        ['retention', sweepLeadRetention],
        ['enrichment', sweepLeadEnrichment],
        ['suppression', syncSuppressionLists],
    ] as const) {
        try {
            out[name] = await run();
        } catch (err) {
            failed = true;
            console.error(`[run-lead-sweeps] ${name} failed`, err);
            out[name] = { error: err instanceof Error ? err.message : 'error' };
        }
    }

    // 500 when any of the three failed, so the workflow's per-endpoint status reflects reality and
    // the failing sweep stays due on the next tick. The successful ones' results are still returned.
    return {
        statusCode: failed ? 500 : 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: !failed, ...out }),
    };
});
