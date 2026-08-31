// src/utils/blog-destinations/store.ts
// Credential custody for blog connectors. Reuses workspace_integrations (provider = `blog_<id>`) +
// vault_secrets, mirroring src/utils/workspace-integrations.ts — but kept SEPARATE from the OAuth
// IntegrationProvider union so the token-refresh machinery there never sees these paste-token creds.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../../db/client';
import { workspaceIntegrations, systemConnections } from '../../../db/schema';
import { storeSecret, getSecret, deleteSecret } from '../vault';
import { getProfileByOrg, ensureProfile } from '../swan-index/profile';
import { swanIndexBaseUrl } from '../swan-index/base-url';
import type { SocialsMap } from '../swan-index/socials';
import { swanIndexProfiles, swanIndexPosts } from '../../../db/schema';
import { inArray } from 'drizzle-orm';
import { getFreshAccessToken, deleteIntegration, type IntegrationProvider } from '../workspace-integrations';
import { getBlogAdapter, BLOG_DESTINATION_IDS, AVAILABLE_BLOG_DESTINATION_IDS } from './index';
import type { BlogDestinationCreds, BlogDestinationId } from './types';

type Db = ReturnType<typeof getDb>;

/**
 * How a connected destination receives an auto-syndicated post on publish: as an unpublished
 * `draft` for the author to release on the platform itself, or straight to `live`. Default is
 * `draft` — a post published on our own site should never surprise-publish onto someone else's
 * blog (US 3.2 AC4). Hashnode has no draft API, so it is always treated as `live`.
 */
export type BlogPublishMode = 'draft' | 'live';
export const DEFAULT_PUBLISH_MODE: BlogPublishMode = 'draft';

const providerFor = (id: BlogDestinationId) => `blog_${id}`;
const refKeyFor = (organisationId: number, id: BlogDestinationId) => `aura/org-${organisationId}/blog-${id}`;
// Non-secret per-destination preferences (publish mode; the social opt-in + its account label).
// Co-located in the blog-connector vault namespace so it needs no schema change;
// workspace_integrations has no JSON column to hold it.
const prefsRefKeyFor = (organisationId: number) => `aura/org-${organisationId}/blog-destination-prefs`;

/** The whole preferences blob. Every writer below merges into this so one key never erases another. */
interface BlogDestinationPrefs {
    modes?: Record<string, string>;
    /** authKind 'social' only: which social destinations this workspace has opted IN to. */
    enabled?: Record<string, boolean>;
    /** authKind 'social' only: the account name resolved when the opt-in was made. */
    labels?: Record<string, string | null>;
}

async function getPrefs(db: Db, organisationId: number): Promise<BlogDestinationPrefs> {
    return ((await getSecret(db, prefsRefKeyFor(organisationId)).catch(() => null)) as BlogDestinationPrefs | null) || {};
}

/**
 * All per-destination publish modes for an org, defaulting missing entries to `draft`.
 *
 * Over EVERY registered destination, withheld ones included: this reads a stored preference, and
 * dropping the withheld keys here would discard a workspace's draft/live choice so that releasing
 * the destination later silently reset it.
 */
export async function getBlogPublishModes(db: Db, organisationId: number): Promise<Record<string, BlogPublishMode>> {
    const blob = await getPrefs(db, organisationId);
    const out: Record<string, BlogPublishMode> = {};
    for (const id of BLOG_DESTINATION_IDS) {
        out[id] = blob?.modes?.[id] === 'live' ? 'live' : 'draft';
    }
    return out;
}

/** Set one destination's publish mode, preserving the others (and the rest of the blob). */
export async function setBlogPublishMode(
    db: Db,
    organisationId: number,
    id: BlogDestinationId,
    mode: BlogPublishMode,
): Promise<void> {
    const prefs = await getPrefs(db, organisationId);
    const modes = { ...(prefs.modes || {}) };
    modes[id] = mode;
    await storeSecret(db, prefsRefKeyFor(organisationId), { ...prefs, modes } as unknown as Record<string, unknown>);
}

/**
 * Turn a SOCIAL destination's syndication on or off for this workspace.
 *
 * ⚠️ This is deliberately NOT the same question as "is LinkedIn connected?". That connection is a
 * shared org-wide pool ([[assistant-platform-selection]]) and most workspaces holding one connected
 * it for their Social Media Manager. Deriving the destination's state from liveness alone would
 * have every one of those workspaces start posting their blog articles to a personal LinkedIn feed
 * the moment this shipped — output nobody asked for, which is the same rule the YouTube producers
 * settled on: blank means false.
 */
export async function setSocialBlogDestinationEnabled(
    db: Db,
    organisationId: number,
    id: BlogDestinationId,
    enabled: boolean,
    accountLabel?: string | null,
): Promise<void> {
    const prefs = await getPrefs(db, organisationId);
    await storeSecret(db, prefsRefKeyFor(organisationId), {
        ...prefs,
        enabled: { ...(prefs.enabled || {}), [id]: enabled },
        labels: { ...(prefs.labels || {}), [id]: enabled ? (accountLabel ?? null) : null },
    } as unknown as Record<string, unknown>);
}

/** Store validated creds in the vault and upsert the (org, provider) row. */
export async function saveBlogDestination(
    db: Db,
    organisationId: number,
    userId: number,
    id: BlogDestinationId,
    creds: BlogDestinationCreds,
    accountLabel: string | null,
): Promise<void> {
    const refKey = refKeyFor(organisationId, id);
    await storeSecret(db, refKey, creds as unknown as Record<string, unknown>);
    await db
        .insert(workspaceIntegrations)
        .values({
            organisationId,
            provider: providerFor(id),
            vaultRefKey: refKey,
            externalAccountName: accountLabel,
            status: 'active',
            connectedBy: userId,
        })
        .onConflictDoUpdate({
            target: [workspaceIntegrations.organisationId, workspaceIntegrations.provider],
            set: {
                vaultRefKey: refKey,
                externalAccountName: accountLabel,
                status: 'active',
                connectedBy: userId,
                updatedAt: new Date(),
            },
        });
}

/** Decrypted creds for (org, id), or null if not connected. */
export async function getBlogDestinationCreds<C extends BlogDestinationCreds = BlogDestinationCreds>(
    db: Db,
    organisationId: number,
    id: BlogDestinationId,
): Promise<C | null> {
    const [row] = await db
        .select()
        .from(workspaceIntegrations)
        .where(and(eq(workspaceIntegrations.organisationId, organisationId), eq(workspaceIntegrations.provider, providerFor(id))))
        .limit(1);
    if (!row || row.status === 'revoked') return null;
    const secret = await getSecret(db, row.vaultRefKey).catch(() => null);
    return (secret as C) ?? null;
}

/**
 * Resolve ready-to-use creds for a destination, uniformly across auth kinds: paste-token creds come
 * from the vault; OAuth creds ({ accessToken, siteId }) come from the OAuth integration. Returns null
 * when not connected (the dispatcher records that as 'not_connected').
 */
export async function resolveDestinationCreds(
    db: Db,
    organisationId: number,
    id: BlogDestinationId,
): Promise<BlogDestinationCreds | null> {
    const adapter = getBlogAdapter(id);
    // First-party (The Swan Index): nothing to authenticate. The publication PROFILE is the
    // connection, so its presence and status are what "connected" means — returning null for a
    // suspended or withdrawn profile makes the dispatcher record 'not_connected', which is exactly
    // right: the workspace is not currently publishing there.
    if (adapter.authKind === 'firstparty') {
        const profile = await getProfileByOrg(db, organisationId);
        if (!profile || profile.status !== 'active') return null;
        return { organisationId } as BlogDestinationCreds;
    }
    if (adapter.authKind === 'oauth' && adapter.oauthProvider) {
        try {
            const fresh = await getFreshAccessToken(db, organisationId, adapter.oauthProvider as IntegrationProvider);
            if (!fresh.tenantId) return null; // no site id → connection is unusable
            return { accessToken: fresh.accessToken, siteId: fresh.tenantId } as BlogDestinationCreds;
        } catch {
            return null; // not_connected / expired → reconnect needed
        }
    }
    // Social (LinkedIn): the token is the workspace's social OAuth connection, resolved through the
    // SAME bridge the publish path uses so a rotated token is never read from a stale copy. The
    // opt-in is checked by listBlogDestinations (the dispatcher only asks about connected ones), so
    // reaching here means the workspace asked for this — all that is left is whether it still works.
    if (adapter.authKind === 'social' && adapter.socialPlatform) {
        try {
            const { resolveSocialCredentials } = await import('../social-publish');
            const creds = await resolveSocialCredentials(db, { organisationId, platform: adapter.socialPlatform });
            if (!creds.token) return null;
            return { accessToken: creds.token, authorUrn: creds.externalUserId || '' } as BlogDestinationCreds;
        } catch {
            return null; // no live connection / no token in the vault → not_connected
        }
    }
    return getBlogDestinationCreds(db, organisationId, id);
}

/** Remove the connection and its vault secret (or the OAuth integration for OAuth destinations). */
export async function deleteBlogDestination(db: Db, organisationId: number, id: BlogDestinationId): Promise<void> {
    const adapter = getBlogAdapter(id);
    // First-party: disconnecting must actually take the author's articles OFF the publication —
    // it is the one destination where we can honour that, and an author who disconnects and still
    // sees their byline on someone else's masthead has been ignored.
    //
    // Withdrawn, not deleted. A hard delete would cascade the swan_index_posts rows away and with
    // them the editorial record of what this publication ran and when, which is the one thing a
    // publication must be able to answer about itself. Reconnecting restores the profile.
    if (adapter.authKind === 'firstparty') {
        const profile = await getProfileByOrg(db, organisationId);
        if (!profile) return;
        await db.update(swanIndexPosts)
            .set({ status: 'withdrawn', featuredRank: null, updatedAt: new Date() })
            .where(and(
                eq(swanIndexPosts.profileId, profile.id),
                inArray(swanIndexPosts.status, ['pending', 'live', 'featured']),
            ));
        await db.update(swanIndexProfiles)
            .set({ status: 'withdrawn', updatedAt: new Date() })
            .where(eq(swanIndexProfiles.id, profile.id));
        return;
    }
    if (adapter.authKind === 'oauth' && adapter.oauthProvider) {
        await deleteIntegration(db, organisationId, adapter.oauthProvider as IntegrationProvider);
        return;
    }
    // Social: disconnecting the DESTINATION must never revoke the CONNECTION. The workspace's
    // LinkedIn is shared with its social assistants, and pulling the token here would silently stop
    // a Social Media Manager posting because someone turned blog syndication off.
    if (adapter.authKind === 'social') {
        await setSocialBlogDestinationEnabled(db, organisationId, id, false);
        return;
    }
    await deleteSecret(db, refKeyFor(organisationId, id)).catch(() => {});
    await db
        .delete(workspaceIntegrations)
        .where(and(eq(workspaceIntegrations.organisationId, organisationId), eq(workspaceIntegrations.provider, providerFor(id))));
}

export interface BlogDestinationStatus {
    id: BlogDestinationId;
    label: string;
    connected: boolean;
    accountLabel: string | null;
    credFields: { key: string; label: string; secret: boolean; help?: string }[];
    /** True when this destination connects via OAuth (redirect) rather than a paste form. */
    oauth: boolean;
    /** For OAuth and social destinations: where the "Connect" button should redirect. */
    connectUrl?: string;
    /**
     * True for a SOCIAL destination (LinkedIn) — one backed by the workspace's shared social OAuth
     * rather than a credential of its own. The card needs both this and `socialConnected` below to
     * tell the two "not connected" states apart: no LinkedIn at all (send them to OAuth), versus a
     * live LinkedIn this workspace has not opted in to syndicating blog posts through (one click).
     */
    social: boolean;
    /** Social only: the workspace holds a live connection for this platform, opted in or not. */
    socialConnected?: boolean;
    /** True when the destination can be pushed as an unpublished draft (false for Hashnode). */
    supportsDraft: boolean;
    /** How this destination receives an auto-syndicated post on publish (draft unless set to live). */
    publishMode: BlogPublishMode;
    /**
     * True for the FIRST-PARTY destination (The Swan Index) — same database, no credentials, and a
     * connect that provisions a public publication profile rather than storing a secret.
     *
     * Sent explicitly rather than left for the client to infer from `credFields.length === 0`: a
     * future paste destination that happens to need no fields would be misread as first-party and
     * offered a one-click connect that stores nothing. The UI needs to know WHICH it is, not how
     * many boxes to draw.
     */
    firstParty: boolean;
    /** First-party only: the profile handle, so the card can link to the author's public page. */
    handle?: string | null;
    /** First-party only: origin of the publication, for that link. */
    siteUrl?: string | null;
    /**
     * First-party only: the editable masthead identity, so the card can render its profile form
     * without a second round trip. Not `siteUrl` above — that one is the PUBLICATION's origin, and
     * this one is the author's own site.
     */
    profile?: SwanProfileFields | null;
}

/** The author-editable half of a Swan Index profile. */
export interface SwanProfileFields {
    handle: string;
    displayName: string;
    roleTitle: string | null;
    companyName: string | null;
    bio: string | null;
    siteUrl: string | null;
    socials: SocialsMap;
}

/** Connection state for every adapter, for the integrations/settings UI. */
export async function listBlogDestinations(db: Db, organisationId: number): Promise<BlogDestinationStatus[]> {
    const rows = await db
        .select({ provider: workspaceIntegrations.provider, name: workspaceIntegrations.externalAccountName, status: workspaceIntegrations.status })
        .from(workspaceIntegrations)
        .where(eq(workspaceIntegrations.organisationId, organisationId));
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    const prefs = await getPrefs(db, organisationId);
    const modes = await getBlogPublishModes(db, organisationId);
    // First-party connection state lives in the profile table, not workspace_integrations — there is
    // no vault secret to hang a row off. One extra read for the whole list.
    const swanProfile = AVAILABLE_BLOG_DESTINATION_IDS.some((id) => getBlogAdapter(id).authKind === 'firstparty')
        ? await getProfileByOrg(db, organisationId)
        : null;
    // Social connection state lives in system_connections, the pool the social assistants share.
    // Liveness mirrors resolveLiveSocialConnections: active + is_active, AND a vault_ref_key — a row
    // without one is a per-assistant toggle SHADOW row carrying no token, so it cannot publish.
    const socialPlatforms = AVAILABLE_BLOG_DESTINATION_IDS
        .map((id) => getBlogAdapter(id))
        .filter((a) => a.authKind === 'social' && a.socialPlatform)
        .map((a) => a.socialPlatform!);
    const liveSocial = new Set<string>();
    if (socialPlatforms.length) {
        const socialRows = await db
            .select({ serviceName: systemConnections.serviceName, vaultRefKey: systemConnections.vaultRefKey })
            .from(systemConnections)
            .where(and(
                eq(systemConnections.organisationId, organisationId),
                inArray(systemConnections.serviceName, socialPlatforms),
                eq(systemConnections.status, 'active'),
                eq(systemConnections.isActive, true),
            ));
        for (const row of socialRows) if (row.vaultRefKey) liveSocial.add(row.serviceName);
    }
    // ⚠️ AVAILABLE, not every registered adapter. This one list feeds all three surfaces — the
    // Connections grid, Blog Studio's per-post picker and the Overview's "Publishing to" block — and
    // it is also what syndicatePublishedPost iterates, so a withheld destination is neither offered
    // nor published to. See WITHHELD_BLOG_DESTINATIONS for why that is the intended reading.
    return AVAILABLE_BLOG_DESTINATION_IDS.map((id) => {
        const adapter = getBlogAdapter(id);
        if (adapter.authKind === 'firstparty') {
            const connected = !!swanProfile && swanProfile.status === 'active';
            return {
                id,
                label: adapter.label,
                connected,
                accountLabel: connected ? `@${swanProfile!.handle}` : null,
                credFields: [],
                oauth: false,
                social: false,
                supportsDraft: adapter.supportsDraft,
                publishMode: modes[id],
                firstParty: true,
                handle: connected ? swanProfile!.handle : null,
                siteUrl: swanIndexBaseUrl(),
                profile: connected ? {
                    handle: swanProfile!.handle,
                    displayName: swanProfile!.displayName,
                    roleTitle: swanProfile!.roleTitle,
                    companyName: swanProfile!.companyName,
                    bio: swanProfile!.bio,
                    siteUrl: swanProfile!.siteUrl,
                    socials: swanProfile!.socials,
                } : null,
            };
        }
        if (adapter.authKind === 'social' && adapter.socialPlatform) {
            const socialConnected = liveSocial.has(adapter.socialPlatform);
            // Connected AND opted in — see setSocialBlogDestinationEnabled for why both are needed.
            const connected = socialConnected && prefs.enabled?.[id] === true;
            return {
                id,
                label: adapter.label,
                connected,
                accountLabel: connected ? (prefs.labels?.[id] ?? null) : null,
                credFields: [],
                oauth: false,
                social: true,
                socialConnected,
                // The social platforms authenticate through social-oauth-init, NOT the /api/oauth
                // flow the `oauth` destinations use — different store, different callback.
                connectUrl: `/.netlify/functions/social-oauth-init?platform=${encodeURIComponent(adapter.socialPlatform)}`,
                supportsDraft: adapter.supportsDraft,
                publishMode: 'live' as BlogPublishMode,
                firstParty: false,
            };
        }
        const isOAuth = adapter.authKind === 'oauth' && !!adapter.oauthProvider;
        // OAuth destinations live under their oauthProvider row; paste ones under `blog_<id>`.
        const row = byProvider.get(isOAuth ? adapter.oauthProvider! : providerFor(id));
        const connected = !!row && (isOAuth ? row.status === 'active' : row.status !== 'revoked');
        return {
            id,
            label: adapter.label,
            connected,
            accountLabel: row?.name ?? null,
            credFields: adapter.credFields,
            oauth: isOAuth,
            social: false,
            connectUrl: isOAuth ? `/api/oauth/${adapter.oauthProvider}/connect` : undefined,
            supportsDraft: adapter.supportsDraft,
            // Hashnode can't draft, so it always reports live regardless of the stored preference.
            publishMode: adapter.supportsDraft ? modes[id] : 'live',
            firstParty: false,
        };
    });
}


/**
 * Connect the first-party destination: create (or reinstate) the workspace's publication profile.
 *
 * Separate from saveBlogDestination because there is nothing to validate and nothing to encrypt —
 * routing it through the vault path would store an empty secret and an integration row that no
 * code reads, purely to make one function signature cover two unlike things.
 */
export async function connectSwanIndex(
    db: Db,
    organisationId: number,
    userId: number,
): Promise<{ handle: string; displayName: string }> {
    const profile = await ensureProfile(db, organisationId, { userId });
    if (profile.status !== 'active') {
        await db.update(swanIndexProfiles)
            .set({ status: 'active', updatedAt: new Date() })
            .where(eq(swanIndexProfiles.id, profile.id));
    }
    return { handle: profile.handle, displayName: profile.displayName };
}

/**
 * Opt this workspace in to syndicating published blog posts to a SOCIAL destination.
 *
 * Validates against the live connection first, for the same reason every paste destination
 * validates before it is stored: an opt-in that cannot post is a destination that reports itself
 * connected and then fails once per publish, on the publish path, where nobody is watching.
 *
 * Returns `{ ok: false, needsConnection: true }` when the workspace has no live LinkedIn at all —
 * the caller turns that into the OAuth redirect rather than an error, because it is not one.
 */
export async function connectSocialBlogDestination(
    db: Db,
    organisationId: number,
    id: BlogDestinationId,
): Promise<{ ok: true; accountLabel: string | null } | { ok: false; error: string; needsConnection?: boolean }> {
    const adapter = getBlogAdapter(id);
    if (adapter.authKind !== 'social') return { ok: false, error: `${adapter.label} is not a social destination.` };

    const creds = await resolveDestinationCreds(db, organisationId, id);
    if (!creds) {
        return {
            ok: false,
            needsConnection: true,
            error: `Connect ${adapter.label} first — this destination posts through your existing ${adapter.label} connection.`,
        };
    }
    const check = await adapter.validate(creds as never);
    if (!check.ok) return { ok: false, error: check.error || `${adapter.label} rejected the connection.` };

    await setSocialBlogDestinationEnabled(db, organisationId, id, true, check.accountLabel ?? null);
    return { ok: true, accountLabel: check.accountLabel ?? null };
}
