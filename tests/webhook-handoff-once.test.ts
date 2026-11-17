// A custom webhook recipe (Zapier / Make) POSTs ONCE per meeting, however many times its scenario job is
// retried (PR #695 review, 2026-11-17): one failing recipe re-queued the whole job and the unguarded webhook
// POSTed the same meeting to the customer's Zap on every attempt. A webhook that itself fails still retries.
// Run: npx tsx tests/webhook-handoff-once.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sendWebhookOnce, webhookHandoffKey, webhookLedger, webhooksSentOnJob } from '../src/utils/webhook-handoff-once';

const read = (f: string) => readFileSync(f, 'utf8');

/** Flatten a drizzle sql`` object into its text and its parameters, in order. */
function flatten(q: unknown, out = { text: '', params: [] as unknown[] }) {
    for (const c of (q as { queryChunks: unknown[] }).queryChunks) {
        if (c && typeof c === 'object' && Array.isArray((c as { value?: unknown }).value)) out.text += (c as { value: string[] }).value.join('');
        else if (c && typeof c === 'object' && 'queryChunks' in (c as object)) flatten(c, out);
        else { out.params.push(c); out.text += '$'; }
    }
    return out;
}

/**
 * An in-memory database that behaves like the real one for the statements these ledgers send: the meeting's
 * data.handoffs stamps (claim / stamp sentAt / release / read) and the job's subject.webhooksSent list.
 */
function fakeDb(opts: { failExecute?: boolean } = {}) {
    const handoffs: Record<string, { claimedAt?: number; sentAt?: number }> = {};
    const jobRow = { id: 7, organisationId: 58, subject: {} as Record<string, unknown> };
    const db = {
        execute: async (q: unknown) => {
            if (opts.failExecute) throw new Error('db down');
            const { text, params } = flatten(q);
            if (text.includes('UPDATE scenario_jobs')) {
                const key = String(params[0]);
                const sent = webhooksSentOnJob(jobRow.subject);
                if (!sent.includes(key)) jobRow.subject = { ...jobRow.subject, webhooksSent: [...sent, key] };
                return [];
            }
            const key = String(params[0]);
            const h = handoffs[key] ?? {};
            if (text.includes('UPDATE assistant_records') && text.includes("'claimedAt', now()")) {
                if (h.sentAt == null && h.claimedAt == null) { handoffs[key] = { claimedAt: Date.now() }; return [{ id: 918 }]; }
                return [];
            }
            if (text.includes('UPDATE assistant_records') && text.includes("'sentAt', now()")) { handoffs[key] = { sentAt: Date.now() }; return []; }
            if (text.includes('UPDATE assistant_records')) { if (h.sentAt == null) delete handoffs[key]; return []; }
            if (text.includes('SELECT')) return [{ sentAt: h.sentAt ? new Date(h.sentAt).toISOString() : null }];
            throw new Error('unexpected statement: ' + text);
        },
    };
    return { db: db as never, handoffs, jobRow };
}

/**
 * One attempt of the scenario job, as process-scenario-jobs.ts runs it: every matching recipe, collecting
 * errors. The webhook goes through the real ledger + sendWebhookOnce; `slackOk` decides the other recipe.
 * Returns the errors — any error means the drain re-queues the whole job.
 */
async function attempt(db: never, job: { id: number; organisationId: number; subject: unknown }, post: () => Promise<{ ok: boolean; status: number }>, slackOk: boolean) {
    const errors: string[] = [];
    const sent = await sendWebhookOnce(webhookLedger(db, job, 'universal_webhook_meeting'), post);
    if (sent.outcome === 'busy') errors.push('universal_webhook_meeting: another run is sending it');
    if (sent.outcome === 'failed') errors.push(`universal_webhook_meeting: webhook ${sent.status}`);
    if (sent.outcome === 'error') errors.push(`universal_webhook_meeting: ${sent.error.message}`);
    if (!slackOk) errors.push('slack_meeting_summary: 503');
    return { errors, sent };
}

(async () => {
    // 1. Keys and the job list.
    assert.equal(webhookHandoffKey('universal_webhook_meeting'), 'webhook:universal_webhook_meeting');
    assert.deepEqual(webhooksSentOnJob({ webhooksSent: ['a', 3, 'b'] }), ['a', 'b']);
    assert.deepEqual(webhooksSentOnJob(null), []);

    // 2. MEETING: Slack fails on attempt 1 → the job retries (3 attempts) → the webhook POSTed exactly once.
    {
        const { db, handoffs } = fakeDb();
        const job = { id: 7, organisationId: 58, subject: { recordType: 'meeting', recordId: 918 } };
        let posts = 0;
        const post = async () => { posts++; return { ok: true, status: 200 }; };
        const a1 = await attempt(db, job, post, false);
        assert.equal(a1.sent.outcome, 'sent');
        assert.ok(a1.errors.length > 0, 'Slack failed → the job is re-queued');
        const a2 = await attempt(db, job, post, false);
        assert.equal(a2.sent.outcome, 'already_sent', 'the retry skips the webhook that already went');
        const a3 = await attempt(db, job, post, true);
        assert.equal(a3.sent.outcome, 'already_sent');
        assert.deepEqual(a3.errors, [], 'skipped webhook is not an error: the job completes once Slack works');
        assert.equal(posts, 1, 'ONE POST to the customer endpoint across three attempts');
        assert.ok(handoffs['webhook:universal_webhook_meeting']?.sentAt, 'stamped on the meeting');
        // A re-approval queues a NEW job for the same meeting: still not POSTed again.
        const again = await attempt(db, { ...job, id: 8 }, post, true);
        assert.equal(again.sent.outcome, 'already_sent');
        assert.equal(posts, 1);
    }

    // 3. MEETING: the webhook ITSELF fails (500) → error, claim released → the retry POSTs again and succeeds.
    {
        const { db, handoffs } = fakeDb();
        const job = { id: 7, organisationId: 58, subject: { recordType: 'meeting', recordId: 918 } };
        const statuses = [500, 200];
        let posts = 0;
        const post = async () => { const status = statuses[posts++]; return { ok: status < 300, status }; };
        const a1 = await attempt(db, job, post, true);
        assert.equal(a1.sent.outcome, 'failed');
        assert.deepEqual(a1.errors, ['universal_webhook_meeting: webhook 500'], 'a failing webhook still re-queues the job');
        assert.equal(handoffs['webhook:universal_webhook_meeting'], undefined, 'claim released, nothing stamped');
        const a2 = await attempt(db, job, post, true);
        assert.equal(a2.sent.outcome, 'sent');
        assert.deepEqual(a2.errors, []);
        assert.equal(posts, 2);
    }

    // 4. MEETING: a network error (fetch throws) is retried too.
    {
        const { db } = fakeDb();
        const job = { id: 7, organisationId: 58, subject: { recordType: 'meeting', recordId: 918 } };
        let posts = 0;
        const post = async () => { posts++; if (posts === 1) throw new Error('ECONNRESET'); return { ok: true, status: 204 }; };
        const a1 = await attempt(db, job, post, true);
        assert.deepEqual(a1.errors, ['universal_webhook_meeting: ECONNRESET']);
        const a2 = await attempt(db, job, post, true);
        assert.equal(a2.sent.outcome, 'sent');
        assert.equal(posts, 2);
    }

    // 5. MEETING: another run holds a fresh claim → busy (job retries later), no POST.
    {
        const { db, handoffs } = fakeDb();
        handoffs['webhook:universal_webhook_meeting'] = { claimedAt: Date.now() };
        let posts = 0;
        const a = await attempt(db, { id: 7, organisationId: 58, subject: { recordType: 'meeting', recordId: 918 } }, async () => { posts++; return { ok: true, status: 200 }; }, true);
        assert.equal(a.sent.outcome, 'busy');
        assert.equal(posts, 0);
        assert.equal(a.errors.length, 1);
    }

    // 6. MEETING: the stamp cannot be read → busy, never a POST.
    {
        const { db } = fakeDb({ failExecute: true });
        let posts = 0;
        const a = await attempt(db, { id: 7, organisationId: 58, subject: { recordType: 'meeting', recordId: 918 } }, async () => { posts++; return { ok: true, status: 200 }; }, true);
        assert.equal(a.sent.outcome, 'busy');
        assert.equal(posts, 0);
    }

    // 7. LEAD (universal_webhook_handoff): the job's own list. A retry of the job (re-read from the DB, as the
    //    drain does) skips it; a NEW job for the lead POSTs as it does today; a failed POST is not recorded.
    {
        const { db, jobRow } = fakeDb();
        jobRow.subject = { recordType: 'lead', recordId: 55 };
        let posts = 0;
        const ok = async () => { posts++; return { ok: true, status: 200 }; };
        await attempt(db, { ...jobRow }, ok, false);
        assert.deepEqual(jobRow.subject.webhooksSent, ['universal_webhook_meeting']);
        const retry = await attempt(db, { ...jobRow }, ok, true);
        assert.equal(retry.sent.outcome, 'already_sent');
        assert.equal(posts, 1, 'a retry of the lead job does not POST again');
        const fresh = await attempt(db, { id: 9, organisationId: 58, subject: { recordType: 'lead', recordId: 55 } }, ok, true);
        assert.equal(fresh.sent.outcome, 'sent', 'a new hand-off job is a new POST, as today');

        const f = fakeDb();
        f.jobRow.subject = { recordType: 'lead', recordId: 55 };
        const r = await attempt(f.db, { ...f.jobRow }, async () => ({ ok: false, status: 502 }), true);
        assert.equal(r.sent.outcome, 'failed');
        assert.equal(f.jobRow.subject.webhooksSent, undefined, 'a failed POST is not recorded: the retry POSTs again');
    }

    // 8. Wiring: the runner sends every webhook recipe through the guard, and reports failures as errors.
    const runner = read('netlify/functions/process-scenario-jobs.ts');
    const hook = runner.slice(runner.indexOf('if (active.webhookUrl) {'), runner.indexOf('// Tier 1 native'));
    assert.ok(hook.includes('await sendWebhookOnce(webhookLedger(db, job, scenario.scenarioKey), () => fetch(webhookUrl, {'));
    assert.equal((hook.match(/fetch\(/g) ?? []).length, 1, 'the only POST is inside the guard');
    assert.ok(hook.includes("if (sent.outcome === 'already_sent') {") && hook.includes('continue;'), 'already sent → skipped, not an error');
    assert.ok(hook.includes("if (sent.outcome === 'busy') { errors.push("));
    assert.ok(hook.includes("if (sent.outcome === 'failed') errors.push("), 'a failing webhook still retries');
    assert.ok(hook.includes("if (sent.outcome === 'error') errors.push("));
    assert.equal((runner.match(/fetch\(/g) ?? []).length, 1, 'no other webhook POST in the runner');

    console.log('webhook-handoff-once: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
