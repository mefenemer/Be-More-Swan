// src/utils/call-to-action.ts
// The database half of an assistant's call to action (src/config/call-to-action.ts says what it is):
// resolving the choice against the workspace's real offer and forms, listing the assistants that
// have one, and saving it. Never throws on the read paths.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, masterAssistants } from '../../db/schema';
import { cleanCtaKind, CTA_ROLES, type CtaKind, type ResolvedCta } from '../config/call-to-action';
import { loadIntroOffer, summariseIntroOffer } from './intro-offer';
import { listGiftForms, offerLinkForThread } from './outreach-offer';

type Db = ReturnType<typeof getDb>;

/** The owner's choice off the setup answers. Blank = 'own'. Pure. */
export function ctaChoiceFromContext(ctx: unknown): { kind: CtaKind; formId: number | null } {
    const c = ctx && typeof ctx === 'object' ? ctx as Record<string, unknown> : {};
    const formId = Number(c.ctaOfferFormId);
    return { kind: cleanCtaKind(c.ctaOffer) ?? 'own', formId: Number.isInteger(formId) && formId > 0 ? formId : null };
}

/**
 * The choice resolved against what exists. An intro offer that isn't recorded, or a gift with no
 * gift form, falls back to 'own' and says why. Never throws.
 */
export async function resolveCta(db: Db, organisationId: number, ctx: unknown): Promise<ResolvedCta> {
    const choice = ctaChoiceFromContext(ctx);
    try {
        if (choice.kind === 'intro_offer') {
            const intro = await loadIntroOffer(db, organisationId);
            if (!intro || !intro.has) return { kind: 'own', unusable: 'Your free trial or introductory offer isn\'t recorded yet — add it above.' };
            return { kind: 'intro_offer', summary: summariseIntroOffer({ ...intro, url: null }), url: intro.url };
        }
        if (choice.kind === 'gift') {
            const forms = await listGiftForms(db, organisationId);
            const form = forms.find((f) => f.id === choice.formId) ?? forms[0];
            if (!form) return { kind: 'own', unusable: 'None of your sign-up forms sends a free download yet.' };
            const url = await offerLinkForThread(db, { kind: 'gift', formId: form.id, formName: form.name, giftLabel: form.giftLabel, linkable: form.linkable }, null);
            return { kind: 'gift', formId: form.id, formName: form.name, giftLabel: form.giftLabel, url };
        }
    } catch (err) {
        console.error('[call-to-action] could not resolve (drafting with its own call to action):', (err as Error)?.message ?? err);
    }
    return { kind: 'own' };
}

/** resolveCta for one assistant, by id. Never throws. */
export async function loadCtaForAssistant(db: Db, organisationId: number, assistantId: number | null | undefined): Promise<ResolvedCta> {
    if (!assistantId) return { kind: 'own' };
    try {
        const [a] = await db.select({ ctx: aiAssistants.onboardingContext }).from(aiAssistants)
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, organisationId))).limit(1);
        return await resolveCta(db, organisationId, a?.ctx);
    } catch {
        return { kind: 'own' };
    }
}

export interface CtaAssistant { id: number; name: string; roleKey: string; choice: { kind: CtaKind; formId: number | null }; resolved: ResolvedCta }

/** This workspace's live Social, Blog and Email assistants with their call to action. [] on failure. */
export async function listCtaAssistants(db: Db, organisationId: number): Promise<CtaAssistant[]> {
    try {
        const rows = await db.select({ id: aiAssistants.id, name: aiAssistants.name, roleKey: masterAssistants.roleKey, ctx: aiAssistants.onboardingContext })
            .from(aiAssistants)
            .innerJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
            .where(and(
                eq(aiAssistants.organisationId, organisationId),
                sql`${aiAssistants.archivedAt} IS NULL`,
                inArray(masterAssistants.roleKey, [...CTA_ROLES]),
            ))
            .orderBy(aiAssistants.id);
        return await Promise.all(rows.map(async (r) => ({
            id: r.id, name: r.name, roleKey: r.roleKey,
            choice: ctaChoiceFromContext(r.ctx),
            resolved: await resolveCta(db, organisationId, r.ctx),
        })));
    } catch (err) {
        console.error('[call-to-action] could not list assistants:', (err as Error)?.message ?? err);
        return [];
    }
}

/**
 * Save one assistant's choice — merges two keys into its setup answers. The assistant must be a live
 * Social, Blog or Email assistant in this workspace, and a gift must name one of its gift forms.
 */
export async function saveCta(db: Db, organisationId: number, input: { assistantId: unknown; kind: unknown; formId?: unknown }): Promise<{ assistant: CtaAssistant } | { error: string; status: number }> {
    const kind = cleanCtaKind(input.kind);
    if (!kind) return { error: 'Choose its own call to action, your offer, or a free download.', status: 400 };
    const assistantId = Number(input.assistantId);
    const target = (await listCtaAssistants(db, organisationId)).find((a) => a.id === assistantId);
    if (!target) return { error: 'That isn\'t one of your Social, Blog or Email assistants.', status: 404 };
    let formId: number | null = null;
    if (kind === 'gift') {
        const forms = await listGiftForms(db, organisationId);
        const form = forms.find((f) => f.id === Number(input.formId)) ?? (input.formId == null ? forms[0] : undefined);
        if (!form) {
            return { error: forms.length ? 'Choose one of your sign-up forms that sends a free download.'
                : 'None of your sign-up forms sends a free download yet. Add one in Audience ▸ Sign-up forms ▸ Free download first.', status: 400 };
        }
        formId = form.id;
    }
    const [row] = await db.select({ ctx: aiAssistants.onboardingContext }).from(aiAssistants)
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, organisationId))).limit(1);
    const ctx = row?.ctx && typeof row.ctx === 'object' && !Array.isArray(row.ctx) ? row.ctx as Record<string, unknown> : {};
    const next = { ...ctx, ctaOffer: kind, ctaOfferFormId: formId };
    await db.update(aiAssistants).set({ onboardingContext: next, updatedAt: new Date() })
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, organisationId)));
    return { assistant: { ...target, choice: { kind, formId }, resolved: await resolveCta(db, organisationId, next) } };
}
