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
}): Promise<IssueSnapshot> {
    const rendered = await renderMarkdown(input.bodyMarkdown || '');
    // Belt and braces: renderMarkdown already sanitises for the blog widget, and this passes
    // through the email allowlist as well. The body can contain anything a tenant pasted in.
    const bodyHtml = sanitiseBodyHtml(rendered);
    const accent = /^#[0-9a-f]{6}$/i.test(String(input.accent || '')) ? String(input.accent) : '#111827';

    // The preheader: hidden in the body, shown by the inbox next to the subject. Without one, most
    // clients show the first words of the body instead, which is usually "Hi there".
    const preheader = input.preheader
        ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(input.preheader)}</div>`
        : '';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(input.senderName)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f7f9;">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:24px 0;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
      <tr><td style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#111827;">
        <style>a{color:${accent};}</style>
        ${bodyHtml}
      </td></tr>
      <tr><td id="bms-footer" style="padding:20px 24px;text-align:center;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#6b7280;"></td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

    return { html, text: htmlToPlainText(bodyHtml) };
}

export interface RecipientRenderInput {
    snapshot: IssueSnapshot;
    contact: { firstName?: string | null; lastName?: string | null; company?: string | null; email?: string | null };
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
