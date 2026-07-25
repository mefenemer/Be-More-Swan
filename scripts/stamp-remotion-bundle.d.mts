// Types for stamp-remotion-bundle.mjs, which stays plain ESM because the deploy scripts invoke it
// directly (`npm run remotion:deploy-site-*`), where a compile step would be in the way.
export declare const STAMP_PATH: string;
/** sha256 (truncated) of every source that ends up in the Remotion bundle. */
export declare function bundleHash(): string;
/** The hash recorded by the last site deploy, or null if none has been recorded. */
export declare function readStamp(): string | null;
