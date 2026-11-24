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
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { partnerRatePeriods, partners, users } from '../../db/schema';
import { sendEmail, sendTemplatedEmail } from './email';
import { ensureReferralCode } from './referral-code';
import { createNotification } from './notify';
import { resolvePeriodAt } from './partner-rate-periods';
import { rateLine } from './partner-onboarding';
import { PARTNER_TERMS_VERSION } from '../config/partner-terms';
import { recordTermsAcceptance } from './partner-terms-acceptance';

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

/**
 * Terms 2.1 / 4.5 / 4.6 (cross-border review 2026-11-23): where the partner is based and whether they join as
 * an individual (sole trader / freelancer) or a business — needed for VAT, sanctions checks and which
 * country's rules apply. The form's <select> (partners.html) must list exactly these codes.
 */
export const PARTNER_COUNTRIES: Record<string, string> = {
    GB: 'United Kingdom',
    US: 'United States',
    CA: 'Canada',
    AU: 'Australia',
    NZ: 'New Zealand',
    IE: 'Ireland',
    AT: 'Austria',
    BE: 'Belgium',
    BG: 'Bulgaria',
    HR: 'Croatia',
    CY: 'Cyprus',
    CZ: 'Czechia',
    DK: 'Denmark',
    EE: 'Estonia',
    FI: 'Finland',
    FR: 'France',
    DE: 'Germany',
    GR: 'Greece',
    HU: 'Hungary',
    IT: 'Italy',
    LV: 'Latvia',
    LT: 'Lithuania',
    LU: 'Luxembourg',
    MT: 'Malta',
    NL: 'Netherlands',
    PL: 'Poland',
    PT: 'Portugal',
    RO: 'Romania',
    SK: 'Slovakia',
    SI: 'Slovenia',
    ES: 'Spain',
    SE: 'Sweden',
    CH: 'Switzerland',
    NO: 'Norway',
    IS: 'Iceland',
    OTHER: 'Somewhere else',
};
export const JOINING_AS = { individual: 'An individual (sole trader or freelancer)', business: 'A business' } as const;

export interface ApplicationInput {
    name: string; email: string; channels: string[]; audience: string; links: string; message: string;
    country: string; joiningAs: keyof typeof JOINING_AS;
}

/** Tidy and check what the form sent. Errors are written for the applicant. */
export function validateApplication(raw: Record<string, unknown>): { ok: true; value: ApplicationInput } | { ok: false; error: string } {
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const name = str(raw.name, 120);
    const email = str(raw.email, 254).toLowerCase();
    const channels = (Array.isArray(raw.channels) ? raw.channels : [])
        .map(String).filter((c) => (PROMOTION_CHANNELS as readonly string[]).includes(c)).slice(0, PROMOTION_CHANNELS.length);
    const country = str(raw.country, 8).toUpperCase();
    const joiningAs = str(raw.joiningAs, 16) as keyof typeof JOINING_AS;
    const value = { name, email, channels: [...new Set(channels)], audience: str(raw.audience, 200), links: str(raw.links, 1000), message: str(raw.message, 2000), country, joiningAs };
    if (!name) return { ok: false, error: 'Please tell us your name.' };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'Please enter a valid email address.' };
    if (!value.channels.length) return { ok: false, error: 'Please tell us how you would promote Be More Swan.' };
    if (!PARTNER_COUNTRIES[country]) return { ok: false, error: 'Please choose the country where you’re based.' };
    if (!(joiningAs in JOINING_AS)) return { ok: false, error: 'Please tell us whether you’re joining as an individual or a business.' };
    if (raw.consent !== true) return { ok: false, error: 'Please tick the box so we can contact you about your application.' };
    if (raw.acceptTerms !== true) return { ok: false, error: 'Please read and accept the Partner Terms.' };
    return { ok: true, value };
}

/** The answers as the admin screen and the Partner Ops chat show them. */
export function applicationAnswers(v: ApplicationInput): Record<string, string> {
    const out: Record<string, string> = {
        'Based in': PARTNER_COUNTRIES[v.country] || v.country,
        'Joining as': JOINING_AS[v.joiningAs] || v.joiningAs,
        'How they will promote': v.channels.map((c) => CHANNEL_LABELS[c] || c).join(', '),
    };
    if (v.audience) out['Audience'] = v.audience;
    if (v.links) out['Links'] = v.links;
    if (v.message) out['Message'] = v.message;
    return out;
}

export type ApplyOutcome = 'created' | 'duplicate';

/**
 * Record an application. One per email (unique index); a repeat changes nothing and reports
 * 'duplicate' — the caller shows the same thank-you either way, so the form never reveals whether
 * an address is already a partner. Links to the account with the SAME email as the application.
 *
 * ⚠️ Being signed in does not make the application yours. This used to take the signed-in user
 * whatever email was typed, so a customer applying for a colleague or an agency address had that
 * application tied to their own account (the approval went to THEIR inbox) — or, if they were
 * already a partner, the new application was reported as 'duplicate' and silently dropped behind
 * the same thank-you (SWAN-14, 2026-11-01). The email decides, so the session is not consulted.
 */
export async function recordApplication(db: Db, v: ApplicationInput): Promise<{ outcome: ApplyOutcome; partnerId: number | null }> {
    const [u] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${v.email}`).limit(1);
    // The account the email belongs to. If that is the signed-in user, this finds them anyway.
    const userId = u?.id ?? null;
    if (userId) {
        const [existing] = await db.select({ id: partners.id }).from(partners).where(eq(partners.userId, userId)).limit(1);
        if (existing) return { outcome: 'duplicate', partnerId: existing.id };
    }
    const inserted = await db.insert(partners).values({
        userId, status: 'applied', applicantName: v.name, applicantEmail: v.email, application: applicationAnswers(v),
        termsVersion: PARTNER_TERMS_VERSION, termsAcceptedAt: new Date(),
    }).onConflictDoNothing().returning({ id: partners.id });
    if (!inserted.length) return { outcome: 'duplicate', partnerId: null };
    // Terms 1.2: keep the acceptance and email them a copy. Best-effort — the application stands.
    await recordTermsAcceptance(db, { partnerId: inserted[0].id, userId, applicantEmail: v.email, channel: 'application', email: v.email, firstName: v.name.split(/\s+/)[0] })
        .catch((err) => console.error('[partner-applications] acceptance record failed:', err));
    return { outcome: 'created', partnerId: inserted[0].id };
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
        html: `<p style="margin:0 0 12px;"><strong>${esc(v.name)}</strong> (${esc(v.email)}) applied to be a Be More Swan partner.</p>${rows}<p style="margin:16px 0 0;"><a href="${baseUrl()}/admin.html?view=partners">Review it in Admin → Money → Partners</a> (application #${partnerId}).</p>`,
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
        // The welcome states their rate and opens the Partner page itself (docs/partner-onboarding-plan.md §2),
        // where the Partner Assistant greets them — it used to say "sign in" and land on the workspace home.
        const rate = await currentRateLine(db, partnerId);
        await send({ triggerKey: 'partner_approved', to: row.email, vars: {
            user: { first_name: row.firstName || row.applicantName?.split(/\s+/)[0] || '' },
            partner: { rate_line: rate },
            link: { action_url: partnerPageUrl() },
        } });
        await notifyApproved(db, row.userId);
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
    if (updated.length) {
        await ensureReferralCode(db, userId);   // their invite link needs a code
        await notifyApproved(db, userId);       // the bell points them at their Partner page
    }
    return updated.length > 0;
}

const partnerPageUrl = () => `${baseUrl()}/workspace.html?view=partner`;

/**
 * Their rate, in one line, for the welcome email: a special rate waiting to start on acceptance (partner-start.ts) wins
 * over today's programme rate (review of #838). Falls back to the template's default.
 */
async function currentRateLine(db: Db, partnerId: number): Promise<string> {
    try {
        const waiting = (await db.execute(sql`SELECT rate_bps, cost_deduction_bps, duration_months FROM partner_pending_rates WHERE partner_id = ${partnerId}`)) as unknown as Array<Record<string, any>>;
        if (waiting[0]) return rateLine({ rateBps: Number(waiting[0].rate_bps), costDeductionBps: Number(waiting[0].cost_deduction_bps), durationMonths: waiting[0].duration_months == null ? null : Number(waiting[0].duration_months) });
        const periods = await db.select().from(partnerRatePeriods)
            .where(or(isNull(partnerRatePeriods.partnerId), eq(partnerRatePeriods.partnerId, partnerId)));
        const t = resolvePeriodAt(periods, partnerId, new Date());
        return t ? rateLine(t) : 'commission';
    } catch (err) {
        console.error('[partner-applications] rate lookup failed (non-blocking):', err);
        return 'commission';
    }
}

/** In-app welcome (notifications.js opens the Partner page for action 'partner_page'). Never throws. */
async function notifyApproved(db: Db, userId: number): Promise<void> {
    await createNotification(db, 'partner_approved', { userId, metadata: { action: 'partner_page' } })
        .catch((err) => console.error('[partner-applications] approval notification failed (non-blocking):', err));
}
