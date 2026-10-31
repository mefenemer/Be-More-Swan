// src/utils/site-published.ts — read a site's PUBLISHED definition, and the page ceiling every
// workspace gets. Split out of site-store.ts (which re-exports both) so a reader that only needs the
// live site — the site page directory, which every drafting assistant loads — does not import the
// whole Website Assistant: site-store pulls in drafting, shop, bookings and, through them, satori,
// whose WebAssembly load broke tests/campaign-tickets.test.ts (its stubbed fetch answered the wasm
// request) on 2026-10-31. Keep this module's imports light.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { sites, siteVersions } from '../../db/schema';
import { DEFAULT_MAX_PAGES, normaliseSiteDefinition, type SiteDefinition } from './site-definition';

type Db = ReturnType<typeof getDb>;
type SiteRow = typeof sites.$inferSelect;

/**
 * Pages this workspace's site may have. No plan limits pages (owner, 2026-10-31: the `website_pages`
 * plan feature — 5 on £29, 15 on the Busywork Buster — was removed), so every workspace gets the
 * same safety ceiling. Kept as a per-workspace call so every caller already passes it through.
 */
export async function maxPagesFor(_db: Db, _orgId: number): Promise<number> {
    return DEFAULT_MAX_PAGES;
}

/** The published definition, through the gate. */
export async function publishedDefinition(db: Db, site: SiteRow, maxPages: number): Promise<SiteDefinition | null> {
    if (site.publishedVersion == null) return null;
    const [row] = await db.select({ definition: siteVersions.definition }).from(siteVersions)
        .where(and(eq(siteVersions.siteId, site.id), eq(siteVersions.version, site.publishedVersion))).limit(1);
    return row ? normaliseSiteDefinition(row.definition, { maxPages }).definition : null;
}
