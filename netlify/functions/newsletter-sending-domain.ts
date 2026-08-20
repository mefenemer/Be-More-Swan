// netlify/functions/newsletter-sending-domain.ts
// The tenant's sending-domain setup — register a subdomain, show the DNS records, re-check.
// Org-scoped via requireTenant, owner/admin only: this changes what the world sees as the sender.
//
//   GET                        → the org's sending domains and their DNS records
//   POST { action: 'create' }  → register a domain with the provider, store the records to add
//   POST { action: 'check' }   → ask the provider to re-verify DNS
//   POST { action: 'update' }  → from name / mailbox / reply-to
//   POST { action: 'remove' }  → delete it (provider-side too, best effort)

import { HandlerEvent } from '@netlify/functions';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { newsletterSendingDomains, newsletterSends, organisations } from '../../db/schema';
import {
    checkSendingDomain, createSendingDomain, deleteSendingDomain, isSubdomain, normaliseSendingDomain,
} from '../../src/utils/sending-domain';
import { requireTenant } from '../../src/utils/tenant';
import { listHealthFindings, warmupLimitFor } from '../../src/utils/deliverability';
import { checkDmarc, dmarcAdvice } from '../../src/utils/dmarc-check';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, obj: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
});

const ROLES = ['owner', 'admin'];

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();

    // ── Deliverability: what we actually know, and nothing we do not ────────
    // ⚠️ A GET, and readable by ANY role in the org rather than owner/admin. It is a report about
    // mail that has already gone out — the person who would act on "2.1% of your emails bounced" is
    // often the one writing the issues, not the one who owns the billing.
    if (event.httpMethod === 'GET' && event.queryStringParameters?.action === 'health') {
        const ctx = await requireTenant(event, db);
        if ('error' in ctx) return ctx.error;
        const orgId = ctx.organisationId;

        const [domain] = await db.select().from(newsletterSendingDomains)
            .where(eq(newsletterSendingDomains.organisationId, orgId))
            .orderBy(desc(newsletterSendingDomains.createdAt))
            .limit(1);

        // Recent outcomes across the org's sends. ⚠️ Counted from the LEDGER rather than from the
        // issue counters: a counter is denormalised and can drift, and this is the number a tenant
        // would act on by deleting part of their list.
        const [totals] = await db
            .select({
                delivered: sql<number>`count(*) FILTER (WHERE ${newsletterSends.status} IN ('sent','delivered'))::int`,
                bounced: sql<number>`count(*) FILTER (WHERE ${newsletterSends.status} = 'bounced')::int`,
                complained: sql<number>`count(*) FILTER (WHERE ${newsletterSends.status} = 'complained')::int`,
            })
            .from(newsletterSends)
            .where(and(
                eq(newsletterSends.organisationId, orgId),
                sql`${newsletterSends.createdAt} >= ${new Date(Date.now() - 90 * 86400000).toISOString()}`,
            ));

        const findings = listHealthFindings({
            delivered: Number(totals?.delivered ?? 0),
            bounced: Number(totals?.bounced ?? 0),
            complained: Number(totals?.complained ?? 0),
        });

        // The DNS half. Only meaningful once a domain exists; a mailbox sender has nothing to check.
        const dmarc = domain?.domain ? await checkDmarc(domain.domain) : null;

        return json(200, {
            listHealth: findings,
            dmarc: dmarc ? { ...dmarc, advice: dmarcAdvice(dmarc) } : null,
            domain: domain ? { domain: domain.domain, status: domain.status, verifiedAt: domain.verifiedAt } : null,
            warmupLimit: domain?.status === 'verified' ? warmupLimitFor(domain.verifiedAt) : null,
            window: 'the last 90 days',
        });
    }

    if (event.httpMethod === 'GET') {
        const ctx = await requireTenant(event, db);
        if ('error' in ctx) return ctx.error;
        try {
            const domains = await db.select().from(newsletterSendingDomains)
                .where(eq(newsletterSendingDomains.organisationId, ctx.organisationId))
                .orderBy(desc(newsletterSendingDomains.createdAt));
            return json(200, { domains });
        } catch (err) {
            const code = (err as { code?: string; cause?: { code?: string } })?.code
                ?? (err as { cause?: { code?: string } })?.cause?.code;
            if (code !== '42P01') throw err;
            return json(200, { domains: [], needsSetup: true });
        }
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const ctx = await requireTenant(event, db, { roles: ROLES });
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    let body: any;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON body.' }); }
    const action = String(body.action || '');

    if (action === 'create') {
        const domain = normaliseSendingDomain(body.domain);
        if (!domain) return json(400, { error: 'Enter a domain like mail.yourbusiness.com' });

        const res = await createSendingDomain(domain);
        if (!res.ok) {
            // An operator error is OUR misconfiguration and the tenant can do nothing about it —
            // it must not be presented to them as "your domain failed".
            return json(res.operatorError ? 503 : 400, { error: res.error, operatorError: !!res.operatorError });
        }

        const [org] = await db.select({ name: organisations.name }).from(organisations)
            .where(eq(organisations.id, orgId)).limit(1);

        const [row] = await db.insert(newsletterSendingDomains).values({
            organisationId: orgId,
            domain,
            providerDomainId: res.providerDomainId || null,
            status: res.status ?? 'pending',
            dnsRecords: res.records ?? [],
            fromName: org?.name || null,
            createdBy: ctx.userId,
        }).onConflictDoUpdate({
            target: [newsletterSendingDomains.organisationId, newsletterSendingDomains.domain],
            set: {
                providerDomainId: res.providerDomainId || null,
                status: res.status ?? 'pending',
                dnsRecords: res.records ?? [],
                updatedAt: new Date(),
            },
        }).returning();

        // Warned, not blocked: plenty of small businesses genuinely want their root domain, but
        // they should know that a bad campaign then reaches the domain their invoices come from.
        return json(200, { domain: row, warning: isSubdomain(domain) ? null : 'Sending from your root domain means a delivery problem here can affect your everyday business email. A subdomain such as mail.' + domain + ' keeps them apart.' });
    }

    const id = Number(body.id || '');
    if (!Number.isFinite(id) || !id) return json(400, { error: 'Invalid domain.' });

    const [existing] = await db.select().from(newsletterSendingDomains)
        .where(and(eq(newsletterSendingDomains.id, id), eq(newsletterSendingDomains.organisationId, orgId)))
        .limit(1);
    if (!existing) return json(404, { error: 'Domain not found.' });

    if (action === 'check') {
        const res = await checkSendingDomain(existing.providerDomainId || '');
        if (!res.ok) {
            await db.update(newsletterSendingDomains)
                .set({ lastCheckedAt: new Date(), updatedAt: new Date() })
                .where(eq(newsletterSendingDomains.id, id));
            return json(res.operatorError ? 503 : 400, { error: res.error, operatorError: !!res.operatorError });
        }
        const verified = res.status === 'verified';
        const [row] = await db.update(newsletterSendingDomains).set({
            status: res.status ?? 'pending',
            // Records are refreshed on every check: a provider can rotate a DKIM selector, and a
            // stale record on screen sends the tenant chasing DNS that no longer matters.
            dnsRecords: res.records?.length ? res.records : existing.dnsRecords,
            lastCheckedAt: new Date(),
            verifiedAt: verified ? (existing.verifiedAt ?? new Date()) : null,
            updatedAt: new Date(),
        }).where(eq(newsletterSendingDomains.id, id)).returning();
        return json(200, { domain: row, verified });
    }

    if (action === 'update') {
        const patch: Record<string, unknown> = { updatedAt: new Date() };
        if ('fromName' in body) patch.fromName = String(body.fromName || '').replace(/["<>\r\n]/g, '').slice(0, 60).trim() || null;
        if ('fromLocalPart' in body) {
            const local = String(body.fromLocalPart || '').replace(/[^a-z0-9._-]/gi, '').slice(0, 40);
            if (!local) return json(400, { error: 'The mailbox part can only contain letters, numbers, dots, dashes and underscores.' });
            patch.fromLocalPart = local;
        }
        if ('replyTo' in body) {
            const reply = String(body.replyTo || '').trim().slice(0, 200);
            if (reply && !reply.includes('@')) return json(400, { error: 'Reply-to must be an email address.' });
            patch.replyTo = reply || null;
        }
        const [row] = await db.update(newsletterSendingDomains).set(patch)
            .where(eq(newsletterSendingDomains.id, id)).returning();
        return json(200, { domain: row });
    }

    if (action === 'remove') {
        await deleteSendingDomain(existing.providerDomainId || '');
        await db.delete(newsletterSendingDomains).where(and(
            eq(newsletterSendingDomains.id, id),
            eq(newsletterSendingDomains.organisationId, orgId),
        ));
        // Says what it costs them: without a verified domain the org drops to the mailbox route.
        return json(200, { removed: true, note: 'Removed. New issues will fall back to sending from your connected mailbox, which is capped at a small list.' });
    }

    return json(400, { error: `Unknown action: ${action}` });
});
