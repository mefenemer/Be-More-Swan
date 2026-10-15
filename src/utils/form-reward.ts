// src/utils/form-reward.ts — a sign-up form's free download (a lead magnet).
// The form's definition names a PDF in the workspace's library (FormDefinition.reward, checked at
// save time in audience-forms.ts). This module emails it to the person who signed up, and signs the
// link it sends. netlify/functions/form-download.ts serves the link. tests/form-reward.test.ts.
//
// WHEN: at the moment the person is subscribed — straight away for a single opt-in form, after they
// click "confirm" for a double opt-in one (audience-public.ts calls deliverFormReward at both). The
// download goes ONLY to the inbox that signed up, never onto a page: the email is what proves the
// address is theirs.
//
// THE LINK is an HMAC of (form, asset) under the app's secret — unguessable, so ids can't be walked.
// At every download the form is re-read: if the owner has since removed or replaced the file, the
// old link stops working. It never names an asset the form does not currently offer.

import { createHmac, timingSafeEqual } from 'crypto';
import { eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { audienceForms, organisations } from '../../db/schema';
import { normaliseFormDefinition } from './form-definition';
import { checkRateLimit } from './rate-limit';
import { sendEmail } from './email';

type Db = ReturnType<typeof getDb>;

/** One email per person per form per day — a second sign-up the same day is not a second download email. */
export const REWARD_RESEND = { maxAttempts: 1, windowSecs: 86_400 };

function secret(): string {
    const s = process.env.JWT_SECRET;
    if (!s) throw new Error('JWT_SECRET is not set — cannot sign download links.');
    return s;
}
export function signReward(formId: number, assetId: number, key = secret()): string {
    return createHmac('sha256', key).update(`form-reward:${formId}:${assetId}`).digest('hex').slice(0, 24);
}
export function verifyReward(formId: number, assetId: number, token: string, key?: string): boolean {
    let expected: Buffer;
    try { expected = Buffer.from(signReward(formId, assetId, key ?? secret())); } catch { return false; }
    const given = Buffer.from(String(token || ''));
    return expected.length === given.length && timingSafeEqual(expected, given);
}
/** `baseUrl` is the app's own origin (absolute — it goes in an email). */
export function rewardDownloadUrl(baseUrl: string, formId: number, assetId: number): string {
    return `${String(baseUrl).replace(/\/+$/, '')}/api/forms/download?f=${formId}&a=${assetId}&s=${signReward(formId, assetId)}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function rewardEmail(p: { business: string; label: string; link: string }): { subject: string; html: string } {
    return {
        subject: `Your ${p.label} — ${p.business}`,
        html: `<p>Thanks for signing up. Here's ${esc(p.label.startsWith('your ') ? p.label : `your ${p.label}`)}:</p>
<p><a href="${esc(p.link)}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold">Download it</a></p>
<p style="color:#666;font-size:13px">The link is yours to keep. You're receiving this because you signed up with ${esc(p.business)}.</p>`,
    };
}

/**
 * Email the form's free download to someone who has just become subscribed. Best-effort and never
 * throws: a failed download email must not turn a successful sign-up or confirmation into an error.
 */
export async function deliverFormReward(db: Db, p: { formId: number | null; contactId: number; email: string; baseUrl: string | null }): Promise<boolean> {
    if (!p.formId || !p.baseUrl) return false;
    try {
        const [form] = await db.select({ id: audienceForms.id, definition: audienceForms.definition, organisationId: audienceForms.organisationId, orgName: organisations.name })
            .from(audienceForms).leftJoin(organisations, eq(organisations.id, audienceForms.organisationId))
            .where(eq(audienceForms.id, p.formId)).limit(1);
        if (!form?.definition) return false;
        const reward = normaliseFormDefinition(form.definition).definition.reward;
        if (!reward) return false;
        const limit = await checkRateLimit(db, 'form_reward', `${form.id}:${p.contactId}`, REWARD_RESEND).catch(() => ({ allowed: true }));
        if (!limit.allowed) return false;
        const business = (form.orgName || 'us').replace(/[<>"\\\r\n]/g, '').slice(0, 60);
        const { subject, html } = rewardEmail({ business, label: reward.label, link: rewardDownloadUrl(p.baseUrl, form.id, reward.assetId) });
        await sendEmail({ to: p.email, from: `${business} (via Be More Swan) <noreply@bemoreswan.com>`, subject, html });
        return true;
    } catch (err) {
        console.error('[form-reward] delivery failed', { formId: p.formId }, err instanceof Error ? err.message : err);
        return false;
    }
}
