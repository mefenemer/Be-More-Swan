// src/utils/dmarc-check.ts
// Does this domain tell the world what to do with mail that fails its checks?
//
// SPF and DKIM are set up as part of verifying a sending domain — the provider hands over the
// records and refuses to verify until they resolve. ⚠️ DMARC is the one nobody sets up, because
// nothing forces it: mail flows perfectly well without it. What it changes is what a receiver does
// with a forgery, and since 2024 Gmail and Yahoo require bulk senders to publish one at all.
//
// This is a plain DNS TXT lookup. No third party, no API key, nothing to pay for — which is also
// why it is here and a "spam score" is not.

import { promises as dns } from 'dns';

export interface DmarcResult {
    found: boolean;
    /** 'none' | 'quarantine' | 'reject' — what the domain asks receivers to do with failures. */
    policy: string | null;
    record: string | null;
    /** Set when the lookup itself failed, as opposed to finding nothing. */
    error?: string;
}

/**
 * Look up `_dmarc.<domain>`.
 *
 * ⚠️ Checked on the ROOT domain, not the sending subdomain. A DMARC record on mail.acme.com is
 * inherited from acme.com when the subdomain has none of its own, and it is the root that receivers
 * fall back to — so reporting "no DMARC" because a subdomain lacks its own record would be wrong
 * and would send a tenant to add something they do not need.
 */
export async function checkDmarc(domain: string): Promise<DmarcResult> {
    const clean = String(domain || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    if (!/^[a-z0-9.-]{3,253}\.[a-z]{2,}$/.test(clean)) {
        return { found: false, policy: null, record: null, error: 'Not a domain we can look up.' };
    }

    // mail.acme.com → acme.com. Naive last-two-labels, which is wrong for co.uk-style suffixes —
    // so BOTH are tried and the first record found wins.
    const parts = clean.split('.');
    const candidates = [clean];
    for (let i = 1; i < parts.length - 1; i++) {
        const parent = parts.slice(i).join('.');
        if (parent.split('.').length >= 2) candidates.push(parent);
    }

    for (const host of candidates) {
        try {
            const records = await dns.resolveTxt(`_dmarc.${host}`);
            const joined = records.map((chunks) => chunks.join('')).find((r) => /^v=DMARC1/i.test(r.trim()));
            if (!joined) continue;
            const policy = (joined.match(/;\s*p\s*=\s*([a-z]+)/i)?.[1] || '').toLowerCase() || null;
            return { found: true, policy, record: joined.slice(0, 500) };
        } catch (err) {
            const code = (err as { code?: string })?.code;
            // ENOTFOUND / ENODATA mean "no record here", which is an answer, not a failure — keep
            // walking up. Anything else is the lookup itself going wrong and is reported as such,
            // because "we could not check" must not be shown as "you have no DMARC".
            if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'ESERVFAIL') continue;
            return { found: false, policy: null, record: null, error: 'The DNS lookup did not complete.' };
        }
    }
    return { found: false, policy: null, record: null };
}

/** What to tell the tenant, given what the lookup found. */
export function dmarcAdvice(result: DmarcResult): { severity: 'warning' | 'note'; message: string } {
    if (result.error) {
        return { severity: 'note', message: 'We could not check your DMARC record just now — that is our lookup failing, not a problem with your domain.' };
    }
    if (!result.found) {
        return {
            severity: 'warning',
            message: 'This domain publishes no DMARC record. Gmail and Yahoo require bulk senders to have one, and without it nothing tells a receiver what to do with mail that forges your address. Adding a TXT record at _dmarc.yourdomain.com with "v=DMARC1; p=none; rua=mailto:you@yourdomain.com" is the usual first step — it asks for reports without changing how anything is delivered.',
        };
    }
    if (result.policy === 'none') {
        return {
            severity: 'note',
            message: 'You publish DMARC with p=none, which satisfies the bulk sender requirements and collects reports without affecting delivery. Once those reports look clean, moving to p=quarantine is what actually stops somebody forging your address.',
        };
    }
    return {
        severity: 'note',
        message: `You publish DMARC with p=${result.policy || 'set'} — the strong position. Forged mail claiming to be from you is acted on rather than delivered.`,
    };
}
