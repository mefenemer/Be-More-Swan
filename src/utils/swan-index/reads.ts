// src/utils/swan-index/reads.ts
// The Swan Index — counting readers of an article.
//
// swan_index_posts has carried view_count and read_count since the publication launched, and
// NOTHING ever incremented them: the article page sent no beacon, so every Swan Index read was
// invisible to the author whose post it was. The Blog Writer's Readers panel
// (get-blog-performance.ts) reports these, so they have to be real.
//
// Received as POST <base>/_read by swan-index-page.ts rather than by a function of its own: on
// theswanindex.com a forced rewrite hands EVERY path to that function, so a separate function URL
// is not reliably reachable from the magazine's own pages.
//
// Same posture as widget-ab-beacon.ts: no auth, no cookies, no identifiers, no raw rows — two
// counters on the piece itself. The page is CDN-cached, so counting happens in the reader's
// browser; a crawler that runs no JavaScript is never counted, which is the point.
//
// ⚠️ Deliberately NOT written into blog_engagement_stats. That table is "reads on the author's own
// blog", and Average Read Time divides by it. Folding the magazine's readers in would blend two
// audiences into one average. Two places, two numbers, both shown.
//
// ⚠️ updated_at is NOT touched: it is emitted as the article's dateModified, and a read is not an
// edit.

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { getDb } from '../../../db/client';
import { swanIndexPosts, swanIndexProfiles } from '../../../db/schema';
import { PUBLIC_STATUSES } from './queries';

type Db = ReturnType<typeof getDb>;

/** The path segment the article beacon posts to, under the publication's base. */
export const READ_PATH = '/_read';

export interface SwanRead { handle: string; slug: string; engaged: boolean }

/** Parse a beacon body. null for anything malformed — beacons are fire-and-forget, never errors. */
export function parseSwanRead(raw: string | null | undefined): SwanRead | null {
    let body: any;
    try { body = JSON.parse(raw || '{}'); } catch { return null; }
    const handle = typeof body.handle === 'string' ? body.handle.trim().toLowerCase().slice(0, 80) : '';
    const slug = typeof body.slug === 'string' ? body.slug.trim().slice(0, 200) : '';
    if (!handle || !slug) return null;
    return { handle, slug, engaged: body.engaged === true };
}

/**
 * Count one read. Only a piece a reader could actually be looking at — public, sectioned, active
 * author — is counted; anything else is a replayed or forged beacon and is dropped silently.
 */
export async function recordSwanRead(db: Db, read: SwanRead): Promise<void> {
    const [row] = await db
        .select({ id: swanIndexPosts.id })
        .from(swanIndexPosts)
        .innerJoin(swanIndexProfiles, eq(swanIndexProfiles.id, swanIndexPosts.profileId))
        .where(and(
            sql`lower(${swanIndexProfiles.handle}) = ${read.handle}`,
            eq(swanIndexPosts.slug, read.slug),
            inArray(swanIndexPosts.status, [...PUBLIC_STATUSES]),
            eq(swanIndexProfiles.status, 'active'),
            isNotNull(swanIndexPosts.section),
        ))
        .limit(1);
    if (!row) return;
    await db.update(swanIndexPosts)
        .set({
            viewCount: sql`${swanIndexPosts.viewCount} + 1`,
            ...(read.engaged ? { readCount: sql`${swanIndexPosts.readCount} + 1` } : {}),
        })
        .where(eq(swanIndexPosts.id, row.id));
}

/**
 * The inline script on an article page: one beacon per page view, sent when the reader leaves.
 * "Engaged" uses the blog beacon's rule — 15 seconds, or past halfway down.
 */
export function readBeaconScript(endpoint: string, handle: string, slug: string): string {
    const cfg = JSON.stringify({ endpoint, handle, slug }).replace(/</g, '\\u003c');
    return `<script>(function(c){
  var start=Date.now(),max=0,sent=false;
  function onScroll(){var h=document.documentElement;max=Math.max(max,Math.min(1,h.scrollTop/Math.max(1,h.scrollHeight-h.clientHeight)));}
  window.addEventListener('scroll',onScroll,{passive:true});
  function flush(){if(sent)return;sent=true;var d=Date.now()-start;
    try{navigator.sendBeacon&&navigator.sendBeacon(c.endpoint,JSON.stringify({handle:c.handle,slug:c.slug,engaged:d>15000||max>0.5}));}catch(e){}}
  window.addEventListener('pagehide',flush,{once:true});
  document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')flush();});
})(${cfg});</script>`;
}
