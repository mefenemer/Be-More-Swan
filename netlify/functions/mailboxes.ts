// netlify/functions/mailboxes.ts — the Email Assistant's Emails tab and its chat cards (docs/email-assistant-plan.md §5).
//
//   GET  /.netlify/functions/mailboxes                         → your mailboxes + sorted email (newest first)
//   GET  /.netlify/functions/mailboxes?mailboxId=&messageId=   → one email's text, fetched from the mailbox now, NOT stored
//        (Outlook or Gmail — src/utils/mail-reader/index.ts readerFor)
//   POST { action: 'recategorise', mailboxId, messageId, category }   → move it in OUR list (+ remember the sender)
//   POST { action: 'private_senders', mailboxId, add?, remove? }      → senders never sent to AI
//   POST { action: 'refresh', mailboxId }                             → read new mail now
//   POST { action: 'disconnect', mailboxId }                          → forget the token, DELETE everything stored
//   GET  ?mailboxId=&actions=1                                       → open drafts, recent actions, clean-up suggestions
//   POST { action: 'draft_reply', mailboxId, messageId, mode?, note? } → AI drafts a reply (changes nothing in the mailbox)
//   POST { action: 'edit_reply', mailboxId, actionId, body }          → the owner's own edit
//   POST { action: 'send_reply', mailboxId, actionId, body, how }     → how 'send' (in the thread) | 'drafts' (to the mailbox's Drafts)
//   POST { action: 'dismiss_reply', mailboxId, actionId }
//   POST { action: 'cleanup', mailboxId, op, messageIds, label, joinActionId? } → archive | trash, ≤ CLEANUP_CHUNK per call;
//        later chunks pass the first chunk's actionId so one batch is one entry
//   POST { action: 'undo_cleanup', mailboxId, actionId }              → back into the inbox, within UNDO_DAYS; ≤ UNDO_CHUNK per
//        call, `remaining` says how many are still out (call again until 0)
//   POST { action: 'add_rule', mailboxId, match, afterDays }          → archive from this sender after N days (never trash)
//   POST { action: 'remove_rule', mailboxId, match }
//   POST { action: 'set_labels', mailboxId, on }                      → write categories into the mailbox, or stop (and clear ours)
//   POST { action: 'unsubscribe', mailboxId, messageId }              → RFC 8058 one-click, else the sender's own link to open
//
// ⚠️ Only the mailbox's OWNER sees its email — not the workspace owner, not admins. An admin viewing
// through impersonation sees that a mailbox exists and its counts, never a subject or sender
// (mailboxAccess). Phase 1 writes nothing to the mailbox itself: "recategorise" changes our list only.
// The GUI and the chat cards call exactly these actions (plan §5.2).

import { withLambda } from '@netlify/aws-lambda-compat';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { mailboxMessages, mailboxes } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { isFeatureEnabled } from '../../src/utils/feature-flags';
import {
    EMAIL_ASSISTANT_FLAG, MailboxError, disconnectMailbox, getMailboxAccessToken, getOwnMailbox, listOwnMailboxes,
    mailboxAccess, parseMailboxSettings, gmailMailboxConfigured, labelsOn,
} from '../../src/utils/mailboxes';
import { DEFAULT_CATEGORIES, PRIORITY_LABELS, categoryLabel } from '../../src/utils/email-sort';
import { readerFor } from '../../src/utils/mail-reader';
import { writerFor } from '../../src/utils/mail-writer';
import { oneClickUnsubscribe, parseListUnsubscribe } from '../../src/utils/one-click-unsubscribe';
import { providerName, triggerMailboxSync } from '../../src/utils/mailbox-sync';
import { resolveNowNotification } from '../../src/utils/mailbox-notify';
import { stopWatch } from '../../src/utils/mailbox-push';
import {
    ActionError, applyCleanup, cleanupSuggestions, dismissReply, draftGaps, draftReply, editReply, listActions, sendReply, undoCleanup,
    CLEANUP_CHUNK, UNDO_DAYS, type DraftMode,
} from '../../src/utils/mailbox-actions';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const MESSAGE_LIMIT = 300;
const CATEGORY_KEYS = new Set(DEFAULT_CATEGORIES.map((c) => c.key));

/** A sender entry the user typed: an address or an @domain. Pure. */
export function normaliseSenderEntry(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const s = raw.trim().toLowerCase();
    if (/^@[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return s;
    if (/^[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return s;
    return null;
}

/** The mailbox card for the page: status and counts, nothing from any email. Pure. */
export function mailboxCard(m: typeof mailboxes.$inferSelect, counts: { total: number; pending: number; needsYou: number }) {
    return {
        id: m.id, provider: m.provider, address: m.address, kind: m.kind, status: m.status,
        lastSyncAt: m.lastSyncAt, lastError: m.lastError, ...counts,
    };
}

export default withLambda(async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const available = await isFeatureEnabled(ctx.organisationId, EMAIL_ASSISTANT_FLAG);
    if (!available) return json(200, { available: false, mailboxes: [], messages: [] });
    // Which providers this site can connect: Gmail only once the mail project's client is configured.
    const providers = { outlook: Boolean(process.env.OUTLOOK_CLIENT_ID), gmail: gmailMailboxConfigured() };
    const access = mailboxAccess(ctx);

    if (event.httpMethod === 'GET') {
        const qp = event.queryStringParameters ?? {};
        const own = await listOwnMailboxes(db, ctx.organisationId, ctx.userId);

        // ── Drafts, recent actions and clean-up suggestions for one mailbox ──
        if (qp.mailboxId && qp.actions === '1') {
            if (access !== 'owner') return json(403, { error: 'Only the mailbox owner can see this.' });
            const box = own.find((b) => b.id === Number(qp.mailboxId));
            if (!box) return json(404, { error: 'Mailbox not found.' });
            const [actions, cleanup] = await Promise.all([listActions(db, box.id), cleanupSuggestions(db, box)]);
            const st = parseMailboxSettings(box.settings);
            return json(200, {
                undoDays: UNDO_DAYS, cleanupChunk: CLEANUP_CHUNK, cleanup,
                archiveRules: st.archiveRules, labelsOn: labelsOn(box.kind, st),
                actions: actions.map((a) => ({
                    id: a.id, kind: a.kind, status: a.status, messageId: a.messageId, actedAt: a.actedAt, updatedAt: a.updatedAt,
                    result: a.result,
                    ...(a.kind === 'reply'
                        ? (() => { const p = a.payload as { to?: string; subject?: string; body?: string }; return { to: p.to, subject: p.subject, body: p.body, gaps: draftGaps(p.body ?? '') }; })()
                        : (() => { const p = a.payload as { op?: string; label?: string; items?: unknown[]; failed?: number }; return { op: p.op, label: p.label, count: (p.items ?? []).length, failed: p.failed ?? 0 }; })()),
                })),
            });
        }

        // ── One email's text ──
        if (qp.mailboxId && qp.messageId) {
            if (access !== 'owner') return json(403, { error: 'Email content is only shown to the mailbox owner.' });
            const box = own.find((b) => b.id === Number(qp.mailboxId));
            if (!box) return json(404, { error: 'Mailbox not found.' });
            const [msg] = await db.select().from(mailboxMessages)
                .where(and(eq(mailboxMessages.id, Number(qp.messageId)), eq(mailboxMessages.mailboxId, box.id))).limit(1);
            if (!msg) return json(404, { error: 'Email not found.' });
            try {
                const reader = readerFor(box.provider);
                if (!reader) return json(400, { error: 'This kind of mailbox can\'t be read.' });
                const token = await getMailboxAccessToken(db, box);
                const body = await reader.getBody(token, msg.providerMessageId);
                // Returned to the owner's browser only. Not written anywhere; not logged.
                return json(200, { text: body.text.slice(0, 50_000), to: body.to, webLink: msg.webLink });
            } catch (err) {
                if (err instanceof MailboxError) return json(err.status, { error: err.message, code: err.code });
                return json(502, { error: `${providerName(box.provider)} did not return this email. Open it in ${providerName(box.provider)} instead.`, webLink: msg.webLink });
            }
        }

        // ── The list ──
        const ids = own.map((b) => b.id);
        const countRows = ids.length ? await db.select({
            mailboxId: mailboxMessages.mailboxId,
            total: sql<number>`count(*)::int`,
            pending: sql<number>`count(*) FILTER (WHERE ${mailboxMessages.sortedBy} = 'pending')::int`,
            needsYou: sql<number>`count(*) FILTER (WHERE ${mailboxMessages.priority} IN ('now','today'))::int`,
            withoutAi: sql<number>`count(*) FILTER (WHERE ${mailboxMessages.sortedBy} IN ('headers','sender_rule','user','private'))::int`,
        }).from(mailboxMessages)
            .where(and(sql`${mailboxMessages.mailboxId} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`, isNull(mailboxMessages.removedAt)))
            .groupBy(mailboxMessages.mailboxId) : [];
        const countBy = new Map(countRows.map((r) => [r.mailboxId, r]));
        const cards = own.map((m) => mailboxCard(m, {
            total: countBy.get(m.id)?.total ?? 0, pending: countBy.get(m.id)?.pending ?? 0, needsYou: countBy.get(m.id)?.needsYou ?? 0,
        }));
        // The Results cards (assistants.js _loadMailboxMetrics): counts only, across the caller's mailboxes.
        const sum = (k: 'total' | 'pending' | 'needsYou' | 'withoutAi') => countRows.reduce((n, r) => n + (r[k] ?? 0), 0);
        const stats = {
            needsYou: sum('needsYou'), sorted: sum('total') - sum('pending'), sortedWithoutAi: sum('withoutAi'),
            privateSenders: own.reduce((n, b) => n + parseMailboxSettings(b.settings).privateSenders.length, 0),
        };

        if (access !== 'owner') return json(200, { available, access, providers, mailboxes: cards, stats, messages: [] });
        // The owner opened the Emails tab (seen=1 — the Results cards' load doesn't send it): the
        // "needs you now" card has done its job.
        if (qp.seen === '1' && !qp.mailboxId) await resolveNowNotification(db, ctx.userId);

        const wanted = qp.mailboxId ? own.filter((b) => b.id === Number(qp.mailboxId)) : own;
        const rows = wanted.length ? await db.select({
            id: mailboxMessages.id, mailboxId: mailboxMessages.mailboxId, fromName: mailboxMessages.fromName,
            fromAddress: mailboxMessages.fromAddress, subject: mailboxMessages.subject, receivedAt: mailboxMessages.receivedAt,
            isRead: mailboxMessages.isRead, webLink: mailboxMessages.webLink, category: mailboxMessages.category,
            priority: mailboxMessages.priority, summary: mailboxMessages.summary, reason: mailboxMessages.reason, sortedBy: mailboxMessages.sortedBy,
        }).from(mailboxMessages)
            .where(and(sql`${mailboxMessages.mailboxId} IN (${sql.join(wanted.map((b) => sql`${b.id}`), sql`, `)})`, isNull(mailboxMessages.removedAt)))
            .orderBy(desc(mailboxMessages.receivedAt)).limit(MESSAGE_LIMIT) : [];
        const privateSenders = Object.fromEntries(own.map((b) => [b.id, parseMailboxSettings(b.settings).privateSenders]));
        return json(200, {
            available, access, providers, mailboxes: cards, stats, privateSenders,
            categories: [...DEFAULT_CATEGORIES.map((c) => ({ key: c.key, label: c.label })), { key: 'private', label: categoryLabel('private') }],
            priorities: PRIORITY_LABELS,
            messages: rows,
        });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
    if (access !== 'owner') return json(403, { error: 'Only the mailbox owner can change it.' });
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
    const box = await getOwnMailbox(db, ctx.organisationId, ctx.userId, Number(body.mailboxId));
    if (!box) return json(404, { error: 'Mailbox not found.' });

    if (body.action === 'disconnect') {
        // Stop push first, while the token still works (a Google revoke ends a Gmail watch anyway).
        await stopWatch(db, box);
        await disconnectMailbox(db, ctx.organisationId, ctx.userId, box.id);
        return json(200, {
            ok: true,
            message: box.provider === 'gmail'
                ? `Disconnected ${box.address}. Everything Be More Swan stored from it has been deleted, and its access to your Google account has been removed.`
                : `Disconnected ${box.address}. Everything Be More Swan stored from it has been deleted. To remove the app from your Microsoft account as well, go to myapps.microsoft.com (work accounts) or account.live.com/consent/Manage (Outlook.com).`,
        });
    }

    if (body.action === 'refresh') {
        const ok = await triggerMailboxSync(box.id);
        return json(ok ? 200 : 503, ok ? { ok: true, message: 'Reading new mail now. New emails appear here in a minute or two.' } : { error: 'Could not start reading right now. It runs by itself every 10 minutes.' });
    }

    if (body.action === 'recategorise') {
        const category = String(body.category ?? '');
        if (!CATEGORY_KEYS.has(category)) return json(400, { error: 'Unknown category.' });
        const [msg] = await db.select({ id: mailboxMessages.id, fromAddress: mailboxMessages.fromAddress }).from(mailboxMessages)
            .where(and(eq(mailboxMessages.id, Number(body.messageId)), eq(mailboxMessages.mailboxId, box.id))).limit(1);
        if (!msg) return json(404, { error: 'Email not found.' });
        await db.update(mailboxMessages).set({ category, sortedBy: 'user', updatedAt: new Date() }).where(eq(mailboxMessages.id, msg.id));
        // The label in the mailbox follows (best effort: our list is the truth, a failed label never undoes the move).
        if (labelsOn(box.kind, parseMailboxSettings(box.settings))) {
            const writer = writerFor(box.provider);
            const [pm] = await db.select({ pid: mailboxMessages.providerMessageId }).from(mailboxMessages).where(eq(mailboxMessages.id, msg.id)).limit(1);
            if (writer && pm) await getMailboxAccessToken(db, box).then((t) => writer.labeller(t).set(pm.pid, categoryLabel(category))).catch(() => undefined);
        }
        // Remember the sender, so their next email sorts the same way without AI (plan §2.1).
        let remembered: string | null = null;
        if (body.remember !== false && msg.fromAddress) {
            const settings = parseMailboxSettings(box.settings);
            settings.senderRules[msg.fromAddress.toLowerCase()] = category;
            await db.update(mailboxes).set({ settings: { ...(box.settings as object), senderRules: settings.senderRules }, updatedAt: new Date() }).where(eq(mailboxes.id, box.id));
            remembered = msg.fromAddress;
        }
        return json(200, { ok: true, category, remembered, message: `Moved to ${categoryLabel(category)}.${remembered ? ` New emails from ${remembered} will go there too.` : ''}` });
    }

    if (body.action === 'private_senders') {
        const settings = parseMailboxSettings(box.settings);
        const set = new Set(settings.privateSenders);
        const add = normaliseSenderEntry(body.add);
        const remove = normaliseSenderEntry(body.remove);
        if (body.add !== undefined && !add) return json(400, { error: 'Enter an email address, or @ and a domain (like @mydoctor.co.uk).' });
        if (add) set.add(add);
        if (remove) set.delete(remove);
        const privateSenders = [...set].slice(0, 200);
        await db.update(mailboxes).set({ settings: { ...(box.settings as object), privateSenders }, updatedAt: new Date() }).where(eq(mailboxes.id, box.id));
        // Email already sorted from a newly private sender keeps its category but loses its AI summary.
        if (add) {
            const match = add.startsWith('@')
                ? sql`lower(${mailboxMessages.fromAddress}) LIKE ${'%' + add}`
                : sql`lower(${mailboxMessages.fromAddress}) = ${add}`;
            await db.update(mailboxMessages).set({ category: 'private', summary: null, reason: 'You marked this sender as private.', sortedBy: 'private', updatedAt: new Date() })
                .where(and(eq(mailboxMessages.mailboxId, box.id), match));
        }
        return json(200, { ok: true, privateSenders, message: add ? `Emails from ${add} will never be sent to AI. Earlier summaries of them are deleted.` : 'Updated.' });
    }

    // ── Phase 2b: rules, labels, unsubscribe ──
    if (body.action === 'add_rule' || body.action === 'remove_rule') {
        const match = normaliseSenderEntry(body.match);
        if (!match) return json(400, { error: 'Enter an email address, or @ and a domain (like @stripe.com).' });
        const st = parseMailboxSettings(box.settings);
        let rules = st.archiveRules.filter((r) => r.match !== match);
        if (body.action === 'add_rule') {
            const afterDays = Math.round(Number(body.afterDays));
            if (!Number.isFinite(afterDays) || afterDays < 0 || afterDays > 365) return json(400, { error: 'Choose between 0 and 365 days.' });
            rules = [...rules, { match, afterDays }].slice(-50);
        }
        await db.update(mailboxes).set({ settings: { ...(box.settings as object), archiveRules: rules }, updatedAt: new Date() }).where(eq(mailboxes.id, box.id));
        return json(200, { ok: true, archiveRules: rules, message: body.action === 'add_rule'
            ? `Rule saved: email from ${match} is archived ${Number(body.afterDays) === 0 ? 'as it arrives' : `once it is ${Math.round(Number(body.afterDays))} day${Math.round(Number(body.afterDays)) === 1 ? '' : 's'} old`}. It is never deleted, and each run can be undone from Done.`
            : `Rule removed: email from ${match} stays in your inbox.` });
    }
    if (body.action === 'set_labels') {
        const on = body.on === true;
        await db.update(mailboxes).set({ settings: { ...(box.settings as object), writeLabels: on }, updatedAt: new Date() }).where(eq(mailboxes.id, box.id));
        return json(200, { ok: true, labelsOn: on, message: on
            ? `New emails will show their category in ${providerName(box.provider)} as well.`
            : `Categories are no longer written into ${providerName(box.provider)}. Labels already there stay until you remove them.` });
    }
    if (body.action === 'unsubscribe') {
        const [msg] = await db.select().from(mailboxMessages)
            .where(and(eq(mailboxMessages.id, Number(body.messageId)), eq(mailboxMessages.mailboxId, box.id))).limit(1);
        if (!msg) return json(404, { error: 'Email not found.' });
        const reader = readerFor(box.provider);
        if (!reader) return json(400, { error: 'This kind of mailbox can\'t be read.' });
        const headers = await getMailboxAccessToken(db, box).then((t) => reader.getHeaders(t, msg.providerMessageId)).catch(() => null);
        if (!headers) return json(502, { error: `${providerName(box.provider)} didn't return this email. Try again in a moment.` });
        const opts = parseListUnsubscribe(headers);
        if (!opts.oneClickUrl) {
            // No one-click: we call nothing. The owner gets the sender's own link (or address) to use themselves.
            return json(200, { ok: false, manual: true, webUrl: opts.webUrl, mailto: opts.mailto,
                message: opts.webUrl || opts.mailto ? 'This sender doesn\'t offer one-click unsubscribe. Use their own unsubscribe link below.' : 'This email has no unsubscribe link. You could ask the sender, or archive their email with a rule.' });
        }
        const r = await oneClickUnsubscribe(opts.oneClickUrl);
        return json(r.ok ? 200 : 502, r.ok
            ? { ok: true, message: `Unsubscribed from ${msg.fromName || msg.fromAddress || 'this sender'}. It can take a few days for their emails to stop.` }
            : { ok: false, error: r.reason === 'unsafe_url' ? 'That unsubscribe link doesn\'t look safe, so it wasn\'t used.' : 'The sender didn\'t accept the unsubscribe. Try their own link instead.', webUrl: opts.webUrl });
    }

    // ── Phase 2a: replies and clean-up — each one pressed (and confirmed) by the owner ──
    try {
        if (body.action === 'draft_reply') {
            const mode = (['new', 'shorter', 'longer', 'redraft'] as const).includes(body.mode as DraftMode) ? body.mode as DraftMode : 'new';
            const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 600) : null;
            const a = await draftReply(db, box, Number(body.messageId), mode, note);
            const p = a.payload as { to: string; subject: string; body: string };
            return json(200, { ok: true, actionId: a.id, to: p.to, subject: p.subject, body: p.body, gaps: draftGaps(p.body) });
        }
        if (body.action === 'edit_reply') {
            const a = await editReply(db, box, Number(body.actionId), String(body.body ?? ''));
            return json(200, { ok: true, gaps: draftGaps((a.payload as { body: string }).body) });
        }
        if (body.action === 'send_reply') {
            const how = body.how === 'drafts' ? 'drafts' : 'send';
            const a = await sendReply(db, box, Number(body.actionId), String(body.body ?? ''), how);
            const to = (a.payload as { to: string }).to;
            return json(200, { ok: true, message: how === 'send' ? `Sent to ${to}, in the same conversation.` : `Saved to your ${providerName(box.provider)} drafts. Nothing has been sent.` });
        }
        if (body.action === 'dismiss_reply') {
            await dismissReply(db, box, Number(body.actionId));
            return json(200, { ok: true, message: 'Draft thrown away. Nothing was sent.' });
        }
        if (body.action === 'cleanup') {
            const ids = Array.isArray(body.messageIds) ? (body.messageIds as unknown[]).map(Number) : [];
            const op = body.op === 'trash' ? 'trash' : 'archive';
            // Later chunks of one batch join the first chunk's entry, so the Done list shows ONE clean-up with one Undo.
            const joinActionId = Number.isInteger(Number(body.joinActionId)) && Number(body.joinActionId) > 0 ? Number(body.joinActionId) : null;
            const r = await applyCleanup(db, box, op, ids, String(body.label ?? ''), joinActionId);
            const verb = op === 'trash' ? 'Moved to trash' : 'Archived';
            return json(200, { ok: true, actionId: r.action.id, moved: r.moved, failed: r.failed,
                message: `${verb}: ${r.moved}.${r.failed ? ` ${r.failed} could not be moved.` : ''} You can undo this for ${UNDO_DAYS} days.` });
        }
        if (body.action === 'undo_cleanup') {
            const r = await undoCleanup(db, box, Number(body.actionId));
            return json(200, { ok: true, restored: r.restored, failed: r.failed, remaining: r.remaining,
                message: `Put back in your inbox: ${r.restored}.${r.failed ? ` ${r.failed} could not be put back.` : ''}` });
        }
    } catch (err) {
        if (err instanceof ActionError) return json(err.status, { error: err.message, code: err.code });
        if (err instanceof MailboxError) return json(err.status, { error: err.message, code: err.code });
        console.error('[mailboxes] action failed', { action: body.action, err: err instanceof Error ? err.message : err });
        return json(500, { error: 'That didn\'t work. Please try again.' });
    }

    return json(400, { error: 'Unknown action.' });
});
