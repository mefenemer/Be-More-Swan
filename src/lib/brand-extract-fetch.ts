// src/lib/brand-extract-fetch.ts — the network + persistence half of website brand extraction.
//
// Split from src/utils/brand-extract.ts so the ranking logic stays a pure function that tests can
// drive with real page shapes and no network.
//
// Everything here is best-effort by design. Extraction runs lazily off the drafting path, so a
// slow, blocked or malformed site must degrade to "no kit extracted" and never delay or fail a
// post. The one thing it must NOT do is retry forever: every attempt is stamped, successful or not
// (see shouldExtractBrandKit / EXTRACT_RETRY_DAYS).

import { eq } from 'drizzle-orm';
import { organisations } from '../../db/schema';
import { safeFetchText, SafeFetchError } from '../utils/safe-fetch';
import { gatewayGenerate } from './ai-gateway';
import { parseModelJson } from '../utils/model-json';
import { harvestBrandSignals, signalsToBrandKit, type BrandSignals } from '../utils/brand-extract';
import { normalizeBrandKit, shouldExtractBrandKit, type BrandKit } from '../utils/brand-kit';
import type { getDb } from '../../db/client';

type Db = ReturnType<typeof getDb>;

// Tight budgets: this runs inside a generation job that already has a wall clock to meet.
const PAGE_TIMEOUT_MS = 8_000;
const CSS_TIMEOUT_MS = 5_000;
// 5 MB, not the 2 MB this started at: linear.app's homepage alone blew a 2 MB cap, and an
// SPA marketing page routinely ships more markup than that.
const PAGE_MAX_BYTES = 5 * 1024 * 1024;
const CSS_MAX_BYTES = 2 * 1024 * 1024;
/** Stylesheets to pull for the second pass. Brand tokens live in the first few (same-origin ones
 *  sort first); a site with thirty is a build artefact and fetching them all buys only latency. */
const MAX_STYLESHEETS = 4;

/**
 * Fetch a website and derive a brand kit from it. Returns null when nothing usable was found —
 * which is a normal outcome, not an error (a site can legitimately be a monochrome wordmark).
 * Never throws.
 */
export async function extractBrandKitFromWebsite(
    websiteUrl: string,
    opts: { useModel?: boolean; now?: Date } = {},
): Promise<BrandKit | null> {
    let page;
    try {
        page = await safeFetchText(websiteUrl, { timeoutMs: PAGE_TIMEOUT_MS, maxBytes: PAGE_MAX_BYTES });
    } catch (err) {
        const why = err instanceof SafeFetchError ? err.message : (err as Error)?.message;
        console.warn(`[brand-extract] could not fetch ${websiteUrl}: ${why}`);
        return null;
    }

    if (!/html/i.test(page.contentType)) {
        console.warn(`[brand-extract] ${websiteUrl} is not HTML (${page.contentType})`);
        return null;
    }

    // First pass: inline styles only. This also tells us which stylesheets are worth fetching.
    const firstPass = harvestBrandSignals(page.body, page.finalUrl);
    const css = await fetchStylesheets(firstPass.stylesheets.slice(0, MAX_STYLESHEETS));
    const signals = css ? harvestBrandSignals(page.body, page.finalUrl, css) : firstPass;

    if (!signals.candidates.length) {
        console.warn(`[brand-extract] no brand-like colour found on ${websiteUrl}`);
        return null;
    }

    const chosenAccent = opts.useModel === false ? null : await chooseAccentWithModel(signals, websiteUrl);

    return signalsToBrandKit(signals, {
        website: hostOf(page.finalUrl),
        chosenAccent,
        now: opts.now,
    });
}

/** Fetch stylesheets in parallel; a failure just contributes nothing. */
async function fetchStylesheets(urls: string[]): Promise<string> {
    if (!urls.length) return '';
    const results = await Promise.all(urls.map(async (u) => {
        try {
            const r = await safeFetchText(u, { timeoutMs: CSS_TIMEOUT_MS, maxBytes: CSS_MAX_BYTES });
            return r.body;
        } catch { return ''; }
    }));
    return results.join('\n');
}

function hostOf(raw: string): string | null {
    try { return new URL(raw).hostname.replace(/^www\./, ''); } catch { return null; }
}

/**
 * Ask the model which harvested colour is the brand accent.
 *
 * Deliberately a MULTIPLE-CHOICE question, never an open one. Ranking gets the obvious cases right
 * (a named --brand-primary, a theme-color) but has no way to tell a brand accent from a prominent
 * decorative colour when both are merely frequent — that is a judgement call, and the reasons we
 * harvested are exactly the evidence a reader would use. Constraining the answer to the candidate
 * list means the worst case is a differently-ranked colour that IS on the site; an open question
 * would let the model invent a plausible-sounding hex that appears nowhere.
 *
 * Returns null on any failure, which falls back to the deterministic top candidate.
 */
async function chooseAccentWithModel(signals: BrandSignals, websiteUrl: string): Promise<string | null> {
    const shortlist = signals.candidates.slice(0, 8);
    // One candidate is not a choice, and the deterministic pick is already that one.
    if (shortlist.length < 2) return null;

    const lines = shortlist.map((c, i) => `${i + 1}. ${c.hex} — found as: ${c.reasons.slice(0, 4).join('; ')}`);

    try {
        const { text } = await gatewayGenerate({
            system: 'You identify a brand\'s primary accent colour from evidence gathered off its website. '
                + 'You answer only with JSON.',
            messages: [{
                role: 'user',
                content: [
                    `Website: ${websiteUrl}`,
                    signals.wordmark ? `Brand name: ${signals.wordmark}` : '',
                    '',
                    'Colours found on the site, with where each was found:',
                    ...lines,
                    '',
                    'Which ONE is the brand\'s primary accent colour — the colour a designer would put on a',
                    'button or a logo, not the page background, body text, or a neutral border?',
                    'Answer with a hex value copied EXACTLY from the list above.',
                    'Return JSON: { "hex": "#rrggbb" }',
                ].filter(Boolean).join('\n'),
            }],
            maxTokens: 128,
        });

        const parsed = parseModelJson<{ hex?: string }>(text);
        const hex = typeof parsed?.hex === 'string' ? parsed.hex.trim().toLowerCase() : null;
        // Validated against the shortlist by signalsToBrandKit too; checked here so a rejected
        // answer is visible in the logs rather than silently becoming the deterministic pick.
        if (hex && shortlist.some((c) => c.hex === hex)) return hex;
        console.warn(`[brand-extract] model returned an off-list colour (${hex ?? 'none'}) for ${websiteUrl}`);
        return null;
    } catch (err) {
        console.warn('[brand-extract] accent selection unavailable:', err instanceof Error ? err.message : err);
        return null;
    }
}

/**
 * The org's brand kit, extracting it from their website first if that's worth doing.
 *
 * This is what the card path calls. It always returns a renderable kit — the neutral default when
 * there is nothing better — so a caller never has to handle "no brand".
 */
export async function resolveBrandKitForOrg(db: Db, orgId: number, now = new Date()): Promise<BrandKit> {
    const [org] = await db
        .select({ name: organisations.name, websiteUrl: organisations.websiteUrl, brandKit: organisations.brandKit })
        .from(organisations).where(eq(organisations.id, orgId)).limit(1);

    const stored = normalizeBrandKit(org?.brandKit);
    if (!org?.websiteUrl || !shouldExtractBrandKit(stored, now)) return stored;

    const extracted = await extractBrandKitFromWebsite(org.websiteUrl, { now });

    // Stamp the attempt either way. On failure this is the ONLY thing written, and it is what stops
    // an unreachable site being re-fetched on every post for the life of the account.
    const next: BrandKit = extracted ?? { ...stored, lastExtractAttemptAt: now.toISOString() };

    try {
        await db.update(organisations)
            .set({ brandKit: next, updatedAt: now })
            .where(eq(organisations.id, orgId));
    } catch (err) {
        // A failed write costs a repeat attempt next time; it must not cost the post.
        console.warn('[brand-extract] could not persist the extracted kit:', err instanceof Error ? err.message : err);
    }

    return next;
}
