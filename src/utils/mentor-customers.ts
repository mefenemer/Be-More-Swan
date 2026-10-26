// src/utils/mentor-customers.ts
// The business's OWN customers, as the Business Mentor may see them (docs/business-mentor-plan.md §5.2,
// Phase 3b). Read only from sources that exist, and only from assistants that are ACTIVE:
//
//   Won, lost and why          revenue_events                      Lead Generator active
//   Quiet won customers        revenue_events → discovered_leads   Lead Generator active
//                              (company and contact NAME only) + lead_threads (last contact DATE only)
//   Customer feedback          org_reviews (published: rating and a short excerpt, never the author)
//   Recurring support problems assistant_records 'ticket'          Support Agent active
//   Overdue invoices           assistant_records 'invoice'         Accounts Receivable active
//
// Never an email address, phone number or message body (§12.2; src/config/mentor-data-inventory.ts). The
// `invoices` table is Be More Swan's OWN billing — not the business's invoices — so it is never read here.
//
// ⚠️ Not churn.ts / churn-signals.ts: those are about Be More Swan's customers leaving Be More Swan.
//
// One function for the Customers panel on the Mentor's Overview tab (mentor.ts ?customers=1), the weekly
// review and the chat (when the user asks about their customers). Never throws on a missing table.

import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { aiAssistants, assistantRecords, discoveredLeads, leadThreads, masterAssistants, orgReviews, revenueEvents } from '../../db/schema';
import { teamState } from './mentor-snapshot';

type Db = any;

const DAY = 86_400_000;
/** A won customer not contacted for this long is "quiet". */
export const QUIET_AFTER_DAYS = 45;
/** Deals and reasons are read over this window. */
export const DEALS_WINDOW_DAYS = 90;
/** Below this many closed deals, "why deals are lost" isn't a pattern yet. */
export const MIN_DEALS = 5;
export const MAX_QUIET = 10;

export const LOSS_REASON_LABELS: Record<string, string> = {
    price: 'price', timing: 'timing', no_budget: 'no budget', competitor: 'went with a competitor', no_response: 'no response',
    wrong_contact: 'wrong contact', not_icp: 'not a good fit', feature_gap: 'missing something they needed', went_silent: 'went silent', other: 'other',
};

const ROLE = { leads: 'lead_qualifier', support: 'tier1_support_agent', ar: 'accounts_receivable_clerk' } as const;

export interface CustomersView {
    /** Which sources were read, and why the others weren't. */
    sources: Array<{ key: string; label: string; available: boolean; note: string }>;
    deals: { won: number; lost: number; disqualified: number; lossReasons: Array<{ reason: string; count: number }>; enough: boolean } | null;
    quiet: Array<{ company: string; contact: string | null; wonAt: string; lastContactAt: string | null }> | null;
    reviews: { count: number; average: number | null; low: Array<{ rating: number; excerpt: string; date: string | null }> } | null;
    tickets: { last30: number; open: number; subjects: string[] } | null;
    overdueInvoices: number | null;
}

const missing = (err: any) => ['42P01', '42703'].includes(err?.code ?? err?.cause?.code);
async function optional<T>(q: () => Promise<T>, fallback: T): Promise<T> {
    try { return await q(); } catch (err) { if (missing(err)) return fallback; throw err; }
}

/** Pure: is the business's customer side empty for the Mentor (it should ask instead)? */
export function nothingToSee(v: CustomersView): boolean {
    return !v.deals && !v.quiet?.length && !v.reviews?.count && !v.tickets && v.overdueInvoices === null;
}

/** Pure: a review excerpt — first 160 characters at a word; never the author. */
export function excerpt(body: string, max = 160): string {
    const t = String(body ?? '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 30))}…`;
}

export async function loadCustomers(db: Db, orgId: number, now = new Date()): Promise<CustomersView> {
    const team = await db.select({ id: aiAssistants.id, roleKey: masterAssistants.roleKey, life: aiAssistants.lifecycleStatus, prov: aiAssistants.provisioningStatus })
        .from(aiAssistants).leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .where(eq(aiAssistants.organisationId, orgId));
    const activeIds = (roleKey: string) => team.filter((t: any) => t.roleKey === roleKey && teamState(t.life, t.prov) === 'active').map((t: any) => t.id as number);
    const leadIds = activeIds(ROLE.leads);
    const supportIds = activeIds(ROLE.support);
    const arIds = activeIds(ROLE.ar);
    const since = new Date(now.getTime() - DEALS_WINDOW_DAYS * DAY);

    const view: CustomersView = { sources: [], deals: null, quiet: null, reviews: null, tickets: null, overdueInvoices: null };
    const notActive = (name: string) => `Your ${name} isn't active, so I don't read this.`;

    // ── Deals and quiet customers: the Lead Generator's outcomes ────────────────────────────────
    view.sources.push({ key: 'deals', label: 'Won and lost deals', available: leadIds.length > 0, note: leadIds.length ? 'From the deals your Lead Generator marked won or lost.' : notActive('Lead Generator') });
    if (leadIds.length) {
        const rows: Array<{ outcome: string; reason: string | null; n: number }> = await optional(() => db.select({
            outcome: revenueEvents.outcome, reason: revenueEvents.lossReason, n: sql<number>`count(*)::int`,
        }).from(revenueEvents).where(and(eq(revenueEvents.organisationId, orgId), isNotNull(revenueEvents.outcome), gte(revenueEvents.occurredAt, since)))
            .groupBy(revenueEvents.outcome, revenueEvents.lossReason), []);
        const by = (o: string) => rows.filter((r) => r.outcome === o).reduce((s, r) => s + Number(r.n), 0);
        const reasons = rows.filter((r) => r.outcome === 'lost' && r.reason).map((r) => ({ reason: LOSS_REASON_LABELS[r.reason!] ?? r.reason!, count: Number(r.n) }))
            .sort((a, b) => b.count - a.count).slice(0, 3);
        const won = by('won'); const lost = by('lost'); const disqualified = by('disqualified');
        view.deals = { won, lost, disqualified, lossReasons: reasons, enough: won + lost >= MIN_DEALS };

        // Won customers and when they were last contacted — names and dates only.
        const wins: any[] = await optional(() => db.select({
            leadId: revenueEvents.discoveredLeadId, wonAt: sql<Date>`max(${revenueEvents.occurredAt})`,
            company: discoveredLeads.companyName, contact: discoveredLeads.contactName,
        }).from(revenueEvents).innerJoin(discoveredLeads, eq(discoveredLeads.id, revenueEvents.discoveredLeadId))
            .where(and(eq(revenueEvents.organisationId, orgId), eq(discoveredLeads.organisationId, orgId), eq(revenueEvents.outcome, 'won')))
            .groupBy(revenueEvents.discoveredLeadId, discoveredLeads.companyName, discoveredLeads.contactName)
            .orderBy(desc(sql`max(${revenueEvents.occurredAt})`)).limit(100), []);
        const ids = wins.map((w) => w.leadId).filter((x) => Number.isInteger(x));
        const contacts: any[] = ids.length ? await optional(() => db.select({
            leadId: leadThreads.discoveredLeadId,
            last: sql<Date | null>`max(greatest(coalesce(${leadThreads.lastOutboundAt}, 'epoch'), coalesce(${leadThreads.lastInboundAt}, 'epoch')))`,
        }).from(leadThreads).where(and(eq(leadThreads.organisationId, orgId), inArray(leadThreads.discoveredLeadId, ids)))
            .groupBy(leadThreads.discoveredLeadId), []) : [];
        const lastBy = new Map(contacts.map((c) => [c.leadId, c.last ? new Date(c.last) : null]));
        view.quiet = wins.flatMap((w) => {
            const wonAt = new Date(w.wonAt);
            const raw = lastBy.get(w.leadId) ?? null;
            const last = raw && raw.getTime() > 0 ? raw : null;
            const ref = last && last > wonAt ? last : wonAt;
            if (now.getTime() - ref.getTime() < QUIET_AFTER_DAYS * DAY) return [];
            return [{ company: w.company, contact: w.contact ?? null, wonAt: wonAt.toISOString(), lastContactAt: last ? last.toISOString() : null }];
        }).slice(0, MAX_QUIET);
    }

    // ── Reviews: the business's own published reviews ─────────────────────────────────────────
    const reviews: any[] = await optional(() => db.select({ rating: orgReviews.rating, body: orgReviews.body, reviewedOn: orgReviews.reviewedOn, createdAt: orgReviews.createdAt })
        .from(orgReviews).where(and(eq(orgReviews.organisationId, orgId), eq(orgReviews.status, 'published')))
        .orderBy(desc(orgReviews.createdAt)).limit(100), []);
    view.sources.push({ key: 'reviews', label: 'Customer reviews', available: reviews.length > 0, note: reviews.length ? 'From the reviews on Business Information.' : 'No reviews have been added yet.' });
    if (reviews.length) {
        const rated = reviews.filter((r) => typeof r.rating === 'number');
        view.reviews = {
            count: reviews.length,
            average: rated.length ? Math.round((rated.reduce((s, r) => s + r.rating, 0) / rated.length) * 10) / 10 : null,
            low: rated.filter((r) => r.rating <= 3).slice(0, 3).map((r) => ({ rating: r.rating, excerpt: excerpt(r.body), date: r.reviewedOn ? String(r.reviewedOn).slice(0, 10) : null })),
        };
    }

    // ── Support tickets: the Support Agent's records ─────────────────────────────────────────
    view.sources.push({ key: 'tickets', label: 'Support tickets', available: supportIds.length > 0, note: supportIds.length ? 'From your Support Agent’s tickets.' : notActive('Support Agent') });
    if (supportIds.length) {
        const t: any[] = await optional(() => db.select({ title: assistantRecords.title, status: assistantRecords.status, createdAt: assistantRecords.createdAt })
            .from(assistantRecords).where(and(eq(assistantRecords.organisationId, orgId), inArray(assistantRecords.aiAssistantId, supportIds), eq(assistantRecords.recordType, 'ticket'),
                gte(assistantRecords.createdAt, new Date(now.getTime() - 30 * DAY))))
            .orderBy(desc(assistantRecords.createdAt)).limit(200), []);
        view.tickets = {
            last30: t.length,
            open: t.filter((r) => !/closed|resolved|done/i.test(String(r.status ?? ''))).length,
            subjects: [...new Set(t.map((r) => String(r.title).slice(0, 80)))].slice(0, 5),
        };
    }

    // ── Overdue invoices: the Accounts Receivable assistant's records (count only) ────────────
    view.sources.push({ key: 'invoices', label: 'Overdue invoices', available: arIds.length > 0, note: arIds.length ? 'From your Accounts Receivable assistant.' : notActive('Accounts Receivable assistant') });
    if (arIds.length) {
        const [r] = await optional(() => db.select({ n: sql<number>`count(*)::int` }).from(assistantRecords)
            .where(and(eq(assistantRecords.organisationId, orgId), inArray(assistantRecords.aiAssistantId, arIds), eq(assistantRecords.recordType, 'invoice'),
                sql`${assistantRecords.status} ILIKE '%overdue%'`)), [] as any[]);
        view.overdueInvoices = Number(r?.n ?? 0);
    }
    return view;
}

/** Pure: the prompt's block — honest about what isn't there. */
export function renderCustomersForMentor(v: CustomersView | null): string[] {
    if (!v) return ['THEIR CUSTOMERS: couldn\'t be read just now — don\'t guess.'];
    const lines = ['THEIR CUSTOMERS (the business\'s own customers — names and dates only; never contact details):'];
    if (nothingToSee(v)) {
        lines.push('- Nothing to read: no active assistant records deals, tickets or invoices, and no reviews are added. Ask them about their customers instead (who buys, who comes back, who has gone quiet).');
        return lines;
    }
    if (v.deals) {
        const d = v.deals;
        lines.push(`- Last ${DEALS_WINDOW_DAYS} days: ${d.won} won, ${d.lost} lost, ${d.disqualified} disqualified.${d.enough
            ? (d.lossReasons.length ? ` Most common loss reasons: ${d.lossReasons.map((r) => `${r.reason} (${r.count})`).join(', ')}.` : '')
            : ` Too few closed deals (under ${MIN_DEALS}) to say why deals are lost — say so.`}`);
    }
    if (v.quiet) lines.push(v.quiet.length
        ? `- Won customers not heard from in ${QUIET_AFTER_DAYS}+ days: ${v.quiet.map((q) => `${q.company}${q.contact ? ` (${q.contact})` : ''}, last contact ${q.lastContactAt ? q.lastContactAt.slice(0, 10) : 'none recorded'}`).join('; ')}.`
        : `- No won customer has gone quiet (${QUIET_AFTER_DAYS}+ days).`);
    if (v.reviews) lines.push(`- Reviews: ${v.reviews.count}${v.reviews.average !== null ? `, average ${v.reviews.average}/5` : ''}.${v.reviews.low.length ? ` Low ones: ${v.reviews.low.map((r) => `${r.rating}/5 "${r.excerpt}"`).join(' | ')}` : ''}`);
    if (v.tickets) lines.push(`- Support tickets in 30 days: ${v.tickets.last30} (${v.tickets.open} open).${v.tickets.subjects.length ? ` Recent subjects: ${v.tickets.subjects.join('; ')}.` : ''}`);
    if (v.overdueInvoices !== null) lines.push(`- Overdue invoices: ${v.overdueInvoices}.`);
    const off = v.sources.filter((s) => !s.available).map((s) => s.label.toLowerCase());
    if (off.length) lines.push(`- Not available (missing ≠ zero): ${off.join(', ')}.`);
    return lines;
}
