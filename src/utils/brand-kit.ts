// src/utils/brand-kit.ts — the org's visual identity, as data.
//
// Until now "brand" meant prose only: organisations.businessDescription / targetAudience and the
// assistant's brand_voice + tone. Those steer what a post SAYS. A brand card has to be DRAWN, which
// needs the other half — colours, a wordmark, a logo — so this module defines that half and gives
// every consumer one normalized shape to read.
//
// Stored as organisations.brand_kit (jsonb, db/brand-kit.sql). Nothing else is authoritative: the
// palette in input.css is Be More Swan's own, and a client org must never inherit it by accident.
// An org that has filled nothing in renders MONOCHROME (see DEFAULT_BRAND_KIT) — a card that is
// deliberately neutral reads as a design choice, whereas a card in someone else's brand pink reads
// as a bug. Phase 2 (website extraction) is what replaces the neutral default with a real palette.

// ⚠️ THE COLOUR MATHS LIVES IN src/public/brand-contrast.js, not here. It is plain .js so the
// browser runs the SAME artifact: the newsletter canvas picks a button's label colour as the author
// adds it, and the server picks the identical colour when it builds one from a template. Re-exported
// rather than moved out of this module's surface, so every existing caller is untouched.
export {
    normalizeHex, relativeLuminance, saturation, contrastRatio, readableInkOn,
    MIN_DISPLAY_CONTRAST,
} from '../public/brand-contrast.js';

import { normalizeHex } from '../public/brand-contrast.js';

export interface BrandKit {
    /** Accent — the headline colour on a light card, and the background of a bold one. */
    primaryColor: string;
    /** Body/ink colour used on light backgrounds. */
    textColor: string;
    /** Light canvas colour. */
    backgroundColor: string;
    /** Short all-caps eyebrow, e.g. "BE MORE SWAN". Falls back to the org name at the call site. */
    wordmark: string | null;
    /** Absolute URL to a logo image. Rendered in place of the wordmark when it loads. */
    logoUrl: string | null;
    /** Footer line — usually the website host. */
    website: string | null;
    /**
     * Display family name, when the org's site uses one we can actually serve (see
     * src/lib/brand-card-webfont.ts). Null = render in the bundled family. Never trusted as a
     * string that reaches a URL: the loader re-validates it against a strict charset.
     */
    fontFamily: string | null;
    /** Where the colours came from. 'website' marks an extraction so the UI can say so. */
    source: 'default' | 'manual' | 'website';
    /** ISO timestamp of the last successful website extraction. */
    extractedAt: string | null;
    /**
     * ISO timestamp of the last extraction ATTEMPT, successful or not. Load-bearing: without it a
     * site that 404s, blocks bots or has no usable colours would be re-fetched on every single
     * post forever. See EXTRACT_RETRY_DAYS.
     */
    lastExtractAttemptAt: string | null;
}

/** How long to wait before re-attempting extraction for an org that yielded nothing usable. */
export const EXTRACT_RETRY_DAYS = 14;

/**
 * Neutral monochrome. Chosen so an org that has configured nothing still gets a publishable,
 * on-purpose-looking card rather than a borrowed identity. Near-black on off-white, which also
 * guarantees the contrast checks below can never fail for a default org.
 */
export const DEFAULT_BRAND_KIT: BrandKit = {
    primaryColor: '#1f1e1b',
    textColor: '#1f1e1b',
    backgroundColor: '#ffffff',
    wordmark: null,
    logoUrl: null,
    website: null,
    fontFamily: null,
    source: 'default',
    extractedAt: null,
    lastExtractAttemptAt: null,
};

/** Be More Swan's own palette, from input.css. Seeded onto the BMS org by db/brand-kit.sql. */
export const BE_MORE_SWAN_BRAND_KIT: BrandKit = {
    primaryColor: '#ff007f',   // --color-emerald-700, the neon-pink accent
    textColor: '#1f1e1b',      // --color-gray-900, deep espresso
    backgroundColor: '#fdfcf9', // --color-gray-50, warm cream
    wordmark: 'BE MORE SWAN',
    logoUrl: null,
    website: 'bemoreswan.com',
    fontFamily: 'Plus Jakarta Sans',
    source: 'manual',
    extractedAt: null,
    lastExtractAttemptAt: null,
};

const MAX_WORDMARK = 32;

/**
 * Font family names accepted into a kit. Deliberately strict: this string is interpolated into a
 * fonts.googleapis.com URL by the web-font loader, so anything that could carry a path, host or
 * query fragment must never survive normalization. Letters, digits and single spaces only.
 */
const FONT_FAMILY_RE = /^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/;

/** A family name safe to put in a font URL, or null. */
export function cleanFontFamily(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const v = raw.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ');
    return v.length >= 2 && v.length <= 48 && FONT_FAMILY_RE.test(v) ? v : null;
}

/** Trim a free-text field to something that fits on a card, or null. */
function cleanText(raw: unknown, max: number): string | null {
    if (typeof raw !== 'string') return null;
    const v = raw.trim().replace(/\s+/g, ' ');
    return v ? v.slice(0, max) : null;
}

/** Only http(s) — a card must never try to render a javascript:/data: "logo" from stored config. */
function cleanUrl(raw: unknown): string | null {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try {
        const u = new URL(raw.trim());
        return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
    } catch { return null; }
}

/**
 * Coerce whatever is stored on the org (or posted from the admin UI) into a complete BrandKit.
 * Every field falls back independently, so a half-filled kit is still renderable.
 */
export function normalizeBrandKit(raw: unknown): BrandKit {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_BRAND_KIT };
    const r = raw as Record<string, unknown>;
    const source = r.source === 'manual' || r.source === 'website' ? r.source : 'default';
    return {
        primaryColor: normalizeHex(r.primaryColor) ?? DEFAULT_BRAND_KIT.primaryColor,
        textColor: normalizeHex(r.textColor) ?? DEFAULT_BRAND_KIT.textColor,
        backgroundColor: normalizeHex(r.backgroundColor) ?? DEFAULT_BRAND_KIT.backgroundColor,
        wordmark: cleanText(r.wordmark, MAX_WORDMARK),
        logoUrl: cleanUrl(r.logoUrl),
        website: cleanText(r.website, 64),
        fontFamily: cleanFontFamily(r.fontFamily),
        source,
        extractedAt: cleanIso(r.extractedAt),
        lastExtractAttemptAt: cleanIso(r.lastExtractAttemptAt),
    };
}

/**
 * Which kit the review-time card editor should open with.
 *
 * A card stores the kit it was rendered with, so reopening shows the user's own edits. Cards
 * drafted before render_params existed have none — and seeding those from normalizeBrandKit(null)
 * would hand the editor DEFAULT_BRAND_KIT: near-black on white, no wordmark, no website. A branded
 * card would preview in monochrome with BOTH element toggles disabled as "nothing saved", and the
 * first save would bake that over a perfectly good card.
 *
 * The org's own kit is the right fallback. This is not the borrowed-brand case the neutral default
 * exists to prevent — it is the same workspace that drew the card. Only when the org has no kit
 * either does neutral apply.
 *
 * `orgName` is returned for the renderer's eyebrow fallback rather than written into the kit as a
 * wordmark: the drafting path passes it the same way, and baking a derived name into the STORED
 * kit would make a wordmark the user never chose permanent from the first save onwards. It is
 * returned only when the stored kit was absent — a card that recorded its own kit already says
 * everything about what it should show.
 */
export function resolveCardEditorKit(
    storedKit: unknown,
    orgBrandKit: unknown,
    orgName?: string | null,
): { kit: BrandKit; orgName: string | null } {
    if (storedKit) return { kit: normalizeBrandKit(storedKit), orgName: null };
    return {
        kit: normalizeBrandKit(orgBrandKit),
        orgName: typeof orgName === 'string' && orgName.trim() ? orgName.trim() : null,
    };
}

/** A stored timestamp, or null. Garbage in a date field must not become an Invalid Date downstream. */
function cleanIso(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Whether it is worth trying (or re-trying) a website extraction for this kit.
 *
 * False for a kit a human set up ('manual') — an automated guess must never overwrite a deliberate
 * choice — and false for a recent attempt, successful or not. The failed-attempt case is the one
 * that matters: extraction runs lazily from the drafting path, so without the backoff an org whose
 * site blocks us would pay a fetch on every post it ever generates.
 */
export function shouldExtractBrandKit(kit: BrandKit, now = new Date()): boolean {
    if (kit.source === 'manual') return false;
    if (!kit.lastExtractAttemptAt) return true;
    const ageMs = now.getTime() - Date.parse(kit.lastExtractAttemptAt);
    return ageMs >= EXTRACT_RETRY_DAYS * 24 * 60 * 60 * 1000;
}

// ── Contrast ──────────────────────────────────────────────────────────────────────────────────
// Moved to src/public/brand-contrast.js and re-exported at the top of this file — the newsletter
// canvas needs the identical answers in the browser. The reasoning that used to live here (why
// readableInkOn prefers white rather than maximising contrast, and what each WCAG floor is for)
// moved with the code; read it there before changing a threshold.
