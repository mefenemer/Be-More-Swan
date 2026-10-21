// src/utils/site-review.ts — the page a customer reaches from a review request email, on the
// business's own site: /_review?r=<request>&t=<signature>. Served by site-serve.ts; its forms post to
// /_form with _k=review or _k=review_stop (the sites host forwards only /_form, /_buy and /_book).
// tests/review-requests.test.ts.
//
// No script. The review they send is saved as 'pending' in Audience ▸ Reviews and the
// owner is told; it appears on the site only once the owner approves it. They must agree, in words,
// that it may be shown with their name. The Google link (if the owner set one) is offered to every
// customer alike on the thank-you page.

import { and, eq, isNull } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { orgReviews, reviewRequests } from '../../db/schema';
import { FORM_ACTION, REVIEW_PATH, esc, renderSiteShell, type RenderContext } from './site-render';
import { cleanText, type SiteDefinition } from './site-definition';
import { loadReviewRequest, optOutOfReviewRequests, reviewSettingsFor } from './review-requests';
import { cleanReview } from './reviews';
import { checkRateLimit } from './rate-limit';
import { ownerOf } from './bookings';
import { createNotification } from './notify';
import { sendEmail } from './email';
import type { SiteRow } from './site-store';

type Db = ReturnType<typeof getDb>;
export interface ReviewCtx { db: Db; site: SiteRow; def: SiteDefinition; ctx: RenderContext; now: Date; }
export type ReviewPage = { status: number; html: string } | { status: 303; location: string };

export const REVIEW_MIN_FILL_MS = 3000;
export const REVIEW_PER_IP = { maxAttempts: 10, windowSecs: 3600 };

const page = (b: ReviewCtx, title: string, inner: string, status = 200): ReviewPage =>
    ({ status, html: renderSiteShell(b.def, b.ctx, title, `<section><div class="w n">${inner}</div></section>`) });
const home = '<p><a class="btn s" href="/">Back to the website</a></p>';
const gone = (b: ReviewCtx) => page(b, 'This link doesn\'t work', `<h1>This link doesn't work</h1><p>It may have been copied only in part. If you'd like to leave a review, please get in touch with us.</p>${home}`, 404);

/** "Sarah Kemp" → "Sarah K." — what we suggest showing; they can change it. */
export function suggestedName(full: string | null): string {
    const parts = (full || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '';
    return parts.length === 1 ? parts[0].slice(0, 40) : `${parts[0].slice(0, 40)} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

function hidden(id: number, t: string, kind: 'review' | 'review_stop', renderedAt: number): string {
    return `<input type="hidden" name="_k" value="${kind}"><input type="hidden" name="r" value="${id}"><input type="hidden" name="t" value="${esc(t)}"><input type="hidden" name="_t" value="${renderedAt}">`;
}

export async function reviewPage(b: ReviewCtx, q: URLSearchParams, message: string | null = null, kept: Record<string, string> = {}): Promise<ReviewPage> {
    const id = Number(q.get('r'));
    const t = String(q.get('t') || '');
    const req = await loadReviewRequest(b.db, b.site.organisationId, id, t);
    if (!req) return gone(b);
    const business = b.def.settings.siteName;

    if (q.get('stop') === '1') {
        return page(b, 'Stop review emails', `<h1>Stop review emails?</h1><p>${esc(business)} won't ask you for a review again.</p>
<form class="fm" method="post" action="${FORM_ACTION}">${hidden(id, t, 'review_stop', b.now.getTime())}<button class="btn" type="submit">Don't ask me again</button></form>${home}`);
    }
    if (q.get('stopped') === '1') return page(b, 'Done', `<h1>Done</h1><p>${esc(business)} won't ask you for a review again.</p>${home}`);
    if (q.get('done') === '1' || req.respondedAt) {
        const s = await reviewSettingsFor(b.db, b.site.organisationId);
        return page(b, 'Thank you', `<h1>Thank you</h1><p>${req.respondedAt && q.get('done') !== '1' ? 'We already have your review — thank you.' : `Thank you for your review. ${esc(business)} will read it before it appears on the website.`}</p>
${s.googleReviewUrl ? `<p>If you'd also like to share it on Google, it helps other people find us.</p><p><a class="btn s" href="${esc(s.googleReviewUrl)}" rel="noopener">Review us on Google</a></p>` : ''}${home}`);
    }

    const rating = kept.rating ?? '';
    const radios = [5, 4, 3, 2, 1].map((n) => `<label class="opt"><input type="radio" name="rating" value="${n}" ${rating === String(n) ? 'checked' : ''}> <span class="stars" aria-hidden="true">${'★'.repeat(n)}<span class="off">${'★'.repeat(5 - n)}</span></span> <span>${n} star${n === 1 ? '' : 's'}</span></label>`).join('');
    return page(b, `Review ${business}`, `<h1>How did we do?</h1>
${req.about ? `<p>Your review of ${esc(req.about.replace(/^your /, ''))}.</p>` : ''}
${message ? `<p class="fine" role="alert" style="color:#b91c1c"><strong>${esc(message)}</strong></p>` : ''}
<form class="fm" method="post" action="${FORM_ACTION}">${hidden(id, t, 'review', b.now.getTime())}
<div class="hp" aria-hidden="true"><label>Leave this empty <input name="website" tabindex="-1" autocomplete="off"></label></div>
<fieldset><legend>Your stars (optional)</legend>${radios}</fieldset>
<label>Your review<textarea name="body" rows="6" maxlength="2000" required>${esc(kept.body ?? '')}</textarea></label>
<label>Your name, as it will be shown<input name="name" maxlength="80" required value="${esc(kept.name ?? suggestedName(req.customerName))}"></label>
<label class="opt"><input type="checkbox" name="consent" value="yes" required ${kept.consent === 'yes' ? 'checked' : ''}> <span>${esc(business)} may show my review and this name on their website.</span></label>
<button class="btn" type="submit">Send my review</button>
<p class="fine">${esc(business)} reads every review before it appears. Your email address is never shown.</p>
</form>`);
}

/** The review form, posted to /_form with _k=review (or _k=review_stop). */
export async function reviewSubmit(b: ReviewCtx, body: URLSearchParams, ip: string): Promise<ReviewPage> {
    const id = Number(body.get('r'));
    const t = String(body.get('t') || '');
    const back = (extra: string) => ({ status: 303 as const, location: `${REVIEW_PATH}?r=${id}&t=${encodeURIComponent(t)}${extra}` });
    const req = await loadReviewRequest(b.db, b.site.organisationId, id, t);
    if (!req) return gone(b);

    if (body.get('_k') === 'review_stop') {
        await optOutOfReviewRequests(b.db, b.site.organisationId, req.customerEmail);
        return back('&stopped=1');
    }
    if (req.respondedAt) return back('&done=1');
    // A bot: the hidden field, or faster than a person could write a review. Thanked; nothing saved.
    const started = Number(body.get('_t'));
    if (String(body.get('website') || '').trim() || !Number.isFinite(started) || b.now.getTime() - started < REVIEW_MIN_FILL_MS) return back('&done=1');

    const kept = { rating: String(body.get('rating') || ''), body: String(body.get('body') || '').slice(0, 2000), name: String(body.get('name') || '').slice(0, 80), consent: String(body.get('consent') || '') };
    const retry = (m: string) => reviewPage(b, new URLSearchParams({ r: String(id), t }), m, kept);
    if (kept.consent !== 'yes') return retry('Please tick the box to say we may show your review.');
    const cleaned = cleanReview({ authorName: cleanText(kept.name, 80), body: kept.body, rating: kept.rating || null, source: 'website', reviewedOn: b.now.toISOString().slice(0, 10) }, false, b.now);
    if (!cleaned.ok) return retry(cleaned.error);
    try {
        const limit = await checkRateLimit(b.db, 'site_review_ip', ip, REVIEW_PER_IP);
        if (!limit.allowed) return retry('Lots of reviews have been sent from here just now. Please try again later.');
    } catch (err) {
        console.error('[site-review] rate limiter unavailable — allowing the review', err);
    }

    // Claim the request (one review per email), then save the review as pending.
    const [claimed] = await b.db.update(reviewRequests).set({ respondedAt: b.now })
        .where(and(eq(reviewRequests.id, id), isNull(reviewRequests.respondedAt))).returning({ id: reviewRequests.id });
    if (!claimed) return back('&done=1');
    const [review] = await b.db.insert(orgReviews).values({ ...(cleaned.value as { authorName: string; body: string }), organisationId: b.site.organisationId, status: 'pending' }).returning();
    await b.db.update(reviewRequests).set({ reviewId: review.id }).where(eq(reviewRequests.id, id));
    await tellOwner(b, review, req.customerName);
    return back('&done=1');
}

/** The owner hears about it: a card to approve, and an email with the words. */
async function tellOwner(b: ReviewCtx, review: typeof orgReviews.$inferSelect, customer: string | null): Promise<void> {
    const owner = await ownerOf(b.db, b.site.aiAssistantId ?? null);
    if (!owner) return;
    const stars = review.rating ? `${review.rating}★` : 'no stars';
    await createNotification(b.db, 'site_review_received', {
        userId: owner.userId, assistantId: b.site.aiAssistantId ?? undefined, category: 'suggested_action',
        context: { assistant: { name: owner.name }, review: { who: review.authorName, stars, next: 'Approve it in Audience ▸ Reviews to show it on your website.' } },
        metadata: { assistantId: b.site.aiAssistantId, reviewId: review.id },
    }).catch((err) => console.error('[site-review] notification failed', err));
    if (owner.email) {
        await sendEmail({
            to: owner.email, subject: `New review from ${review.authorName} (${stars})`,
            html: `<p><strong>${esc(review.authorName)}</strong>${customer && customer !== review.authorName ? ` (${esc(customer)})` : ''} left a review — ${esc(stars)}:</p><blockquote>${esc(review.body).replace(/\n/g, '<br>')}</blockquote><p>It isn't on your website yet. Approve it in Audience ▸ Reviews.</p>`,
        }).catch((err: unknown) => console.error('[site-review] owner email failed', err instanceof Error ? err.message : err));
    }
}

