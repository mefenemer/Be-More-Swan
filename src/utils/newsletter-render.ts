// src/utils/newsletter-render.ts
// Turning an approved issue into the two things a mail server actually accepts: an HTML part and a
// plain-text part, per recipient.
//
// Two stages, deliberately separate:
//
//   1. renderIssueSnapshot()  — at APPROVAL. Markdown → sanitised HTML in a neutral shell, plus the
//      text part. Merge tags survive verbatim. Stored in newsletter_issues.rendered_payload.
//   2. renderForRecipient()   — at SEND. Resolves the merge tags against one contact and appends
//      the footer. Never re-renders from body_markdown.
//
// ⚠️ WHY THE SNAPSHOT EXISTS. A human approved a specific set of words. Re-rendering from
// body_markdown at send time means an edit landing mid-send ships two different issues to two
// halves of the list, with no record of which anyone received. Same reasoning as
// blog_posts.published_payload.
//
// ⚠️ NOT renderMasterTemplate(). That wrapper is Be More Swan's OWN branded shell — our logo, our
// privacy and terms links, our copyright line — and it is correct for every email WE send to OUR
// users. Putting it around a tenant's newsletter would sign Acme's mail with our brand and point
// their subscribers at our legal pages. Same collision family as win-back-unsubscribe.ts vs
// lead-unsubscribe.ts: two things that look interchangeable and are addressed to different people.

import { renderMarkdown } from './markdown-render';
import { escapeHtml, htmlToPlainText, renderMergeVars, sanitiseBodyHtml } from './email-template';
import { isUsablePostalAddress } from '../config/outreach-footer';
import { contactMergeContext } from '../config/newsletter-merge-vars';
import {
    DEFAULT_THEME, designToHtml, designToPlainText, normaliseDesign, type NewsletterDesign,
} from './newsletter-design';
import { newsletterMediaUrl } from './newsletter-media-url';
// The same colour maths the browser runs — see src/public/brand-contrast.js.
import { ensureContrast } from '../public/brand-contrast.js';

/**
 * The unsubscribe route for a newsletter recipient. Keyed on newsletter_sends.unsubscribe_token,
 * which is minted per (issue, contact) before anything is sent.
 *
 * ⚠️ Phase 4 must add the matching netlify.toml rewrite and the function behind it. A footer link
 * that 404s is worse than no link: it reads as a company refusing to let you leave.
 */
export function newsletterUnsubscribeUrl(baseUrl: string, token: string): string {
    return `${baseUrl.replace(/\/$/, '')}/api/newsletter/unsubscribe?t=${encodeURIComponent(token)}`;
}

export interface IssueSnapshot {
    html: string;
    text: string;
}

/**
 * The shell colours for an issue with NO design.
 *
 * ⚠️ Deliberately the pre-Studio values, not DEFAULT_THEME — every issue ever sent used these, and
 * a plain Markdown issue must not silently change appearance because a feature it does not use
 * shipped. DEFAULT_THEME is what a NEW design starts from.
 */
const DEFAULT_THEME_SHELL = {
    ...DEFAULT_THEME,
    accent: '#111827',
    background: '#f6f7f9',
    cardBackground: '#ffffff',
    rounded: true,
};

/**
 * A design's blocks as email HTML.
 *
 * ⚠️ Image URLs are resolved to the signed, permanent /api/newsletter/media route HERE, at snapshot
 * time — not at send time and never to a presigned R2 URL. See src/utils/newsletter-media-url.ts:
 * an email is rendered once and read for years.
 */
async function renderDesignBody(design: NewsletterDesign, baseUrl: string | null): Promise<string> {
    return designToHtml(design, {
        renderMarkdown: (md) => renderMarkdown(md),
        imageUrl: (assetId) => {
            // No origin to build an absolute URL from. Rendering the picture with a relative src
            // would put a broken image in every inbox; leaving it out loses the picture and keeps
            // the email intact, and the Studio warns before it gets this far.
            if (!baseUrl) return null;
            try { return newsletterMediaUrl(baseUrl, assetId); }
            catch { return null; }          // JWT_SECRET unset — same trade, fail quiet not broken
        },
    });
}

/**
 * Render the approved body once. Called at approval, not at send.
 *
 * `accent` themes the links and nothing else — an email client will strip most CSS anyway, and a
 * newsletter that depends on styling to be readable is a newsletter half the recipients cannot read.
 */
export async function renderIssueSnapshot(input: {
    bodyMarkdown: string;
    preheader?: string | null;
    senderName: string;
    accent?: string | null;
    /**
     * The laid-out issue, when there is one (newsletter_issues.design). Absent or empty = the
     * Markdown body, which is what every issue was before the Design Studio existed.
     */
    design?: unknown;
    /**
     * The app's own origin, for image URLs. ⚠️ REQUIRED if the design contains pictures: an email
     * has no base to be relative to, and a relative src is a broken image in every client. A design
     * with images and no baseUrl renders WITHOUT them rather than with dead ones.
     */
    baseUrl?: string | null;
}): Promise<IssueSnapshot> {
    const design = normaliseDesign(input.design);
    // ⚠️ The theme's accent wins over the caller's when a design is present: the author chose it in
    // the Studio, and the two must not disagree about the colour of a link.
    const themeAccent = design ? design.theme.accent : null;
    const bodyHtml = design
        ? sanitiseBodyHtml(await renderDesignBody(design, input.baseUrl ?? null))
        // Belt and braces: renderMarkdown already sanitises for the blog widget, and this passes
        // through the email allowlist as well. The body can contain anything a tenant pasted in.
        : sanitiseBodyHtml(await renderMarkdown(input.bodyMarkdown || ''));
    const accentSource = themeAccent || input.accent || '';
    const accent = /^#[0-9a-f]{6}$/i.test(String(accentSource)) ? String(accentSource) : '#111827';

    // The preheader: hidden in the body, shown by the inbox next to the subject. Without one, most
    // clients show the first words of the body instead, which is usually "Hi there".
    const preheader = input.preheader
        ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(input.preheader)}</div>`
        : '';

    // A Markdown issue keeps the shell it has always had; a designed one takes the author's theme.
    const shell = design ? design.theme : DEFAULT_THEME_SHELL;

    // ⚠️ THE ACCENT IS A FILL; A LINK IS TEXT. The accent is stored exactly as the brand (or the
    // author, in the Style panel) set it, which is right for a button — a button carries its own
    // label colour, picked against that fill. Written as body text on the card it can easily be
    // unreadable: a soft yellow link on white is about 1.3:1. So the link colour, and ONLY the link
    // colour, is walked toward legibility here. Darkening the stored accent instead would darken
    // every button with it and turn a pale brand into a different one.
    const linkColour = ensureContrast(accent, shell.cardBackground) ?? accent;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(input.senderName)}</title>
<style>
a{color:${linkColour};}
/* ⚠️ The ONLY thing this stylesheet is load-bearing for is stacking a two-column block on a phone.
   Every colour, size and space in the body is inline, because Outlook drops this block entirely —
   a design that needs it renders as a wall of unstyled text for a third of business recipients. */
@media only screen and (max-width:520px){
  td.bms-col{display:block !important;width:100% !important;padding:0 0 12px !important;}
}
</style>
</head>
<body style="margin:0;padding:0;background:${shell.background};">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${shell.background};padding:24px 0;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
      <tr><td style="background:${shell.cardBackground};border:1px solid #e5e7eb;border-radius:${shell.rounded ? '12px' : '0'};padding:32px;font-family:${shell.fontFamily};font-size:16px;line-height:1.6;color:${shell.text};">
        ${bodyHtml}
      </td></tr>
      <tr><td id="bms-footer" style="padding:20px 24px;text-align:center;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#6b7280;"></td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

    // ⚠️ THE TEXT PART OF A DESIGNED ISSUE COMES FROM THE PROSE MIRROR, not from stripping the HTML.
    // htmlToPlainText discards an <img> entirely — including its alt text, which is the ONLY thing
    // a reader whose client blocks images was ever going to get from that picture. The mirror keeps
    // it (designToMarkdown falls back to alt), so the plain-text reader and the image-blocked
    // reader end up with the same email.
    const text = design ? designToPlainText(design) : htmlToPlainText(bodyHtml);
    return { html, text };
}

export interface RecipientRenderInput {
    snapshot: IssueSnapshot;
    contact: {
        firstName?: string | null; lastName?: string | null; company?: string | null; email?: string | null;
        /** The org's own columns for THIS recipient — {{contact.custom.city}} resolves from here. */
        customFields?: Record<string, unknown> | null;
    };
    senderName: string;
    /** Built from this recipient's newsletter_sends.unsubscribe_token. */
    unsubscribeUrl: string;
    /** organisations.outreach_postal_address — required by CAN-SPAM/CASL for commercial mail. */
    postalAddress?: string | null;
}

export interface RecipientRender {
    html: string;
    text: string;
    /** RFC 2369/8058 header value, or null when there is no usable URL. */
    listUnsubscribe: string | null;
}

/**
 * Resolve one recipient's copy and append the footer.
 *
 * ⚠️ THE FOOTER IS BUILT HERE, IN CODE — never by the model and never stored in body_markdown.
 * src/config/outreach-footer.ts learned this the expensive way: a model paraphrases or drops the
 * opt-out line, and a human editing the draft in the review queue deletes it without knowing what
 * it is. Neither can happen to a footer that is appended after approval.
 */
export function renderForRecipient(input: RecipientRenderInput): RecipientRender {
    const ctx = contactMergeContext(input.contact, input.senderName);

    // escape=true for HTML (a subscriber called "O'Brien & Sons" must not break the markup);
    // escape=false for the text part, where escaping would print &amp; at people.
    const bodyHtml = renderMergeVars(input.snapshot.html, ctx, true);
    const bodyText = renderMergeVars(input.snapshot.text, ctx, false);

    const address = isUsablePostalAddress(input.postalAddress || '') ? String(input.postalAddress).trim() : '';
    const sender = escapeHtml(input.senderName || '');

    const footerHtml = [
        `You are receiving this because you subscribed to updates from ${sender}.`,
        `<a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a>`,
        address ? escapeHtml(address) : '',
    ].filter(Boolean).join('<br>');

    const footerText = [
        '',
        '—',
        `You are receiving this because you subscribed to updates from ${input.senderName || ''}.`,
        `Unsubscribe: ${input.unsubscribeUrl}`,
        address,
    ].filter((l) => l !== undefined && l !== null).join('\n');

    // Inserted into the reserved footer cell rather than concatenated after </html>, which some
    // clients drop and others render outside the layout entirely.
    const html = bodyHtml.replace(
        /(<td id="bms-footer"[^>]*>)(<\/td>)/,
        (_m, open: string) => `${open}${footerHtml}</td>`,
    );

    return {
        html,
        text: `${bodyText}\n${footerText}`,
        listUnsubscribe: input.unsubscribeUrl ? `<${input.unsubscribeUrl}>` : null,
    };
}
