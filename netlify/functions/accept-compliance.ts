// netlify/functions/accept-compliance.ts
// Onboarding Wizard Step 5 (Compliance, US6 AC2). Records the organisation's acceptance of
// the plain-language AI-usage / data-processing agreement as a single timestamp on
// organisations.compliance_accepted_at. A non-null value marks the step complete in
// get-wizard-state.ts.
//
//   GET           → { acceptedAt: string | null }
//   POST { accepted } → set (now) / clear (null) the acceptance timestamp; returns { acceptedAt }
//
// Org-scoped: the timestamp is a property of the workspace, not the individual user.

import { Handler } from '@netlify/functions';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { organisations } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export const handler: Handler = async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    if (event.httpMethod === 'GET') {
        const [org] = await db.select({ acceptedAt: organisations.complianceAcceptedAt })
            .from(organisations).where(eq(organisations.id, orgId)).limit(1);
        return json(200, { acceptedAt: org?.acceptedAt ?? null });
    }

    if (event.httpMethod === 'POST') {
        const body = JSON.parse(event.body || '{}');
        // Default to acceptance; only an explicit `accepted: false` clears it (toggle off).
        const acceptedAt = body.accepted === false ? null : new Date();
        await db.update(organisations)
            .set({ complianceAcceptedAt: acceptedAt })
            .where(eq(organisations.id, orgId));
        return json(200, { acceptedAt });
    }

    return json(405, { error: 'Method Not Allowed' });
};
