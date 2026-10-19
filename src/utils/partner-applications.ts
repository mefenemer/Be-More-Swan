// src/utils/partner-applications.ts
// Affiliate Partner Programme, step 4 — applying, approval, and the private account link
// (docs/affiliate-partner-programme-plan.md §4.6; owner decision 2026-10-18: "apply first, account on
// approval").
//
//   /partners form → partner-apply.ts → a partners row, status 'applied', NO account. If the email
//   already belongs to an account, user_id is linked straight away.
//   Admin approves (admin-partners.ts, or a Partner Ops card) → sendApprovalEmail:
//     • has an account → "you're approved";
//     • no account     → a one-time link to /register?partner=<token> (14 days), which register.ts
//                        honours even while sign-ups are locked, for THAT email only.
//
// The token is random (32 bytes) and only its sha256 is stored, like a password-reset token.

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { partners, users } from '../../db/schema';
import { sendEmail, sendTemplatedEmail } from './email';
import { ensureReferralCode } from './referral-code';
import { PARTNER_TERMS_VERSION } from '../config/partner-terms';

type Db = ReturnType<typeof getDb>;

export const INVITE_TTL_DAYS = 14;
export const APPLY_LIMITS = {
    perIp: { maxAttempts: 5, windowSecs: 3600 },
    perEmail: { maxAttempts: 3, windowSecs: 86_400 },
    /** A form filled in faster than this was not filled in by a person (same rule as the taster). */
    minFillMs: 1500,
};
export const PROMOTION_CHANNELS = ['newsletter', 'social', 'blog_video', 'clients', 'community', 'events', 'other'] as const;
const CHANNEL_LABELS: Record<string, string> = {
    newsletter: 'Email newsletter', social: 'Social media', blog_video: 'Blog, podcast or YouTube',
    clients: 'My own clients (consultancy / agency)', community: 'A community or membership', events: 'Events or workshops', other: 'Something else',
};

const baseUrl = () => (process.env.BASE_URL || 'https://bemoreswan.com').replace(/\/$/, '');
const FOUNDER_EMAIL = process.env.FOUNDER_ALERT_EMAIL || 'hello@bemoreswan.com';

export function hashInviteToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

export function newInviteToken(now = new Date()): { token: string; hash: string; expiresAt: Date } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: hashInviteToken(token), expiresAt: new Date(now.getTime() + INVITE_TTL_DAYS * 86_400_000) };
}

export interface ApplicationInput {
    name: string; email: string; channels: string[]; audience: string; links: string; message: string;
}

/** Tidy and check what the form sent. Errors are written for the applicant. */
export function validateApplication(raw: Record<string, unknown>): { ok: true; value: ApplicationInput } | { ok: false; error: string } {
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const name = str(raw.name, 120);
    const email = str(raw.email, 254).toLowerCase();
    const channels = (Array.isArray(raw.channels) ? raw.channels : [])
        .map(String).filter((c) => (PROMOTION_CHANNELS as readonly string[]).includes(c)).slice(0, PROMOTION_CHANNELS.length);
    const value = { name, email, channels: [...new Set(channels)], audience: str(raw.audience, 200), links: str(raw.links, 1000), message: str(raw.message, 2000) };
    if (!name) return { ok: false, error: 'Please tell us your name.' };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'Please enter a valid email address.' };
    if (!value.channels.length) return { ok: false, error: 'Please tell us how you would promote Be More Swan.' };
    if (raw.consent !== true) return { ok: false, error: 'Please tick the box so we can contact you about your application.' };
    if (raw.acceptTerms !== true) return { ok: false, error: 'Please read and accept the Partner Terms.' };
    return { ok: true, value };
}

/** The answers as the admin screen and the Partner Ops chat show them. */
export function applicationAnswers(v: ApplicationInput): Record<string, string> {
    const out: Record<string, string> = { 'How they will promote': v.channels.map((c) => CHANNEL_LABELS[c] || c).join(', ') };
    if (v.audience) out['Audience'] = v.audience;
    if (v.links) out['Links'] = v.links;
    if (v.message) out['Message'] = v.message;
    return out;
}

export type ApplyOutcome = 'created' | 'duplicate';

/**
 * Record an application. One per email (unique index); a repeat changes nothing and reports
 * 'duplicate' — the caller shows the same thank-you either way, so the form never reveals whether
 * an address is already a partner. Links to an existing account with the same email, or to the
 * signed-in user.
 */
export async function recordApplication(db: Db, v: ApplicationInput, signedInUserId: number | null): Promise<{ outcome: ApplyOutcome; partnerId: number | null }> {
    let userId = signedInUserId;
    if (!userId) {
        const [u] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${v.email}`).limit(1);
        userId = u?.id ?? null;
    }
    if (userId) {
        const [existing] = await db.select({ id: partners.id }).from(partners).where(eq(partners.userId, userId)).limit(1);
        if (existing) return { outcome: 'duplicate', partnerId: existing.id };
    }
    const inserted = await db.insert(partners).values({
        userId, status: 'applied', applicantName: v.name, applicantEmail: v.email, application: applicationAnswers(v),
        termsVersion: PARTNER_TERMS_VERSION, termsAcceptedAt: new Date(),
    }).onConflictDoNothing().returning({ id: partners.id });
    return inserted.length ? { outcome: 'created', partnerId: inserted[0].id } : { outcome: 'duplicate', partnerId: null };
}

/** The applicant's "we've got it" email and the founder's heads-up. Both best-effort. */
export async function sendApplicationEmails(v: ApplicationInput, partnerId: number): Promise<void> {
    await sendTemplatedEmail({ triggerKey: 'partner_application_received', to: v.email, vars: { user: { first_name: v.name.split(/\s+/)[0] } } })
        .catch((err) => console.error('[partner-applications] applicant email failed:', err));
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    const rows = Object.entries(applicationAnswers(v)).map(([k, val]) => `<p style="margin:0 0 8px;"><strong>${esc(k)}:</strong> ${esc(val)}</p>`).join('');
    await sendEmail({
        to: FOUNDER_EMAIL,
        subject: `🤝 New partner application: ${v.name}`,
        html: `<p style="margin:0 0 12px;"><strong>${esc(v.name)}</strong> (${esc(v.email)}) applied to be a Be More Swan partner.</p>${rows}<p style="margin:16px 0 0;"><a href="${baseUrl()}/admin.html?view=partners">Review it in Admin → Revenue → Partners</a> (application #${partnerId}).</p>`,
        text: `${v.name} (${v.email}) applied to be a partner.\n${Object.entries(applicationAnswers(v)).map(([k, val]) => `${k}: ${val}`).join('\n')}\nReview: ${baseUrl()}/admin.html?view=partners`,
    }).catch((err) => console.error('[partner-applications] founder alert failed:', err));
}

/**
 * After approval: tell the partner. No account yet → a fresh one-time account link (replacing any
 * earlier one). Returns what was sent so the admin screen can say so.
 */
export async function sendApprovalEmail(
    db: Db, partnerId: number,
    send: typeof sendTemplatedEmail = sendTemplatedEmail,   // test seam: tests pass a recorder
): Promise<{ sent: 'welcome' | 'account_link' | 'none'; to: string | null }> {
    const [row] = await db.select({
        id: partners.id, userId: partners.userId, applicantName: partners.applicantName, applicantEmail: partners.applicantEmail,
        email: users.email, firstName: users.firstName,
    }).from(partners).leftJoin(users, eq(users.id, partners.userId)).where(eq(partners.id, partnerId)).limit(1);
    if (!row) return { sent: 'none', to: null };

    if (row.userId && row.email) {
        await ensureReferralCode(db, row.userId);   // their invite link needs a code
        await send({ triggerKey: 'partner_approved', to: row.email, vars: {
            user: { first_name: row.firstName || row.applicantName?.split(/\s+/)[0] || '' },
            link: { action_url: `${baseUrl()}/workspace.html` },
        } });
        return { sent: 'welcome', to: row.email };
    }
    if (!row.applicantEmail) return { sent: 'none', to: null };
    const { token, hash, expiresAt } = newInviteToken();
    await db.update(partners).set({ inviteTokenHash: hash, inviteExpiresAt: expiresAt, invitedAt: new Date(), updatedAt: new Date() }).where(eq(partners.id, partnerId));
    await send({ triggerKey: 'partner_approved_create_account', to: row.applicantEmail, vars: {
        user: { first_name: row.applicantName?.split(/\s+/)[0] || '' },
        partner: { link_expires_days: String(INVITE_TTL_DAYS) },
        link: { action_url: `${baseUrl()}/register.html?partner=${encodeURIComponent(token)}` },
    } });
    return { sent: 'account_link', to: row.applicantEmail };
}

/**
 * The approved partner a sign-up link belongs to, if it is still good: approved, no account yet,
 * not expired. register.ts also requires the email entered to be the one they applied with.
 */
export async function findPartnerByInviteToken(db: Db, token: string, now = new Date()) {
    if (!token || token.length < 20 || token.length > 100) return null;
    const [row] = await db.select({ id: partners.id, applicantEmail: partners.applicantEmail, applicantName: partners.applicantName })
        .from(partners)
        .where(and(
            eq(partners.inviteTokenHash, hashInviteToken(token)),
            eq(partners.status, 'approved'),
            isNull(partners.userId),
            gt(partners.inviteExpiresAt, now),
        )).limit(1);
    return row ?? null;
}

/** Link the new account to the partner and spend the token. Conditional, so a link works once. */
export async function claimPartnerInvite(db: Db, partnerId: number, userId: number): Promise<boolean> {
    const updated = await db.update(partners)
        .set({ userId, inviteTokenHash: null, inviteExpiresAt: null, updatedAt: new Date() })
        .where(and(eq(partners.id, partnerId), isNull(partners.userId)))
        .returning({ id: partners.id });
    if (updated.length) await ensureReferralCode(db, userId);   // their invite link needs a code
    return updated.length > 0;
}
