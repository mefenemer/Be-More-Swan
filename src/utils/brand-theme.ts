// src/utils/brand-theme.ts — the org's brand kit, resolved into the themes our editors paint with.
//
// `organisations.brand_kit` has held a real palette since brand cards shipped (src/utils/brand-kit.ts):
// a primary colour, an ink, a canvas, a wordmark, a logo, sometimes extracted from the customer's
// own website. Until now NOTHING in either studio read it. The Newsletter Design Studio carried a
// hardcoded emerald — in TWO copies, one on the server and one in the browser — so every issue
// every customer sent went out in a green that belongs to nobody.
//
// This module is the one place that turns a BrandKit into a DesignTheme, so there is exactly one
// answer to "what colour is this customer's newsletter" and both copies of it come from here.
//
// ── The rule about orgs that have configured nothing ────────────────────────────────────────────
// ⚠️ A kit with `source: 'default'` means the org has never set a colour and no extraction has ever
// succeeded — DEFAULT_BRAND_KIT is near-black monochrome, chosen so a brand CARD looks deliberate
// rather than borrowed. An email is not a card: turning every unconfigured customer's newsletter
// monochrome overnight is a visible change to a live product that nobody asked for. So an
// unconfigured org keeps DEFAULT_THEME exactly as before, and only a kit somebody actually set
// ('manual') or that we extracted from their site ('website') moves the colours. Nothing here
// invents a brand.
//
// ── Where the contrast correction happens, and why not here ─────────────────────────────────────
// A pale brand — soft yellow, mint, baby blue — makes a perfectly good button and an invisible
// link. The fix is NOT to store a darkened accent: that would darken the buttons too, and a
// wellness brand whose yellow arrives olive has had its identity reinterpreted to solve a problem
// its buttons never had. So the accent is stored exactly as the customer set it, and the ONE place
// it becomes text — the `a{color:…}` rule in the email shell — is corrected against the card at
// render time (src/utils/newsletter-render.ts). A button's LABEL is picked against its own fill
// (readableInkOn) rather than hardcoded white, which is what made a yellow button unreadable.
//
// ── Why there is no webfont here ────────────────────────────────────────────────────────────────
// ⚠️ Deliberately absent: the kit's `fontFamily` is NOT pushed into the email theme. Setting a
// family in inline CSS without loading the font does nothing in any mail client that does not
// already have it installed, and Outlook — rendering with Word — will not load one at all. It would
// be a setting that appears to work in the canvas and silently does nothing in the inbox, which is
// the exact failure the Studio's "the preview is the truth" rule exists to prevent. The brand font
// belongs on the blog, where a real <link> can load it (src/config/blog-fonts.ts).

import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { organisations } from '../../db/schema';
import { DEFAULT_BRAND_KIT, normalizeBrandKit, type BrandKit } from './brand-kit';
// ⚠️ Straight from the shared module rather than through brand-kit's re-export, so it is obvious
// at a glance that the browser runs this same code (src/components/newsletter-designer.js).
import {
    contrastRatio, mixHex, normalizeHex, readableInkOn, MIN_BODY_CONTRAST,
} from '../public/brand-contrast.js';
import { DEFAULT_THEME, type DesignBlock, type DesignTheme } from './newsletter-design';

type Db = ReturnType<typeof getDb>;

/**
 * The fill and label for a button painted in `accent`.
 *
 * ⚠️ The label is picked, never assumed. Every button block in the product used to be born with
 * `color: '#ffffff'`, which is right for a deep brand and unreadable on a pale one.
 */
export function themedButtonColours(accent: string): { background: string; color: string } {
    const background = normalizeHex(accent) ?? DEFAULT_THEME.accent;
    return { background, color: readableInkOn(background) };
}

/**
 * The newsletter theme for an organisation's brand kit.
 *
 * Returns DEFAULT_THEME untouched for an org that has configured nothing — see the note at the top
 * of this file. Everything else is derived, and every colour that lands on another colour is
 * checked rather than hoped for.
 */
export function brandNewsletterTheme(rawKit: BrandKit | null | undefined): DesignTheme {
    const kit = rawKit ?? DEFAULT_BRAND_KIT;
    if (kit.source === 'default') return { ...DEFAULT_THEME };

    // The card is the paper the email is printed on: the brand's own canvas colour.
    const cardBackground = normalizeHex(kit.backgroundColor) ?? DEFAULT_THEME.cardBackground;

    // The brand's ink, but only if it can actually be read on that paper. A kit whose ink and
    // canvas were extracted from different parts of a website can easily be light-on-light.
    const brandInk = normalizeHex(kit.textColor) ?? DEFAULT_THEME.text;
    const text = contrastRatio(brandInk, cardBackground) >= MIN_BODY_CONTRAST
        ? brandInk
        : readableInkOn(cardBackground, DEFAULT_THEME.text);

    // ⚠️ The brand colour EXACTLY as the customer set it — deliberately NOT contrast-corrected here.
    // In an email `accent` fills buttons and nothing else structural (a button carries its own
    // colours per block, and the divider is a fixed grey); the one place it becomes TEXT is the
    // `a{color:…}` rule in the shell, and that is corrected at render time against the card it will
    // sit on (src/utils/newsletter-render.ts). Correcting it here instead would darken every button
    // as well, which turns a soft-yellow brand olive — a visible reinterpretation of somebody's
    // identity to fix a problem their buttons never had. Correcting at the link keeps both right,
    // and covers an accent picked by hand in the Style panel too.
    const accent = normalizeHex(kit.primaryColor) ?? DEFAULT_THEME.accent;

    return {
        accent,
        // Behind the card. Mixed from the card toward the ink so it is always a shade of the
        // brand's own palette and always distinguishable from the card — a flat #f6f7f9 surround
        // under a dark-brand card would frame it in somebody else's grey.
        background: mixHex(cardBackground, text, 0.06),
        cardBackground,
        text,
        fontFamily: DEFAULT_THEME.fontFamily,
        rounded: DEFAULT_THEME.rounded,
    };
}

/**
 * Repaint every button in a freshly-built design so it matches the theme it was built with.
 *
 * Template blocks are built by src/config/newsletter-templates.ts, which has no organisation in
 * scope and hardcodes the default accent. Rather than thread a theme through every factory, the
 * design is recoloured once at creation.
 *
 * ⚠️ Creation only. Running this over a design somebody has already edited would silently undo a
 * button they deliberately coloured by hand.
 */
export function applyThemeToNewBlocks(blocks: DesignBlock[], theme: DesignTheme): DesignBlock[] {
    const paint = (block: DesignBlock): DesignBlock => {
        if (block.type === 'button') return { ...block, ...themedButtonColours(theme.accent) };
        if (block.type === 'columns') {
            return {
                ...block,
                columns: [
                    block.columns[0].map(paint),
                    block.columns[1].map(paint),
                ] as typeof block.columns,
            };
        }
        return block;
    };
    return blocks.map(paint);
}

// ── Loading it ──────────────────────────────────────────────────────────────────────────────────

/**
 * The organisation's newsletter theme, read from `organisations.brand_kit`.
 *
 * One query, one row, one column — cheap enough to call on any path that mints a design, which is
 * the point: every creation seam resolves the brand the same way rather than each remembering to.
 *
 * ⚠️ A missing org or an unreadable kit resolves to DEFAULT_THEME, never throws. Creating a layout
 * is not the moment to fail because a colour could not be looked up.
 */
export async function loadBrandNewsletterTheme(db: Db, organisationId: number): Promise<DesignTheme> {
    try {
        const [org] = await db
            .select({ brandKit: organisations.brandKit })
            .from(organisations)
            .where(eq(organisations.id, organisationId))
            .limit(1);
        return brandNewsletterTheme(normalizeBrandKit(org?.brandKit));
    } catch (err) {
        console.error('[brand-theme] could not load brand kit', { organisationId }, err);
        return { ...DEFAULT_THEME };
    }
}
