// src/utils/chat-reviews.ts
// Customer reviews (Audience ▸ Reviews) for the Email Marketing chat: what it can see, and the two
// cards the Website Assistant's chat already offers — reviews_add (save reviews the owner pasted,
// word for word) and review_decisions (approve or decline reviews customers sent in).
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────────
// Reviews live on the Audience page, which the Email Marketing assistant shares, but only the
// Website Assistant's chat could add or approve them. The cards, their click handlers
// (chat-session.js onReviewsAdd / onReviewDecisions → org-reviews.ts) and their renderers already
// exist; this gives the email chat the same prompt and rules, and checks each card on the server.
//
// ── The check ────────────────────────────────────────────────────────────────────────────────────
// The newsletter route keeps only cards it has checked (it rebuilds uiElement), so a review card is
// rebuilt here: every pasted review goes through cleanReview — org-reviews.ts's own rule, which
// refuses the WHOLE batch if one review fails — and a failing one is left out and named, so the
// card's button can work; a decision is kept only for a review that is waiting in THIS workspace.
// Wording is never touched: cleanReview tidies spacing, never words. Nothing here writes.
//
// ⚠️ Never throws.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { orgReviews } from '../../db/schema';
import { cleanReview, REVIEW_LIMITS, reviewsForPrompt } from './reviews';

type Db = ReturnType<typeof getDb>;

/** Roles whose chat gets this block. The Website Assistant has its own (chat-orchestrator.ts). */
export const EMAIL_REVIEW_ROLES: readonly string[] = ['newsletter_editor'];

const DECLINE_REASONS = ['not_genuine', 'offensive', 'not_about_us'];

/** The block for this turn's prompt. Null for other roles; an admission when the read fails. */
export async function buildReviewsBlock(db: Db, organisationId: number, roleKey: string | null | undefined): Promise<string | null> {
    if (!roleKey || !EMAIL_REVIEW_ROLES.includes(roleKey)) return null;
    const listed = await reviewsForPrompt(db, organisationId, 'email').catch((err) => {
        console.error('[chat-reviews] could not read reviews (non-fatal)', err);
        return 'Their reviews could not be read this turn — say so; never quote or count a review from memory.';
    });
    return `CUSTOMER REVIEWS (Audience ▸ Reviews). ${listed}
QUOTING. In an email, quote only a review listed above as shown, WORD FOR WORD with the customer's name as listed — never shorten, correct or improve it, never invent one, never quote a waiting one.
ADDING REVIEWS. When they paste reviews (from Google, Facebook, an email…), set each out in a reviews_add card WORD FOR WORD — never shorten, correct, translate or improve a review, never write or invent one, never change its stars, and never add a review they did not give you (UK law bans fake reviews). If a name, the stars or where it was left isn't clear, leave it out (stars null, source "other") or ask.
{"type":"reviews_add","summary":"<one sentence>","reviews":[{"authorName":"...","authorDetail":null,"rating":5|null,"body":"<their exact words>","source":"google|facebook|trustpilot|tripadvisor|checkatrade|yell|direct|website|other","reviewedOn":"YYYY-MM-DD"|null}]}   (up to ${REVIEW_LIMITS.batch})
WAITING REVIEWS. Reviews customers sent in wait for the owner's approval (listed above by reviewId). When they ask you to approve or turn some down, emit a review_decisions card — only reviewIds listed as waiting. "decline" ONLY for a review that isn't genuine, is offensive, or isn't about this business, with that reason; a genuine bad review is approved (they can hide it afterwards in Audience ▸ Reviews, and it still counts in their average) — never offer to bury a bad review, and say so if asked (UK law: no misleading reviews).
{"type":"review_decisions","summary":"<one sentence>","decisions":[{"reviewId":<id>,"decision":"approve"|"decline","reason":"not_genuine|offensive|not_about_us"|null}]}
Put either card in "uiElement" instead of anything else. You never save or decide yourself: the user confirms on the card, and only that click changes anything — so never say a review HAS been added, approved or declined.`;
}

export interface ReviewsAddCard { type: 'reviews_add'; summary: string; reviews: Array<Record<string, unknown>> }
export interface ReviewDecisionsCard { type: 'review_decisions'; summary: string; decisions: Array<{ reviewId: number; decision: 'approve' | 'decline'; reason: string | null }> }
export type ReviewsCard = ReviewsAddCard | ReviewDecisionsCard;

export function isReviewsUiElement(uiElement: unknown): boolean {
    const t = (uiElement as { type?: unknown } | null)?.type;
    return t === 'reviews_add' || t === 'review_decisions';
}

/** Pasted reviews by cleanReview, the endpoint's own rule. Pure — `today` for the future-date check. */
export function checkReviewsAdd(ui: Record<string, unknown>, existingCount: number, today = new Date()): ReviewsAddCard {
    const raw = Array.isArray(ui.reviews) ? ui.reviews : [];
    const kept: Array<Record<string, unknown>> = [];
    const left: string[] = [];
    raw.forEach((r, i) => {
        const res = cleanReview((r && typeof r === 'object' ? r : {}) as Record<string, unknown>, false, today);
        if (res.ok) kept.push(res.value); else left.push(`review ${i + 1} (${res.error})`);
    });
    const room = Math.max(0, Math.min(REVIEW_LIMITS.batch, REVIEW_LIMITS.perWorkspace - existingCount));
    if (kept.length > room) left.push(`${kept.length - room} more than can be kept (up to ${REVIEW_LIMITS.batch} at a time and ${REVIEW_LIMITS.perWorkspace} in all)`);
    const reviews = kept.slice(0, room);
    const summary = [String(ui.summary ?? '').slice(0, 300), left.length ? `Left out: ${left.join('; ')}.` : ''].filter(Boolean).join(' ');
    return { type: 'reviews_add', summary, reviews };
}

/** Decisions kept only for reviews waiting in this workspace, and a decline only with a reason. Pure. */
export function checkReviewDecisions(ui: Record<string, unknown>, waitingIds: Set<number>): ReviewDecisionsCard {
    const raw = Array.isArray(ui.decisions) ? ui.decisions : [];
    const decisions: ReviewDecisionsCard['decisions'] = [];
    let dropped = 0;
    for (const d of raw) {
        const x = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
        const reviewId = Number(x.reviewId);
        const decision = x.decision === 'approve' || x.decision === 'decline' ? x.decision : null;
        const reason = typeof x.reason === 'string' && DECLINE_REASONS.includes(x.reason) ? x.reason : null;
        if (!waitingIds.has(reviewId) || !decision || (decision === 'decline' && !reason) || decisions.some((k) => k.reviewId === reviewId)) { dropped++; continue; }
        decisions.push({ reviewId, decision, reason: decision === 'decline' ? reason : null });
    }
    const summary = [String(ui.summary ?? '').slice(0, 300), dropped ? `${dropped} left out — not waiting for approval, or a decline with no reason.` : ''].filter(Boolean).join(' ');
    return { type: 'review_decisions', summary, decisions };
}

/** Rebuild a review card against the database. Null when it isn't one, or the read fails. */
export async function resolveReviewsCard(db: Db, organisationId: number, uiElement: unknown): Promise<ReviewsCard | null> {
    if (!isReviewsUiElement(uiElement)) return null;
    const ui = uiElement as Record<string, unknown>;
    try {
        if (ui.type === 'reviews_add') {
            const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(orgReviews).where(eq(orgReviews.organisationId, organisationId));
            return checkReviewsAdd(ui, Number(c?.n) || 0);
        }
        const ids = (Array.isArray(ui.decisions) ? ui.decisions : []).map((d) => Number((d as { reviewId?: unknown } | null)?.reviewId)).filter((n) => Number.isInteger(n) && n > 0);
        const waiting = ids.length
            ? await db.select({ id: orgReviews.id }).from(orgReviews)
                .where(and(eq(orgReviews.organisationId, organisationId), eq(orgReviews.status, 'pending'), inArray(orgReviews.id, ids)))
            : [];
        return checkReviewDecisions(ui, new Set(waiting.map((r) => r.id)));
    } catch (err) {
        console.error('[chat-reviews] could not check the card (non-fatal)', err);
        return null;
    }
}
