// netlify/functions/get-my-agreements.ts
// "My Agreements" tab — single aggregator over every user/org-accepted agreement, so the
// My Account page renders in one round-trip and the payload doubles as a GDPR / EU AI Act
// consent snapshot.
//
// GET → { agreements: Agreement[] }
//
// Reuses the existing acceptance stores and version constants (does NOT re-derive them):
//   - ToS              → tosAcceptances              · CURRENT_TOS_VERSION (accept-tos.ts)
//   - Privacy          → static page, no record (informational row)
//   - DPA              → dpaAcceptances (org-scoped)  · CURRENT_DPA_VERSION (accept-dpa.ts)
//   - AI usage & data  → organisations.complianceAcceptedAt (accept-compliance.ts)
//   - AI acknowledgement → userProfiles.legalConsents.aiDisclaimerAcceptedAt (legal-consent.ts)

import { Handler } from '@netlify/functions';
import { eq, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    tosAcceptances,
    dpaAcceptances,
    organisations,
    userProfiles,
} from '../../db/schema';
import { CURRENT_TOS_VERSION } from './accept-tos';
import { CURRENT_DPA_VERSION } from './accept-dpa';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';

// Keep in lockstep with the disclaimer version stamped in legal-consent.ts.
const CURRENT_AI_DISCLAIMER_VERSION = '2026-06-10';

const json = (statusCode: number, body: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();

    // Resolve org the same way every other agreement endpoint does (accept-compliance.ts,
    // get-wizard-state.ts) — the session's active-org claim, re-verified against current
    // membership. The previous ad-hoc "first userOrganisations row, no ordering" lookup could
    // pick a DIFFERENT org than the one the toggle/wizard act on for any multi-org user, making
    // this tab (and the ai_data completion check that advances the wizard) show the wrong org's
    // agreement status.
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId } = ctx;

    // ── ToS (user-scoped) ─────────────────────────────────────────────
    // Pull the FULL acceptance history (every version the user has ever accepted, newest
    // first) so the My Agreements tab can render an audit log of dates/times, not just the
    // latest record. The head of the list is the current acceptance.
    const tosHistory = await db
        .select({ version: tosAcceptances.version, acceptedAt: tosAcceptances.acceptedAt })
        .from(tosAcceptances)
        .where(eq(tosAcceptances.userId, userId))
        .orderBy(desc(tosAcceptances.acceptedAt));
    const latestTos = tosHistory[0];
    const currentTos = tosHistory.find((t) => t.version === CURRENT_TOS_VERSION);

    // ── DPA (org-scoped) ──────────────────────────────────────────────
    const dpaHistory = organisationId
        ? await db
              .select({ version: dpaAcceptances.version, acceptedAt: dpaAcceptances.acceptedAt })
              .from(dpaAcceptances)
              .where(eq(dpaAcceptances.organisationId, organisationId))
              .orderBy(desc(dpaAcceptances.acceptedAt))
        : [];
    const latestDpa = dpaHistory[0];

    // ── Plain-language AI usage & data agreement (org-scoped timestamp) ─
    const [orgRow] = organisationId
        ? await db
              .select({ acceptedAt: organisations.complianceAcceptedAt })
              .from(organisations)
              .where(eq(organisations.id, organisationId))
              .limit(1)
        : [undefined];

    // ── AI content acknowledgement (user-scoped JSON) ─────────────────
    const [profile] = await db
        .select({ legalConsents: userProfiles.legalConsents })
        .from(userProfiles)
        .where(eq(userProfiles.userId, userId))
        .limit(1);
    const consents = (profile?.legalConsents as Record<string, any>) || {};

    // `history` is the full audit trail of acceptances for the agreement (newest first).
    // For the two single-timestamp agreements (AI usage & data, AI acknowledgement) we only
    // have the latest acceptance on record, so the trail is a single synthesised entry.
    const aiDataHistory = orgRow?.acceptedAt
        ? [{ version: null, acceptedAt: orgRow.acceptedAt }]
        : [];
    const aiDisclaimerHistory = consents.aiDisclaimerAcceptedAt
        ? [{ version: consents.tosVersion ?? null, acceptedAt: consents.aiDisclaimerAcceptedAt }]
        : [];

    const agreements = [
        {
            key: 'tos',
            name: 'Terms of Service',
            scope: 'user',
            acceptedVersion: latestTos?.version ?? null,
            currentVersion: CURRENT_TOS_VERSION,
            acceptedAt: latestTos?.acceptedAt ?? null,
            upToDate: !!currentTos,
            reviewUrl: '/terms_of_service.html',
            history: tosHistory,
        },
        {
            key: 'privacy',
            name: 'Privacy Policy',
            scope: 'info',
            reviewUrl: '/privacy.html',
            history: [],
        },
        {
            key: 'dpa',
            name: 'Data Processing Agreement',
            scope: 'org',
            acceptedVersion: latestDpa?.version ?? null,
            currentVersion: CURRENT_DPA_VERSION,
            acceptedAt: latestDpa?.acceptedAt ?? null,
            upToDate: latestDpa?.version === CURRENT_DPA_VERSION,
            history: dpaHistory,
        },
        {
            key: 'ai_data',
            name: 'Responsible AI Use Agreement',
            scope: 'org',
            acceptedVersion: null,
            currentVersion: null,
            acceptedAt: orgRow?.acceptedAt ?? null,
            upToDate: !!orgRow?.acceptedAt,
            history: aiDataHistory,
        },
        {
            key: 'ai_disclaimer',
            name: 'AI content acknowledgement',
            scope: 'user',
            acceptedVersion: consents.tosVersion ?? null,
            currentVersion: CURRENT_AI_DISCLAIMER_VERSION,
            acceptedAt: consents.aiDisclaimerAcceptedAt ?? null,
            upToDate: !!consents.aiDisclaimerAcceptedAt,
            history: aiDisclaimerHistory,
        },
    ];

    return json(200, { agreements });
});
