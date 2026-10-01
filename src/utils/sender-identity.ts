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
        if (assistantId) {
            const [a] = await db.select({ ctx: aiAssistants.onboardingContext }).from(aiAssistants)
                .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, organisationId))).limit(1);
            signature = signatureFromContext(a?.ctx) || null;
        }
        return {
            businessName: org?.name ?? '',
            businessDescription: org?.businessDescription ?? null,
            industry: org?.industry ?? null,
            websiteUrl: org?.websiteUrl ?? null,
            signature,
        };
    } catch (err) {
        console.error('[sender-identity] could not read the org row:', err);
        return { businessName: '' };
    }
}
