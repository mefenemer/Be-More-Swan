// src/utils/email.ts
import { Resend } from 'resend';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { emailTemplates } from '../../db/schema';
import {
    renderMasterTemplate,
    renderMergeVars,
    sanitiseBodyHtml,
    type MergeContext,
} from './email-template';
import { getTemplateDefault } from './email-templates-catalog';

const resendApiKey = process.env.RESEND_API_KEY;

// Initialize the Resend client LAZILY. The resend v6 constructor THROWS on a missing
// key ("Missing API key"). Constructing at module load would crash this module on import
// — taking down every function that imports it (register, admin-api, etc.) with a 500 and
// NO handler logs. Guarding here keeps the dev-mode fallbacks below working as intended:
// when the key is absent we simply skip sending instead of crashing the whole app.
const resend = resendApiKey ? new Resend(resendApiKey) : null;

interface SendEmailParams {
    to: string;
    subject: string;
    html: string;
}

// sendEmail is an alias for sendMagicLinkEmail used by most Netlify functions
export const sendEmail = async ({ to, subject, html }: SendEmailParams) => {
    if (!resend) {
        console.warn(`[DEV MODE] RESEND_API_KEY missing. Simulated email to ${to}`);
        return null;
    }

    // resend v6 returns { data, error } for API-level failures (it does NOT throw on a
    // rejected send); only network/runtime problems throw. Normalise both into `error` so
    // the real reason is always logged verbatim and never silently swallowed.
    const { data, error } = await resend.emails
        .send({ from: 'Be More Swan <noreply@bemoreswan.com>', to, subject, html })
        .catch((err: any) => ({ data: null, error: { name: 'ResendException', message: err?.message ?? String(err) } }));

    if (error) {
        console.error(`[email] Resend rejected message to ${to} (subject: "${subject}"): ${error.name ?? 'Error'} — ${error.message ?? JSON.stringify(error)}`);
        throw new Error(`Resend error: ${error.message ?? error.name ?? 'unknown'}`);
    }
    return data;
};

export function buildAnnualRenewalEmail(firstName: string, renewalDay: string, amount: string): string {
    return `
        <p>Hi ${firstName},</p>
        <p>Your Be More Swan annual subscription will automatically renew on <strong>${renewalDay}</strong>${amount ? ` for <strong>${amount}</strong>` : ''}.</p>
        <p>If you wish to cancel before this date, you can do so at any time from your <a href="${process.env.BASE_URL || 'https://bemoreswan.com'}/billing.html">account settings</a>. Cancellations take effect at the end of your current billing period.</p>
        <p>If you have any questions, reply to this email or contact our support team.</p>
        <p>Thank you for being an Be More Swan customer.</p>
        <p>— The Be More Swan Team</p>
    `;
}

export function buildDunningEmail(firstName: string, amount: string, nextRetryLine: string, assistantWarning: string, portalUrl: string): string {
    return `<p>Hi ${firstName},</p>
            <p>We were unable to process your subscription payment.</p>
            <p>💰 <strong>Amount:</strong> ${amount}</p>
            ${nextRetryLine}
            ${assistantWarning}
            <p style="margin-top:24px;">
              <a href="${portalUrl}" style="background:#dc2626;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
                Update Payment Details →
              </a>
            </p>
            <p style="margin-top:16px;font-size:0.875rem;color:#6b7280;">
              Questions? <a href="mailto:hello@bemoreswan.com">Contact our support team</a>.
            </p>
            <p>The Be More Swan Team</p>`;
}

export const sendMagicLinkEmail = async ({ to, subject, html }: SendEmailParams) => {
    if (!resend) {
        console.warn(`[DEV MODE] RESEND_API_KEY missing. Simulated email to ${to}`);
        return null;
    }

    // resend v6 returns { data, error } for API-level failures (it does NOT throw on a
    // rejected send); only network/runtime problems throw. Normalise both so the real
    // reason is always logged verbatim instead of a generic "Failed to send email."
    const { data, error } = await resend.emails
        // IMPORTANT: the `from` domain must be verified in the Resend dashboard.
        .send({ from: 'Be More Swan <noreply@bemoreswan.com>', to, subject, html })
        .catch((err: any) => ({ data: null, error: { name: 'ResendException', message: err?.message ?? String(err) } }));

    if (error) {
        console.error(`[email] Resend rejected magic-link to ${to} (subject: "${subject}"): ${error.name ?? 'Error'} — ${error.message ?? JSON.stringify(error)}`);
        throw new Error(`Resend error: ${error.message ?? error.name ?? 'unknown'}`);
    }
    return data;
};

// ─────────────────────────────────────────────────────────────────────────────
// US-COMMS-1: Templated transactional email.
//
// renderTemplate() resolves a trigger to a ready-to-send { subject, html } using the
// admin-edited DB template when present, else the in-code catalog default. It NEVER throws
// for a missing template — a transactional email must not be lost. sendTemplatedEmail()
// renders + delivers via Resend; the admin preview/test endpoints reuse renderTemplate()
// directly so what admins see is exactly what ships.
// ─────────────────────────────────────────────────────────────────────────────

export interface RenderedTemplate {
    subject: string;
    html: string;
    /** False when an admin has deactivated a non-critical template — callers should skip sending. */
    isActive: boolean;
    /** True when resolved from the in-code catalog (DB row missing/unseeded). */
    usedFallback: boolean;
}

interface TemplateSource {
    subject: string;
    bodyHtml: string;
    preheader: string | null;
    transactional: boolean;
    isActive: boolean;
}

/** Load a trigger's content from the DB, falling back to the in-code catalog. */
async function loadTemplateSource(triggerKey: string): Promise<{ src: TemplateSource | null; usedFallback: boolean }> {
    // Try the admin-editable DB row first. Tolerate the table not existing yet (pre-migration).
    try {
        const db = getDb();
        const [row] = await db
            .select({
                subject: emailTemplates.subject,
                bodyHtml: emailTemplates.bodyHtml,
                preheader: emailTemplates.preheader,
                transactional: emailTemplates.transactional,
                isActive: emailTemplates.isActive,
            })
            .from(emailTemplates)
            .where(eq(emailTemplates.triggerKey, triggerKey))
            .limit(1);
        if (row && row.subject && row.bodyHtml) {
            return { src: { ...row, preheader: row.preheader ?? null }, usedFallback: false };
        }
    } catch (err: any) {
        const msg: string = err?.message || '';
        if (!(msg.includes('relation') && msg.includes('does not exist'))) {
            console.error(`[email] DB template read failed for "${triggerKey}":`, msg);
        }
        // fall through to catalog
    }

    const def = getTemplateDefault(triggerKey);
    if (!def) return { src: null, usedFallback: true };
    return {
        src: {
            subject: def.subject,
            bodyHtml: def.bodyHtml,
            preheader: def.preheader ?? null,
            transactional: !!def.transactional,
            isActive: true, // catalog defaults are always considered active
        },
        usedFallback: true,
    };
}

/**
 * Resolve a trigger + merge context into a fully-wrapped { subject, html }. Pass
 * `overrideBody`/`overrideSubject` from the admin editor to preview unsaved edits.
 */
export async function renderTemplate(
    triggerKey: string,
    vars: MergeContext = {},
    opts: { overrideSubject?: string; overrideBody?: string; transactional?: boolean } = {},
): Promise<RenderedTemplate | null> {
    const { src, usedFallback } = await loadTemplateSource(triggerKey);
    if (!src && opts.overrideBody === undefined) return null;

    const subjectRaw = opts.overrideSubject ?? src?.subject ?? '';
    const bodyRaw = opts.overrideBody ?? src?.bodyHtml ?? '';
    const transactional = opts.transactional ?? src?.transactional ?? false;

    // Subjects are plain text (don't HTML-escape); bodies are HTML (sanitise admin input).
    const subject = renderMergeVars(subjectRaw, vars, false);
    const body = renderMergeVars(sanitiseBodyHtml(bodyRaw), vars, false);
    const html = renderMasterTemplate(body, { preheader: src?.preheader ?? undefined, transactional });

    return { subject, html, isActive: src?.isActive ?? true, usedFallback };
}

export interface SendTemplatedParams {
    triggerKey: string;
    to: string;
    /** Nested merge context, e.g. { user: { first_name: 'Jane' }, billing: { amount: '£49' } }. */
    vars?: MergeContext;
}

/**
 * Render a trigger template and deliver it. Returns null (without sending) when the template
 * is missing entirely or has been deactivated by an admin (non-critical mail only — critical
 * triggers are `locked` and can't be deactivated, AC3.2.2).
 */
export async function sendTemplatedEmail({ triggerKey, to, vars = {} }: SendTemplatedParams) {
    const rendered = await renderTemplate(triggerKey, vars);
    if (!rendered) {
        console.error(`[email] No template found for trigger "${triggerKey}" — email NOT sent to ${to}.`);
        return null;
    }
    if (!rendered.isActive) {
        console.log(`[email] Template "${triggerKey}" is inactive — skipping send to ${to}.`);
        return null;
    }
    return sendEmail({ to, subject: rendered.subject, html: rendered.html });
}