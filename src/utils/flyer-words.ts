// src/utils/flyer-words.ts
// "Draft the words" for a flyer (docs/brand-designer-flyers-plan.md §3.2).
//
// The model writes FOUR fields only — headline, subheading, points, call to action — from the brief
// and what the business has recorded. Everything a reader acts on is filled from data, never written
// by a model:
//   • the offer      — the recorded introductory offer, verbatim (or left empty);
//   • contact        — the workspace's last flyer's details, else just its website;
//   • the QR link    — the offer's "where to start" link, else the website.
// A field we do not have stays empty for the user to fill. An invented phone number on 500 printed
// copies is the failure this file exists to prevent.
//
// Metered: one task per draft (TASK_WEIGHTS.flyer_words) — hasTaskCapacity before the model call,
// recordCompletedWork after it succeeds (work-metering.ts; the order is pinned by its tests).

import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { organisations, visualBriefs } from '../../db/schema';
import { gatewayGenerate } from '../lib/ai-gateway';
import { gatewayRoleModel } from './assistant-model';
import { loadProductsBlock } from './org-products';
import { loadIntroOffer, summariseIntroOffer, type IntroOffer } from './intro-offer';
import { loadBusinessKnowledgeBlock } from './business-knowledge';
import { loadAssistantRulesBlock } from './assistant-rules-prompt';
import { hasTaskCapacity, recordCompletedWork, TASK_LIMIT_MESSAGE } from './work-metering';
import { normalizeBrandKit } from './brand-kit';
import {
    FLYER_LIMITS, PAPER_SPECS, cleanQrUrl, normaliseFlyerContent, paperSizeOf,
    type FlyerContact, type FlyerContent,
} from '../config/flyer-vocab';
import type { BriefRow } from './visual-briefs';

type Db = ReturnType<typeof getDb>;

/** What the drafting model may return. Anything else in its JSON is ignored. */
export interface DraftedWords { headline: string; subheading: string | null; points: string[]; callToAction: string | null }

export function flyerWordsSystemPrompt(): string {
    return `You write the words for ONE printed flyer for a small business. A flyer is read in five seconds on a noticeboard or a doormat: a headline that says what is in it for the reader, a line of detail, up to three short points, and what to do next.

Write four things, and nothing else:
1. "headline" — at most ${FLYER_LIMITS.headline} characters. Concrete and specific to this business. No puns that hide what they sell.
2. "subheading" — one sentence, at most ${FLYER_LIMITS.subheading} characters.
3. "points" — one to three short points, each at most ${Math.min(FLYER_LIMITS.point, 70)} characters. Benefits or facts the business has given you. Not sentences that need a full stop.
4. "callToAction" — at most ${FLYER_LIMITS.callToAction} characters: what to do next ("Book online or call us", "Pop in this Saturday").

Rules:
- Use ONLY facts given below. Never invent a price, a discount, a date, an opening time, a statistic, an award, a review, a customer or a guarantee.
- Never write a phone number, email address, street address or web address — those are filled in separately from what the business recorded.
- Never mention an offer or free trial — the offer line is filled in separately, exactly as the business recorded it.
- British English. Plain words. No hashtags, no emoji.

Return STRICT JSON only: {"headline": "...", "subheading": "...", "points": ["..."], "callToAction": "..."}`;
}

const CONTACTISH = /(\+?\d[\d\s()-]{6,}\d)|(@[a-z0-9-]+\.)|(https?:\/\/)|(www\.)|(\b[a-z0-9-]+\.(co\.uk|com|org|uk|net|io)\b)/i;

/** Parse the model's JSON. A field carrying contact-like text is dropped — those come from data only. Pure. */
export function parseDraftedWords(raw: string): DraftedWords | null {
    let j: Record<string, unknown> = {};
    try {
        const m = raw.match(/\{[\s\S]*\}/);
        j = m ? JSON.parse(m[0]) : {};
    } catch { return null; }
    const clean = (v: unknown, max: number) => {
        if (typeof v !== 'string') return null;
        const t = v.replace(/\s+/g, ' ').trim().slice(0, max);
        return t && !CONTACTISH.test(t) ? t : null;
    };
    const headline = clean(j.headline, FLYER_LIMITS.headline);
    if (!headline) return null;
    const points = (Array.isArray(j.points) ? j.points : [])
        .map((p) => clean(p, FLYER_LIMITS.point)).filter((p): p is string => !!p).slice(0, FLYER_LIMITS.points);
    return { headline, subheading: clean(j.subheading, FLYER_LIMITS.subheading), points, callToAction: clean(j.callToAction, FLYER_LIMITS.callToAction) };
}

/** The offer line, from the recorded introductory offer only. Pure. */
export function offerLine(intro: IntroOffer | null): string | null {
    if (!intro || !intro.has) return null;
    // The summary's first sentence is the offer itself; "who can have it" and the link do not fit a pill.
    const first = summariseIntroOffer(intro).split(/(?<=\.)\s/)[0].replace(/\.$/, '');
    return first.length <= FLYER_LIMITS.offer ? first : null;
}

/**
 * Contact details and QR link from data: the workspace's most recent flyer (what the user typed last
 * time), else the website. Never a model.
 */
export async function contactDefaults(db: Db, orgId: number, intro: IntroOffer | null): Promise<{ contact: FlyerContact; qr: FlyerContent['qr'] }> {
    const [[last], [org]] = await Promise.all([
        db.select({ content: visualBriefs.flyerContent }).from(visualBriefs)
            .where(and(eq(visualBriefs.organisationId, orgId), isNotNull(visualBriefs.flyerContent)))
            .orderBy(desc(visualBriefs.updatedAt)).limit(1),
        db.select({ website: organisations.websiteUrl, kit: organisations.brandKit }).from(organisations).where(eq(organisations.id, orgId)).limit(1),
    ]);
    const prev = last ? normaliseFlyerContent(last.content) : null;
    const website = (org?.website || normalizeBrandKit(org?.kit).website || '').replace(/^https?:\/\//i, '').replace(/\/$/, '') || null;
    const contact: FlyerContact = prev && prev.ok
        ? prev.content.contact
        : { phone: null, email: null, website: website ? website.slice(0, FLYER_LIMITS.website) : null, address: null };
    const offerUrl = intro && intro.has ? cleanQrUrl(intro.url) : null;
    const prevQr = prev && prev.ok ? prev.content.qr : null;
    const qrUrl = offerUrl || prevQr?.url || cleanQrUrl(website);
    return { contact, qr: qrUrl ? { url: qrUrl, label: offerUrl ? 'Scan to claim' : prevQr?.label ?? null } : null };
}

export type DraftResult = { ok: true; content: FlyerContent } | { ok: false; status: number; error: string; code?: string };

/**
 * Draft a brief's flyer words and SAVE them on the brief. Keeps any contact details, offer and QR the
 * user already saved on this brief — a redraft rewrites the words, not their phone number.
 */
export async function draftFlyerWords(db: Db, args: { orgId: number; brief: BriefRow }): Promise<DraftResult> {
    const { orgId, brief } = args;
    if (!(await hasTaskCapacity(db, orgId, 1))) return { ok: false, status: 402, error: TASK_LIMIT_MESSAGE, code: 'task_limit' };

    const [[org], products, intro, knowledge, rules] = await Promise.all([
        db.select({ name: organisations.name, industry: organisations.industry, description: organisations.businessDescription })
            .from(organisations).where(eq(organisations.id, orgId)).limit(1),
        loadProductsBlock(db, orgId).catch(() => null),
        loadIntroOffer(db, orgId).catch(() => null),
        loadBusinessKnowledgeBlock(db, orgId).catch(() => null),
        loadAssistantRulesBlock(db, { assistantId: brief.aiAssistantId, organisationId: orgId }).catch(() => null),
    ]);
    const paper = PAPER_SPECS[paperSizeOf(brief.paperSize) ?? 'A5'];
    const user = [
        `BUSINESS: ${org?.name ?? ''}${org?.industry ? ` (${org.industry})` : ''}`,
        org?.description ? `ABOUT THEM: ${org.description.slice(0, 800)}` : '',
        products ?? '',
        knowledge ?? '',
        `THE FLYER: "${brief.title}" — printed ${paper.label.split(' — ')[0]}.`,
        brief.message ? `WHAT IT IS FOR: ${brief.message}` : '',
        brief.headline ? `THE OWNER'S OWN HEADLINE (use it unchanged): ${brief.headline}` : '',
        brief.mood ? `TONE: ${brief.mood}` : '',
        brief.mustInclude ? `MUST INCLUDE: ${brief.mustInclude}` : '',
        brief.mustAvoid ? `MUST AVOID: ${brief.mustAvoid}` : '',
    ].filter(Boolean).join('\n\n');

    let drafted: DraftedWords | null = null;
    try {
        const res = await gatewayGenerate({
            system: flyerWordsSystemPrompt() + (rules ? `\n\n${rules}` : ''),
            messages: [{ role: 'user', content: user }],
            maxTokens: 600,
            deadlineMs: 45_000,
            usage: { workspaceId: orgId, assistantId: brief.aiAssistantId },
            ...(await gatewayRoleModel(db, 'brand_designer')),
        });
        drafted = parseDraftedWords(res.text);
    } catch (err) {
        console.error('[flyer-words] draft failed:', brief.id, err instanceof Error ? err.message : err);
    }
    if (!drafted) return { ok: false, status: 502, error: 'The words could not be drafted just now. Nothing was charged — try again, or type them in.' };
    if (brief.headline) drafted.headline = brief.headline.slice(0, FLYER_LIMITS.headline);

    const saved = brief.flyerContent ? normaliseFlyerContent(brief.flyerContent) : null;
    const defaults = saved && saved.ok ? null : await contactDefaults(db, orgId, intro);
    const n = normaliseFlyerContent({
        ...drafted,
        offer: saved && saved.ok ? saved.content.offer : offerLine(intro),
        dateLine: saved && saved.ok ? saved.content.dateLine : null,
        contact: saved && saved.ok ? saved.content.contact : defaults!.contact,
        qr: saved && saved.ok ? saved.content.qr : defaults!.qr,
    });
    if (!n.ok) return { ok: false, status: 502, error: 'The words could not be drafted just now. Nothing was charged — try again, or type them in.' };

    await db.update(visualBriefs).set({ flyerContent: n.content, updatedAt: new Date() })
        .where(and(eq(visualBriefs.id, brief.id), eq(visualBriefs.organisationId, orgId)));
    // AFTER the success — a failed draft costs nothing (work-metering.ts).
    await recordCompletedWork(db, orgId, 'flyer_words', { ref: `flyer-brief-${brief.id}`, assistantId: brief.aiAssistantId });
    return { ok: true, content: n.content };
}
