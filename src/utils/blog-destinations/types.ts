// src/utils/blog-destinations/types.ts
// Content Engine — blog connector layer (US 3.2). One adapter interface, one adapter per external
// blog platform. Dispatched off blog_posts.destinations jsonb; see docs/content-engine-remaining-build.md §A.
//
// Both content representations already exist on a blog_posts row: Markdown-native platforms
// (Dev.to, Hashnode) take body_markdown directly; HTML platforms (WordPress, Ghost — later) take the
// sanitised published_payload HTML. No new rendering.

export type BlogDestinationId = 'devto' | 'hashnode' | 'wordpress' | 'ghost' | 'wordpresscom' | 'swanindex' | 'linkedin';

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

export interface BlogPublishOptions {
    /** A prior push's platform-native id. Present = update in place; absent = create. */
    externalId?: string;
    /**
     * Push as an unpublished draft, leaving the author to publish from the CMS itself (US 3.2 AC4).
     * Only honoured by adapters declaring `supportsDraft`; the dispatcher refuses the combination
     * otherwise rather than quietly publishing live to someone's blog.
     */
    asDraft?: boolean;
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

/** WordPress.com is OAuth-backed: creds come from the OAuth integration, not a paste form. */
export interface WordpresscomCreds {
    accessToken: string;
    /** The authorised blog id — roots every /sites/{siteId}/... REST call. */
    siteId: string;
}

/**
 * The Swan Index is FIRST-PARTY: same database, same deployment, so there is nothing to
 * authenticate against. The "creds" are only the tenant the dispatcher is already acting for, which
 * store.ts synthesises from the profile row. Modelled as creds anyway so the adapter interface
 * stays uniform and the dispatcher needs no special case.
 */
export interface SwanIndexCreds {
    organisationId: number;
}

/**
 * LinkedIn is SOCIAL-backed: the token is the workspace's existing LinkedIn OAuth connection in
 * system_connections (the same one the Social Media Manager posts through), resolved by store.ts.
 * `authorUrn` is that connection's externalUserId — the member the share is posted as.
 */
export interface LinkedinCreds {
    accessToken: string;
    /** `urn:li:person:<sub>`, or the bare sub; empty when the connection row never stored one. */
    authorUrn: string;
}

export type BlogDestinationCreds = DevtoCreds | HashnodeCreds | WordpressCreds | GhostCreds | WordpresscomCreds | SwanIndexCreds | LinkedinCreds;

export interface BlogDestinationAdapter<C extends BlogDestinationCreds = BlogDestinationCreds> {
    id: BlogDestinationId;
    label: string;
    /**
     * How the workspace connects this destination. 'paste' (default) collects `credFields` and
     * stores them in the vault; 'oauth' connects via the shared /api/oauth flow, and creds are
     * resolved from the OAuth integration instead; 'firstparty' has nothing to authenticate — the
     * destination is this same deployment, and connecting means creating a publication profile;
     * 'social' reuses the workspace's existing social OAuth connection in system_connections, which
     * is SHARED with the social assistants — so it carries a separate per-workspace opt-in, and
     * disconnecting it here never revokes that connection. See store.ts.
     */
    authKind?: 'paste' | 'oauth' | 'firstparty' | 'social';
    /** For authKind 'oauth': the IntegrationProvider the creds live under. */
    oauthProvider?: string;
    /** For authKind 'social': the system_connections serviceName holding the token. */
    socialPlatform?: string;
    /** Fields the connect form collects (paste only); the secret ones are encrypted into the vault. */
    credFields: CredField[];
    /**
     * Whether this platform's publish call can create an unpublished draft. False for Hashnode, whose
     * `publishPost` mutation has no draft path at all (drafts are a separate `createDraft` mutation).
     */
    supportsDraft: boolean;
    /** Narrow an untyped `{ [k]: string }` form body into this adapter's cred shape, or return an error. */
    parseCreds(input: Record<string, unknown>): { ok: true; creds: C } | { ok: false; error: string };
    /** Validate creds with a live call; returns an account label to display/store on success. */
    validate(creds: C): Promise<ValidationResult>;
    /** Publish, or update in place when `opts.externalId` is supplied (idempotent re-publish). */
    publish(post: BlogDestinationPost, creds: C, opts?: BlogPublishOptions): Promise<BlogPublishResult>;
}

/** Shared tag slugifier — lowercased, alphanumeric, hyphen-collapsed. */
export function slugifyTag(tag: string): string {
    return String(tag || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
