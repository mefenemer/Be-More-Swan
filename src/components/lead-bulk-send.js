// src/components/lead-bulk-send.js
// Approve and send several leads' outreach emails in one go — the Outreach tab's "Approve & send"
// bar (assistants.js) and the Lead Generation chat's "approve all" card (chat-session.js) both
// call this, so the two cannot disagree about what is allowed to go out.
//
// ── One lead at a time, through the single-lead path ─────────────────────────
// Nothing new on the server. Each lead goes through exactly what the chat's one-lead card does:
//   1. send_outreach with checkOnly — every gate, changing nothing;
//   2. the assistant-records PATCH that approves it (so lead_approved and the CRM hand-off fire);
//   3. send_outreach for real.
// Sequential on purpose: each send is a real email from the user's own inbox, the task allowance
// is checked per send, and a workspace-level refusal (no inbox, no postal address, allowance used
// up) must stop the run before it is repeated twenty times.
//
// ── What a bulk run never does ───────────────────────────────────────────────
// It never confirms a named person's inbox and never overrules a do-not-contact flag. Both need a
// per-lead decision — the single Approve button asks for it — so those leads are SKIPPED, left
// exactly where they were, and listed back so the user can deal with each on its own.
(function () {
    'use strict';

    // Reasons that are about the WORKSPACE, not the lead: the next lead would get the same answer.
    const STOP_REASONS = new Set(['no_provider', 'not_connected', 'no_postal_address', 'task_limit', 'suppression_check_failed']);

    const WHY = {
        no_provider: 'No inbox is set up to send from. Connect Gmail or Outlook on the Outreach tab.',
        not_connected: 'Your sending inbox isn’t connected any more. Reconnect it on the Outreach tab.',
        no_postal_address: 'Add your business postal address in Business Information — anti-spam law requires one in every outreach email.',
        task_limit: 'Your monthly task allowance is used up. It resets on the 1st of the month.',
        suppression_check_failed: 'Your suppression list couldn’t be checked just now, and nothing is emailed without checking. Try again shortly.',
        draft_changed: 'its email was edited after you chose it',
        personal_inbox_unconfirmed: 'the address looks like a named person’s own inbox — approve it on its own to confirm',
        do_not_contact: 'it’s flagged do-not-contact',
        no_recipient: 'there’s no email address on it',
        suppressed: 'the company is on your suppression list',
        unsubscribed: 'they’ve unsubscribed from your emails',
        paused: 'they’ve paused emails from you',
        generator_declined: 'an email couldn’t honestly be written for it',
    };
    const why = (r) => WHY[r && r.reason] || (r && r.detail) || `not sent (${String((r && r.reason) || 'unknown').replace(/_/g, ' ')})`;

    async function call(fn, method, body) {
        const res = await fetch(`/.netlify/functions/${fn}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `That didn’t work (HTTP ${res.status}).`);
        return data;
    }

    /**
     * @param {{ assistantId: number, items: Array<{ recordId: number, title?: string, approveFirst?: boolean, draftHash?: string|null }>,
     *           onProgress?: (done: number, total: number) => void }} opts
     * @returns {Promise<{ sent: Array<{recordId:number,title:string,to:string}>, skipped: Array<{recordId:number,title:string,why:string,approved:boolean}>,
     *           stopped: { why: string, approvedUnsent: boolean } | null }>}
     */
    async function run(opts) {
        const items = (opts && Array.isArray(opts.items)) ? opts.items : [];
        const out = { sent: [], skipped: [], stopped: null };
        let done = 0;
        for (const it of items) {
            const title = it.title || `#${it.recordId}`;
            const sendBody = {
                action: 'send_outreach', assistantId: opts.assistantId, recordId: it.recordId,
                ...(it.draftHash ? { expectDraftHash: it.draftHash } : {}),
            };
            try {
                const check = await call('lead-generation', 'POST', { ...sendBody, checkOnly: true });
                if (!check.ready) {
                    if (STOP_REASONS.has(check.reason)) { out.stopped = { why: why(check), approvedUnsent: false }; break; }
                    out.skipped.push({ recordId: it.recordId, title, why: why(check), approved: false });
                    continue;
                }
                if (it.approveFirst !== false) {
                    await call('assistant-records', 'PATCH', { id: it.recordId, approvalStatus: 'approved' });
                }
                const r = await call('lead-generation', 'POST', sendBody);
                if (r.sent) {
                    out.sent.push({ recordId: it.recordId, title, to: r.to });
                } else if (STOP_REASONS.has(r.reason)) {
                    out.skipped.push({ recordId: it.recordId, title, why: why(r), approved: true });
                    out.stopped = { why: why(r), approvedUnsent: true };
                    break;
                } else {
                    out.skipped.push({ recordId: it.recordId, title, why: why(r), approved: true });
                }
            } catch (err) {
                out.skipped.push({ recordId: it.recordId, title, why: (err && err.message) || 'something went wrong', approved: false });
            } finally {
                done += 1;
                if (typeof opts.onProgress === 'function') opts.onProgress(done, items.length);
            }
        }
        return out;
    }

    /** One plain-English summary of a run, for a toast or a card's status line. */
    function summarise(result) {
        const n = result.sent.length;
        const parts = [n ? `Sent ${n} email${n === 1 ? '' : 's'}.` : 'Nothing was sent.'];
        if (result.stopped) parts.push(`Stopped: ${result.stopped.why}`);
        if (result.skipped.length) {
            const left = result.skipped.map((s) => `${s.title} — ${s.why}${s.approved ? ' (approved, not sent)' : ''}`);
            parts.push(`Skipped ${result.skipped.length}: ${left.join('; ')}.`);
        }
        return parts.join(' ');
    }

    window.LeadBulkSend = { run, summarise, STOP_REASONS };
})();
