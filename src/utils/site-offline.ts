// src/utils/site-offline.ts
// An archived Website Assistant's site goes offline with it (owner, 2026-11-03).
//
// ── The failure ──────────────────────────────────────────────────────────────
// Archiving stopped the assistant but left its site published. Be More Swan's own test site
// (wordsworth-sitecheck, a café template) stayed live to the public for a week after its assistant
// was archived, and because a published hosted site wins the site directory, every assistant read
// Menu / Classes / Shop as Be More Swan's website. The owner could not take it down either: the
// Publish card lives on the assistant's page, and archived assistants are hidden.
//
// ── The rule ─────────────────────────────────────────────────────────────────
// Archiving takes the assistant's site offline exactly as the owner's own "Take offline" does
// (unpublishSite: back to draft, versions kept), purges its cached pages, and re-reads the site
// directory so every assistant falls back to the website address in Business Information.
// Reinstating does NOT republish — going live is always the owner's click on the Publish card.
// purge-archived-assistants.ts runs the same sweep daily for any archived assistant whose site is
// still published (sites archived before this rule).

import { and, eq, inArray } from 'drizzle-orm';
import { purgeCache } from '@netlify/functions';
import type { getDb } from '../../db/client';
import { aiAssistants, sites } from '../../db/schema';
import { siteCacheTag } from './site-hosting';
import { unpublishSite } from './site-store';
import { refreshDirectoryAfterAddressChange } from './site-directory-store';

type Db = ReturnType<typeof getDb>;

/**
 * Take every published site of these assistants offline. Never throws — an archive must not fail
 * because a site could not be reached. Returns the slugs it took down.
 */
export async function takeAssistantSitesOffline(db: Db, assistantIds: number[]): Promise<string[]> {
    if (!assistantIds.length) return [];
    try {
        const live = await db.select().from(sites)
            .where(and(inArray(sites.aiAssistantId, assistantIds), eq(sites.status, 'published')));
        const orgs = new Set<number>();
        const down: string[] = [];
        for (const site of live) {
            await unpublishSite(db, site);
            orgs.add(site.organisationId);
            if (site.slug) {
                down.push(site.slug);
                try { await purgeCache({ tags: [siteCacheTag(site.slug)] }); }
                catch (err) { console.error('[site-offline] cache purge failed (the change shows within a minute)', err instanceof Error ? err.message : err); }
            }
        }
        // Never throws: the directory now reads the Business Information address (or none).
        for (const orgId of orgs) await refreshDirectoryAfterAddressChange(db, orgId);
        return down;
    } catch (err) {
        console.error('[site-offline] could not take sites offline (non-fatal)', err instanceof Error ? err.message : err);
        return [];
    }
}

/** Sites still published by an ARCHIVED assistant — the daily sweep's input. [] on failure. */
export async function archivedAssistantsWithLiveSites(db: Db): Promise<number[]> {
    try {
        const rows = await db.select({ id: sites.aiAssistantId }).from(sites)
            .innerJoin(aiAssistants, eq(aiAssistants.id, sites.aiAssistantId))
            .where(and(eq(sites.status, 'published'), eq(aiAssistants.lifecycleStatus, 'archived')))
            .limit(500);
        return [...new Set(rows.map((r) => r.id))];
    } catch (err) {
        console.error('[site-offline] could not list archived assistants with live sites', err instanceof Error ? err.message : err);
        return [];
    }
}
