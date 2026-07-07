// src/utils/blog-destinations/types.ts
// Content Engine — blog connector layer (US 3.2). One adapter interface, one adapter per external
// blog platform. Dispatched off blog_posts.destinations jsonb; see docs/content-engine-remaining-build.md §A.
//
// Both content representations already exist on a blog_posts row: Markdown-native platforms
// (Dev.to, Hashnode) take body_markdown directly; HTML platforms (WordPress, Ghost — later) take the
// sanitised published_payload HTML. No new rendering.

export type BlogDestinationId = 'devto' | 'hashnode' | 'wordpress' | 'ghost';

/** The published blog data an adapter needs, projected from a blog_posts row + its snapshot. */
export interface BlogDestinationPost {
    title: string;
    /** Source of truth. Markdown-native platforms (Dev.to, Hashnode) publish this verbatim. */
    bodyMarkdown: string;
    /** Sanitised HTML snapshot (published_payload.html). HTML platforms (WordPress, Ghost) use this. */
    bodyHtml: string | null;
    /** Canonical URL of the native/widget copy, so cross-posts don't compete in search. Null = none. */
    canonicalUrl: string | null;
    tags: string[];
    /** Public, non-expiring cover image URL, or null. Private-R2 heroes are deferred (they expire). */
    coverImageUrl: string | null;
    metaDescription: string | null;
}

export interface BlogPublishResult {
    /** Platform-native id, persisted for idempotent re-publish (update, not duplicate). */
    externalId: string;
    url: string;
    status: 'published' | 'draft';
}

export interface ValidationResult {
    ok: boolean;
    /** Human label to show in the UI + store as workspace_integrations.externalAccountName. */
    accountLabel?: string;
    error?: string;
}

/** One credential field the connect UI collects. `secret` fields are stored in the vault. */
export interface CredField {
    key: string;
    label: string;
    secret: boolean;
    help?: string;
}

export interface DevtoCreds {
    apiKey: string;
}

export interface HashnodeCreds {
    token: string;
    publicationId: string;
}

export interface WordpressCreds {
    siteUrl: string;
    username: string;
    appPassword: string;
}

export interface GhostCreds {
    apiUrl: string;
    adminApiKey: string;
}

export type BlogDestinationCreds = DevtoCreds | HashnodeCreds | WordpressCreds | GhostCreds;

export interface BlogDestinationAdapter<C extends BlogDestinationCreds = BlogDestinationCreds> {
    id: BlogDestinationId;
    label: string;
    /** Fields the connect form collects; the secret ones are encrypted into the vault. */
    credFields: CredField[];
    /** Narrow an untyped `{ [k]: string }` form body into this adapter's cred shape, or return an error. */
    parseCreds(input: Record<string, unknown>): { ok: true; creds: C } | { ok: false; error: string };
    /** Validate creds with a live call; returns an account label to display/store on success. */
    validate(creds: C): Promise<ValidationResult>;
    /** Publish, or update in place when `externalId` is supplied (idempotent re-publish). */
    publish(post: BlogDestinationPost, creds: C, externalId?: string): Promise<BlogPublishResult>;
}

/** Shared tag slugifier — lowercased, alphanumeric, hyphen-collapsed. */
export function slugifyTag(tag: string): string {
    return String(tag || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
