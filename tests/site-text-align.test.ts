// tests/site-text-align.test.ts
// FR#11 (noticed by assistants twice, 2026-11-11): "centre the body text of a text section" — only the
// heading could be aligned (FR#8, tests/site-heading-align.test.ts). Now textAlign: left (default, not
// stored) | center | right, in the definition, on the page, in the Website tab's form and the chat's props.
// Run:  npx tsx tests/site-text-align.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanSection, normaliseSiteDefinition } from '../src/utils/site-definition';
import { renderSitePage } from '../src/utils/site-render';

let passed = 0;
function check(name: string, fn: () => void) { fn(); passed++; console.log(`  ✓ ${name}`); }
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const noWarn = () => {};
const ta = (raw: unknown) => (cleanSection('text', { heading: 'A', body: 'W', textAlign: raw }, noWarn)!.props as { textAlign?: string }).textAlign;

check('left is the default and is not stored; centre and right are; nonsense is dropped', () => {
    assert.ok(!('textAlign' in cleanSection('text', { heading: 'About', body: 'Words.' }, noWarn)!.props));
    assert.strictEqual(ta('left'), undefined);
    assert.strictEqual(ta('center'), 'center');
    assert.strictEqual(ta('centre'), 'center');
    assert.strictEqual(ta('right'), 'right');
    assert.strictEqual(ta('justify'), undefined);
});

check('heading and text align separately', () => {
    const p = cleanSection('text', { heading: 'A', body: 'W', headingAlign: 'right', textAlign: 'center' }, noWarn)!.props as unknown as Record<string, unknown>;
    assert.strictEqual(p.headingAlign, 'right');
    assert.strictEqual(p.textAlign, 'center');
});

check('the page wraps the body in the alignment class, with or without a picture; left adds nothing', () => {
    const def = normaliseSiteDefinition({
        settings: { siteName: 'Test' },
        pages: [{ title: 'Home', slug: '', sections: [
            { id: 't1', type: 'text', props: { heading: 'Plain', body: 'Plain words' } },
            { id: 't2', type: 'text', props: { heading: 'Mid', body: 'Centred words\n\n- one\n- two', textAlign: 'center' } },
            { id: 't3', type: 'text', props: { heading: 'Side', body: 'Right words', textAlign: 'right', headingAlign: 'right' } },
        ] }],
    }).definition;
    const html = renderSitePage(def, '/', { origin: 'https://x.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null } as never).html;
    assert.ok(/<\/h[12]><p>Plain words<\/p>/.test(html), 'left: no wrapper');
    assert.ok(/<\/h[12]><div class="ha-c"><p>Centred words<\/p><ul class="rt">/.test(html));
    assert.ok(/<h[12] class="ha-r">Side<\/h[12]><div class="ha-r"><p>Right words/.test(html));
    assert.ok(html.includes(':is(.ha-c,.ha-r)>:is(ul,ol){list-style-position:inside;padding-left:0}'), 'bullets stay beside centred lines');
});

check('wired: Website tab form and chat props', () => {
    assert.ok(read('src/components/assistant-site-editor.js').includes("{ k: 'textAlign', kind: 'select', label: 'Text'"));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('textAlign:"left|center|right" (where the body text sits'));
});

console.log(`\n${passed} passed, 0 failed\n`);
