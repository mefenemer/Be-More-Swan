// scripts/build-brand-card-fonts.mjs
// Regenerates src/lib/brand-card-fonts.ts from the live Google Fonts release of Plus Jakarta Sans
// (the same family the site loads in input.css, so a brand card matches the product's typography).
//
//   node scripts/build-brand-card-fonts.mjs
//
// Fetching the css2 endpoint with a legacy user-agent is what makes Google serve .ttf rather than
// .woff2 — satori needs TrueType/OpenType, and there is no woff2 decoder in the function runtime.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'brand-card-fonts.ts');
const CSS_URL = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;800&display=swap';
// A UA old enough that Google's font API falls back to truetype.
const LEGACY_UA = 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/40.0 Safari/537.36';

async function ttfFor(css, weight) {
    const block = css.split('@font-face').find((b) => new RegExp(`font-weight:\\s*${weight}\\b`).test(b));
    if (!block) throw new Error(`No @font-face block for weight ${weight}.`);
    const url = block.match(/url\((https:\/\/[^)]+\.ttf)\)/)?.[1];
    if (!url) throw new Error(`No .ttf url for weight ${weight} — Google may have stopped serving truetype for this UA.`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed for weight ${weight}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

// 120 chars per line keeps the generated file diffable-ish and inside sane editor widths.
const wrap = (b64) => {
    const lines = [];
    for (let i = 0; i < b64.length; i += 120) lines.push(`    '${b64.slice(i, i + 120)}'`);
    return lines.join(' +\n');
};

const cssRes = await fetch(CSS_URL, { headers: { 'User-Agent': LEGACY_UA } });
if (!cssRes.ok) throw new Error(`Could not fetch the font CSS: ${cssRes.status}`);
const css = await cssRes.text();

const [regular, extrabold] = await Promise.all([ttfFor(css, 400), ttfFor(css, 800)]);

const header = `// src/lib/brand-card-fonts.ts
// GENERATED FILE — do not hand-edit.
//
// Plus Jakarta Sans (Regular 400 / ExtraBold 800), latin subset, base64-embedded.
// Licensed under the SIL Open Font License 1.1 — see THIRD-PARTY-NOTICES.
//
// Embedded rather than shipped as .ttf files on purpose: netlify bundles these functions with
// esbuild, which inlines imported MODULES but not loose binary assets. A base64 constant is the
// only form guaranteed to survive the bundle without an included_files rule that silently breaks
// the renderer the day someone reorganises the repo. Cost is ~170KB of source for a hard guarantee
// that a brand card can always be drawn.
//
// Regenerate with scripts/build-brand-card-fonts.mjs.

const REGULAR_B64 =
`;

const body = `${header}${wrap(regular.toString('base64'))};

const EXTRABOLD_B64 =
${wrap(extrabold.toString('base64'))};

export const BRAND_CARD_FONT_FAMILY = 'Plus Jakarta Sans';

/** Font buffers in the shape satori expects. Decoded once per cold start. */
export const brandCardFonts = [
    { name: BRAND_CARD_FONT_FAMILY, data: Buffer.from(REGULAR_B64, 'base64'), weight: 400 as const, style: 'normal' as const },
    { name: BRAND_CARD_FONT_FAMILY, data: Buffer.from(EXTRABOLD_B64, 'base64'), weight: 800 as const, style: 'normal' as const },
];
`;

fs.writeFileSync(OUT, body);
console.log(`Wrote ${OUT} (${regular.length + extrabold.length} font bytes).`);
