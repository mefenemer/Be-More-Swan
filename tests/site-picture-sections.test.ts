// tests/site-picture-sections.test.ts
// FR#9 / issue 34 (org 41, 2026-11-10): pictures for several website sections at once. One site_picture
// card may carry `sections`; the server tidies it (site-picture-card.ts) and the chat shows a picker each.
// Run:  npx tsx tests/site-picture-sections.test.ts

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { normaliseSitePictureCard, MAX_PICTURE_SECTIONS } from '../src/utils/site-picture-card';

let passed = 0;
function check(name: string, fn: () => void) { fn(); passed++; console.log(`  ✓ ${name}`); }
const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const sec = (id: string, extra: Record<string, unknown> = {}) => ({ pageId: 'home', sectionId: id, sectionLabel: `S ${id}`, place: 'in', description: '', alt: `A ${id}`, ...extra });

check('one section stays the plain card, as before', () => {
    const out = normaliseSitePictureCard({ type: 'site_picture', ...sec('a'), source: 'stock' });
    assert.deepStrictEqual(out, { type: 'site_picture', kind: 'picture', source: 'stock', ...sec('a') });
});

check('several: the first on top, all in sections, deduped, top-level repeat counted once', () => {
    const out = normaliseSitePictureCard({ type: 'site_picture', ...sec('a'), sections: [sec('a'), sec('b', { place: 'after', description: 'a team photo' }), sec('b'), { pageId: '', sectionId: 'x' }, 'junk'] })!;
    assert.strictEqual(out.sectionId, 'a');
    const list = out.sections as { sectionId: string; place: string; description: string }[];
    assert.deepStrictEqual(list.map((s) => s.sectionId), ['a', 'b']);
    assert.strictEqual(list[1].place, 'after');
    assert.strictEqual(list[1].description, 'a team photo');
});

check('sections only (no top-level section) still works; capped', () => {
    const many = Array.from({ length: 10 }, (_, i) => sec(`s${i}`));
    const out = normaliseSitePictureCard({ type: 'site_picture', source: 'ai', sections: many })!;
    assert.strictEqual(out.sectionId, 's0');
    assert.strictEqual((out.sections as unknown[]).length, MAX_PICTURE_SECTIONS);
});

check('nothing usable → null; other cards untouched', () => {
    assert.strictEqual(normaliseSitePictureCard({ type: 'site_picture', sections: [] }), null);
    const other = { type: 'site_changes', ops: [] };
    assert.strictEqual(normaliseSitePictureCard(other), other);
});

check('wired: prompt, server, card', () => {
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(orch.includes('SEVERAL SECTIONS AT ONCE') && orch.includes('uiElement = normaliseSitePictureCard(uiElement)'));
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.ok(reg.includes('data-sp-multi') && reg.includes('Array.isArray(ui.sections) && ui.sections.length > 1'));
});

console.log(`\n${passed} passed, 0 failed\n`);
