// src/utils/sender-identity.ts
// Read the sender's business identity from the org row. Rendering lives in
// src/config/sender-identity.ts — same split as icp-snapshot.ts / icp-profile.ts.
//
// One reader for every drafting seam on purpose. Four prompts write prospect-facing prose
// (discovery scoring, manual lead scoring, send-time generation, sequence follow-ups) and three of
// them already had an `organisations` query in scope for something else — the postal address, the
// footer's sender name. Letting each one pick its own fields is how the body and the footer came to
// disagree about who sent the email in the first place.

import { eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { organisations } from '../../db/schema';
import type { SenderIdentity } from '../config/sender-identity';

type Db = ReturnType<typeof getDb>;

/**
 * Never throws and never returns null: a failed read yields an unnamed sender, which
 * senderIdentityBlock() renders as an explicit "do not guess a name" instruction. An outreach draft
 * that has to be signed by hand is a worse draft; one signed with the wrong company is a wrong one.
 */
export async function loadSenderIdentity(db: Db, organisationId: number): Promise<SenderIdentity> {
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
        return {
            businessName: org?.name ?? '',
            businessDescription: org?.businessDescription ?? null,
            industry: org?.industry ?? null,
            websiteUrl: org?.websiteUrl ?? null,
        };
    } catch (err) {
        console.error('[sender-identity] could not read the org row:', err);
        return { businessName: '' };
    }
}
