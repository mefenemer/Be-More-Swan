// A meeting's follow-up email, Slack summary and Notion page go out ONCE, however many times it is approved
// or its job is retried (step 8 real-account run, 2026-11-16: approving twice emailed the attendees twice).
// Run: npx tsx tests/meeting-handoff-once.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    CLAIM_TTL_MINUTES, ONCE_PER_MEETING_ACTIONS, claimMeetingHandoff, finishMeetingHandoff, keepServerOwnedMeetingKeys, runsOncePerMeeting,
} from '../src/utils/meeting-handoff-once';

const read = (f: string) => readFileSync(f, 'utf8');

(async () => {
    // 1. Which hand-offs run once.
    assert.deepEqual([...ONCE_PER_MEETING_ACTIONS].sort(), ['email_meeting_followup', 'notion_create_page', 'slack_post_summary']);
    assert.equal(runsOncePerMeeting('meeting', 'email_meeting_followup', 918), true);
    assert.equal(runsOncePerMeeting('meeting', 'slack_post_summary', '918'), true);
    assert.equal(runsOncePerMeeting('meeting', 'jira_create_tasks', 918), false, 'tickets keep their own ledger: a re-approval retries skipped ones');
    assert.equal(runsOncePerMeeting('meeting', 'asana_create_tasks', 918), false);
    assert.equal(runsOncePerMeeting('lead', 'email_meeting_followup', 918), false);
    assert.equal(runsOncePerMeeting('meeting', 'email_meeting_followup', null), false);
    assert.ok(CLAIM_TTL_MINUTES >= 5);

    // 2. The claim, against a stub database: a won UPDATE claims; otherwise sentAt decides done vs busy.
    const stub = (updateRows: unknown[], selectRows: unknown[], fail = false) => {
        const calls: string[] = [];
        const db = { execute: async (q: { queryChunks?: unknown[] }) => {
            const text = JSON.stringify(q);
            calls.push(text.includes('UPDATE') ? 'update' : 'select');
            if (fail) throw new Error('db down');
            return text.includes('UPDATE') ? updateRows : selectRows;
        } };
        return { db: db as never, calls };
    };
    let s = stub([{ id: 918 }], []);
    assert.equal(await claimMeetingHandoff(s.db, 58, 918, 'email_meeting_followup'), 'claimed');
    assert.deepEqual(s.calls, ['update']);
    s = stub([], [{ sentAt: '2026-11-16T13:59:29Z' }]);
    assert.equal(await claimMeetingHandoff(s.db, 58, 918, 'email_meeting_followup'), 'done', 'already sent → skipped');
    s = stub([], [{ sentAt: null }]);
    assert.equal(await claimMeetingHandoff(s.db, 58, 918, 'email_meeting_followup'), 'busy', 'claimed by another run → retry later');
    s = stub([], []);
    assert.equal(await claimMeetingHandoff(s.db, 58, 918, 'email_meeting_followup'), 'done', 'meeting gone → nothing to send');
    s = stub([], [], true);
    assert.equal(await claimMeetingHandoff(s.db, 58, 918, 'email_meeting_followup'), 'busy', 'a failed read never sends');
    s = stub([], [], true);
    await finishMeetingHandoff(s.db, 58, 918, 'email_meeting_followup', true); // never throws

    // 3. The SQL: one atomic UPDATE guarded on "not sent, not freshly claimed"; finish stamps or releases.
    const src = read('src/utils/meeting-handoff-once.ts');
    assert.ok(src.includes("AND data->'handoffs'->(${actionType}::text)->>'sentAt' IS NULL"), 'only when not sent');
    assert.ok(src.includes("AND (data->'handoffs'->(${actionType}::text)->>'claimedAt' IS NULL"), 'and not freshly claimed');
    assert.match(src, /make_interval\(mins => \$\{CLAIM_TTL_MINUTES\}\)/);
    assert.ok(src.includes("AND NOT (${actionType}::text = 'email_meeting_followup' AND data ? 'followupSentAt')"), 'a follow-up sent before the stamps existed counts as done');
    assert.match(src, /jsonb_build_object\('sentAt', now\(\)\)/);
    assert.match(src, /COALESCE\(data->'handoffs', '\{\}'::jsonb\) - \$\{actionType\}::text/);

    // 4. An Inbox save that sends a stale `data` keeps the stamps; one that sends them keeps its own.
    const stored = { handoffs: { email_meeting_followup: { sentAt: 'x' } }, followupSentVia: 'gmail', followupSentAt: 't', tasks: [1] };
    assert.deepEqual(keepServerOwnedMeetingKeys({ tasks: [2], followupEmail: { subject: 'S' } }, stored), {
        tasks: [2], followupEmail: { subject: 'S' }, handoffs: { email_meeting_followup: { sentAt: 'x' } }, followupSentVia: 'gmail', followupSentAt: 't',
    });
    assert.deepEqual(keepServerOwnedMeetingKeys({ a: 1 }, null), { a: 1 });

    // 5. Wiring: the runner claims before running and finishes after, for both outcomes.
    const runner = read('netlify/functions/process-scenario-jobs.ts');
    assert.ok(runner.includes('const once = runsOncePerMeeting(subject.recordType, scenario.actionType, subject.recordId);'));
    const claimAt = runner.indexOf('await claimMeetingHandoff(');
    const runAt = runner.indexOf('result = await runAction(');
    assert.ok(claimAt > 0 && claimAt < runAt, 'claimed BEFORE the hand-off runs');
    assert.ok(runner.includes("if (claim === 'done') {") && runner.includes('continue;'), 'already done → skipped, not an error');
    assert.ok(runner.includes("if (claim === 'busy') { errors.push("), 'busy → the job retries later');
    assert.ok(runner.includes('result.statusCode < 400);'), 'success stamps sentAt, failure releases the claim');
    const recs = read('netlify/functions/assistant-records.ts');
    assert.ok(recs.includes("if (stored?.recordType === 'meeting') patch.data = keepServerOwnedMeetingKeys(body.data as Record<string, unknown>, stored.data);"));

    console.log('meeting-handoff-once: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
