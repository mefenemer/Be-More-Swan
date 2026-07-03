// netlify/functions/social-profile-sync.ts
// US-SMM-4.2.2: Business profile synchronisation — pushes org profile to Meta Page and LinkedIn org.
// POST { organisationId? }  — reads org profile, pushes to connected Meta/LinkedIn.
// Triggered post-OAuth (fire-and-forget) and via "Sync Profile" button on integrations page.

import { Handler } from '@netlify/functions';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { systemConnections, organisations, aiAssistants, notifications, userOrganisations } from '../../db/schema';
import { getSecret } from '../../src/utils/vault';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { requireTenant } from '../../src/utils/tenant';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const baseUrl = resolveBaseUrl(event.headers);
    if (!baseUrl) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const db = getDb();

    // Accept auth from either session cookie (user-triggered) or internal call (organisationId in body)
    const cookieHeader = event.headers.cookie || '';
    const sessionToken = cookieHeader.match(/aura_session=([^;]+)/)?.[1];

    let organisationId: number | undefined;
    let callerUserId: number | undefined;

    if (sessionToken) {
        // Session carries `activeOrganisationId`, not `organisationId` — resolve via requireTenant.
        const ctx = await requireTenant(event, db);
        if ('error' in ctx) return ctx.error;
        callerUserId = ctx.userId;
        organisationId = ctx.organisationId;
    }

    const body = JSON.parse(event.body || '{}');
    if (!organisationId && body.organisationId) {
        // Internal call — only allowed from same host
        const origin = event.headers['x-forwarded-host'] ?? event.headers.host ?? '';
        if (!origin.includes('netlify') && !origin.includes('localhost') && !baseUrl.includes(origin)) {
            return { statusCode: 403, body: 'Forbidden' };
        }
        organisationId = parseInt(body.organisationId);
    }

    if (!organisationId) return { statusCode: 400, body: JSON.stringify({ error: 'organisationId required' }) };

    // Load organisation profile
    const [org] = await db.select({ id: organisations.id, name: organisations.name, slug: organisations.slug })
        .from(organisations)
        .where(eq(organisations.id, organisationId))
        .limit(1);

    if (!org) return { statusCode: 404, body: JSON.stringify({ error: 'Organisation not found' }) };

    // Read onboarding context from the first active assistant for bio/description
    const [assistant] = await db.select({ onboardingContext: aiAssistants.onboardingContext })
        .from(aiAssistants)
        .where(and(eq(aiAssistants.organisationId, organisationId), eq(aiAssistants.isActive, true)))
        .limit(1);

    const ctx = (assistant?.onboardingContext as Record<string, unknown>) ?? {};
    // AC1: prefer platform-tailored bios from the bio generator when present.
    const profileBios = (ctx.profile_bios as { facebook?: string; linkedin?: string } | undefined) ?? {};
    // AC: use stored business_bio field if set; fall back to derived value
    const businessBio: string = (ctx.business_bio as string)
        || ((ctx.target_audience as string) ? `Serving ${ctx.target_audience}. ${ctx.tone_of_voice ?? ''}` : `${org.name} — managed via Be More Swan.`);
    const metaBio: string = profileBios.facebook || businessBio;
    const linkedinBio: string = profileBios.linkedin || businessBio;
    const websiteUrl  = baseUrl;

    // AC: business hours in Meta page-level format (day_of_week: { open, close })
    const businessHours = ctx.business_hours as Record<string, { open: string; close: string }> | undefined;
    // AC: business category mapping — stored as a human-readable string, mapped to Meta page category
    const businessCategory = ctx.business_category as string | undefined;

    const results: Record<string, { status: 'ok' | 'failed' | 'skipped'; detail?: string }> = {};

    // ── Meta (Facebook Page) ─────────────────────────────────────────────────
    const [metaConn] = await db.select({ id: systemConnections.id, vaultRefKey: systemConnections.vaultRefKey, metadata: systemConnections.metadata })
        .from(systemConnections)
        .where(and(eq(systemConnections.organisationId, organisationId), eq(systemConnections.serviceName, 'instagram'), eq(systemConnections.isActive, true)))
        .limit(1);

    if (metaConn?.vaultRefKey) {
        const secret = await getSecret(db, metaConn.vaultRefKey);
        const token  = (secret as { token?: string } | null)?.token;
        const fbPageId = (metaConn.metadata as Record<string, unknown>)?.fbPageId as string | undefined;

        if (token && fbPageId) {
            try {
                const updatePayload: Record<string, unknown> = {
                    website: websiteUrl,
                    description: metaBio.slice(0, 255),
                    access_token: token,
                };
                if (businessCategory) updatePayload.category_list = JSON.stringify([businessCategory]);
                if (businessHours) updatePayload.hours = JSON.stringify(businessHours);
                const params = new URLSearchParams(Object.fromEntries(Object.entries(updatePayload).map(([k, v]) => [k, String(v)])));
                const res = await fetch(`https://graph.facebook.com/v19.0/${fbPageId}?${params.toString()}`, { method: 'POST', signal: AbortSignal.timeout(5000) });
                const data: { success?: boolean; error?: { message: string } } = await res.json();
                results.meta = data.success ? { status: 'ok' } : { status: 'failed', detail: data.error?.message };

                // Update lastProfileSyncAt on connection
                const existingMeta = (metaConn.metadata as Record<string, unknown>) ?? {};
                await db.update(systemConnections).set({
                    metadata: { ...existingMeta, lastProfileSyncAt: new Date().toISOString(), lastProfileSyncStatus: results.meta.status },
                    updatedAt: new Date(),
                }).where(eq(systemConnections.id, metaConn.id));
            } catch (err) {
                results.meta = { status: 'failed', detail: String(err) };
                console.warn('[social-profile-sync] Meta sync failed:', err);
            }
        } else {
            results.meta = { status: 'skipped', detail: 'No token or Facebook Page ID found' };
        }
    } else {
        results.meta = { status: 'skipped', detail: 'No active Instagram/Meta connection' };
    }

    // ── LinkedIn ─────────────────────────────────────────────────────────────
    const [liConn] = await db.select({ id: systemConnections.id, vaultRefKey: systemConnections.vaultRefKey, externalUserId: systemConnections.externalUserId, metadata: systemConnections.metadata })
        .from(systemConnections)
        .where(and(eq(systemConnections.organisationId, organisationId), eq(systemConnections.serviceName, 'linkedin'), eq(systemConnections.isActive, true)))
        .limit(1);

    if (liConn?.vaultRefKey) {
        const secret = await getSecret(db, liConn.vaultRefKey);
        const token  = (secret as { token?: string } | null)?.token;

        if (token) {
            // Fetch the org URN via member roles API
            try {
                const rolesRes = await fetch('https://api.linkedin.com/v2/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organization~(localizedName)))', {
                    headers: { Authorization: `Bearer ${token}` },
                    signal: AbortSignal.timeout(5000),
                });
                const rolesData: { elements?: Array<{ organization: string }> } = await rolesRes.json();
                const orgUrn = rolesData.elements?.[0]?.organization;

                if (orgUrn) {
                    const patchRes = await fetch(`https://api.linkedin.com/v2/organizations/${orgUrn.split(':').pop()}`, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Restli-Method': 'partial_update' },
                        body: JSON.stringify({
                            patch: { $set: { websiteUrl, description: { localized: { en_US: linkedinBio.slice(0, 700) } } } },
                        }),
                        signal: AbortSignal.timeout(5000),
                    });
                    results.linkedin = patchRes.ok ? { status: 'ok' } : { status: 'failed', detail: `HTTP ${patchRes.status}` };
                } else {
                    results.linkedin = { status: 'skipped', detail: 'No administrated LinkedIn organisation found' };
                }

                const existingMeta = (liConn.metadata as Record<string, unknown>) ?? {};
                await db.update(systemConnections).set({
                    metadata: { ...existingMeta, lastProfileSyncAt: new Date().toISOString(), lastProfileSyncStatus: results.linkedin?.status ?? 'skipped' },
                    updatedAt: new Date(),
                }).where(eq(systemConnections.id, liConn.id));
            } catch (err) {
                results.linkedin = { status: 'failed', detail: String(err) };
                console.warn('[social-profile-sync] LinkedIn sync failed:', err);
            }
        } else {
            results.linkedin = { status: 'skipped', detail: 'No token found' };
        }
    } else {
        results.linkedin = { status: 'skipped', detail: 'No active LinkedIn connection' };
    }

    // Workspace chat notification (AC)
    const syncedPlatforms = Object.entries(results).filter(([, v]) => v.status === 'ok').map(([k]) => k);
    const failedPlatforms  = Object.entries(results).filter(([, v]) => v.status === 'failed').map(([k]) => k);
    if (callerUserId) {
        const msg = syncedPlatforms.length
            ? `Business profile synced to ${syncedPlatforms.join(', ')}.${failedPlatforms.length ? ` Sync failed for: ${failedPlatforms.join(', ')}.` : ''}`
            : `Profile sync completed — no platforms updated.`;
        await db.insert(notifications).values({
            userId: callerUserId,
            type: 'profile_sync_complete',
            title: 'Social profile sync complete',
            message: msg,
            metadata: { results },
        }).catch(() => {});
    } else {
        // Internal call — find org owner to notify
        const [owner] = await db.select({ userId: userOrganisations.userId })
            .from(userOrganisations)
            .where(and(eq(userOrganisations.organisationId, organisationId), eq(userOrganisations.role, 'owner')))
            .limit(1);
        if (owner) {
            await db.insert(notifications).values({
                userId: owner.userId,
                type: 'profile_sync_complete',
                title: 'Social profile sync complete',
                message: syncedPlatforms.length ? `Business profile synced to ${syncedPlatforms.join(', ')}.` : 'Profile sync completed.',
                metadata: { results },
            }).catch(() => {});
        }
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, results }),
    };
};
