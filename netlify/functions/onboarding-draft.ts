// netlify/functions/onboarding-draft.ts
// Auto-save store for in-progress assistant setups. Multi-row: a user/org may have
// several drafts at once, each surfaced as an "Onboarding" card.
//
//   GET                 → list the caller's drafts (newest first) — feeds the cards
//   GET    ?id=N        → hydrate a single draft (wizard resume)
//   POST                → create a new draft, returns { id }
//   PATCH/PUT ?id=N     → autosave a draft by id (bumps updatedAt)
//   DELETE ?id=N        → cancel/delete a draft by id
//
// Every id-scoped operation is authorised against the caller's userId.

import { Handler } from '@netlify/functions';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { onboardingDrafts } from '../../db/schema';
import { getSession } from '../../src/utils/session';
import { resolveActiveOrg } from '../../src/utils/tenant';

const json = (statusCode: number, body: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

export const handler: Handler = async (event) => {
    const session = getSession(event);
    if (!session) return json(401, { error: 'Unauthorized.' });
    const userId = session.userId;

    const db = getDb();

    try {
        // Org is best-effort — drafts still work for users mid-onboarding without a
        // resolvable active org (organisation_id is nullable).
        const org = await resolveActiveOrg(db, userId, session.activeOrganisationId);
        const organisationId = org?.organisationId ?? null;

        const qs = event.queryStringParameters || {};
        const draftId = qs.id ? Number(qs.id) : null;

        // ── GET ──────────────────────────────────────────────────────────
        if (event.httpMethod === 'GET') {
            if (draftId) {
                const [draft] = await db.select().from(onboardingDrafts)
                    .where(and(eq(onboardingDrafts.id, draftId), eq(onboardingDrafts.userId, userId)));
                return json(200, { draft: draft || null });
            }
            const drafts = await db.select().from(onboardingDrafts)
                .where(eq(onboardingDrafts.userId, userId))
                .orderBy(desc(onboardingDrafts.updatedAt));
            return json(200, { drafts });
        }

        // ── POST: create a fresh draft ───────────────────────────────────
        if (event.httpMethod === 'POST') {
            const body = JSON.parse(event.body || '{}');
            const { onboardingPath, roleKey, displayName, currentStep, draftData } = body;
            if (!onboardingPath) return json(400, { error: 'onboardingPath is required.' });

            const [created] = await db.insert(onboardingDrafts).values({
                userId,
                organisationId,
                onboardingPath,
                roleKey: roleKey || null,
                displayName: displayName || null,
                currentStep: typeof currentStep === 'number' ? currentStep : 1,
                draftData: draftData || {},
            }).returning({ id: onboardingDrafts.id });

            return json(200, { id: created.id });
        }

        // ── PATCH / PUT: autosave by id ──────────────────────────────────
        if (event.httpMethod === 'PATCH' || event.httpMethod === 'PUT') {
            if (!draftId) return json(400, { error: 'Draft id is required.' });
            const body = JSON.parse(event.body || '{}');
            const { currentStep, onboardingPath, draftData, roleKey, displayName } = body;

            const [existing] = await db.select().from(onboardingDrafts)
                .where(and(eq(onboardingDrafts.id, draftId), eq(onboardingDrafts.userId, userId)));
            if (!existing) return json(404, { error: 'Draft not found.' });

            await db.update(onboardingDrafts).set({
                currentStep: currentStep ?? existing.currentStep,
                onboardingPath: onboardingPath ?? existing.onboardingPath,
                draftData: draftData ?? existing.draftData,
                roleKey: roleKey ?? existing.roleKey,
                displayName: displayName ?? existing.displayName,
                // Backfill org if it wasn't known at create time.
                organisationId: existing.organisationId ?? organisationId,
                updatedAt: new Date(),
                // AC2.4: saving progress resets the 30-day clock — re-arm the nudge so an
                // abandoned-again draft is reminded afresh next cycle.
                reminderSentAt: null,
            }).where(eq(onboardingDrafts.id, draftId));

            return json(200, { success: true });
        }

        // ── DELETE by id ─────────────────────────────────────────────────
        if (event.httpMethod === 'DELETE') {
            if (!draftId) return json(400, { error: 'Draft id is required.' });
            await db.delete(onboardingDrafts)
                .where(and(eq(onboardingDrafts.id, draftId), eq(onboardingDrafts.userId, userId)));
            return json(200, { success: true });
        }

        return json(405, { error: 'Method Not Allowed' });
    } catch (error) {
        console.error('Onboarding Draft API Error:', error);
        return json(500, { error: 'Internal Server Error' });
    }
};
