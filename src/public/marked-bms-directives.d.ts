// src/lib/marked-bms-directives.d.ts
// Types for the shared directive tokenizer. The implementation is deliberately plain .js so the
// SAME artifact can be <script>-loaded by the browser editor and imported by the bundled functions
// — see marked-bms-directives.js's header and docs/blog-media-composition-plan.md §3.2.

/** A marked instance/module exposing the bits we need. Kept structural so both the browser's
 *  marked@12 global and the server's marked@18 import satisfy it. */
interface MarkedLike {
    use(...args: unknown[]): unknown;
    lexer(src: string, opts?: unknown): unknown[];
    Marked?: new (...args: unknown[]) => MarkedLike;
}

export interface InstallOptions {
    /**
     * Preview-only src resolver. Return a display URL for an assetId, or null/undefined for none.
     *
     * The SERVER MUST NOT pass this: the published snapshot has to stay src-less so widget-api can
     * resolve a fresh presigned URL at read time. Baking a src into the immutable, CDN-cached
     * payload produces posts whose media 404s once the presign expires.
     */
    resolveUrl?: (assetId: string, mediaType: 'image' | 'video' | 'audio') => string | null | undefined;
}

/** Register the `:::media` / `::::columns` extensions on an ISOLATED marked instance. */
export function install<T extends MarkedLike>(inst: T, opts?: InstallOptions): T;

/** Project a blog body for external destinations: media removed, columns unwrapped (plan §3.5). */
export function stripMediaForSyndication(markedMod: MarkedLike, md: string): string;
