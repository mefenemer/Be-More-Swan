// Meeting Note Taker step 7: a meeting's follow-up goes from Gmail, then Outlook — and NOTHING else (owner,
// 2026-11-17: "if they do not connect Outlook or Gmail then they cannot email"; no Be More Swan address).
// Run: npx tsx tests/meeting-followup-send.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IntegrationError } from '../src/utils/workspace-integrations';
import { NoMailboxError, followupSentMessage, sendMeetingFollowup, type FollowupSenders } from '../src/utils/meeting-followup-send';
import { outlookRecipients } from '../src/utils/outlook';
import { buildEmailPayload } from '../src/utils/scenario-engine';

const read = (f: string) => readFileSync(f, 'utf8');
const notConnected = () => new IntegrationError('not_connected', 'not connected');

type Call = { who: string; m: unknown };
function senders(o: { gmail?: 'ok' | 'off' | 'fail'; outlook?: 'ok' | 'off' | 'fail' }): { s: FollowupSenders; calls: Call[] } {
    const calls: Call[] = [];
    const s: FollowupSenders = {
        gmail: async (m) => {
            calls.push({ who: 'gmail', m });
            if (o.gmail === 'off') throw notConnected();
            if (o.gmail === 'fail') throw new Error('Gmail rejected the send.');
            return { id: 'g-1' };
        },
        outlook: async (m) => {
            calls.push({ who: 'outlook', m });
            if (o.outlook === 'off') throw notConnected();
            if (o.outlook === 'fail') throw new Error('Outlook rejected the send.');
            return { accepted: true };
        },
    };
    return { s, calls };
}
const msg = { recipients: ['ana@x.com', 'bo@y.com'], subject: 'Thanks', body: 'Recap' };

(async () => {
    // 1. Gmail connected → Gmail, nothing else tried.
    {
        const { s, calls } = senders({ gmail: 'ok', outlook: 'ok' });
        assert.deepEqual(await sendMeetingFollowup(msg, s), { via: 'gmail', id: 'g-1' });
        assert.deepEqual(calls, [{ who: 'gmail', m: { to: 'ana@x.com, bo@y.com', subject: 'Thanks', body: 'Recap' } }]);
    }
    // 2. Outlook-only workspace → its own Outlook.
    {
        const { s, calls } = senders({ gmail: 'off', outlook: 'ok' });
        assert.deepEqual(await sendMeetingFollowup(msg, s), { via: 'outlook', id: null });
        assert.deepEqual(calls.map((c) => c.who), ['gmail', 'outlook']);
        assert.deepEqual(calls[1].m, { to: 'ana@x.com, bo@y.com', subject: 'Thanks', body: 'Recap' });
    }
    // 3. No inbox → NOT SENT. No fallback sender exists to try.
    {
        const { s, calls } = senders({ gmail: 'off', outlook: 'off' });
        await assert.rejects(sendMeetingFollowup(msg, s), (err: unknown) => err instanceof NoMailboxError && err.code === 'no_mailbox' && /Not sent — no Gmail or Outlook is connected/.test(err.message));
        assert.deepEqual(calls.map((c) => c.who), ['gmail', 'outlook']);
    }
    // 4. A connected inbox that REFUSES stops there: never a second copy from another account.
    {
        const { s, calls } = senders({ gmail: 'fail', outlook: 'ok' });
        await assert.rejects(sendMeetingFollowup(msg, s), /Gmail rejected/);
        assert.deepEqual(calls.map((c) => c.who), ['gmail']);
        const o = senders({ gmail: 'off', outlook: 'fail' });
        await assert.rejects(sendMeetingFollowup(msg, o.s), /Outlook rejected/);
        assert.deepEqual(o.calls.map((c) => c.who), ['gmail', 'outlook']);
    }
    // 5. Small pieces.
    assert.equal(followupSentMessage('outlook', 1), 'Follow-up sent to 1 attendee from your Outlook.');
    assert.equal(followupSentMessage('gmail', 3), 'Follow-up sent to 3 attendees from your Gmail.');
    assert.deepEqual(outlookRecipients('a@x.com, b@y.com,'), [{ emailAddress: { address: 'a@x.com' } }, { emailAddress: { address: 'b@y.com' } }]);
    assert.deepEqual(outlookRecipients('solo@x.com'), [{ emailAddress: { address: 'solo@x.com' } }], 'one address unchanged');

    // 6. The payload carries the meeting, and no Reply-To / From-name for a sender that no longer exists.
    const subject = { recordType: 'meeting', recordId: 41, newStatus: 'MEETING_BOOKED', fields: {
        attendees: [{ name: 'Ana', email: 'ana@x.com' }], followupEmail: { subject: 'S', body: 'B' },
    } };
    const p = buildEmailPayload(subject as never, {});
    assert.equal(p.meetingRecordId, 41);
    assert.deepEqual(p.to, ['ana@x.com']);
    assert.ok(!('replyTo' in p) && !('assistantName' in p));

    // 7. Wiring.
    const sync = read('netlify/functions/sync-action.ts');
    const handler = sync.slice(sync.indexOf('async function handleEmailMeetingFollowup('), sync.indexOf('// ── PM task push:'));
    assert.ok(handler.includes('sendMeetingFollowup(') && handler.includes('outlook: (m) => sendOutlookMessage(db, organisationId, m)'));
    // Owner 2026-11-16: an approved follow-up goes out exactly as approved — no AI disclosure footer.
    assert.ok(!/injectAiFooter|aiDisclosureFooterText/.test(handler) && handler.includes('const finalBody = rawBody;'), 'no AI footer on an approved follow-up');
    assert.ok(!sync.includes("from '../../src/utils/ai-email-footer'"), 'sync-action no longer imports the footer');
    assert.ok(handler.includes('followupSentVia: sent.via') && handler.includes("['followupNotSent']"), 'stamped with the inbox; the not-sent flag cleared');
    assert.ok(handler.includes("followupNotSent: { reason: 'no_mailbox'") && handler.includes('return json(409, { error: err.message, code: err.code });'), 'no inbox → stamped not sent, 409');
    assert.ok(!/Resend|resend|FROM_DOMAIN|outbound\.bemoreswan/.test(sync), 'sync-action has no Be More Swan sender any more');
    const recs = read('netlify/functions/assistant-records.ts');
    assert.ok(recs.includes('await enqueueHandoffOnApproval(db, orgId, liveRecord);') && !recs.includes('approverEmail'));
    assert.ok(recs.includes('if (body.sendFollowup === true) {') && recs.includes("await enqueueHandoffOnApproval(db, orgId, m, ['email_meeting_followup']);"), 'Send the follow-up now queues the follow-up alone');
    assert.ok(recs.includes("if (!(await connectedMailbox(db, orgId))) return json(409, { error: NO_MAILBOX_MESSAGE, code: 'no_mailbox' });"));
    assert.ok(read('netlify/functions/process-scenario-jobs.ts').includes('if (!subject.onlyActions.includes(matches[i].scenario.actionType ?? \'\')) matches.splice(i, 1);'));
    assert.ok(read('src/utils/meeting-handoff-once.ts').includes("'followupNotSent'] as const;"), 'an Inbox save keeps the not-sent flag');
    const app = read('assistants.js');
    assert.ok(app.includes('function _rqMeetingFollowupSent(d)') && app.includes("const meetingSentLine = r.recordType === 'meeting' ? _rqMeetingFollowupSent(r.data || {}) : '';"));
    assert.ok(app.includes('function _rqMeetingFollowupNotSent(r)') && app.includes("_detailRqRecordAct(this,'sendFollowup')") && app.includes("if (action === 'sendFollowup') {"));
    assert.ok(app.includes('from your own Gmail or Outlook. With neither connected, it isn’t sent.'));

    console.log('meeting-followup-send: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
