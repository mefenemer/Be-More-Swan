// src/utils/sending-domain.ts
// The tenant's own verified sending domain — the default half of the dispatch decision
// (docs/newsletter-assistant-plan.md §6, option 2).
//
// Why a per-tenant domain rather than sending everything from bemoreswan.com: Gmail and Yahoo
// require bulk senders to authenticate with SPF and DKIM ALIGNED TO THE FROM DOMAIN and to keep
// spam complaints low. Pooling every tenant's newsletter behind our one domain would put their
// complaint rate onto the same reputation that carries our magic links and receipts. The failure
// mode is not "a customer's newsletter goes to spam" — it is "nobody can log in because password
// reset emails are being filtered".
//
// ⚠️ THE RESTRICTED-KEY TRAP. A least-privilege Resend "Sending access" key is REJECTED on
// /domains with name 'restricted_api_key' (admin-system-status.ts documents this on the health
// check). Domain provisioning therefore reads RESEND_DOMAINS_API_KEY first and only falls back to
// RESEND_API_KEY — keep the send path on the restricted key and give this one its own. A 401 here
// is surfaced as an operator misconfiguration, not as "your domain failed to verify", because
// those two send the tenant to completely different places.

const RESEND_API = 'https://api.resend.com';

export interface DnsRecord {
    record?: string;
    name: string;
    type: string;
    value: string;
    ttl?: string;
    priority?: number;
    status?: string;
}

export interface SendingDomainResult {
    ok: boolean;
    providerDomainId?: string;
    /** 'pending' | 'verified' | 'failed' — normalised from whatever the provider calls it. */
    status?: 'pending' | 'verified' | 'failed';
    records?: DnsRecord[];
    error?: string;
    /** True when the failure is OUR configuration, not the tenant's DNS. */
    operatorError?: boolean;
}

function domainsKey(): string | undefined {
    return process.env.RESEND_DOMAINS_API_KEY || process.env.RESEND_API_KEY;
}

/**
 * Normalise the provider's status vocabulary to ours.
 *
 * Defensive on purpose: a provider is free to add a state, and an unrecognised one must read as
 * "not verified yet" rather than accidentally matching 'verified' and unlocking sending.
 */
function normaliseStatus(raw: unknown): 'pending' | 'verified' | 'failed' {
    const v = String(raw ?? '').toLowerCase();
    if (v === 'verified') return 'verified';
    if (v === 'failed') return 'failed';
    return 'pending';
}

/** Records come back under different keys across API versions; take whichever exists. */
function readRecords(body: any): DnsRecord[] {
    const list = body?.records ?? body?.data?.records ?? [];
    return Array.isArray(list) ? list : [];
}

async function call(path: string, init: RequestInit): Promise<{ status: number; body: any }> {
    const key = domainsKey();
    if (!key) return { status: 0, body: { name: 'missing_api_key' } };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
        const res = await fetch(`${RESEND_API}${path}`, {
            ...init,
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
            signal: ctrl.signal,
        });
        const body = await res.json().catch(() => ({}));
        return { status: res.status, body };
    } finally {
        clearTimeout(t);
    }
}

/** Turn a provider failure into something a human can act on, and say WHOSE problem it is. */
function classify(status: number, body: any): SendingDomainResult {
    if (status === 0) {
        return { ok: false, operatorError: true, error: 'No Resend API key is configured for domain setup (RESEND_DOMAINS_API_KEY).' };
    }
    if ((status === 401 || status === 403) && body?.name === 'restricted_api_key') {
        // The single most likely deployment mistake, and it looks nothing like what it is.
        return {
            ok: false,
            operatorError: true,
            error: 'The Resend key in use can send email but cannot manage domains. Set RESEND_DOMAINS_API_KEY to a full-access key.',
        };
    }
    if (status === 401 || status === 403) {
        return { ok: false, operatorError: true, error: 'The Resend API key was rejected.' };
    }
    if (status === 422 || status === 400) {
        return { ok: false, error: String(body?.message || 'That domain was not accepted. Check the spelling and try a subdomain such as mail.yourdomain.com.') };
    }
    return { ok: false, error: String(body?.message || `The domain service is unavailable (${status}). Try again shortly.`) };
}

/** Only a subdomain, lowercased. Rejects the shape of a URL, an email, or a bare TLD. */
export function normaliseSendingDomain(raw: string | null | undefined): string | null {
    let v = String(raw ?? '').trim().toLowerCase();
    if (!v) return null;
    v = v.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    if (v.includes('@') || v.includes(' ')) return null;
    if (!/^[a-z0-9.-]+$/.test(v)) return null;
    const parts = v.split('.').filter(Boolean);
    if (parts.length < 2) return null;
    return v;
}

/**
 * Is this a subdomain rather than a root domain?
 *
 * Not enforced — a tenant may insist, and plenty of small businesses genuinely want to send from
 * their root domain. But it is warned about, because sending marketing from the same domain as
 * their invoices means one bad campaign can take both down.
 */
export function isSubdomain(domain: string): boolean {
    return domain.split('.').filter(Boolean).length >= 3;
}

export async function createSendingDomain(domain: string): Promise<SendingDomainResult> {
    const { status, body } = await call('/domains', { method: 'POST', body: JSON.stringify({ name: domain }) });
    if (status < 200 || status >= 300) return classify(status, body);
    return {
        ok: true,
        providerDomainId: String(body?.id ?? ''),
        status: normaliseStatus(body?.status),
        records: readRecords(body),
    };
}

/**
 * Ask the provider to re-check DNS, then read the result.
 *
 * Two calls because they answer different questions: the verify POST triggers a fresh lookup, the
 * GET reports what it found. Firing only the POST and trusting its response would report the state
 * BEFORE the check on some responses.
 */
export async function checkSendingDomain(providerDomainId: string): Promise<SendingDomainResult> {
    if (!providerDomainId) return { ok: false, error: 'This domain has not been registered with the mail provider yet.' };
    await call(`/domains/${encodeURIComponent(providerDomainId)}/verify`, { method: 'POST' }).catch(() => ({ status: 0, body: {} }));
    const { status, body } = await call(`/domains/${encodeURIComponent(providerDomainId)}`, { method: 'GET' });
    if (status < 200 || status >= 300) return classify(status, body);
    return {
        ok: true,
        providerDomainId,
        status: normaliseStatus(body?.status ?? body?.data?.status),
        records: readRecords(body),
    };
}

export async function deleteSendingDomain(providerDomainId: string): Promise<void> {
    if (!providerDomainId) return;
    // Best effort: the local row is what gates sending, so a provider-side orphan is untidy, not
    // dangerous, and must not block a tenant from removing a domain they no longer own.
    await call(`/domains/${encodeURIComponent(providerDomainId)}`, { method: 'DELETE' }).catch(() => undefined);
}

/** The From header for a verified domain. `Acme Ltd <hello@mail.acme.com>` */
export function buildFromAddress(row: { fromName?: string | null; fromLocalPart: string; domain: string }, fallbackName: string): string {
    // Strip anything that could restructure the header — the display name is tenant-supplied.
    const name = String(row.fromName || fallbackName || '').replace(/["<>\r\n]/g, '').slice(0, 60).trim();
    const local = String(row.fromLocalPart || 'hello').replace(/[^a-z0-9._-]/gi, '').slice(0, 40) || 'hello';
    const address = `${local}@${row.domain}`;
    return name ? `${name} <${address}>` : address;
}
