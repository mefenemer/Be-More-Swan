// src/utils/sender-identity.ts
// Read the sender's business identity from the org row. Rendering lives in
// src/config/sender-identity.ts — same split as icp-snapshot.ts / icp-profile.ts.
//
// One reader for every drafting seam on purpose. Four prompts write prospect-facing prose
// (discovery scoring, manual lead scoring, send-time generation, sequence follow-ups) and three of
// them already had an `organisations` query in scope for something else — the postal address, the
// footer's sender name. Letting each one pick its own fields is how the body and the footer came to
// disagree about who sent the email in the first place.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, organisations } from '../../db/schema';
import { signatureFromContext } from './outreach-signature';
import type { SenderIdentity } from '../config/sender-identity';
import { loadProductsBlock } from './org-products';
import { loadSiteDirectoryBlock } from './site-directory-store';
import { resolveOutreachOffer } from './outreach-offer';
import type { ResolvedOutreachOffer } from '../config/outreach-offer';

type Db = ReturnType<typeof getDb>;

/**
 * Never throws and never returns null: a failed read yields an unnamed sender, which
 * senderIdentityBlock() renders as an explicit "do not guess a name" instruction. An outreach draft
 * that has to be signed by hand is a worse draft; one signed with the wrong company is a wrong one.
 */
/**
 * @param assistantId The SENDING assistant, when known — its email signature (onboarding_context
 *   .outreachSignature) tells the prompt not to sign off. Omitted = no signature, today's behaviour.
 */
export async function loadSenderIdentity(db: Db, organisationId: number, assistantId?: number | null): Promise<SenderIdentity> {
    try {
        const [org] = await db
            .select({
                name: organisations.name,
                businessDescription: organisations.businessDescription,
                industry: organisations.industry,
                websiteUrl: organisations.websiteUrl,
            })
            .from(organisations)
            .where(eq(organisations.id, organisationId))
            .limit(1);
        let signature: string | null = null;
        // And what its emails offer (src/utils/outreach-offer.ts) — every outreach prompt loads the
        // sender, so carrying the offer here means no seam can draft without it. Never throws.
        let outreachOffer: ResolvedOutreachOffer | null = null;
        if (assistantId) {
            const [a] = await db.select({ ctx: aiAssistants.onboardingContext }).from(aiAssistants)
                .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, organisationId))).limit(1);
            signature = signatureFromContext(a?.ctx) || null;
            outreachOffer = await resolveOutreachOffer(db, organisationId, a?.ctx);
        }
        return {
            businessName: org?.name ?? '',
            businessDescription: org?.businessDescription ?? null,
            industry: org?.industry ?? null,
            websiteUrl: org?.websiteUrl ?? null,
            // Never throws — no products (or no table yet) is simply no block.
            productsBlock: await loadProductsBlock(db, organisationId, org?.name ?? null),
            // The pages of their website (site-directory-store.ts). Never throws.
            siteDirectoryBlock: await loadSiteDirectoryBlock(db, organisationId),
            signature,
            outreachOffer,
        };
    } catch (err) {
        console.error('[sender-identity] could not read the org row:', err);
        return { businessName: '' };
    }
}
