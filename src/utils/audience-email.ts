// src/utils/audience-email.ts
// The double opt-in confirmation email — the only message the audience layer sends to a person who
// is not yet a subscriber.
//
// ── Who is it from? ─────────────────────────────────────────────────────────────────────────────
// The recipient typed their address into a form on the TENANT'S website and has never heard of Be
// More Swan. An email headed "Be More Swan" is, from where they are sitting, a stranger emailing
// them seconds after they signed up somewhere else — the single most reportable message this
// product can produce. So the From line names the tenant and says how we relate to them:
//
//     Acme Ltd (via Be More Swan) <noreply@bemoreswan.com>
//
// The ADDRESS stays ours because it is the only domain Resend has verified for this account. When
// per-tenant sending domains land (docs/newsletter-assistant-plan.md §6, option A) this is the
// first thing that should move onto the tenant's own domain.
//
// ── The link is a GET that renders a page, not a GET that confirms ──────────────────────────────
// Mail scanners, corporate link rewriters and antivirus proxies fetch every URL in an email. A
// confirmation that completed on GET would be auto-accepted by those clients on the recipient's
// behalf, which would make double opt-in a formality that confirms itself. The page carries a form
// that POSTs. lead-unsubscribe.ts solved the mirror-image problem (HEAD must not opt anyone out).

import { createHash, randomBytes } from 'crypto';
import { sendEmail } from './email';

/** How long a confirmation link lives. Long enough for a weekend and an inbox backlog. */
export const CONFIRM_TTL_DAYS = 7;
/** At most this many confirmation emails per sign-up, ever. */
export const MAX_CONFIRM_SENDS = 3;
/** And no more often than this. Both bounds exist because the recipient did not ask us again. */
export const CONFIRM_RESEND_COOLDOWN_MS = 60 * 60 * 1000;

export function mintConfirmToken(): string {
    return randomBytes(24).toString('base64url');
}

/** What we store. The token itself only ever exists in the email and in the visitor's click. */
export function hashConfirmToken(token: string): string {
    return createHash('sha256').update(String(token)).digest('hex');
}

export function confirmUrl(baseUrl: string, token: string): string {
    return `${baseUrl.replace(/\/$/, '')}/api/audience/confirm?t=${encodeURIComponent(token)}`;
}

const esc = (s: string): string => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export interface ConfirmationEmailInput {
    to: string;
    firstName?: string | null;
    /** The tenant's organisation name — this is whose list they joined. */
    senderName: string;
    /** The page they signed up on, shown so they can place the request. */
    sourceUrl?: string | null;
    baseUrl: string;
    token: string;
}

export function buildConfirmationEmail(input: ConfirmationEmailInput): { subject: string; html: string; text: string } {
    const url = confirmUrl(input.baseUrl, input.token);
    const who = esc(input.senderName || 'the sender');
    // "there" rather than an empty string: "Hi ," is the classic tell of a broken mailing.
    const hello = esc((input.firstName || '').trim() || 'there');
    const where = input.sourceUrl ? esc(input.sourceUrl) : '';

    const subject = `Please confirm your subscription to ${input.senderName}`;

    const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f9fafb;padding:24px;margin:0;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;">
    <h1 style="font-size:18px;margin:0 0 12px;color:#111827;">One more step, ${hello}</h1>
    <p style="font-size:14px;line-height:1.6;color:#374151;margin:0 0 16px;">
      You asked to receive emails from <strong>${who}</strong>${where ? ` after visiting <span style="color:#6b7280;">${where}</span>` : ''}.
      Click below to confirm — we will not send you anything until you do.
    </p>
    <p style="margin:24px 0;">
      <a href="${esc(url)}" style="display:inline-block;background:#059669;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 20px;border-radius:8px;">Confirm my subscription</a>
    </p>
    <p style="font-size:13px;line-height:1.6;color:#6b7280;margin:0 0 8px;">
      This link expires in ${CONFIRM_TTL_DAYS} days.
    </p>
    <p style="font-size:13px;line-height:1.6;color:#6b7280;margin:0;">
      If you did not sign up, ignore this email — nothing happens and you will not hear from us again.
    </p>
  </div>
</body></html>`;

    const text = [
        `One more step, ${(input.firstName || '').trim() || 'there'}`,
        '',
        `You asked to receive emails from ${input.senderName}${input.sourceUrl ? ` after visiting ${input.sourceUrl}` : ''}.`,
        'Confirm your subscription by opening this link:',
        url,
        '',
        `This link expires in ${CONFIRM_TTL_DAYS} days.`,
        'If you did not sign up, ignore this email — nothing happens and you will not hear from us again.',
    ].join('\n');

    return { subject, html, text };
}

/**
 * Send it. Throws on failure so the caller can decide — the public subscribe endpoint fails the
 * request, because a pending subscription whose confirmation never arrived is a contact that can
 * never be mailed and a visitor who thinks they subscribed.
 */
export async function sendConfirmationEmail(input: ConfirmationEmailInput): Promise<void> {
    const { subject, html, text } = buildConfirmationEmail(input);
    await sendEmail({
        to: input.to,
        subject,
        html,
        text,
        // The display name is the tenant; the address stays on our verified domain. Quotes and
        // angle brackets stripped so a crafted organisation name cannot restructure the header.
        from: `${String(input.senderName || 'Be More Swan').replace(/["<>\r\n]/g, '').slice(0, 60)} (via Be More Swan) <noreply@bemoreswan.com>`,
    });
}
