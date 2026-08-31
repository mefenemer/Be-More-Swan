// src/utils/blog-destinations/index.ts
// Registry of blog connector adapters. Add WordPress/Ghost adapters here (Tier 1) and
// WordPress.com (Tier 2, OAuth) later — the dispatch + store layers are platform-agnostic.

import type { BlogDestinationAdapter, BlogDestinationId } from './types';
import { devtoAdapter } from './devto';
import { hashnodeAdapter } from './hashnode';
import { wordpressAdapter } from './wordpress';
import { ghostAdapter } from './ghost';
import { wordpresscomAdapter } from './wordpresscom';
import { swanindexAdapter } from './swanindex';
import { linkedinAdapter } from './linkedin';

const ADAPTERS: Record<BlogDestinationId, BlogDestinationAdapter> = {
    devto: devtoAdapter as BlogDestinationAdapter,
    hashnode: hashnodeAdapter as BlogDestinationAdapter,
    wordpress: wordpressAdapter as BlogDestinationAdapter,
    ghost: ghostAdapter as BlogDestinationAdapter,
    wordpresscom: wordpresscomAdapter as BlogDestinationAdapter,
    // First-party: same database, no credentials. See swanindex.ts for why it is an adapter.
    swanindex: swanindexAdapter as BlogDestinationAdapter,
    // Social-backed: the workspace's existing LinkedIn OAuth, opted in separately. See linkedin.ts.
    linkedin: linkedinAdapter as BlogDestinationAdapter,
};

/**
 * EVERY registered adapter, released or not.
 *
 * ⚠️ This is the list for READING BACK what already happened — `summariseSyndication` names the
 * destinations a published post recorded, and `getBlogPublishModes` keeps their stored preferences.
 * Filtering it would erase a post's own history the moment a destination was withheld. To decide
 * what a workspace may CONNECT, use AVAILABLE_BLOG_DESTINATION_IDS below.
 */
export const BLOG_DESTINATION_IDS = Object.keys(ADAPTERS) as BlogDestinationId[];

/**
 * Destinations withheld from the product, 2026-08-31, by the owner's decision.
 *
 * These five are fully implemented and unit-tested, but NO live connection has ever been made
 * through any of them — the 2026-08-18 end-to-end staging run recorded syndication dispatch as
 * unproven, with nothing connected. Publishing through unexercised code onto a customer's own blog
 * is the one failure here that lands in public, under their name, so they are withheld until each
 * has been proved against a real account.
 *
 * This is a VISIBILITY gate, not a teardown: adapters stay registered, credentials already in the
 * vault stay there, tests keep running, and deleting an id from this set restores the destination
 * exactly as it was. Search Console is deliberately NOT here — it is read-only, cannot post
 * anywhere, and backs live KPI cards, the content-decay notifications and a goal metric.
 *
 * ⚠️ Withheld also means NOT SYNDICATED: listBlogDestinations stops reporting them, and
 * syndicatePublishedPost only pushes to what that returns. If any workspace turns out to have one
 * connected, flipping this on stops their syndication silently — check before releasing to prod.
 */
export const WITHHELD_BLOG_DESTINATIONS = new Set<BlogDestinationId>([
    'wordpress', 'wordpresscom', 'ghost', 'devto', 'hashnode',
]);

/** The destinations a workspace may see and connect today. */
export const AVAILABLE_BLOG_DESTINATION_IDS = BLOG_DESTINATION_IDS
    .filter((id) => !WITHHELD_BLOG_DESTINATIONS.has(id));

/** Is this destination offered today? False for a withheld one. */
export function isBlogDestinationAvailable(id: BlogDestinationId): boolean {
    return !WITHHELD_BLOG_DESTINATIONS.has(id);
}

/**
 * ⚠️ Deliberately answers for WITHHELD ids too. It validates ids coming back off stored data — the
 * `destinations.selected` array in save-blog-draft, chiefly — and rejecting a withheld id there
 * would quietly rewrite an author's saved distribution choice on the next autosave.
 */
export function isBlogDestinationId(value: unknown): value is BlogDestinationId {
    return typeof value === 'string' && value in ADAPTERS;
}

export function getBlogAdapter(id: BlogDestinationId): BlogDestinationAdapter {
    return ADAPTERS[id];
}

export * from './types';
