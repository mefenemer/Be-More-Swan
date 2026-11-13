// netlify/functions/mailboxes.ts — the Email Assistant's Emails tab and its chat cards (docs/email-assistant-plan.md §5).
//
//   GET  /.netlify/functions/mailboxes                         → your mailboxes + sorted email (newest first)
//   GET  /.netlify/functions/mailboxes?mailboxId=&messageId=   → one email's text, fetched from the mailbox now, NOT stored
//        (Outlook or Gmail — src/utils/mail-reader/index.ts readerFor)
//   POST { action: 'recategorise', mailboxId, messageId, category }   → move it in OUR list (+ remember the sender)
//   POST { action: 'private_senders', mailboxId, add?, remove? }      → senders never sent to AI
//   POST { action: 'refresh', mailboxId }                             → read new mail now
//   POST { action: 'disconnect', mailboxId }                          → forget the token, DELETE everything stored
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
    mailboxAccess, parseMailboxSettings, gmailMailboxConfigured,
} from '../../src/utils/mailboxes';
import { DEFAULT_CATEGORIES, PRIORITY_LABELS, categoryLabel } from '../../src/utils/email-sort';
import { readerFor } from '../../src/utils/mail-reader';
import { providerName, triggerMailboxSync } from '../../src/utils/mailbox-sync';

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

    return json(400, { error: 'Unknown action.' });
});
