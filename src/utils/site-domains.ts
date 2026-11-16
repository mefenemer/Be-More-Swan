// src/utils/site-domains.ts — a business's OWN domain for its Website Assistant site (decision D2,
// docs/website-assistant-plan.md: "build behind one site-domains.ts interface, launch on Netlify
// aliases"). Owner's choice 2026-10-17: Netlify to start; Cloudflare for SaaS when ~40 are in use.
//
// ── How it works ────────────────────────────────────────────────────────────────────────────────
// A THIRD Netlify project (setup in sites-host/netlify.toml) serves customer domains: the same edge
// function as *.bemoreswan.site, but carrying each customer domain as a domain alias. (A project with
// wildcard subdomains cannot also carry aliases — that is why it is separate.) Env on the APP:
//   NETLIFY_API_TOKEN          a Netlify personal access token that can edit that project
//   CUSTOM_DOMAINS_SITE_ID     the project's API id
//   CUSTOM_DOMAINS_TARGET      its *.netlify.app name — where a customer's www CNAME points
//
// One domain per site, in two forms: `domain` (what visitors are sent to — normally www.example.com)
// and `alt_domain` (example.com, which redirects to it). Life of a row:
//   pending_dns  saved, shown the DNS records to add. NOT on Netlify yet — an alias whose DNS doesn't
//                point at us only fails certificate requests (20 per domain per week).
//   securing     DNS points at us: added as aliases, HTTPS certificate requested.
//   live         https://domain answers with this site — the bemoreswan.site address redirects here.
//   removed      taken off (by the owner, or replaced) — kept for the record.
// Checks run when the owner presses "Check now" (sites.ts domain_check) AND every 10 minutes for
// domains still on their way (check-site-domains.ts → checkDueDomains), so nobody has to keep pressing.
// The owner is emailed once when their domain goes live (notifyDomainLive).
//
// ⚠️ When WE are the reason it can't connect (Netlify refusing our token, Netlify down), the owner is
// told so and told they don't need to do anything, and the operator is emailed (alertOperator). A
// 401 here once left a customer pressing "Check now" for an hour while told "we'll try again"
// (Restorative Futures, 2026-11-13). check-provider-balances also probes the token every 6 hours.

import { Resolver } from 'node:dns/promises';
import { and, eq, gt, inArray, ne, or, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, siteDomains, sites, users } from '../../db/schema';
import { safeFetchText } from './safe-fetch';
import { sitesDomain, slugFromHost } from './site-hosting';

type Db = ReturnType<typeof getDb>;
export type SiteDomainRow = typeof siteDomains.$inferSelect;

/** Netlify's load balancer — what a bare domain's A record points at when its DNS is elsewhere. */
export const NETLIFY_APEX_IP = '75.2.60.5';
/** A domain never reaches "live" without this long since its certificate was asked for — then ask again. */
const PROVISION_RETRY_MS = 30 * 60_000;
/** An unproven claim (DNS never pointed at us) lapses, so nobody can squat someone else's name. */
export const CLAIM_LAPSES_DAYS = 7;

/** Our own and our infrastructure's names — never a customer domain. */
const OURS = ['bemoreswan.com', 'bemoreswan.site', 'aura-assist.com', 'theswanindex.com', 'netlify.app', 'netlify.com'];

export function customDomainsConfig(env: Record<string, string | undefined> = process.env) {
    const token = env.NETLIFY_API_TOKEN || '';
    const siteId = env.CUSTOM_DOMAINS_SITE_ID || '';
    const target = (env.CUSTOM_DOMAINS_TARGET || '').trim().toLowerCase().replace(/\.$/, '');
    return { token, siteId, target, ready: !!(token && siteId && /^[a-z0-9-]+\.netlify\.app$/.test(target)) };
}

/**
 * What the owner typed → the domain visitors use and the form that redirects to it. A bare domain
 * (example.com) is served at www.example.com with example.com redirecting; a deeper name
 * (shop.example.com) is used as it is, with no second form.
 */
export function cleanDomainInput(raw: unknown): { domain: string; alt: string | null } | { error: string } {
    let h = String(raw ?? '').trim().toLowerCase();
    h = h.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
    if (!h) return { error: 'Type your domain, e.g. yourbusiness.co.uk.' };
    if (h.length > 253 || !/^[a-z0-9.-]+$/.test(h) || !h.includes('.')) return { error: 'That doesn\'t look like a domain. Type it like yourbusiness.co.uk.' };
    const labels = h.split('.');
    if (labels.some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return { error: 'That doesn\'t look like a domain. Type it like yourbusiness.co.uk.' };
    if (/^\d+$/.test(labels[labels.length - 1])) return { error: 'Use a domain name, not an IP address.' };
    if (OURS.some((o) => h === o || h.endsWith(`.${o}`)) || h === sitesDomain() || h.endsWith(`.${sitesDomain()}`)) return { error: 'That address belongs to Be More Swan. Use a domain you own.' };
    const bare = labels[0] === 'www' ? labels.slice(1).join('.') : h;
    // A registrable domain on its own (example.com, example.co.uk): served at www, the bare one redirects.
    const looksBare = labels[0] === 'www' || isRegistrable(bare) === bare;
    return looksBare ? { domain: `www.${bare}`, alt: bare } : { domain: h, alt: null };
}

/**
 * The registrable part of a name, by a short list of two-part public suffixes (co.uk, org.uk, com.au…)
 * — enough to tell example.co.uk (bare) from shop.example.com (a subdomain). Not a full PSL: a name
 * we misjudge still works, it only decides whether www is offered.
 */
const TWO_PART = new Set(['co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk', 'gov.uk', 'nhs.uk',
    'com.au', 'net.au', 'org.au', 'co.nz', 'org.nz', 'co.za', 'com.br', 'co.jp', 'com.mx', 'co.in', 'com.sg', 'com.hk', 'co.ie']);
export function isRegistrable(host: string): string {
    const l = host.split('.');
    const last2 = l.slice(-2).join('.');
    return TWO_PART.has(last2) ? l.slice(-3).join('.') : last2;
}

/** The records the owner adds at wherever their domain is registered. */
export function dnsRecordsFor(row: Pick<SiteDomainRow, 'domain' | 'altDomain'>, target: string): Array<{ type: 'CNAME' | 'A'; name: string; value: string; note: string }> {
    const out: Array<{ type: 'CNAME' | 'A'; name: string; value: string; note: string }> = [];
    const sub = (host: string) => { const reg = isRegistrable(host); return host === reg ? '@' : host.slice(0, -(reg.length + 1)); };
    out.push({ type: 'CNAME', name: sub(row.domain), value: target, note: `So ${row.domain} shows your website.` });
    if (row.altDomain) out.push({ type: 'A', name: '@', value: NETLIFY_APEX_IP, note: `So ${row.altDomain} (without www) goes to your website too. Remove any other A records for @.` });
    return out;
}

/** Whether a name's DNS points at us: a CNAME to the target, or (a bare domain) an A record to Netlify. */
/** The two lookups the DNS check needs (a stand-in in tests). */
export interface DnsLookup { resolveCname(host: string): Promise<string[]>; resolve4(host: string): Promise<string[]>; }

export async function dnsPointsAtUs(host: string, target: string, resolver: DnsLookup = new Resolver({ timeout: 4000, tries: 2 }) as unknown as DnsLookup): Promise<{ ok: boolean; found: string }> {
    try {
        const cn = await resolver.resolveCname(host);
        const hit = cn.map((c) => c.toLowerCase().replace(/\.$/, ''));
        if (hit.includes(target)) return { ok: true, found: `CNAME ${hit.join(', ')}` };
        if (hit.length) return { ok: false, found: `CNAME ${hit.join(', ')}` };
    } catch { /* no CNAME: look for A records */ }
    try {
        const a = await resolver.resolve4(host);
        return { ok: a.includes(NETLIFY_APEX_IP) && a.every((ip) => ip === NETLIFY_APEX_IP), found: a.length ? `A ${a.join(', ')}` : 'nothing yet' };
    } catch {
        return { ok: false, found: 'nothing yet' };
    }
}

// ── Netlify (the custom-domains project's aliases) ──────────────────────────────────────────────

/** A refusal from Netlify's API, with its HTTP status (401/403 = our token, not the customer). */
export class NetlifyApiError extends Error {
    constructor(public status: number, message: string) { super(`Netlify ${status}: ${message}`); this.name = 'NetlifyApiError'; }
}

async function netlify(path: string, init: RequestInit = {}): Promise<unknown> {
    const { token } = customDomainsConfig();
    const res = await fetch(`https://api.netlify.com/api/v1${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
        signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new NetlifyApiError(res.status, (body as { message?: string }).message || res.statusText);
    return body;
}

/**
 * Add and/or remove aliases on the custom-domains project. Netlify takes the WHOLE list, so the
 * read-modify-write runs under a transaction-scoped advisory lock: two owners connecting at once
 * must not each write a list without the other's domain.
 */
export async function changeAliases(db: Db, add: string[], remove: string[]): Promise<void> {
    const { siteId } = customDomainsConfig();
    await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('bms_custom_domain_aliases'))`);
        const site = await netlify(`/sites/${siteId}`) as { domain_aliases?: string[] };
        const now = new Set((site.domain_aliases || []).map((d) => d.toLowerCase()));
        add.forEach((d) => now.add(d));
        remove.forEach((d) => now.delete(d));
        await netlify(`/sites/${siteId}`, { method: 'PATCH', body: JSON.stringify({ domain_aliases: [...now] }) });
    });
}

/**
 * Can our token still edit the custom-domains project? For check-provider-balances: a token that has
 * expired or been revoked breaks every domain connection, and nobody sees it until a customer tries.
 */
export async function probeDomainsAccess(): Promise<{ status: 'ok' | 'not_configured' | 'key_rejected' | 'error'; httpStatus?: number; message?: string }> {
    const { token, siteId } = customDomainsConfig();
    if (!token || !siteId) return { status: 'not_configured' };
    try { await netlify(`/sites/${siteId}`); return { status: 'ok' }; }
    catch (err) {
        if (err instanceof NetlifyApiError && (err.status === 401 || err.status === 403 || err.status === 404)) return { status: 'key_rejected', httpStatus: err.status, message: err.message };
        return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
}

async function requestCertificate(): Promise<void> {
    const { siteId } = customDomainsConfig();
    await netlify(`/sites/${siteId}/ssl`, { method: 'POST' });
}

// ── The site a request's host names ─────────────────────────────────────────────────────────────

/** What site-serve answers for /_bms-domain-check — proof that https://domain really is this site. */
export const DOMAIN_CHECK_PATH = '/_bms-domain-check';
export const domainCheckBody = (siteId: number) => `bms-site:${siteId}`;

/**
 * The site for a Host, and where it should really be seen:
 *   - a *.bemoreswan.site address → its slug; `redirectTo` its own domain once that is live
 *   - a customer domain           → that site's slug; `redirectTo` the main form when this is the other
 * Null when nothing is there.
 */
export async function resolveSiteHost(db: Db, rawHost: string | null | undefined): Promise<{ slug: string; origin: string | null; redirectTo: string | null } | null> {
    const host = String(rawHost || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    const slug = slugFromHost(host);
    if (slug) {
        const [live] = await db.select({ domain: siteDomains.domain }).from(siteDomains)
            .innerJoin(sites, eq(sites.id, siteDomains.siteId))
            .where(and(eq(sites.slug, slug), eq(siteDomains.status, 'live'))).limit(1);
        return { slug, origin: live ? `https://${live.domain}` : null, redirectTo: live ? `https://${live.domain}` : null };
    }
    if (!host || !host.includes('.')) return null;
    const [row] = await db.select({ domain: siteDomains.domain, alt: siteDomains.altDomain, slug: sites.slug }).from(siteDomains)
        .innerJoin(sites, eq(sites.id, siteDomains.siteId))
        .where(and(or(eq(siteDomains.domain, host), eq(siteDomains.altDomain, host)), inArray(siteDomains.status, ['securing', 'live']))).limit(1);
    if (!row || !row.slug) return null;
    return { slug: row.slug, origin: `https://${row.domain}`, redirectTo: host === row.alt ? `https://${row.domain}` : null };
}

// ── Claiming, checking, removing ────────────────────────────────────────────────────────────────

export async function currentDomain(db: Db, siteId: number): Promise<SiteDomainRow | null> {
    const [row] = await db.select().from(siteDomains).where(and(eq(siteDomains.siteId, siteId), ne(siteDomains.status, 'removed'))).limit(1);
    return row ?? null;
}

export async function claimDomain(db: Db, site: { id: number; organisationId: number }, raw: unknown): Promise<{ ok: true; row: SiteDomainRow } | { ok: false; error: string }> {
    if (!customDomainsConfig().ready) return { ok: false, error: 'Using your own domain isn\'t switched on yet. Please try again soon.' };
    const clean = cleanDomainInput(raw);
    if ('error' in clean) return { ok: false, error: clean.error };
    const names = [clean.domain, ...(clean.alt ? [clean.alt] : [])];
    // A name another site holds: refused, unless that claim never got its DNS pointed here and has lapsed.
    const held = await db.select().from(siteDomains).where(and(ne(siteDomains.status, 'removed'),
        or(inArray(siteDomains.domain, names), inArray(siteDomains.altDomain, names))));
    for (const h of held) {
        if (h.siteId === site.id) continue;
        const lapsed = h.status === 'pending_dns' && Date.now() - new Date(h.createdAt).getTime() > CLAIM_LAPSES_DAYS * 86_400_000;
        if (!lapsed) return { ok: false, error: 'That domain is already connected to another website here. If it\'s yours, contact us.' };
        await db.update(siteDomains).set({ status: 'removed', statusDetail: 'Lapsed: DNS never pointed here.', updatedAt: new Date() }).where(eq(siteDomains.id, h.id));
    }
    const old = await currentDomain(db, site.id);
    if (old) await removeDomain(db, old);
    const [row] = await db.insert(siteDomains).values({
        siteId: site.id, organisationId: site.organisationId, domain: clean.domain, altDomain: clean.alt, status: 'pending_dns',
    }).returning();
    return { ok: true, row };
}

export async function removeDomain(db: Db, row: SiteDomainRow): Promise<void> {
    if (row.status === 'securing' || row.status === 'live') {
        await changeAliases(db, [], [row.domain, ...(row.altDomain ? [row.altDomain] : [])]);
    }
    await db.update(siteDomains).set({ status: 'removed', statusDetail: 'Removed by the owner.', updatedAt: new Date() }).where(eq(siteDomains.id, row.id));
}

/**
 * "Doesn't point here yet", in words that say what to do. A CNAME to some OTHER *.netlify.app is a site
 * already on Netlify (Restorative Futures, 2026-11-13): changing the record is not enough — the domain
 * must also come off that site, or Netlify keeps showing it.
 */
export function notPointingDetail(row: Pick<SiteDomainRow, 'domain' | 'altDomain'>, found: string, target: string): string {
    const other = /CNAME ([a-z0-9-]+\.netlify\.app)/.exec(found)?.[1];
    if (other && other !== target) {
        return `${row.domain} still points at another Netlify website (${other}). Change that record to ${target} as shown below. Then remove ${row.altDomain || row.domain} from that site in Netlify (Domain management) and press Check now straight away, so there's no gap.`;
    }
    return `${row.domain} doesn't point here yet (found: ${found}). DNS changes can take up to a few hours — we check every 10 minutes.`;
}

// What the owner reads. Exported so the panel's heading (domainView) and the tests agree with checkDomain.
export const DETAIL_DNS_RIGHT_PREFIX = 'Your DNS is right.';
export const DETAIL_HELD_ELSEWHERE = (domain: string) => `${DETAIL_DNS_RIGHT_PREFIX.slice(0, -1)}, but ${domain} is still attached to another Netlify website, so it keeps showing that one. Whoever runs that site needs to remove the domain there (Netlify → that site → Domain management), then press Check now straight away — we also check every 10 minutes. Can't get into that Netlify account? Contact us and we'll sort it out with Netlify.`;
/** Netlify's refusal when another Netlify site (any account) already carries one of the names. */
export function heldByAnotherNetlifySite(err: unknown): boolean {
    return err instanceof NetlifyApiError && err.status === 422 && /already|in use|another|taken|registered|belongs|exists/i.test(err.message);
}
export const DETAIL_OUR_SIDE = `${DETAIL_DNS_RIGHT_PREFIX} Something on our side stopped us finishing the connection. We've been alerted and will finish it for you — you don't need to change anything.`;
const OPERATOR_EMAIL = () => process.env.FOUNDER_ALERT_EMAIL || 'hello@bemoreswan.com';

/** Email the operator. Never throws: a failed alert is logged, and the domain check carries on. */
export async function alertOperator(subject: string, lines: string[]): Promise<void> {
    const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    try {
        const { sendEmail } = await import('./email');
        await sendEmail({ to: OPERATOR_EMAIL(), subject: `[Be More Swan] ${subject}`,
            html: `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`, text: lines.map((l) => `- ${l}`).join('\n') });
    } catch (err) { console.error('[site-domains] OPERATOR ALERT FAILED — a domain is stuck and nobody has been told', subject, err); }
}

/**
 * Move a domain on as far as it can go right now, and say where it stands in words the owner can act
 * on. Safe to call often: Netlify is only touched when something changes (or a certificate is overdue).
 */
export async function checkDomain(db: Db, row: SiteDomainRow, now = new Date()): Promise<SiteDomainRow> {
    const cfg = customDomainsConfig();
    if (!cfg.ready || row.status === 'removed') return row;
    const set = async (patch: Partial<SiteDomainRow>) => {
        const [r] = await db.update(siteDomains).set({ ...patch, checkedAt: now, updatedAt: now }).where(eq(siteDomains.id, row.id)).returning();
        return r;
    };
    if (row.status === 'pending_dns') {
        const main = await dnsPointsAtUs(row.domain, cfg.target);
        const alt = row.altDomain ? await dnsPointsAtUs(row.altDomain, cfg.target) : { ok: true, found: '' };
        if (!main.ok) return set({ statusDetail: notPointingDetail(row, main.found, cfg.target) });
        try {
            // The bare form joins only once its own record points here too; until then www works on its own.
            await changeAliases(db, [row.domain, ...(row.altDomain && alt.ok ? [row.altDomain] : [])], []);
        } catch (err) {
            console.error('[site-domains] could not add aliases', { domainId: row.id }, err);
            // Ours, not the customer's: their DNS is right. Alert once per stuck spell (the 10-minute
            // recheck keeps the same detail, so it doesn't re-send); the owner is told to do nothing.
            // Held by another Netlify site: the owner (or whoever runs that site) can fix this, so say how.
            if (heldByAnotherNetlifySite(err)) {
                const detail = DETAIL_HELD_ELSEWHERE(row.altDomain || row.domain);
                if (row.statusDetail !== detail) {
                    await alertOperator(`Own domain held by another Netlify site: ${row.domain}`, [
                        `${row.domain}${row.altDomain ? ` (and ${row.altDomain})` : ''}: DNS points at us, but Netlify says another site carries the name.`,
                        'The owner has been asked to remove it from that site. If they can\'t reach that Netlify account, the real owner of the domain can claim it through Netlify support (a TXT record check).',
                        `Error: ${err instanceof Error ? err.message : String(err)}`, `site_domains.id ${row.id}. Rechecked every 10 minutes.`,
                    ]);
                }
                return set({ statusDetail: detail });
            }
            if (row.statusDetail !== DETAIL_OUR_SIDE) {
                const why = err instanceof NetlifyApiError && (err.status === 401 || err.status === 403)
                    ? 'Netlify refused our API token — replace NETLIFY_API_TOKEN (production) and redeploy. Every domain connection fails until then.'
                    : 'Netlify refused to add the domain as an alias. A 422 can mean the domain is still attached to another Netlify site.';
                await alertOperator(`Own domain stuck: ${row.domain}`, [
                    `${row.domain}${row.altDomain ? ` (and ${row.altDomain})` : ''}: the customer's DNS is right, but we couldn't add it to the custom-domains project.`,
                    why, `Error: ${err instanceof Error ? err.message : String(err)}`, `site_domains.id ${row.id}. It is retried every 10 minutes; nothing is needed from the customer.`,
                ]);
            }
            return set({ statusDetail: DETAIL_OUR_SIDE });
        }
        // Not fatal: once the aliases are on, the domain must move on to securing, where the check
        // proves https and asks again for a certificate if one is overdue. Netlify answers 422 while a
        // certificate is already being issued or already covers these names — treating that as a
        // failure left Restorative Futures stuck on "waiting" with everything ready (2026-11-13).
        try { await requestCertificate(); }
        catch (err) { console.error('[site-domains] certificate request refused; moving on to securing', { domainId: row.id }, err); }
        return set({ status: 'securing', provisionRequestedAt: now, altLive: !!(row.altDomain && alt.ok),
            statusDetail: 'Your DNS is right. Setting up the secure (https) connection — usually a few minutes, sometimes up to an hour.' });
    }
    // securing or live: does https://domain answer as this site?
    let answers = false;
    try {
        const r = await safeFetchText(`https://${row.domain}${DOMAIN_CHECK_PATH}`, { timeoutMs: 8000, maxBytes: 200, maxRedirects: 0 });
        answers = r.body.trim() === domainCheckBody(row.siteId);
    } catch { answers = false; }
    // The bare form, if it wasn't pointing before, may be now.
    if (row.altDomain && !row.altLive && (await dnsPointsAtUs(row.altDomain, cfg.target)).ok) {
        try { await changeAliases(db, [row.altDomain], []); await requestCertificate(); row = await set({ altLive: true, provisionRequestedAt: now }); }
        catch (err) { console.error('[site-domains] could not add the bare domain', { domainId: row.id }, err); }
    }
    if (answers) {
        return set({ status: 'live', liveAt: row.liveAt ?? now,
            statusDetail: row.altDomain && !row.altLive ? `Live at ${row.domain}. Add the A record for ${row.altDomain} so it works without www too.` : `Live at ${row.domain}.` });
    }
    if (row.status === 'live') return set({ statusDetail: `${row.domain} isn't answering as your website right now. Check its DNS records haven't changed.` });
    if (!row.provisionRequestedAt || now.getTime() - new Date(row.provisionRequestedAt).getTime() > PROVISION_RETRY_MS) {
        try { await requestCertificate(); } catch (err) { console.error('[site-domains] certificate request failed', { domainId: row.id }, err); }
        return set({ provisionRequestedAt: now, statusDetail: 'Still setting up the secure (https) connection. We\'ve asked again — check back in a few minutes.' });
    }
    return set({ statusDetail: 'Setting up the secure (https) connection — usually a few minutes, sometimes up to an hour.' });
}

/**
 * Where a domain stands, for the heading — never "waiting for your DNS" when the DNS is right:
 *   needs_dns   the owner still has records to add
 *   held_elsewhere  DNS right, but another Netlify site still carries the domain
 *   connecting  DNS right; we're adding it (or we're stuck — the detail says it's ours)
 *   securing    on Netlify; the https certificate is being issued
 *   live
 */
export function domainPhase(row: Pick<SiteDomainRow, 'status' | 'statusDetail'>): 'needs_dns' | 'held_elsewhere' | 'connecting' | 'securing' | 'live' | 'removed' {
    if (row.status === 'live' || row.status === 'securing' || row.status === 'removed') return row.status;
    if ((row.statusDetail || '').includes('is still attached to another Netlify website')) return 'held_elsewhere';
    return (row.statusDetail || '').startsWith(DETAIL_DNS_RIGHT_PREFIX) ? 'connecting' : 'needs_dns';
}

/** What the Publish card shows. */
export function domainView(row: SiteDomainRow | null) {
    const cfg = customDomainsConfig();
    if (!row) return { available: cfg.ready, domain: null };
    return {
        available: cfg.ready, domain: row.domain, altDomain: row.altDomain, status: row.status, phase: domainPhase(row), detail: row.statusDetail,
        checkedAt: row.checkedAt, records: cfg.ready ? dnsRecordsFor(row, cfg.target) : [],
    };
}

// ── Without anyone pressing "Check now" ─────────────────────────────────────────────────────────

/** Domains still on their way are rechecked this long after they were saved; after that, "Check now" only. */
export const AUTO_CHECK_HOURS = 72;

/**
 * Tell the site's owner, once, that their domain now shows their website. Never throws.
 * Called on the step to live, from "Check now" and from the 10-minute recheck alike.
 */
export async function notifyDomainLive(db: Db, siteId: number, domain: string): Promise<void> {
    try {
        const [o] = await db.select({ email: users.email, firstName: users.firstName })
            .from(sites).innerJoin(aiAssistants, eq(aiAssistants.id, sites.aiAssistantId)).leftJoin(users, eq(users.id, aiAssistants.userId))
            .where(eq(sites.id, siteId)).limit(1);
        if (!o?.email) return;
        const url = `https://${domain}`;
        const hi = o.firstName ? `Hi ${o.firstName},` : 'Hi,';
        const { sendEmail } = await import('./email');
        await sendEmail({
            to: o.email,
            subject: `Your website is live at ${domain}`,
            html: `<p>${hi}</p><p>Good news: <a href="${url}">${domain}</a> now shows your Be More Swan website, with a secure (https) connection.</p><p>Your old bemoreswan.site address keeps working and sends visitors to it. You don't need to do anything else.</p>`,
            text: `${hi}\n\nGood news: ${url} now shows your Be More Swan website, with a secure (https) connection.\n\nYour old bemoreswan.site address keeps working and sends visitors to it. You don't need to do anything else.`,
        });
    } catch (err) { console.error('[site-domains] could not email the owner that their domain is live', { siteId }, err); }
}

/**
 * The scheduled recheck (check-site-domains.ts): every domain on its way — saved in the last
 * AUTO_CHECK_HOURS and not yet live, or securing at any age — moved on as far as it will go.
 * `onLive` runs for each that went live this time (purge the site's cache, email the owner).
 * One failing domain never stops the rest.
 */
export async function checkDueDomains(db: Db, onLive: (row: SiteDomainRow, slug: string | null) => Promise<void>, now = new Date()): Promise<{ checked: number; live: number; failed: number }> {
    if (!customDomainsConfig().ready) return { checked: 0, live: 0, failed: 0 };
    const since = new Date(now.getTime() - AUTO_CHECK_HOURS * 3_600_000);
    const due = await db.select({ row: siteDomains, slug: sites.slug }).from(siteDomains)
        .innerJoin(sites, eq(sites.id, siteDomains.siteId))
        .where(and(ne(sites.status, 'suspended'), or(eq(siteDomains.status, 'securing'), and(eq(siteDomains.status, 'pending_dns'), gt(siteDomains.createdAt, since)))))
        .limit(100);
    let live = 0; let failed = 0;
    for (const { row, slug } of due) {
        try {
            const after = await checkDomain(db, row, now);
            if (after.status === 'live') { live++; await onLive(after, slug); }
        } catch (err) { failed++; console.error('[site-domains] scheduled check failed', { domainId: row.id }, err); }
    }
    return { checked: due.length, live, failed };
}

// ── Where the domain is managed (shown on the panel) ────────────────────────────────────────────
// "Where you bought restorativefutures.co.uk" assumed the owner knew. They thought Openprovider; it was
// Webador (a reseller of Openprovider's) — the public registry said so in one lookup. RDAP gives the
// reseller, registrar and expiry; the nameservers say whose DNS panel the records go in. Looked up when
// the panel loads, cached per instance, so no column and no SQL. Never throws, never blocks: a failed
// lookup just leaves the panel as it was.

export interface DomainRegistry {
    /** Whose DNS settings the records go in, e.g. "Webador", "GoDaddy", "Cloudflare". Null: unknown. */
    dnsManagedBy: string | null;
    /** The reseller or registrar the domain was bought through. */
    boughtThrough: string | null;
    expiresAt: string | null;
    /** Already on Netlify DNS — usually another Netlify account; records are edited there. */
    netlifyDns: boolean;
}

const NAMESERVER_HOSTS: Array<[RegExp, string]> = [
    [/\.domaincontrol\.com$/, 'GoDaddy'], [/\.registrar-servers\.com$/, 'Namecheap'], [/\.cloudflare\.com$/, 'Cloudflare'],
    [/\.ui-dns\.(com|de|org|biz)$/, 'IONOS'], [/\.123-reg\.co\.uk$/, '123 Reg'], [/\.wixdns\.net$/, 'Wix'],
    [/\.squarespacedns\.com$|\.googledomains\.com$/, 'Squarespace'], [/\.dns-parking\.com$/, 'Hostinger'],
    [/\.awsdns-\d+\./, 'Amazon Route 53'], [/\.ovh\.net$/, 'OVH'], [/\.gandi\.net$/, 'Gandi'], [/\.openprovider\.(nl|be|eu)$/, 'Openprovider'],
    [/\.nsone\.net$/, 'Netlify DNS'], [/\.hover\.com$/, 'Hover'], [/\.name-services\.com$/, 'Enom'], [/\.fasthosts\.net\.uk$|\.livedns\.co\.uk$/, 'Fasthosts'],
];

/** Pure: the DNS host a set of nameservers belongs to. */
export function dnsHostFromNameservers(ns: string[]): string | null {
    for (const n of ns.map((x) => x.toLowerCase().replace(/\.$/, ''))) {
        const hit = NAMESERVER_HOSTS.find(([re]) => re.test(n));
        if (hit) return hit[1];
    }
    return null;
}

/** Pure: the reseller (else registrar) and expiry from an RDAP domain answer. */
export function parseRdap(json: unknown): { reseller: string | null; registrar: string | null; expiresAt: string | null } {
    const d = (json && typeof json === 'object' ? json : {}) as { entities?: Array<{ roles?: string[]; vcardArray?: [string, Array<[string, unknown, string, unknown]>] }>; events?: Array<{ eventAction?: string; eventDate?: string }> };
    const nameOf = (role: string) => {
        const e = (d.entities || []).find((x) => (x.roles || []).includes(role));
        const card = e?.vcardArray?.[1] || [];
        const pick = (k: string) => { const v = card.find((c) => c[0] === k)?.[3]; return typeof v === 'string' && v.trim() ? v.trim() : null; };
        return pick('org') || pick('fn');
    };
    const exp = (d.events || []).find((e) => e.eventAction === 'expiration')?.eventDate;
    return { reseller: nameOf('reseller'), registrar: nameOf('registrar'), expiresAt: exp && !Number.isNaN(Date.parse(exp)) ? new Date(exp).toISOString() : null };
}

/** Pure: put the two together. A reseller on a wholesale registrar's nameservers is whose panel the owner uses. */
export function summariseRegistry(ns: string[], rdap: ReturnType<typeof parseRdap>): DomainRegistry {
    const host = dnsHostFromNameservers(ns);
    const wholesale = host === 'Openprovider' || host === 'Enom';
    return {
        dnsManagedBy: host === 'Netlify DNS' ? 'Netlify DNS' : wholesale && rdap.reseller ? rdap.reseller : host,
        boughtThrough: rdap.reseller || rdap.registrar,
        expiresAt: rdap.expiresAt,
        netlifyDns: host === 'Netlify DNS',
    };
}

// The official RDAP server for each domain ending comes from IANA's bootstrap list (RFC 9224), not a
// middleman: rdap.org answers Node's fetch with a 403. Some country endings (.io…) have no RDAP — then
// only the nameservers are known, which is still enough to say whose DNS panel to use.
const IANA_RDAP_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';
let bootstrap: { at: number; services: Array<[string[], string[]]> } | null = null;
/** Pure: the RDAP base URL for a domain from the bootstrap services (longest matching ending wins). */
export function rdapBaseFor(domain: string, services: Array<[string[], string[]]>): string | null {
    const labels = domain.toLowerCase().split('.');
    for (let i = 1; i < labels.length; i++) {
        const ending = labels.slice(i).join('.');
        const svc = services.find(([endings]) => endings.includes(ending));
        const url = svc?.[1].find((u) => u.startsWith('https://')) ?? svc?.[1][0];
        if (url) return url.endsWith('/') ? url : `${url}/`;
    }
    return null;
}
async function rdapServerFor(domain: string, fetchJson: (url: string) => Promise<unknown>): Promise<string | null> {
    if (!bootstrap || Date.now() - bootstrap.at > 24 * 3_600_000) {
        const j = await fetchJson(IANA_RDAP_BOOTSTRAP) as { services?: Array<[string[], string[]]> };
        bootstrap = { at: Date.now(), services: Array.isArray(j?.services) ? j.services : [] };
    }
    return rdapBaseFor(domain, bootstrap.services);
}

const REGISTRY_CACHE = new Map<string, { at: number; value: DomainRegistry | null }>();
const REGISTRY_TTL_MS = 6 * 3_600_000;
const REGISTRY_FAIL_TTL_MS = 10 * 60_000;

/** Who manages a domain — for the panel. Cached; at most ~2.5 s on a miss; null when nothing is known. */
export async function lookupDomainRegistry(host: string, deps: { resolveNs?: (h: string) => Promise<string[]>; fetchJson?: (url: string) => Promise<unknown> } = {}): Promise<DomainRegistry | null> {
    const bare = isRegistrable(host);
    const hit = REGISTRY_CACHE.get(bare);
    if (hit && Date.now() - hit.at < (hit.value ? REGISTRY_TTL_MS : REGISTRY_FAIL_TTL_MS)) return hit.value;
    const resolveNs = deps.resolveNs ?? ((h: string) => new Resolver({ timeout: 2000, tries: 1 }).resolveNs(h));
    const fetchJson = deps.fetchJson ?? (async (url: string) => {
        const res = await fetch(url, { headers: { Accept: 'application/rdap+json, application/json' }, signal: AbortSignal.timeout(2500), redirect: 'follow' });
        if (!res.ok) throw new Error(`RDAP ${res.status}`);
        return res.json();
    });
    const [ns, rdap] = await Promise.all([
        resolveNs(bare).catch(() => [] as string[]),
        rdapServerFor(bare, fetchJson)
            .then((base) => base ? fetchJson(`${base}domain/${encodeURIComponent(bare)}`).then(parseRdap) : Promise.reject(new Error('no RDAP server for this ending')))
            .catch(() => ({ reseller: null, registrar: null, expiresAt: null })),
    ]);
    const s = summariseRegistry(ns, rdap);
    const value = s.dnsManagedBy || s.boughtThrough || s.expiresAt ? s : null;
    REGISTRY_CACHE.set(bare, { at: Date.now(), value });
    return value;
}
