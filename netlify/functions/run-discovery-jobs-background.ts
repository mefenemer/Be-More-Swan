// netlify/functions/run-discovery-jobs-background.ts
// Fire-and-forget drain of the lead-discovery queue, for a search a human just started.
//
// WHY THIS EXISTS: process-discovery-jobs runs on a ten-minute cron, deliberately — the aligned
// drainers let Neon autosuspend between ticks, and an always-on minute-cron is what exhausted the
// project-wide compute quota on 2026-07-11 (see netlify.toml). That is the right trade for the
// hourly dispatcher's scheduled runs, which nobody is watching.
//
// It was badly wrong for "Start search". Creating a search only INSERTs a discovery_jobs row at
// status 'queued'; nothing invoked the worker, so the user watched a "Queued" chip for up to ten
// minutes before anything looked at it — and on a branch deploy, forever, because Netlify fires
// scheduled functions only on the production deploy.
//
// ── Why this one LOOPS and run-content-jobs-background does not ────────────────
// A discovery run is sliced. Each drain does one search query (QUERIES_PER_SLICE = 1) and re-queues
// the job for the next tick, so a fifteen-query run needs fifteen ticks, plus more for the
// promoting and enriching stages. Draining once would move a search from "Queued" to "Searching
// now" and then strand it back on the cron for another ten minutes per query — over two hours for
// one run. So this drains repeatedly until the queue is empty or the budget runs out, and one poke
// carries the whole run.
//
// The `-background` suffix is load-bearing: Netlify answers 202 immediately and allows up to 15
// minutes, so the loop is not bounded by the 26-second budget of the request that triggered it.
//
// ── And when 15 minutes is not enough either ──────────────────────────────────
// A run needing more slice-time than BUDGET_MS used to stop here and drop its tail back onto the
// ten-minute cron — mid-run, after the user had been told a search was running. It now hands the
// remainder to a fresh invocation (MAX_HANDOFFS below), so "one poke carries the whole run" holds
// for runs of any length. docs/lead-generator-completeness-plan.md §2.2.
//
// SAFETY vs the cron: drainDiscoveryJobs claims its rows in a single atomic UPDATE ... RETURNING
// (see process-discovery-jobs.ts), so a cron tick landing mid-loop takes different rows or none.
// Overlap costs nothing and duplicates nothing.
//
// AUTH: same shared secret as run-discovery-jobs.ts, and it fails closed. A drain spends real money
// (Serper calls + model tokens), so this is never open to the internet.

import { drainDiscoveryJobs } from './process-discovery-jobs';
import { triggerDiscoveryDrain } from '../../src/utils/trigger-drain';
import { withLambda } from '@netlify/aws-lambda-compat';

// Netlify allows a background function 15 minutes. Stop well short so the final slice in flight
// finishes and reports rather than being killed mid-write — a slice truncated by the platform is
// exactly the "stuck in processing" case the worker then has to time out and reset.
const BUDGET_MS = 12 * 60 * 1000;
// Belt and braces against a pathological queue that never empties (e.g. many orgs' searches all
// running at once): the cron picks up whatever is left, as it always did.
const MAX_PASSES = 200;

/**
 * ── BUDGET HAND-OFF ─────────────────────────────────────────────────────────────────────────────
 * How many times a run may hand itself to a fresh invocation when BUDGET_MS expires with work left.
 *
 * ⚠️ THE GAP THIS CLOSES. BUDGET_MS is a platform limit, not a statement about the work: a run
 * needing more than ~12 minutes of slices simply stopped here, and its tail fell back to the
 * ten-minute cron — one slice per tick, mid-run, after the user had been told a search was
 * running. The original defect, arriving late.
 *
 * Rare today. It becomes the NORMAL case the moment contact lookup widens beyond hot/warm:
 * 500 leads at ENRICH_BATCH = 5 is 100 enrichment slices, roughly 17 minutes of consecutive work.
 * See docs/lead-generator-completeness-plan.md §2.2.
 *
 * ⚠️ FOUR, and the ceiling is not arbitrary. Four hand-offs is ~48 minutes of continuous draining,
 * which keeps one chain inside the hourly dispatch window — a chain still running when the next
 * dispatch fires would overlap it. That costs nothing in correctness (drainDiscoveryJobs claims
 * rows in one atomic UPDATE ... RETURNING, so overlapping loops take different rows or none) but
 * it is compute nobody asked for, and unbounded chaining is the shape that exhausted the
 * project-wide quota on 2026-07-11.
 *
 * Past the cap the cron takes the remainder, which is exactly the behaviour before this existed.
 */
const MAX_HANDOFFS = 4;

/**
 * Chain depth carried in the request body by the previous link. A first poke has none.
 *
 * Exported for tests. ⚠️ Unparseable, absent, negative or fractional all read as 0 — a malformed
 * body must not be able to grant an unbounded chain, and this endpoint is reachable by anything
 * holding the shared secret.
 */
export function parseHandoff(body: string | null | undefined): number {
    if (!body) return 0;
    try {
        const parsed = JSON.parse(body) as { handoff?: unknown };
        const n = Math.trunc(Number(parsed?.handoff));
        // ⚠️ NaN and a positive number are different failures and must fall DIFFERENT ways.
        // A missing or non-numeric field is a first poke, so 0. But Infinity is not "no value" —
        // treating it as one (which `Number.isFinite(n) && …` did) handed a forged body a FULL
        // chain of hand-offs, the exact opposite of the safe direction. Anything above the cap,
        // finite or not, clamps DOWN to it.
        if (Number.isNaN(n)) return 0;
        return n > 0 ? Math.min(n, MAX_HANDOFFS) : 0;
    } catch {
        return 0;   // not JSON — treat as a first poke
    }
}

/** What to do with the queue when the loop ends. */
export type LoopExit = 'queue_empty' | 'hand_off' | 'leave_to_cron';

/**
 * ── THE DECISION, and why the three exits are not equivalent ────────────────────────────────────
 *
 *   drained            the queue is empty. Nothing to hand off; a poke here would find no work.
 *   passes >= MAX      a pathological queue burning passes without draining — every job erroring
 *                      instantly, say. MAX_PASSES exists to STOP that, so chaining would convert
 *                      the safety net into a spin loop that outlives the process. The cron is the
 *                      right owner of a queue behaving badly.
 *   budget expired     legitimate long work interrupted by a platform limit. This one, and only
 *                      this one, deserves to continue.
 *
 * ⚠️ Collapsing the last two into "work remains, so chain" is the mistake this shape prevents: it
 * reads as obviously correct and turns a broken queue into an unbounded chain of invocations.
 */
export function decideLoopExit(state: {
    drained: boolean;
    passes: number;
    maxPasses: number;
    handoff: number;
}): LoopExit {
    if (state.drained) return 'queue_empty';
    if (state.passes >= state.maxPasses) return 'leave_to_cron';
    return state.handoff < MAX_HANDOFFS ? 'hand_off' : 'leave_to_cron';
}

export const HANDOFF_LIMITS = { MAX_HANDOFFS, MAX_PASSES, BUDGET_MS } as const;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-discovery-jobs-background] CRON_TRIGGER_SECRET is not set — trigger disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }

    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    const handoff = parseHandoff(event.body);

    const deadline = Date.now() + BUDGET_MS;
    let passes = 0;
    let slices = 0;
    /** Did the queue actually EMPTY, as opposed to us running out of time or patience? */
    let drained = false;

    try {
        while (Date.now() < deadline && passes < MAX_PASSES) {
            // Returns the number of job rows this pass claimed. Zero means the queue is empty OR
            // everything left is backing off (next_retry_at in the future) — either way there is
            // nothing this loop can usefully do, and the cron owns the retry.
            const processed = await drainDiscoveryJobs();
            passes++;
            if (!processed) { drained = true; break; }
            slices += processed;
        }
        console.log(`[run-discovery-jobs-background] ${slices} slice(s) over ${passes} pass(es)${handoff ? ` (hand-off ${handoff}/${MAX_HANDOFFS})` : ''}`);

        // Best-effort like every other poke: if it fails, `poke` logs and the rows stay exactly
        // where they are for the cron. A run can be slow; it cannot be lost.
        const exit = decideLoopExit({ drained, passes, maxPasses: MAX_PASSES, handoff });
        if (exit === 'hand_off') {
            await triggerDiscoveryDrain(
                event.headers as Record<string, string | undefined>,
                `handoff-${handoff + 1}`,
                'run-discovery-jobs-background',
                { handoff: handoff + 1 },
            );
        } else if (exit === 'leave_to_cron') {
            console.warn(`[run-discovery-jobs-background] stopping with work still queued (passes ${passes}/${MAX_PASSES}, hand-off ${handoff}/${MAX_HANDOFFS}) — the cron takes the remainder.`);
        }

        return { statusCode: 200, body: JSON.stringify({ ok: true, slices, passes, handoff, exit }) };
    } catch (err) {
        // Nothing is listening — the caller got its 202 long ago. Log loudly, then let the cron
        // pick the work up exactly as it would have before this endpoint existed.
        console.error(`[run-discovery-jobs-background] drain failed after ${slices} slice(s):`, err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, slices, passes }) };
    }
});
