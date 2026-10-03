// src/utils/product-update-email.ts
// The weekly "What's new at Be More Swan" email — everything that does not touch the database.
//
//   normaliseDraft()            the one gate for an uploaded draft (the weekly task's JSON)
//   normaliseEdit()             the one gate for an admin's edit in the portal
//   renderProductUpdateEmail()  subject + branded HTML + plain text for ONE recipient
//   productUpdateImageUrl()     the permanent, signed <img src> for a screenshot
//   whatsNewUnsubscribeUrl()    the per-user signed unsubscribe link
//   renderReminderEmail()       the "ready for review" note to hello@bemoreswan.com
//
// See docs/weekly-product-update.md for the whole process.
//
// ⚠️ COPY IS PLAIN TEXT. Headings and bodies come from an AI-written draft and an admin's edits, and
// the email goes to every customer — so nothing in them is ever treated as HTML. The renderer escapes
// it and turns blank lines into paragraphs; that is the only formatting there is.

import { createHmac, timingSafeEqual } from 'crypto';
import { renderMasterTemplate, escapeHtml } from './email-template';

// ── Limits ─────────────────────────────────────────────────────────────────────────────────────
export const LIMITS = {
    subject: 150,
    preheader: 200,
    intro: 1500,
    heading: 120,
    body: 1000,
    maxItems: 12,
    /** Decoded bytes. A cropped 800px screenshot is ~60–150 KB; this is generous headroom. */
    imageBytes: 1_500_000,
    /** All images together — keeps an upload well under Netlify's 6 MB request limit. */
    totalImageBytes: 4_500_000,
} as const;

export const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ImageMime = typeof IMAGE_MIMES[number];

/** Be More Swan's brand pink (button-system "primary") — readable under white text (WCAG AA). */
export const BRAND_PINK = '#d6006b';

// ── Draft validation ───────────────────────────────────────────────────────────────────────────
export interface DraftImageInput { mime: string; dataB64: string; width?: number; height?: number }
export interface DraftItemInput { heading: string; body: string; image?: DraftImageInput | null }
export interface DraftInput {
    subject: string;
    preheader?: string;
    intro?: string;
    items: DraftItemInput[];
    commitFrom?: string;
    commitTo?: string;
    periodStart?: string;
    periodEnd?: string;
}

export interface NormalisedImage { mime: ImageMime; dataB64: string; width: number | null; height: number | null }
export interface NormalisedDraft {
    subject: string;
    preheader: string | null;
    intro: string | null;
    items: { heading: string; body: string; image: NormalisedImage | null }[];
    commitFrom: string | null;
    commitTo: string | null;
    periodStart: string | null;
    periodEnd: string | null;
}

export class DraftError extends Error {}

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Trim, collapse runs of 3+ newlines, and refuse empty or over-long text. */
function cleanText(value: unknown, field: string, max: number, required: boolean): string | null {
    if (value == null || value === '') {
        if (required) throw new DraftError(`${field} is required.`);
        return null;
    }
    if (typeof value !== 'string') throw new DraftError(`${field} must be text.`);
    const s = value.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!s) {
        if (required) throw new DraftError(`${field} is required.`);
        return null;
    }
    if (s.length > max) throw new DraftError(`${field} is ${s.length} characters; the limit is ${max}.`);
    return s;
}

function cleanImage(img: unknown, field: string): NormalisedImage | null {
    if (img == null) return null;
    if (typeof img !== 'object') throw new DraftError(`${field} must be an object.`);
    const { mime, dataB64, width, height } = img as DraftImageInput;
    if (!IMAGE_MIMES.includes(mime as ImageMime)) {
        throw new DraftError(`${field}.mime must be one of ${IMAGE_MIMES.join(', ')}.`);
    }
    const data = String(dataB64 || '').replace(/\s+/g, '');
    if (!data || !B64_RE.test(data)) throw new DraftError(`${field}.dataB64 is not base64.`);
    const bytes = Math.floor(data.length * 3 / 4);
    if (bytes > LIMITS.imageBytes) {
        throw new DraftError(`${field} is ${Math.round(bytes / 1024)} KB; the limit is ${Math.round(LIMITS.imageBytes / 1024)} KB.`);
    }
    const dim = (n: unknown) => (Number.isInteger(n) && (n as number) > 0 && (n as number) < 10_000 ? n as number : null);
    return { mime: mime as ImageMime, dataB64: data, width: dim(width), height: dim(height) };
}

/** The uploaded draft, validated. Throws DraftError with a message an operator can act on. */
export function normaliseDraft(input: unknown): NormalisedDraft {
    if (!input || typeof input !== 'object') throw new DraftError('The draft must be a JSON object.');
    const d = input as DraftInput;
    if (!Array.isArray(d.items) || d.items.length === 0) throw new DraftError('The draft needs at least one item.');
    if (d.items.length > LIMITS.maxItems) throw new DraftError(`The draft has ${d.items.length} items; the limit is ${LIMITS.maxItems}.`);

    const items = d.items.map((it, i) => ({
        heading: cleanText(it?.heading, `items[${i}].heading`, LIMITS.heading, true)!,
        body: cleanText(it?.body, `items[${i}].body`, LIMITS.body, true)!,
        image: cleanImage(it?.image, `items[${i}].image`),
    }));
    const total = items.reduce((n, it) => n + (it.image ? Math.floor(it.image.dataB64.length * 3 / 4) : 0), 0);
    if (total > LIMITS.totalImageBytes) {
        throw new DraftError(`The screenshots total ${Math.round(total / 1024)} KB; the limit is ${Math.round(LIMITS.totalImageBytes / 1024)} KB.`);
    }

    const sha = (v: unknown, f: string) => {
        if (v == null || v === '') return null;
        if (typeof v !== 'string' || !SHA_RE.test(v)) throw new DraftError(`${f} must be a git commit SHA.`);
        return v.toLowerCase();
    };
    const day = (v: unknown, f: string) => {
        if (v == null || v === '') return null;
        if (typeof v !== 'string' || !DATE_RE.test(v)) throw new DraftError(`${f} must be YYYY-MM-DD.`);
        return v;
    };

    return {
        subject: cleanText(d.subject, 'subject', LIMITS.subject, true)!,
        preheader: cleanText(d.preheader, 'preheader', LIMITS.preheader, false),
        intro: cleanText(d.intro, 'intro', LIMITS.intro, false),
        items,
        commitFrom: sha(d.commitFrom, 'commitFrom'),
        commitTo: sha(d.commitTo, 'commitTo'),
        periodStart: day(d.periodStart, 'periodStart'),
        periodEnd: day(d.periodEnd, 'periodEnd'),
    };
}

// ── Admin edits ────────────────────────────────────────────────────────────────────────────────
export interface StoredItem { heading: string; body: string; imageId: number | null }
export interface EditInput {
    subject?: unknown;
    preheader?: unknown;
    intro?: unknown;
    /** The full list in its new order. An item may only reference an image this digest owns. */
    items?: unknown;
}
export interface NormalisedEdit {
    subject?: string;
    preheader?: string | null;
    intro?: string | null;
    items?: StoredItem[];
}

/**
 * An admin's edit, validated. `ownImageIds` are the digest's own screenshots: an item can keep,
 * drop or move its picture, but never point at another digest's — the image route would happily
 * serve it, and the email would show a screenshot nobody reviewed.
 */
export function normaliseEdit(input: EditInput, ownImageIds: number[]): NormalisedEdit {
    const out: NormalisedEdit = {};
    if (input.subject !== undefined) out.subject = cleanText(input.subject, 'Subject', LIMITS.subject, true)!;
    if (input.preheader !== undefined) out.preheader = cleanText(input.preheader, 'Preview text', LIMITS.preheader, false);
    if (input.intro !== undefined) out.intro = cleanText(input.intro, 'Introduction', LIMITS.intro, false);
    if (input.items !== undefined) {
        if (!Array.isArray(input.items) || input.items.length === 0) throw new DraftError('Keep at least one feature.');
        if (input.items.length > LIMITS.maxItems) throw new DraftError(`At most ${LIMITS.maxItems} features.`);
        const own = new Set(ownImageIds);
        out.items = input.items.map((raw, i) => {
            const it = (raw || {}) as Record<string, unknown>;
            const imageId = it.imageId == null ? null : Number(it.imageId);
            if (imageId !== null && !own.has(imageId)) throw new DraftError(`Feature ${i + 1} points at a screenshot that is not part of this email.`);
            return {
                heading: cleanText(it.heading, `Feature ${i + 1} heading`, LIMITS.heading, true)!,
                body: cleanText(it.body, `Feature ${i + 1} description`, LIMITS.body, true)!,
                imageId,
            };
        });
    }
    return out;
}

// ── Signed links ───────────────────────────────────────────────────────────────────────────────
function requireSecret(): string {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is not set — cannot sign product-update links.');
    return secret;
}

function sign(purpose: string, id: number, length: number, secret: string): string {
    return createHmac('sha256', secret).update(`${purpose}:${id}`).digest('hex').slice(0, length);
}

function verify(purpose: string, id: number, given: string, length: number, secret: string): boolean {
    const expected = Buffer.from(sign(purpose, id, length, secret));
    const actual = Buffer.from(String(given || ''));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const base = (baseUrl: string) => String(baseUrl).replace(/\/$/, '');

/**
 * The <img src> for a screenshot. Permanent (an email sits in an inbox for years) and signed, so
 * the unauthenticated route cannot be walked by id. ⚠️ Must be absolute — a relative src in an
 * email resolves against nothing.
 */
export function productUpdateImageUrl(baseUrl: string, imageId: number, secret = requireSecret()): string {
    return `${base(baseUrl)}/api/product-updates/image?i=${imageId}&s=${sign('product-update-image', imageId, 16, secret)}`;
}
export function verifyImageSignature(imageId: number, sig: string, secret = requireSecret()): boolean {
    return verify('product-update-image', imageId, sig, 16, secret);
}

/**
 * The per-user unsubscribe link. Signed — unlike the win-back link, whose token is a base64 user
 * id anyone can forge — because this one changes a preference on a real account.
 */
export function whatsNewUnsubscribeUrl(baseUrl: string, userId: number, secret = requireSecret()): string {
    return `${base(baseUrl)}/api/product-updates/unsubscribe?u=${userId}&s=${sign('whats-new-unsub', userId, 24, secret)}`;
}
export function verifyUnsubscribeSignature(userId: number, sig: string, secret = requireSecret()): boolean {
    return verify('whats-new-unsub', userId, sig, 24, secret);
}

// ── Rendering ──────────────────────────────────────────────────────────────────────────────────
export interface RenderDigest {
    subject: string;
    preheader: string | null;
    intro: string | null;
    items: StoredItem[];
}
export interface RenderOptions {
    baseUrl: string;
    firstName?: string | null;
    /** Absent in the admin preview — the footer link then points at account settings. */
    unsubscribeUrl?: string;
    /** For tests: sign without JWT_SECRET. */
    secret?: string;
}

/** Blank-line-separated paragraphs, single newlines kept as <br>. Input is escaped first. */
function paragraphs(text: string, style: string): string {
    return text.split(/\n{2,}/).map(p =>
        `<p style="${style}">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}

const P_STYLE = 'margin:0 0 14px;font-size:16px;line-height:1.6;color:#1f2937;';

/** The email for one recipient: subject, branded HTML and a plain-text part. */
export function renderProductUpdateEmail(d: RenderDigest, opts: RenderOptions): { subject: string; html: string; text: string } {
    const appUrl = `${base(opts.baseUrl)}/workspace.html`;
    const greeting = `Hi ${opts.firstName?.trim() || 'there'},`;

    const itemsHtml = d.items.map((it, i) => {
        const img = it.imageId != null
            ? `<img src="${escapeHtml(productUpdateImageUrl(opts.baseUrl, it.imageId, opts.secret))}" alt="${escapeHtml(it.heading)}" width="536"
                 style="display:block;width:100%;max-width:536px;height:auto;margin:4px 0 0;border:1px solid #e5e7eb;border-radius:12px;">`
            : '';
        return `
        <tr><td style="padding:${i === 0 ? '8px' : '28px'} 0 0;">
          <h2 style="margin:0 0 8px;font-size:19px;line-height:1.3;font-weight:800;color:${BRAND_PINK};">${escapeHtml(it.heading)}</h2>
          ${paragraphs(it.body, P_STYLE)}
          ${img}
        </td></tr>`;
    }).join('');

    const body = `
      <p style="${P_STYLE}">${escapeHtml(greeting)}</p>
      ${d.intro ? paragraphs(d.intro, P_STYLE) : ''}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${itemsHtml}</table>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:32px 0 8px;">
        <tr><td style="background:${BRAND_PINK};border-radius:10px;">
          <a href="${escapeHtml(appUrl)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">Try them in Be More Swan</a>
        </td></tr>
      </table>
      <p style="margin:24px 0 0;font-size:15px;line-height:1.6;color:#6b7280;">Questions or ideas? Just reply to this email.<br>— The Be More Swan team</p>`;

    const html = renderMasterTemplate(body, {
        preheader: d.preheader || undefined,
        unsubscribeUrl: opts.unsubscribeUrl,
        accent: BRAND_PINK,
    });

    const text = [
        greeting,
        d.intro || '',
        ...d.items.map(it => `${it.heading.toUpperCase()}\n${it.body}`),
        `Try them in Be More Swan: ${appUrl}`,
        'Questions or ideas? Just reply to this email.\n— The Be More Swan team',
        opts.unsubscribeUrl ? `Unsubscribe from "What's new" emails: ${opts.unsubscribeUrl}` : '',
    ].filter(Boolean).join('\n\n');

    return { subject: d.subject, html, text };
}

/** The note to the business inbox when a draft lands. */
export function renderReminderEmail(args: {
    baseUrl: string; digestId: number; subject: string; itemCount: number; periodStart: string | null; periodEnd: string | null;
}): { subject: string; html: string; text: string } {
    const link = `${base(args.baseUrl)}/admin.html?view=product-updates&id=${args.digestId}`;
    const period = args.periodStart && args.periodEnd ? ` (${args.periodStart} to ${args.periodEnd})` : '';
    const subject = `Ready for review: this week's "What's new" email`;
    const body = `
      <p style="${P_STYLE}">This week's "What's new" email has been drafted${escapeHtml(period)} and is waiting for you.</p>
      <p style="${P_STYLE}"><strong>Subject:</strong> ${escapeHtml(args.subject)}<br><strong>Features:</strong> ${args.itemCount}</p>
      <p style="${P_STYLE}">Nothing is sent to customers until you approve it in the admin portal.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 4px;">
        <tr><td style="background:${BRAND_PINK};border-radius:10px;">
          <a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">Review the email</a>
        </td></tr>
      </table>`;
    return {
        subject,
        html: renderMasterTemplate(body, { transactional: true, accent: BRAND_PINK }),
        text: `This week's "What's new" email has been drafted${period} and is waiting for you.\n\nSubject: ${args.subject}\nFeatures: ${args.itemCount}\n\nNothing is sent to customers until you approve it.\n\nReview it: ${link}`,
    };
}
