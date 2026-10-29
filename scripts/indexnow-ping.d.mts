// Types for scripts/indexnow-ping.mjs (plain JS so the Netlify build plugin can import it unbundled).
export function pingIndexNow(opts?: {
    env?: Record<string, string | undefined>;
    extraUrls?: string[];
    fetchImpl?: typeof fetch;
}): Promise<string | undefined>;
