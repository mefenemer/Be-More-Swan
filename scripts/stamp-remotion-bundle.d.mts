// Types for stamp-remotion-bundle.mjs, which stays plain ESM because the deploy scripts invoke it
// directly (`npm run remotion:deploy-site-*`), where a compile step would be in the way.
export declare const STAMP_PATH: string;
/** The sites `npm run remotion:deploy-site-*` can deploy to. */
export declare const SITES: string[];
/** sha256 (truncated) of every source that ends up in the Remotion bundle. */
export declare function bundleHash(): string;
/** What each site was last stamped with. A site never deployed from this tree is null — it does
 *  NOT inherit another site's hash, which is what let a stale prod bundle read as current. */
export declare function readStamps(): Record<string, { hash: string; at: string | null } | null>;
/** Record `site` as deployed at `hash`, leaving every other site's stamp untouched. */
export declare function writeStamp(site: string, hash: string, now?: Date): void;
