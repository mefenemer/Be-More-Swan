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
// Checks run when the owner opens or presses "Check now" (sites.ts domain_check).

import { Resolver } from 'node:dns/promises';
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { siteDomains, sites } from '../../db/schema';
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

async function netlify(path: string, init: RequestInit = {}): Promise<unknown> {
    const { token } = customDomainsConfig();
    const res = await fetch(`https://api.netlify.com/api/v1${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
        signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Netlify ${res.status}: ${(body as { message?: string }).message || res.statusText}`);
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
        if (!main.ok) return set({ statusDetail: `${row.domain} doesn't point here yet (found: ${main.found}). DNS changes can take up to a few hours.` });
        try {
            // The bare form joins only once its own record points here too; until then www works on its own.
            await changeAliases(db, [row.domain, ...(row.altDomain && alt.ok ? [row.altDomain] : [])], []);
            await requestCertificate();
        } catch (err) {
            console.error('[site-domains] could not add aliases / request a certificate', { domainId: row.id }, err);
            return set({ statusDetail: 'Your DNS is right. We couldn\'t finish connecting it just now — we\'ll try again when you next check.' });
        }
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

/** What the Publish card shows. */
export function domainView(row: SiteDomainRow | null) {
    const cfg = customDomainsConfig();
    if (!row) return { available: cfg.ready, domain: null };
    return {
        available: cfg.ready, domain: row.domain, altDomain: row.altDomain, status: row.status, detail: row.statusDetail,
        checkedAt: row.checkedAt, records: cfg.ready ? dnsRecordsFor(row, cfg.target) : [],
    };
}
