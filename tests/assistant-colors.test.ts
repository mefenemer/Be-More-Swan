// tests/assistant-colors.test.ts
//
// The assistant icon colour exists in FOUR places that have to agree, and every disagreement is
// silent — the assistant just looks like a different assistant on a different page:
//
//   1. src/config/assistant-colors.ts        — the palette + the validator the server writes through
//   2. src/generated/platform-constants.js   — the browser's GENERATED copy of that palette
//   3. /assistant-colors.js                  — window.AssistantColors, what every surface calls
//   4. netlify/functions/update-assistant-context.ts — the carry-across that keeps a saved colour
//                                                      alive across an unrelated partial save
//
// The drift this guards against is not hypothetical: before this feature, notifications.js keyed the
// same ten-colour palette by `id % length` while calendar.js keyed it by the assistant's INDEX in
// its loaded list. Both files' comments claimed to mirror the other. They agreed only when load
// order happened to match id order, so one assistant was routinely two colours in one session.
//
// Nothing here touches a database or a browser: the generated mirror and the client module are read
// as SOURCE, the config module is imported.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ASSISTANT_COLORS, ASSISTANT_COLOR_VALUES, ASSISTANT_COLOR_NEUTRAL,
    normaliseAssistantColor, autoAssistantColor,
} from '../src/config/assistant-colors';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('\nAssistant icon colours\n');

// ── The validator ───────────────────────────────────────────────────────────────────────────────
// The stored value is interpolated straight into `style="background:…"` on four surfaces, so the
// question "may this string be persisted?" is a security question, not a tidiness one.
check('normalise accepts every palette colour', () => {
    for (const c of ASSISTANT_COLORS) {
        assert.strictEqual(normaliseAssistantColor(c.value), c.value, `${c.name} (${c.value}) was rejected`);
    }
});

check('normalise is case-insensitive and trims', () => {
    assert.strictEqual(normaliseAssistantColor('#EC4899'), '#ec4899');
    assert.strictEqual(normaliseAssistantColor('  #ec4899  '), '#ec4899');
});

check('normalise refuses anything outside the palette', () => {
    for (const junk of [
        '#123456',                        // a valid hex we do not offer
        'red',
        '#ec4899; background:url(//evil)', // the CSS-injection shape
        '#ec4899"><script>',              // the attribute-escape shape
        '', '   ', null, undefined, 42, {}, ['#ec4899'],
    ]) {
        assert.strictEqual(normaliseAssistantColor(junk as unknown), null,
            `expected null for ${JSON.stringify(junk)}`);
    }
});

// ── The automatic fallback ──────────────────────────────────────────────────────────────────────
check('auto colour is stable per id and load-order independent', () => {
    assert.strictEqual(autoAssistantColor(7), autoAssistantColor(7));
    assert.strictEqual(autoAssistantColor('7'), autoAssistantColor(7), 'string and number ids must agree');
    // The pre-existing notifications.js rule, preserved so enabling the feature repaints nobody.
    assert.strictEqual(autoAssistantColor(7), ASSISTANT_COLOR_VALUES[7 % ASSISTANT_COLOR_VALUES.length]);
    assert.strictEqual(autoAssistantColor(0), ASSISTANT_COLOR_VALUES[0]);
});

check('auto colour is always a palette colour, never junk', () => {
    for (const id of [0, 1, 9, 10, 999, -3, '12']) {
        assert.ok(ASSISTANT_COLOR_VALUES.includes(autoAssistantColor(id as number | string)),
            `id ${id} produced a colour outside the palette`);
    }
});

check('no assistant resolves to the neutral colour, which is not assignable', () => {
    assert.strictEqual(autoAssistantColor(null), ASSISTANT_COLOR_NEUTRAL);
    assert.strictEqual(autoAssistantColor(undefined), ASSISTANT_COLOR_NEUTRAL);
    assert.strictEqual(autoAssistantColor('not-a-number'), ASSISTANT_COLOR_NEUTRAL);
    assert.strictEqual(normaliseAssistantColor(ASSISTANT_COLOR_NEUTRAL), null,
        'the neutral grey must not be storable as a choice');
});

// ── The generated browser mirror ────────────────────────────────────────────────────────────────
// `npm run gen:constants` writes this. If it is stale, the server validates against one palette and
// the browser paints from another.
check('generated platform-constants mirrors the palette exactly', () => {
    const gen = read('src/generated/platform-constants.js');
    const block = gen.slice(
        landmark(gen, 'window.AssistantColorPalette'),
        landmark(gen, 'window.BlogFonts'),
    );
    for (const c of ASSISTANT_COLORS) {
        assert.ok(block.includes(`"${c.value}"`), `${c.value} missing from the generated mirror — run npm run gen:constants`);
        assert.ok(block.includes(`"${c.name}"`), `${c.name} missing from the generated mirror — run npm run gen:constants`);
    }
    assert.ok(block.includes(`"${ASSISTANT_COLOR_NEUTRAL}"`), 'neutral colour missing from the generated mirror');
});

// ── The client module ───────────────────────────────────────────────────────────────────────────
check('assistant-colors.js prefers the generated palette over its own fallback', () => {
    const js = read('assistant-colors.js');
    assert.ok(/const GEN = .*window\.AssistantColorPalette/.test(js),
        'the client module must read the generated palette');
    assert.ok(js.includes('(GEN && GEN.values) ||'),
        'the generated values must win over the inline fallback list');
});

check('assistant-colors.js validates before returning a colour to a style attribute', () => {
    const js = read('assistant-colors.js');
    const body = js.slice(landmark(js, 'const colorFor'), landmark(js, 'const nameOf'));
    assert.ok(body.includes('isValid(explicit)'), 'colorFor must validate an explicit colour');
    assert.ok(body.includes('isValid(cached)'), 'colorFor must validate a cached colour');
});

check('remember() DROPS a cached colour when an assistant is reset to automatic', () => {
    const js = read('assistant-colors.js');
    const body = js.slice(landmark(js, 'const remember ='), landmark(js, 'const rememberAll'));
    // Without the delete, resetting to automatic leaves the old override in the cache and every
    // surface keeps painting the colour the user just cleared — the exact bug this caught.
    assert.ok(body.includes('_explicit.delete('), 'remember() must clear the override when the colour is unset');
});

// ── The save path ───────────────────────────────────────────────────────────────────────────────
check('update-assistant-context normalises before writing, and honours an explicit reset', () => {
    const fn = read('netlify/functions/update-assistant-context.ts');
    assert.ok(fn.includes('normaliseAssistantColor(avatarColor)'),
        'the endpoint must normalise the incoming colour rather than trusting it');
    const block = fn.slice(
        landmark(fn, 'if (avatarColor !== undefined) {'),
        landmark(fn, 'await tx.update(aiAssistants)'),
    );
    assert.ok(block.includes('delete next.avatarColor'),
        'an explicit null must remove the stored colour, not leave the old one');
});

check('a partial save cannot silently wipe a stored colour', () => {
    const fn = read('netlify/functions/update-assistant-context.ts');
    const block = fn.slice(
        landmark(fn, 'if (avatarColor !== undefined) {'),
        landmark(fn, 'await tx.update(aiAssistants)'),
    );
    // newConfiguration REPLACES configuration wholesale, so every caller that builds one from its
    // own form (the onboarding wizard, integrations.js) would drop the colour without this.
    assert.ok(block.includes("hasOwnProperty.call(existingConfig, 'avatarColor')"),
        'the endpoint must carry a stored colour across a save that never mentions it');
});

// ── The surfaces ────────────────────────────────────────────────────────────────────────────────
// Each of these used to own a copy of the palette. None of them may own one again.
check('no surface keeps its own copy of the palette', () => {
    for (const file of ['notifications.js', 'calendar.js', 'assistants.js']) {
        const src = read(file);
        assert.ok(!src.includes('ASSISTANT_PALETTE'),
            `${file} still declares its own palette — it must resolve through window.AssistantColors`);
        assert.ok(src.includes('AssistantColors'),
            `${file} must resolve its icon colours through window.AssistantColors`);
    }
});

// The failure count is printed too: a lone ✗ scrolling past above a bare "N checks passed" is how
// a red suite reads as green.
console.log(`\n${passed} checks passed${failed ? `, ${failed} FAILED` : ''}\n`);
