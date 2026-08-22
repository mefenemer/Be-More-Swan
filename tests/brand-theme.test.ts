// tests/brand-theme.test.ts
// The brand injector: an organisation's brand kit, resolved into the colours its newsletters are
// actually built in.
//
// ⚠️ WHAT THIS FILE EXISTS TO STOP, in the order the faults are likely to come back:
//
//  1. THE ORIGINAL BUG. `organisations.brand_kit` has held a real palette since brand cards
//     shipped, and NOTHING in the Studio read it — the theme was a hardcoded emerald in TWO
//     copies, one on the server and one in the browser, so every issue every customer sent went
//     out in a green that belongs to nobody. Both copies are asserted to come from one place now.
//
//  2. A SILENT REGRESSION FOR ORGS WITH NO BRAND. DEFAULT_BRAND_KIT is near-black monochrome —
//     right for a brand card that would otherwise borrow somebody else's identity, very wrong as a
//     surprise repaint of a live product's emails. An unconfigured org must keep exactly what it
//     had.
//
//  3. AN UNREADABLE EMAIL. One `accent` field is the link colour, the button fill AND the rule.
//     A pale brand makes a fine button and an invisible link, and the button label was hardcoded
//     white. Every colour that lands on another colour is checked here against the WCAG floor,
//     not eyeballed.
//
//  4. A THEME THE VALIDATOR THROWS AWAY. normaliseDesign is the gate every design passes through,
//     and it silently replaces a fontFamily that is not one of FONT_STACKS and any colour that is
//     not #rrggbb. A resolved brand theme that does not survive it would look right in the canvas
//     and arrive green.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import {
    applyThemeToNewBlocks, brandNewsletterTheme, themedButtonColours,
} from '../src/utils/brand-theme';
import { contrastRatio, ensureContrast, mixHex } from '../src/public/brand-contrast.js';
import {
    BE_MORE_SWAN_BRAND_KIT, DEFAULT_BRAND_KIT, normalizeBrandKit, type BrandKit,
} from '../src/utils/brand-kit';
import {
    DEFAULT_THEME, normaliseDesign, type ButtonBlock, type ColumnsBlock, type DesignBlock,
    type NewsletterDesign,
} from '../src/utils/newsletter-design';
import { designFromTemplate, NEWSLETTER_TEMPLATES } from '../src/config/newsletter-templates';
import { renderIssueSnapshot } from '../src/utils/newsletter-render';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
/** Negative assertions must not match the comment that explains why the thing was removed. */
const codeOnly = (src: string) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
    try {
        const out = fn();
        if (out instanceof Promise) {
            return out.then(() => { passed++; console.log(`  ✓ ${name}`); })
                .catch((err: Error) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
        }
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
        process.exitCode = 1;
    }
    return Promise.resolve();
}

const BRAND_KIT = read('src/utils/brand-kit.ts');
const CONTRAST_JS = read('src/public/brand-contrast.js');
const THEME = read('src/utils/brand-theme.ts');
const ISSUES = read('netlify/functions/newsletter-issues.ts');
const SEQ = read('netlify/functions/newsletter-sequences.ts');
const DESIGNER = read('src/components/newsletter-designer.js');
const UI = read('newsletter.js');
const WORKSPACE = read('workspace.html');

/** A kit somebody actually configured. `source` is what separates "set" from "never touched". */
const kit = (over: Partial<BrandKit>): BrandKit =>
    normalizeBrandKit({ ...DEFAULT_BRAND_KIT, source: 'manual', ...over });

const AA = 4.5;

console.log('\nBrand injector\n');

// ── 1. The org that has configured nothing ──────────────────────────────────

check('an org with no brand kit keeps exactly the theme it already had', () => {
    // ⚠️ Not "close to". A live product's emails must not change colour because a feature shipped.
    assert.deepStrictEqual(brandNewsletterTheme(DEFAULT_BRAND_KIT), DEFAULT_THEME);
    assert.deepStrictEqual(brandNewsletterTheme(null), DEFAULT_THEME);
    assert.deepStrictEqual(brandNewsletterTheme(normalizeBrandKit(null)), DEFAULT_THEME);
});

check('a kit is only honoured once somebody set it or we extracted it', () => {
    // The same colours with source 'default' must be ignored — a half-written kit that never came
    // from the customer is not a brand.
    const colours = { primaryColor: '#1d4ed8', textColor: '#0b1220', backgroundColor: '#ffffff' };
    assert.deepStrictEqual(brandNewsletterTheme(normalizeBrandKit({ ...colours, source: 'default' })), DEFAULT_THEME);
    assert.notDeepStrictEqual(brandNewsletterTheme(normalizeBrandKit({ ...colours, source: 'website' })), DEFAULT_THEME);
    assert.notDeepStrictEqual(brandNewsletterTheme(normalizeBrandKit({ ...colours, source: 'manual' })), DEFAULT_THEME);
});

// ── 2. The colours themselves ───────────────────────────────────────────────

check("a configured brand paints the card, the ink and the accent", () => {
    const theme = brandNewsletterTheme(kit({
        primaryColor: '#1d4ed8', textColor: '#0b1220', backgroundColor: '#ffffff',
    }));
    assert.strictEqual(theme.cardBackground, '#ffffff');
    assert.strictEqual(theme.text, '#0b1220');
    // Already legible on white, so it is passed through untouched — the common case must not be
    // "corrected" into a different blue.
    assert.strictEqual(theme.accent, '#1d4ed8');
});

check('the surround is always a shade of the brand and never the same as the card', () => {
    for (const bg of ['#ffffff', '#fdfcf9', '#111111']) {
        const theme = brandNewsletterTheme(kit({ backgroundColor: bg, textColor: '#808080' }));
        assert.notStrictEqual(theme.background, theme.cardBackground);
    }
});

check('a pale brand colour is stored EXACTLY as the customer set it', () => {
    // ⚠️ The temptation is to darken it here so links are readable. That darkens the buttons too,
    // and a soft-yellow brand whose emails arrive olive has had its identity reinterpreted to fix a
    // problem its buttons never had. The link is corrected at render time instead (below).
    const theme = brandNewsletterTheme(kit({ primaryColor: '#ffe066', backgroundColor: '#ffffff' }));
    assert.strictEqual(theme.accent, '#ffe066');
    assert.strictEqual(brandNewsletterTheme(BE_MORE_SWAN_BRAND_KIT).accent, BE_MORE_SWAN_BRAND_KIT.primaryColor);
});

check('ensureContrast keeps the hue when it does have to move a colour', () => {
    // Be More Swan's own neon pink on its own cream scores about 3.6:1 — a real kit, seeded by
    // db/brand-kit.sql, and genuinely borderline, so this is the case that exercises the walk.
    assert.ok(contrastRatio(BE_MORE_SWAN_BRAND_KIT.primaryColor, BE_MORE_SWAN_BRAND_KIT.backgroundColor) < AA);
    const fixed = ensureContrast(BE_MORE_SWAN_BRAND_KIT.primaryColor, BE_MORE_SWAN_BRAND_KIT.backgroundColor) as string;
    assert.ok(contrastRatio(fixed, BE_MORE_SWAN_BRAND_KIT.backgroundColor) >= AA);
    // Still pink. A "correction" that walks all the way to black is not the brand any more.
    const [r, , b] = [1, 3, 5].map((i) => parseInt(fixed.slice(i, i + 2), 16));
    assert.ok(r > 60 && b > 30, `expected the hue to survive, got ${fixed}`);
});

check('an ink that cannot be read on its own canvas is replaced, not shipped', () => {
    // Extraction takes the ink and the canvas from different parts of a website, so light-on-light
    // is not hypothetical.
    const theme = brandNewsletterTheme(kit({ textColor: '#eeeeee', backgroundColor: '#ffffff' }));
    assert.notStrictEqual(theme.text, '#eeeeee');
    assert.ok(contrastRatio(theme.text, theme.cardBackground) >= AA);
});

check('a dark brand stays dark, with light ink and a distinguishable surround', () => {
    const theme = brandNewsletterTheme(kit({
        primaryColor: '#7dd3fc', textColor: '#f8fafc', backgroundColor: '#111111',
    }));
    assert.strictEqual(theme.cardBackground, '#111111');
    assert.strictEqual(theme.accent, '#7dd3fc');
    assert.ok(contrastRatio(theme.text, theme.cardBackground) >= AA);
    assert.notStrictEqual(theme.background, theme.cardBackground);
});

check('ensureContrast leaves a colour that already passes completely alone', () => {
    assert.strictEqual(ensureContrast('#0b1220', '#ffffff'), '#0b1220');
    assert.strictEqual(mixHex('#000000', '#ffffff', 0), '#000000');
    assert.strictEqual(mixHex('#000000', '#ffffff', 1), '#ffffff');
    assert.strictEqual(mixHex('#000000', '#ffffff', 0.5), '#808080');
});

// ── 3. Buttons ──────────────────────────────────────────────────────────────

check('a button label is picked against its fill, never assumed white', () => {
    assert.strictEqual(themedButtonColours('#1d4ed8').color, '#ffffff');
    // The fault this replaces: white on soft yellow.
    const pale = themedButtonColours('#ffe066');
    assert.notStrictEqual(pale.color, '#ffffff');
    assert.ok(contrastRatio(pale.color, pale.background) >= 3);
});

check('every button in a new design is repainted, including inside a column', () => {
    const theme = brandNewsletterTheme(kit({ primaryColor: '#1d4ed8', backgroundColor: '#ffffff' }));
    const blocks: DesignBlock[] = [
        { id: 'a', type: 'button', label: 'One', href: '', align: 'center', background: '#059669', color: '#ffffff' },
        { id: 'b', type: 'heading', text: 'Untouched', level: 2, align: 'left' },
        {
            id: 'c', type: 'columns',
            columns: [
                [{ id: 'd', type: 'button', label: 'Two', href: '', align: 'center', background: '#059669', color: '#ffffff' }],
                [{ id: 'e', type: 'text', markdown: 'Untouched', align: 'left' }],
            ],
        },
    ];
    const out = applyThemeToNewBlocks(blocks, theme);
    assert.strictEqual((out[0] as ButtonBlock).background, theme.accent);
    assert.deepStrictEqual(out[1], blocks[1]);
    const nested = (out[2] as ColumnsBlock).columns[0][0] as ButtonBlock;
    assert.strictEqual(nested.background, theme.accent);
    assert.strictEqual(nested.label, 'Two');
    assert.deepStrictEqual((out[2] as ColumnsBlock).columns[1][0], blocks[2] && (blocks[2] as ColumnsBlock).columns[1][0]);
});

// ── 4. Templates, and the validator every design passes through ─────────────

check('a template built with a theme comes out in that theme, buttons and all', () => {
    const theme = brandNewsletterTheme(kit({ primaryColor: '#1d4ed8', backgroundColor: '#ffffff' }));
    for (const t of NEWSLETTER_TEMPLATES) {
        const d = designFromTemplate(t.key, theme);
        assert.deepStrictEqual(d.theme, theme, `${t.key} kept the wrong theme`);
        const buttons = d.blocks.filter((b): b is ButtonBlock => b.type === 'button');
        for (const b of buttons) assert.strictEqual(b.background, theme.accent, `${t.key} shipped a stale button`);
    }
});

check('designFromTemplate with no theme is unchanged — every existing caller still works', () => {
    const d = designFromTemplate('announcement');
    assert.deepStrictEqual(d.theme, DEFAULT_THEME);
    const button = d.blocks.find((b): b is ButtonBlock => b.type === 'button');
    assert.strictEqual(button?.background, DEFAULT_THEME.accent);
});

check('a resolved brand theme survives normaliseDesign intact', () => {
    // ⚠️ The gate. It replaces any colour that is not #rrggbb and any fontFamily that is not one of
    // FONT_STACKS — silently. A theme that does not round-trip through it looks right in the canvas
    // and arrives in the inbox green.
    const theme = brandNewsletterTheme(BE_MORE_SWAN_BRAND_KIT);
    const d = normaliseDesign(designFromTemplate('offer', theme)) as NewsletterDesign;
    assert.ok(d, 'the design did not survive validation at all');
    assert.deepStrictEqual(d.theme, theme);
    for (const b of d.blocks.filter((x): x is ButtonBlock => x.type === 'button')) {
        assert.strictEqual(b.background, theme.accent);
    }
});

check('the brand font is deliberately NOT pushed into the email theme', () => {
    // A family set in inline CSS with no webfont loaded does nothing in a mail client that does not
    // already have it — and Outlook will not load one at all. It would be a setting that works in
    // the canvas and silently does not in the inbox.
    const theme = brandNewsletterTheme(kit({ fontFamily: 'Plus Jakarta Sans' }));
    assert.strictEqual(theme.fontFamily, DEFAULT_THEME.fontFamily);
    assert.match(THEME, /Why there is no webfont here/);
});

// ── 5. One implementation of the colour maths, not two ──────────────────────

check('the colour maths lives in the shared browser/server artifact only', () => {
    for (const fn of ['function relativeLuminance', 'function contrastRatio', 'function readableInkOn']) {
        assert.ok(CONTRAST_JS.includes(fn), `brand-contrast.js lost ${fn}`);
        assert.ok(!codeOnly(BRAND_KIT).includes(fn), `brand-kit.ts grew a second copy of ${fn}`);
    }
    // Re-exported, so every existing server caller (brand cards, the card editor) is untouched.
    assert.match(BRAND_KIT, /export \{[\s\S]*readableInkOn[\s\S]*\} from '\.\.\/public\/brand-contrast\.js'/);
    assert.match(THEME, /from '\.\.\/public\/brand-contrast\.js'/);
});

check('the browser loads that same artifact, before the designer that reads it', () => {
    const script = landmark(WORKSPACE, '/src/public/brand-contrast.js');
    const designer = landmark(WORKSPACE, '/src/components/newsletter-designer.js');
    assert.ok(script < designer, 'brand-contrast.js must load before newsletter-designer.js');
    assert.match(DESIGNER, /window\.BrandContrast/);
    assert.match(DESIGNER, /CONTRAST\.readableInkOn\(accent\)/);
    // The fault: every button born in the default green with a hardcoded white label.
    assert.ok(!/background: DEFAULT_THEME\.accent, color: '#ffffff'/.test(codeOnly(DESIGNER)));
});

// ── 6. Every seam that mints a design asks for the brand ────────────────────

check('both server seams that create a design resolve the org brand first', () => {
    const create = ISSUES.slice(landmark(ISSUES, "if (action === 'create')"), landmark(ISSUES, "if (action === 'generate')"));
    assert.match(create, /designFromTemplate\(body\.template, await loadBrandNewsletterTheme\(db, orgId\)\)/);

    const designAction = ISSUES.slice(landmark(ISSUES, "if (action === 'design')"), landmark(ISSUES, "if (action === 'preview')"));
    assert.match(designAction, /const theme = await loadBrandNewsletterTheme\(db, orgId\)/);
    // Both branches — a converted draft and a fresh template — take the same theme.
    assert.match(designAction, /theme,\s*blocks: blocksFromMarkdown\(issue\.bodyMarkdown\)/);
    assert.match(designAction, /designFromTemplate\(body\.template, theme\)/);
    // And the old hardcoded default is gone from the function entirely.
    assert.ok(!codeOnly(ISSUES).includes('DEFAULT_THEME'), 'newsletter-issues.ts still mints a hardcoded theme');
});

check('a welcome-sequence step gets the brand too — it is an email like any other', () => {
    assert.match(SEQ, /designFromTemplate\(body\.template, await loadBrandNewsletterTheme\(db, orgId\)\)/);
});

check('the browser is told the brand rather than computing one', () => {
    assert.match(ISSUES, /brandTheme: await loadBrandNewsletterTheme\(db, orgId\)/);
    assert.match(UI, /if \(brandTheme\) state\.brandTheme = brandTheme;/);
    // Both canvases — the issue editor and the sequence step editor.
    assert.strictEqual((UI.match(/defaultTheme: state\.brandTheme \|\| null/g) || []).length, 2);
    // The one place the browser mints a whole design by itself.
    const convert = UI.slice(landmark(UI, "'nl-seq-design-on'"), landmark(UI, "'nl-seq-design-off'"));
    assert.match(convert, /theme: state\.brandTheme/);
});

check('a design already saved is never repainted behind the author', () => {
    // The brand is the base a NEW design starts from. Reopening an issue somebody styled by hand
    // must not restyle it — the stored theme wins field by field.
    assert.match(DESIGNER, /Object\.assign\(\{\}, DEFAULT_THEME, opts\.defaultTheme \|\| \{\}, \(design && design\.theme\) \|\| \{\}\)/);
    // Going back to the brand is a button the author presses, not something that happens to them.
    assert.match(DESIGNER, /data-nld-brandreset/);
    assert.match(DESIGNER, /Back to my brand colours/);
});

// ── 7. What the email actually renders as ───────────────────────────────────

async function main() {
    const render = async (theme: ReturnType<typeof brandNewsletterTheme>) => {
        const design = normaliseDesign(designFromTemplate('offer', theme)) as NewsletterDesign;
        const snap = await renderIssueSnapshot({
            bodyMarkdown: '', design, preheader: '', senderName: 'Example', baseUrl: 'https://app.example.com',
        });
        return snap.html;
    };
    const linkColour = (html: string) => {
        const m = /a\{color:(#[0-9a-f]{6});\}/i.exec(html);
        assert.ok(m, 'the shell no longer sets a link colour at all');
        return (m as RegExpExecArray)[1];
    };

    await check('a pale brand renders a readable LINK and a button in its true colour', async () => {
        const theme = brandNewsletterTheme(kit({ primaryColor: '#ffe066', backgroundColor: '#ffffff' }));
        const html = await render(theme);
        // The link is walked toward legibility — soft yellow on white is about 1.3:1.
        assert.ok(contrastRatio(linkColour(html), theme.cardBackground) >= AA,
            `link ${linkColour(html)} is still unreadable on ${theme.cardBackground}`);
        // ⚠️ And the button is STILL the customer's actual yellow, with a label picked against it.
        assert.ok(html.includes('background:#ffe066'), 'the button lost the brand colour');
        const label = themedButtonColours('#ffe066').color;
        assert.notStrictEqual(label, '#ffffff');
        assert.ok(html.includes(`color:${label}`), 'the button label was not picked against its fill');
    });

    await check('a brand that is already legible is rendered exactly as set', async () => {
        const theme = brandNewsletterTheme(kit({ primaryColor: '#1d4ed8', backgroundColor: '#ffffff' }));
        const html = await render(theme);
        assert.strictEqual(linkColour(html), '#1d4ed8');
        assert.ok(html.includes('background:#1d4ed8'));
    });

    await check('a dark brand renders dark, end to end', async () => {
        const theme = brandNewsletterTheme(kit({
            primaryColor: '#38bdf8', textColor: '#f8fafc', backgroundColor: '#151a21',
        }));
        const html = await render(theme);
        assert.ok(html.includes('background:#151a21'), 'the card is not the brand canvas');
        assert.strictEqual(linkColour(html), '#38bdf8');
        assert.ok(contrastRatio(linkColour(html), '#151a21') >= AA);
    });

    await check('the correction is on the link only — the stored theme is never rewritten', async () => {
        // ⚠️ If this ever fails the way to fix it is NOT to darken the theme: see the header of
        // src/utils/brand-theme.ts. The renderer owns the link colour.
        const RENDER = read('src/utils/newsletter-render.ts');
        assert.match(RENDER, /const linkColour = ensureContrast\(accent, shell\.cardBackground\) \?\? accent;/);
        assert.match(RENDER, /a\{color:\$\{linkColour\};\}/);
        assert.ok(!codeOnly(THEME).includes('ensureContrast'), 'brand-theme.ts is correcting the accent again');
    });

    console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
