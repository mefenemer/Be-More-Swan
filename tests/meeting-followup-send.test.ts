// Meeting Note Taker step 7: a meeting's follow-up goes from Gmail, then Outlook, then Be More Swan's
// address (docs/meeting-note-taker-finish-plan.md, owner decision 4). Run: npx tsx tests/meeting-followup-send.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IntegrationError } from '../src/utils/workspace-integrations';
import { followupSentMessage, resendFromLine, sendMeetingFollowup, type FollowupSenders } from '../src/utils/meeting-followup-send';
import { outlookRecipients } from '../src/utils/outlook';
import { buildEmailPayload } from '../src/utils/scenario-engine';

const read = (f: string) => readFileSync(f, 'utf8');
const notConnected = () => new IntegrationError('not_connected', 'not connected');

type Call = { who: string; m: unknown };
function senders(o: { gmail?: 'ok' | 'off' | 'fail'; outlook?: 'ok' | 'off' | 'fail'; resend?: 'ok' | 'fail' | null }): { s: FollowupSenders; calls: Call[] } {
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
        resend: o.resend === null ? null : async (m) => {
            calls.push({ who: 'resend', m });
            return o.resend === 'fail' ? { id: null, error: 'domain not verified' } : { id: 'r-1', error: null };
        },
        fromDomain: 'outbound.example.com',
    };
    return { s, calls };
}
const msg = { recipients: ['ana@x.com', 'bo@y.com'], subject: 'Thanks', body: 'Recap', businessName: 'Swan Cafe', replyTo: 'owner@swan.cafe' };

(async () => {
    // 1. Gmail connected → Gmail, nothing else tried.
    {
        const { s, calls } = senders({ gmail: 'ok', outlook: 'ok', resend: 'ok' });
        assert.deepEqual(await sendMeetingFollowup(msg, s), { via: 'gmail', id: 'g-1' });
        assert.deepEqual(calls, [{ who: 'gmail', m: { to: 'ana@x.com, bo@y.com', subject: 'Thanks', body: 'Recap' } }]);
    }
    // 2. Outlook-only workspace → its own Outlook, not Be More Swan's address.
    {
        const { s, calls } = senders({ gmail: 'off', outlook: 'ok', resend: 'ok' });
        assert.deepEqual(await sendMeetingFollowup(msg, s), { via: 'outlook', id: null });
        assert.deepEqual(calls.map((c) => c.who), ['gmail', 'outlook']);
        assert.deepEqual(calls[1].m, { to: 'ana@x.com, bo@y.com', subject: 'Thanks', body: 'Recap' });
    }
    // 3. No inbox → Resend: the business's name, our address, Reply-To the approver, every attendee.
    {
        const { s, calls } = senders({ gmail: 'off', outlook: 'off', resend: 'ok' });
        assert.deepEqual(await sendMeetingFollowup(msg, s), { via: 'resend', id: 'r-1' });
        assert.deepEqual(calls[2], { who: 'resend', m: {
            from: '"Swan Cafe" <assistant@outbound.example.com>', to: ['ana@x.com', 'bo@y.com'], subject: 'Thanks', text: 'Recap', replyTo: 'owner@swan.cafe',
        } });
        const again = senders({ gmail: 'off', outlook: 'off', resend: 'ok' });
        await sendMeetingFollowup({ ...msg, replyTo: null }, again.s);
        assert.ok(!('replyTo' in (again.calls[2].m as object)), 'no approver address → no Reply-To');
    }
    // 4. No inbox and no Resend key (local dev) → nothing sent.
    {
        const { s } = senders({ gmail: 'off', outlook: 'off', resend: null });
        assert.deepEqual(await sendMeetingFollowup(msg, s), { via: 'dev', id: null });
    }
    // 5. A connected inbox that REFUSES stops there: never a second copy from another account.
    {
        const { s, calls } = senders({ gmail: 'fail', outlook: 'ok', resend: 'ok' });
        await assert.rejects(sendMeetingFollowup(msg, s), /Gmail rejected/);
        assert.deepEqual(calls.map((c) => c.who), ['gmail']);
        const o = senders({ gmail: 'off', outlook: 'fail', resend: 'ok' });
        await assert.rejects(sendMeetingFollowup(msg, o.s), /Outlook rejected/);
        assert.deepEqual(o.calls.map((c) => c.who), ['gmail', 'outlook']);
        const r = senders({ gmail: 'off', outlook: 'off', resend: 'fail' });
        await assert.rejects(sendMeetingFollowup(msg, r.s), /could not be sent: domain not verified/);
    }

    // 6. Small pieces.
    assert.equal(resendFromLine('Bob\'s "Best" <Cafe>\r\n', 'd.com'), '"Bob\'s Best Cafe" <assistant@d.com>');
    assert.equal(resendFromLine('', 'd.com'), '"Your Be More Swan assistant" <assistant@d.com>');
    assert.equal(followupSentMessage('outlook', 1), 'Follow-up sent to 1 attendee from your Outlook.');
    assert.match(followupSentMessage('resend', 3), /^Follow-up sent to 3 attendees from Be More Swan’s address because no inbox is connected — replies come to you\. Connect Gmail or Outlook/);
    assert.deepEqual(outlookRecipients('a@x.com, b@y.com,'), [{ emailAddress: { address: 'a@x.com' } }, { emailAddress: { address: 'b@y.com' } }]);
    assert.deepEqual(outlookRecipients('solo@x.com'), [{ emailAddress: { address: 'solo@x.com' } }], 'one address unchanged');

    // 7. The payload carries the approver and the meeting.
    const subject = { recordType: 'meeting', recordId: 41, newStatus: 'MEETING_BOOKED', fields: {
        attendees: [{ name: 'Ana', email: 'ana@x.com' }], followupEmail: { subject: 'S', body: 'B' }, approverEmail: ' owner@swan.cafe ',
    } };
    const p = buildEmailPayload(subject as never, {});
    assert.equal(p.replyTo, 'owner@swan.cafe');
    assert.equal(p.meetingRecordId, 41);
    assert.equal(buildEmailPayload({ ...subject, fields: { ...subject.fields, approverEmail: 'nope' } } as never, {}).replyTo, null);

    // 8. Wiring.
    const sync = read('netlify/functions/sync-action.ts');
    const handler = sync.slice(sync.indexOf('async function handleEmailMeetingFollowup('), sync.indexOf('// ── PM task push:'));
    assert.ok(handler.includes('sendMeetingFollowup(') && handler.includes('outlook: (m) => sendOutlookMessage(db, organisationId, m)'));
    assert.ok(handler.includes('businessName: orgRow?.name'), 'the From name is the business');
    // Owner 2026-11-16: an approved follow-up goes out exactly as approved — no AI disclosure footer.
    assert.ok(!/injectAiFooter|aiDisclosureFooterText/.test(handler) && handler.includes('const finalBody = rawBody;'), 'no AI footer on an approved follow-up');
    assert.ok(!sync.includes("from '../../src/utils/ai-email-footer'"), 'sync-action no longer imports the footer');
    assert.ok(handler.includes('followupSentVia: sent.via'), 'the meeting is stamped with the route');
    assert.ok(!handler.includes('via Be More Swan <assistant@'), 'the old assistant-name From line is gone');
    const recs = read('netlify/functions/assistant-records.ts');
    assert.ok(recs.includes('await enqueueHandoffOnApproval(db, orgId, liveRecord, userId);') && recs.includes('approverEmail,'));
    const app = read('assistants.js');
    assert.ok(app.includes('function _rqMeetingFollowupSent(d)') && app.includes("const meetingSentLine = r.recordType === 'meeting' ? _rqMeetingFollowupSent(r.data || {}) : '';"));
    assert.ok(app.includes('otherwise from Be More Swan’s address with replies coming to you'));

    console.log('meeting-followup-send: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
