// src/utils/outreach-offer.ts
// The database half of a Lead Generator's outreach offer (src/config/outreach-offer.ts says what it is
// and why): which sign-up form is the free gift, the tracked link a follow-up carries, and crediting
// the lead when somebody signs up through it.
//
// Stored on the assistant's setup answers — onboarding_context.outreachOffer ('gift' | 'intro_offer' |
// 'reply') and .outreachOfferFormId — merged by lead-generation.ts `set_outreach_offer`, the ONE writer
// behind the Outreach tab's offer strip and the chat's outreach_offer card. Read through
// loadSenderIdentity(), which every outreach prompt already loads, so no seam can miss it.
//
// THE LINK. A gift form's own page (/f/<slug> or /s/<key>) plus `lt=<threadId>.<sig>` — an HMAC of the
// conversation under the app secret, so an id can't be walked to credit (or halt) someone else's lead.
// No new table: the thread already names the org, assistant and lead. The sign-up endpoint
// (audience-public.ts) already receives the page's address for campaign attribution; creditOfferSignup
// reads the same address, after the person is subscribed, and never throws.

import { createHmac, timingSafeEqual } from 'crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, audienceForms, leadThreads, revenueEvents, sequenceEnrolments } from '../../db/schema';
import { cleanOutreachOfferKind, type OutreachOfferKind, type ResolvedOutreachOffer } from '../config/outreach-offer';
import { loadIntroOffer, summariseIntroOffer } from './intro-offer';
import { recordEvent } from './revenue-ledger';
import { haltEnrolment } from './outreach-sequences';
import { getBlueprintVersion } from './blueprint-version';
import { getIcpSnapshot } from './icp-snapshot';

type Db = ReturnType<typeof getDb>;

export interface GiftForm { id: number; name: string; giftLabel: string; linkable: boolean }

/** The free download a form's definition names, or null. Pure. */
function giftLabelOf(definition: unknown): string | null {
    const rw = definition && typeof definition === 'object' ? (definition as { reward?: unknown }).reward : null;
    if (!rw || typeof rw !== 'object') return null;
    const r = rw as { assetId?: unknown; label?: unknown };
    if (!Number.isInteger(Number(r.assetId))) return null;
    const label = typeof r.label === 'string' ? r.label.replace(/\s+/g, ' ').trim() : '';
    return label ? label.slice(0, 120) : 'free guide';
}

/** The workspace's active sign-up forms that send a free download, newest first. [] on failure. */
export async function listGiftForms(db: Db, organisationId: number): Promise<GiftForm[]> {
    try {
        const rows = await db.select({
            id: audienceForms.id, name: audienceForms.name, definition: audienceForms.definition,
            hostedEnabled: audienceForms.hostedEnabled,
        }).from(audienceForms)
            .where(and(eq(audienceForms.organisationId, organisationId), eq(audienceForms.status, 'active')))
            .orderBy(desc(audienceForms.id));
        return rows.flatMap((r) => {
            const giftLabel = giftLabelOf(r.definition);
            return giftLabel ? [{ id: r.id, name: r.name, giftLabel, linkable: !!r.hostedEnabled }] : [];
        });
    } catch (err) {
        console.error('[outreach-offer] could not list gift forms:', (err as Error)?.message ?? err);
        return [];
    }
}

/** The owner's choice off the setup answers. Blank = reply (the behaviour before offers existed). Pure. */
export function offerChoiceFromContext(ctx: unknown): { kind: OutreachOfferKind; formId: number | null } {
    const c = ctx && typeof ctx === 'object' ? ctx as Record<string, unknown> : {};
    const formId = Number(c.outreachOfferFormId);
    return { kind: cleanOutreachOfferKind(c.outreachOffer) ?? 'reply', formId: Number.isInteger(formId) && formId > 0 ? formId : null };
}

/**
 * The choice, resolved against what exists. A gift with no gift form, or an intro offer the business
 * hasn't recorded (or said "no" to), falls back to reply — saying why, so the Outreach tab can tell the
 * owner instead of quietly sending emails that offer nothing. Never throws.
 */
export async function resolveOutreachOffer(db: Db, organisationId: number, ctx: unknown): Promise<ResolvedOutreachOffer> {
    const choice = offerChoiceFromContext(ctx);
    try {
        if (choice.kind === 'gift') {
            const forms = await listGiftForms(db, organisationId);
            const form = forms.find((f) => f.id === choice.formId) ?? forms[0];
            if (!form) return { kind: 'reply', unusable: 'None of your sign-up forms sends a free download yet — add one in Audience ▸ Sign-up forms ▸ Free download.' };
            return { kind: 'gift', formId: form.id, formName: form.name, giftLabel: form.giftLabel, linkable: form.linkable };
        }
        if (choice.kind === 'intro_offer') {
            const intro = await loadIntroOffer(db, organisationId);
            if (!intro || !intro.has) return { kind: 'reply', unusable: 'Your free trial or introductory offer isn\'t recorded — add it in Business Information ▸ Products & Services.' };
            return { kind: 'intro_offer', summary: summariseIntroOffer({ ...intro, url: null }), url: intro.url };
        }
    } catch (err) {
        console.error('[outreach-offer] could not resolve the offer (sending without one):', (err as Error)?.message ?? err);
    }
    return { kind: 'reply' };
}

/** resolveOutreachOffer for one assistant, by id. Never throws. */
export async function loadOutreachOffer(db: Db, organisationId: number, assistantId: number): Promise<ResolvedOutreachOffer> {
    try {
        const [a] = await db.select({ ctx: aiAssistants.onboardingContext }).from(aiAssistants)
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, organisationId))).limit(1);
        return await resolveOutreachOffer(db, organisationId, a?.ctx);
    } catch {
        return { kind: 'reply' };
    }
}

// ── The tracked link ─────────────────────────────────────────────────────────────────────────────

function secret(): string {
    const s = process.env.JWT_SECRET;
    if (!s) throw new Error('JWT_SECRET is not set — cannot sign offer links.');
    return s;
}

/** `<threadId>.<sig>` — the value of the link's `lt` parameter. */
export function signOfferRef(threadId: number, key = secret()): string {
    const sig = createHmac('sha256', key).update(`lead-offer:${threadId}`).digest('hex').slice(0, 20);
    return `${threadId}.${sig}`;
}

/** The thread an `lt` value names, or null when it is malformed or forged. */
export function verifyOfferRef(ref: string | null | undefined, key?: string): number | null {
    const m = /^(\d{1,10})\.([0-9a-f]{20})$/.exec(String(ref ?? ''));
    if (!m) return null;
    const threadId = Number(m[1]);
    let expected: Buffer;
    try { expected = Buffer.from(signOfferRef(threadId, key ?? secret()).split('.')[1]); } catch { return null; }
    const given = Buffer.from(m[2]);
    return expected.length === given.length && timingSafeEqual(expected, given) ? threadId : null;
}

/** The `lt` value in a page address, or null. Pure. */
export function offerRefFromUrl(pageUrl: string | null | undefined): string | null {
    if (!pageUrl) return null;
    try { return new URL(pageUrl).searchParams.get('lt'); } catch { return null; }
}

const BASE = () => (process.env.BASE_URL || 'https://bemoreswan.com').replace(/\/+$/, '');

/**
 * The link a follow-up (or a reply) carries for this conversation: a gift form's page with the signed
 * ref, or the intro offer's own address (not ours, so not tracked). Null when there is nothing to link.
 */
export async function offerLinkForThread(
    db: Db, offer: ResolvedOutreachOffer, threadId: number | null | undefined, baseUrl?: string | null,
): Promise<string | null> {
    if (offer.kind === 'intro_offer') return offer.url;
    if (offer.kind !== 'gift' || !offer.linkable) return null;
    try {
        const [f] = await db.select({ slug: audienceForms.slug, publicKey: audienceForms.publicKey })
            .from(audienceForms).where(eq(audienceForms.id, offer.formId)).limit(1);
        if (!f) return null;
        const base = (baseUrl || BASE()).replace(/\/+$/, '');
        const page = f.slug ? `${base}/f/${f.slug}` : `${base}/s/${f.publicKey}`;
        return threadId ? `${page}?lt=${signOfferRef(threadId)}` : page;
    } catch (err) {
        console.error('[outreach-offer] could not build the offer link:', (err as Error)?.message ?? err);
        return null;
    }
}

// ── Crediting a sign-up ─────────────────────────────────────────────────────────────────────────

/**
 * Somebody signed up on a form page reached through an offer link: credit the lead (an
 * `offer_signed_up` event in its Activity, once per conversation) and stop its chasers — they have
 * said yes, and a "just bumping this" after that reads as not listening.
 *
 * Called by audience-public.ts after the sign-up is recorded. Never throws, and the sign-up never
 * waits on it to succeed. Returns the thread credited, or null.
 */
export async function creditOfferSignup(db: Db, input: {
    organisationId: number; formId: number; contactId: number; pageUrl: string | null;
}): Promise<number | null> {
    try {
        const threadId = verifyOfferRef(offerRefFromUrl(input.pageUrl));
        if (!threadId) return null;
        const [t] = await db.select({
            id: leadThreads.id, organisationId: leadThreads.organisationId, aiAssistantId: leadThreads.aiAssistantId,
            assistantRecordId: leadThreads.assistantRecordId, discoveredLeadId: leadThreads.discoveredLeadId,
        }).from(leadThreads).where(eq(leadThreads.id, threadId)).limit(1);
        // A signed link to another workspace's conversation, on this workspace's form, credits nothing.
        if (!t || t.organisationId !== input.organisationId) return null;

        const [already] = await db.select({ id: revenueEvents.id }).from(revenueEvents)
            .where(and(
                eq(revenueEvents.organisationId, t.organisationId),
                eq(revenueEvents.eventType, 'offer_signed_up'),
                sql`${revenueEvents.payload}->>'leadThreadId' = ${String(t.id)}`,
            )).limit(1);
        if (!already) {
            await recordEvent(db, 'offer_signed_up', {
                organisationId: t.organisationId,
                aiAssistantId: t.aiAssistantId,
                discoveredLeadId: t.discoveredLeadId,
                assistantRecordId: t.assistantRecordId,
                actor: 'system',
                blueprintVersion: await getBlueprintVersion(db, t.aiAssistantId),
                icpSnapshot: await getIcpSnapshot(db, { discoveredLeadId: t.discoveredLeadId, aiAssistantId: t.aiAssistantId }),
                payload: { leadThreadId: t.id, formId: input.formId, contactId: input.contactId },
            });
        }

        const active = await db.select({
            id: sequenceEnrolments.id, organisationId: sequenceEnrolments.organisationId,
            aiAssistantId: sequenceEnrolments.aiAssistantId, assistantRecordId: sequenceEnrolments.assistantRecordId,
            discoveredLeadId: sequenceEnrolments.discoveredLeadId, lastStepSent: sequenceEnrolments.lastStepSent,
        }).from(sequenceEnrolments)
            .where(and(eq(sequenceEnrolments.leadThreadId, t.id), eq(sequenceEnrolments.state, 'active')));
        for (const e of active) await haltEnrolment(db, e, 'signed_up');
        return t.id;
    } catch (err) {
        console.error('[outreach-offer] could not credit the sign-up to a lead (the sign-up itself is fine):', (err as Error)?.message ?? err);
        return null;
    }
}
