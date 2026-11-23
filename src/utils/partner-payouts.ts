// src/utils/partner-payouts.ts
// Affiliate Partner Programme, step 5 — where a partner's commission is paid
// (docs/affiliate-partner-programme-plan.md §4.6).
//
// A change NEVER applies straight away — it is what an account thief would change:
//   1. requestPayoutChange: the new details go to the vault as PENDING (aura/partner-<id>/payout-pending),
//      a masked summary and a hashed 24-hour token go on the partner row, and the partner's ACCOUNT
//      email gets a link to /workspace.html?view=partner&payoutToken=<token>.
//   2. The link opens the Partner page, which needs them signed in, and they press Confirm —
//      confirmPayoutChange. (Not a GET that confirms on open: email link-scanners open links.)
//   3. Confirmed → the pending secret becomes aura/partner-<id>/payout, and a "your payout details
//      changed" email goes to the same address, so a change they didn't make is noticed.
//
// Only masked summaries leave this module. UK bank accounts, US bank accounts (since 2026-11-23 — paid via
// Wise in USD; db/z-partner-us-bank.sql), euro bank accounts by IBAN (paid via Wise in EUR; db/z-partner-eu-bank.sql),
// PayPal or Wise (by email).

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { partners, users } from '../../db/schema';
import { getSecret, storeSecret, deleteSecret } from './vault';
import { sendTemplatedEmail } from './email';

type Db = ReturnType<typeof getDb>;

export const PAYOUT_METHODS = ['paypal', 'wise', 'bank', 'us_bank', 'eu_bank'] as const;

/**
 * An IBAN: country code, 2 check digits, then the account (up to 30 letters/digits); valid when the ISO 13616
 * mod-97 check gives 1. Catches almost every typo or swapped digit. Spaces are ignored, letters upper-cased.
 */
export function normaliseIban(v: unknown): string { return String(v || '').replace(/\s+/g, '').toUpperCase(); }
export function isValidIban(raw: unknown): boolean {
    const iban = normaliseIban(raw);
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
    const moved = iban.slice(4) + iban.slice(0, 4);
    let rem = 0;
    for (const ch of moved) {
        const n = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
        for (const d of n) rem = (rem * 10 + Number(d)) % 97;
    }
    return rem === 1;
}
/** A BIC / SWIFT code: 4 bank letters, 2 country letters, 2 location characters, optional 3-character branch. */
export function isValidBic(raw: unknown): boolean { return /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(String(raw || '').replace(/\s+/g, '').toUpperCase()); }

/** US states, DC and territories — the 2-letter codes Wise accepts for a US recipient's address. */
export const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','PR','GU','VI','AS','MP'] as const;

/** An ABA routing number: 9 digits whose weighted sum (3,7,1 repeating) is a multiple of 10. Catches most typos. */
export function isValidRoutingNumber(v: string): boolean {
    if (!/^\d{9}$/.test(v)) return false;
    const d = v.split('').map(Number);
    const sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
    return sum % 10 === 0 && sum > 0;
}
export type PayoutMethod = typeof PAYOUT_METHODS[number];
export const PAYOUT_CONFIRM_TTL_HOURS = 24;
export const PAYOUT_REQUEST_LIMIT = { maxAttempts: 5, windowSecs: 3600 };

export const payoutRefKey = (partnerId: number) => `aura/partner-${partnerId}/payout`;
export const pendingPayoutRefKey = (partnerId: number) => `aura/partner-${partnerId}/payout-pending`;
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
const baseUrl = () => (process.env.BASE_URL || 'https://bemoreswan.com').replace(/\/$/, '');

export type PayoutDetails =
    | { method: 'paypal' | 'wise'; email: string }
    // holderType added 2026-11-23 (Wise: PERSON vs INSTITUTION); details saved before then have none → person.
    | { method: 'bank'; accountName: string; sortCode: string; accountNumber: string; holderType?: 'person' | 'business' }
    | {
        method: 'us_bank'; accountName: string; holderType: 'person' | 'business';
        routingNumber: string; accountNumber: string; accountType: 'checking' | 'savings';
        // Wise needs the recipient's address to pay a US account.
        addressLine: string; city: string; state: string; zip: string;
    }
    | { method: 'eu_bank'; accountName: string; holderType: 'person' | 'business'; iban: string; bic: string | null };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Check what the partner typed. Errors are written for them. */
export function validatePayoutDetails(raw: Record<string, unknown>): { ok: true; value: PayoutDetails } | { ok: false; error: string } {
    const method = String(raw.method || '');
    if (method === 'paypal' || method === 'wise') {
        const email = String(raw.email || '').trim().toLowerCase();
        if (!EMAIL_RE.test(email) || email.length > 254) return { ok: false, error: `Enter the email address of your ${method === 'paypal' ? 'PayPal' : 'Wise'} account.` };
        return { ok: true, value: { method, email } };
    }
    if (method === 'bank') {
        const accountName = String(raw.accountName || '').trim().slice(0, 140);
        const sortCode = String(raw.sortCode || '').replace(/[\s-]/g, '');
        const accountNumber = String(raw.accountNumber || '').replace(/\s/g, '');
        const holderType = raw.holderType === 'business' ? 'business' : raw.holderType === 'person' ? 'person' : null;
        if (!accountName) return { ok: false, error: 'Enter the name on the bank account.' };
        if (!holderType) return { ok: false, error: 'Say whether the account belongs to you personally or to a business.' };
        if (!/^\d{6}$/.test(sortCode)) return { ok: false, error: 'A sort code is 6 digits, e.g. 12-34-56.' };
        if (!/^\d{8}$/.test(accountNumber)) return { ok: false, error: 'A UK account number is 8 digits.' };
        return { ok: true, value: { method, accountName, sortCode, accountNumber, holderType } };
    }
    if (method === 'us_bank') {
        const t = (v: unknown, max: number) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
        const accountName = t(raw.accountName, 140);
        const holderType = raw.holderType === 'business' ? 'business' : raw.holderType === 'person' ? 'person' : null;
        const routingNumber = String(raw.routingNumber || '').replace(/[\s-]/g, '');
        const accountNumber = String(raw.accountNumber || '').replace(/[\s-]/g, '');
        const accountType = raw.accountType === 'savings' ? 'savings' : raw.accountType === 'checking' ? 'checking' : null;
        const addressLine = t(raw.addressLine, 140);
        const city = t(raw.city, 80);
        const state = String(raw.state || '').trim().toUpperCase();
        const zip = String(raw.zip || '').trim();
        if (!accountName) return { ok: false, error: 'Enter the name on the bank account.' };
        if (!holderType) return { ok: false, error: 'Say whether the account belongs to you personally or to a business.' };
        if (!isValidRoutingNumber(routingNumber)) return { ok: false, error: 'That routing number doesn’t look right — it is 9 digits, printed at the bottom left of a check or in your bank’s app.' };
        if (!/^\d{4,17}$/.test(accountNumber)) return { ok: false, error: 'A US account number is 4 to 17 digits.' };
        if (!accountType) return { ok: false, error: 'Choose checking or savings.' };
        if (!addressLine || !city) return { ok: false, error: 'Enter the account holder’s street address and city — Wise needs them to pay a US account.' };
        if (!(US_STATES as readonly string[]).includes(state)) return { ok: false, error: 'Choose the state (2 letters, e.g. NY).' };
        if (!/^\d{5}(-\d{4})?$/.test(zip)) return { ok: false, error: 'A ZIP code is 5 digits (or ZIP+4, e.g. 10001-1234).' };
        return { ok: true, value: { method, accountName, holderType, routingNumber, accountNumber, accountType, addressLine, city, state, zip } };
    }
    if (method === 'eu_bank') {
        const accountName = String(raw.accountName || '').replace(/\s+/g, ' ').trim().slice(0, 140);
        const holderType = raw.holderType === 'business' ? 'business' : raw.holderType === 'person' ? 'person' : null;
        const iban = normaliseIban(raw.iban);
        const bicRaw = String(raw.bic || '').replace(/\s+/g, '').toUpperCase();
        if (!accountName) return { ok: false, error: 'Enter the name on the bank account.' };
        if (!holderType) return { ok: false, error: 'Say whether the account belongs to you personally or to a business.' };
        if (!isValidIban(iban)) return { ok: false, error: 'That IBAN doesn’t look right — check it against your bank statement or app (it starts with 2 letters, e.g. DE89 3704…).' };
        if (bicRaw && !isValidBic(bicRaw)) return { ok: false, error: 'That BIC (SWIFT code) doesn’t look right — it is 8 or 11 letters and numbers, e.g. COBADEFFXXX. You can leave it blank.' };
        return { ok: true, value: { method, accountName, holderType, iban, bic: bicRaw || null } };
    }
    return { ok: false, error: 'Choose how you would like to be paid: PayPal, Wise, a UK bank account, a US bank account or a euro bank account.' };
}

/** The only form payout details are ever shown in. */
export function maskPayoutDetails(d: PayoutDetails): string {
    if (d.method === 'bank') return `UK bank · ${d.accountName} · ****${d.accountNumber.slice(-4)}`;
    // US account numbers can be as short as 4 digits: show at most half of them, never the whole number (review of #819).
    if (d.method === 'eu_bank') return `Euro bank · ${d.accountName} · ${d.iban.slice(0, 2)}** ****${d.iban.slice(-4)}`;
    if (d.method === 'us_bank') return `US bank · ${d.accountName} · ${d.accountType} ****${d.accountNumber.slice(-Math.min(4, Math.floor(d.accountNumber.length / 2)))}`;
    const [local, domain] = d.email.split('@');
    return `${d.method === 'paypal' ? 'PayPal' : 'Wise'} · ${local.slice(0, 1)}***@${domain}`;
}

/** Start a change: pending in the vault, confirmation link to the ACCOUNT email. */
export async function requestPayoutChange(
    db: Db, partnerId: number, details: PayoutDetails, now = new Date(),
    send: typeof sendTemplatedEmail = sendTemplatedEmail,   // test seam: tests pass a recorder
): Promise<{ display: string; sentTo: string | null }> {
    const [row] = await db.select({ email: users.email, firstName: users.firstName })
        .from(partners).innerJoin(users, eq(users.id, partners.userId)).where(eq(partners.id, partnerId)).limit(1);
    if (!row?.email) throw new Error('This partner has no account email to confirm with.');
    const token = randomBytes(32).toString('base64url');
    const display = maskPayoutDetails(details);
    await storeSecret(db as never, pendingPayoutRefKey(partnerId), details as unknown as Record<string, unknown>);
    await db.update(partners).set({
        payoutPendingMethod: details.method, payoutPendingDisplay: display,
        payoutPendingTokenHash: hashToken(token), payoutPendingExpiresAt: new Date(now.getTime() + PAYOUT_CONFIRM_TTL_HOURS * 3_600_000),
        updatedAt: now,
    }).where(eq(partners.id, partnerId));
    await send({ triggerKey: 'partner_payout_confirm', to: row.email, vars: {
        user: { first_name: row.firstName || '' },
        partner: { payout_display: display },
        link: { action_url: `${baseUrl()}/workspace.html?view=partner&payoutToken=${encodeURIComponent(token)}` },
    } });
    return { display, sentTo: row.email };
}

/**
 * Confirm a pending change. The token must be live AND belong to this partner (the caller passes the
 * signed-in user's partner id), so a forwarded link is useless to anyone else. Conditional on the
 * token hash, so it applies once.
 */
export async function confirmPayoutChange(db: Db, partnerId: number, token: string, now = new Date()): Promise<{ ok: true; display: string } | { ok: false; error: string }> {
    if (!token || token.length < 20 || token.length > 100) return { ok: false, error: 'That confirmation link is not valid.' };
    const [row] = await db.select({ method: partners.payoutPendingMethod, display: partners.payoutPendingDisplay, email: users.email, firstName: users.firstName })
        .from(partners).innerJoin(users, eq(users.id, partners.userId))
        .where(and(eq(partners.id, partnerId), eq(partners.payoutPendingTokenHash, hashToken(token)), gt(partners.payoutPendingExpiresAt, now)))
        .limit(1);
    if (!row?.method || !row.display) return { ok: false, error: 'That confirmation link has expired or has already been used. Enter your payout details again to get a new one.' };
    const pending = await getSecret(db as never, pendingPayoutRefKey(partnerId));
    if (!pending) return { ok: false, error: 'We could not find the details to confirm. Please enter them again.' };

    const applied = await db.update(partners).set({
        payoutMethod: row.method, payoutDisplay: row.display, payoutDetailsConfirmedAt: now,
        payoutPendingMethod: null, payoutPendingDisplay: null, payoutPendingTokenHash: null, payoutPendingExpiresAt: null, updatedAt: now,
    }).where(and(eq(partners.id, partnerId), eq(partners.payoutPendingTokenHash, hashToken(token)))).returning({ id: partners.id });
    if (!applied.length) return { ok: false, error: 'That confirmation link has already been used.' };

    await storeSecret(db as never, payoutRefKey(partnerId), pending);
    await deleteSecret(db as never, pendingPayoutRefKey(partnerId));
    if (row.email) {
        await sendTemplatedEmail({ triggerKey: 'partner_payout_changed', to: row.email, vars: {
            user: { first_name: row.firstName || '' }, partner: { payout_display: row.display },
        } }).catch((err) => console.error('[partner-payouts] changed email failed:', err));
    }
    return { ok: true, display: row.display };
}

/** Drop a pending change (the partner changed their mind, or typed it wrong). */
export async function cancelPayoutChange(db: Db, partnerId: number): Promise<void> {
    await db.update(partners).set({ payoutPendingMethod: null, payoutPendingDisplay: null, payoutPendingTokenHash: null, payoutPendingExpiresAt: null, updatedAt: new Date() })
        .where(eq(partners.id, partnerId));
    await deleteSecret(db as never, pendingPayoutRefKey(partnerId));
}

/** The confirmed details, for the payout export (step 6). Never sent to a browser. */
export async function getPayoutDetails(db: Db, partnerId: number): Promise<PayoutDetails | null> {
    return (await getSecret(db as never, payoutRefKey(partnerId))) as PayoutDetails | null;
}
