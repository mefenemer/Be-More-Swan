// src/utils/email-domain.ts
// Helpers for business-domain organisation grouping (#2).
//
// A "business domain" is the host part of an email that is NOT a public/free email
// provider. Only business domains are eligible for domain-based org auto-join — public
// providers (gmail, outlook, …) must never group unrelated users into one tenant.

// Public / free email providers + common disposable domains. Lowercased, host only.
const PUBLIC_EMAIL_DOMAINS = new Set<string>([
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk',
    'live.com', 'live.co.uk', 'msn.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com',
    'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com',
    'gmx.com', 'gmx.net', 'mail.com', 'zoho.com', 'yandex.com', 'pm.me',
    // common disposable providers
    'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'trashmail.com',
]);

/** The lowercased host part of an email, or null if it doesn't look like an email. */
export function domainOf(email: string | null | undefined): string | null {
    const at = (email || '').trim().toLowerCase().lastIndexOf('@');
    if (at < 0) return null;
    const domain = (email as string).trim().toLowerCase().slice(at + 1);
    // Basic sanity: must contain a dot and no whitespace.
    return /^[^\s@]+\.[^\s@]+$/.test(domain) ? domain : null;
}

/** True for free/public/disposable providers that must NOT be used for domain grouping. */
export function isPublicEmailDomain(domain: string | null | undefined): boolean {
    if (!domain) return true; // unknown → treat as public (never group)
    return PUBLIC_EMAIL_DOMAINS.has(domain.trim().toLowerCase());
}

/** The business domain for an email, or null when it's public/invalid (→ no grouping). */
export function businessDomainOf(email: string | null | undefined): string | null {
    const d = domainOf(email);
    return d && !isPublicEmailDomain(d) ? d : null;
}
