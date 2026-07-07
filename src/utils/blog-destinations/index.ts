// src/utils/blog-destinations/index.ts
// Registry of blog connector adapters. Add WordPress/Ghost adapters here (Tier 1) and
// WordPress.com (Tier 2, OAuth) later — the dispatch + store layers are platform-agnostic.

import type { BlogDestinationAdapter, BlogDestinationId } from './types';
import { devtoAdapter } from './devto';
import { hashnodeAdapter } from './hashnode';
import { wordpressAdapter } from './wordpress';
import { ghostAdapter } from './ghost';

const ADAPTERS: Record<BlogDestinationId, BlogDestinationAdapter> = {
    devto: devtoAdapter as BlogDestinationAdapter,
    hashnode: hashnodeAdapter as BlogDestinationAdapter,
    wordpress: wordpressAdapter as BlogDestinationAdapter,
    ghost: ghostAdapter as BlogDestinationAdapter,
};

export const BLOG_DESTINATION_IDS = Object.keys(ADAPTERS) as BlogDestinationId[];

export function isBlogDestinationId(value: unknown): value is BlogDestinationId {
    return typeof value === 'string' && value in ADAPTERS;
}

export function getBlogAdapter(id: BlogDestinationId): BlogDestinationAdapter {
    return ADAPTERS[id];
}

export * from './types';
