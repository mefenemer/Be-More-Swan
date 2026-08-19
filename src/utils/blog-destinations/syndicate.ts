// src/utils/blog-destinations/syndicate.ts
// Shared syndication dispatch (US 3.2). Pushes an already-published blog post out to EVERY connected
// external blog destination, honouring each one's stored publish mode (draft vs live). Idempotent —
// re-running updates the existing external post via the stored externalId rather than duplicating.
//
// This is the single dispatch path: it runs automatically from publishBlogPost() the moment a post
// goes live (src/utils/blog-publish.ts), and backs the manual re-push endpoint. Connecting a
// destination (in the assistant Connections tab) opts it in and its publish mode decides draft vs
// live — but the author can narrow that per post in Blog Studio, which is stored as the reserved
// `selected` key inside destinations jsonb. Absent (every post written before the picker existed)
// means "every connected destination", so nothing that already worked changes behaviour.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../../db/client';
import { blogPosts, widgetConfigs } from '../../../db/schema';
import { getBlogAdapter } from './index';
import { resolveDestinationCreds, listBlogDestinations } from './store';
import { stripMediaForSyndication } from '../blog-publish';
import { renderMarkdown } from '../markdown-render';
import { isAiAssisted, BLOG_AI_NOTICE } from '../blog-ai-assisted';
import type { BlogDestinationId, BlogDestinationPost } from './types';

type Db = ReturnType<typeof getDb>;

export interface SyndicationTargetResult {
    status: 'published' | 'draft' | 'not_connected' | 'error';
    externalId?: string;
    url?: string;
    error?: string;
    at?: string;
}

/** A blog_posts row (the shape syndication reads), kept loose to avoid a schema-type import cycle. */
export interface SyndicatablePost {
    id: number;
    title: string;
    bodyMarkdown: string | null;
    canonicalUrl?: string | null;
    tags?: unknown;
    metaDescription?: string | null;
    destinations?: unknown;
    // Provenance — drives the AI transparency notice on the syndicated copy (see isAiAssisted).
    jobId?: string | null;
    blueprintId?: number | null;
    isAutonomous?: boolean | null;
    generationReason?: string | null;
}

/** Project a published blog_posts row into the text-only payload adapters consume, or null if empty. */
// Async only because rendering reaches `marked` through a dynamic import — see markdown-render.ts.
export async function projectPost(
    post: SyndicatablePost,
    opts: { badgeEnabled?: boolean } = {},
): Promise<BlogDestinationPost | null> {
    // Syndicated copies are TEXT ONLY (docs/blog-media-composition-plan.md §3.5): our media URLs are
    // presigned/expiring and Pexels is hotlink-only, so external platforms receive no media rather
    // than links that 404 or breach a licence. bodyHtml is derived from the SAME stripped source
    // because the HTML adapters (WordPress/Ghost/WordPress.com) send `bodyHtml || bodyMarkdown`.
    const stripped = await stripMediaForSyndication(post.bodyMarkdown || '');
    if (!stripped.trim()) return null;

    // AI transparency (EU AI Act Art. 50). The widget and the /b/:key/:slug permalink both badge a
    // machine-drafted post; a syndicated copy carried NO disclosure at all, so the same article was
    // labelled on our surfaces and unlabelled on the customer's Dev.to or Ghost. The notice is
    // appended to the MARKDOWN, before bodyHtml is derived from it, so the markdown adapters
    // (Dev.to, Hashnode) and the HTML adapters (WordPress, Ghost, WordPress.com) all carry it.
    //
    // `badgeEnabled` defaults to true when the caller supplies nothing: an unknown workspace
    // preference must fail towards disclosing, never away from it.
    const disclose = isAiAssisted(post) && (opts.badgeEnabled ?? true);
    const syndicatedMarkdown = disclose ? `${stripped}\n\n*${BLOG_AI_NOTICE}*` : stripped;

    return {
        title: post.title,
        bodyMarkdown: syndicatedMarkdown,
        bodyHtml: await renderMarkdown(syndicatedMarkdown) || null,
        canonicalUrl: post.canonicalUrl ?? null,
        tags: Array.isArray(post.tags) ? (post.tags as unknown[]).map(String) : [],
        coverImageUrl: null,
        metaDescription: post.metaDescription ?? null,
    };
}

/**
 * Push a published post to every connected destination, each at its stored publish mode, and merge
 * the per-target outcomes back into blog_posts.destinations. Best-effort: one destination failing
 * never blocks the others or the publish itself. Returns the per-target results (empty when there is
 * nothing connected or no text to send).
 */
export async function syndicatePublishedPost(
    db: Db,
    organisationId: number,
    post: SyndicatablePost,
): Promise<Record<string, SyndicationTargetResult>> {
    const stored = (post.destinations as Record<string, unknown>) || {};
    // null (not []) when the author never made a choice — an empty array is a real answer meaning
    // "my site only", and collapsing the two would silently push a post the author excluded.
    const selected = Array.isArray(stored.selected) ? stored.selected.map(String) : null;

    const connected = (await listBlogDestinations(db, organisationId))
        .filter((d) => d.connected)
        .filter((d) => selected === null || selected.includes(d.id));
    if (!connected.length) return {};

    // The workspace's AI-badge preference governs the syndicated notice too, so a customer who turns
    // the badge off on their widget is not still labelled on Dev.to. No widget config row (a
    // syndicate-only workspace never provisions one) means no stated preference — disclose.
    const [wcfg] = await db
        .select({ badgeEnabled: widgetConfigs.badgeEnabled })
        .from(widgetConfigs)
        .where(eq(widgetConfigs.organisationId, organisationId))
        .limit(1);

    const projected = await projectPost(post, { badgeEnabled: wcfg?.badgeEnabled ?? true });
    if (!projected) return {}; // media-only post: nothing to syndicate as text

    const existing = stored;
    const results: Record<string, SyndicationTargetResult> = {};

    for (const dest of connected) {
        const target = dest.id as BlogDestinationId;
        const adapter = getBlogAdapter(target);
        try {
            const creds = await resolveDestinationCreds(db, organisationId, target);
            if (!creds) {
                results[target] = { status: 'not_connected' };
                continue;
            }
            const prior = existing[target];
            const priorExternalId =
                prior && typeof prior === 'object' && 'externalId' in prior
                    ? String((prior as { externalId?: unknown }).externalId ?? '') || undefined
                    : undefined;

            const out = await adapter.publish(projected, creds as never, {
                externalId: priorExternalId,
                // supportsDraft:false destinations (Hashnode) already report publishMode 'live'.
                asDraft: dest.publishMode === 'draft',
            });
            results[target] = { status: out.status, externalId: out.externalId, url: out.url, at: new Date().toISOString() };
        } catch (err) {
            results[target] = { status: 'error', error: err instanceof Error ? err.message : 'Publish failed.' };
        }
    }

    // Merge outcomes back into destinations jsonb (preserves the widget status + untouched targets).
    const destinations = { ...existing, ...results };
    await db
        .update(blogPosts)
        .set({ destinations, updatedAt: new Date() })
        .where(and(eq(blogPosts.id, post.id), eq(blogPosts.organisationId, organisationId)));

    return results;
}
