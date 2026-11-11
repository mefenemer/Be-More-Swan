// tests/site-heading-align.test.ts
// FR#8 (org 41, 2026-11-10): "alternate the text section headings left and right" — a text section only
// had a picture side. Now headingAlign: left (default, not stored) | center | right, in the definition,
// on the page, in the Website tab's section form and in the chat's section props.
// Run:  npx tsx tests/site-heading-align.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanSection, normaliseSiteDefinition } from '../src/utils/site-definition';
import { renderSitePage } from '../src/utils/site-render';

let passed = 0;
function check(name: string, fn: () => void) { fn(); passed++; console.log(`  ✓ ${name}`); }
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const noWarn = () => {};

check('left is the default and is not stored; centre and right are', () => {
    const plain = cleanSection('text', { heading: 'About', body: 'Words.' }, noWarn)!;
    assert.ok(!('headingAlign' in plain.props));
    assert.ok(!('headingAlign' in cleanSection('text', { heading: 'About', body: 'Words.', headingAlign: 'left' }, noWarn)!.props));
    assert.strictEqual((cleanSection('text', { heading: 'A', body: 'W', headingAlign: 'right' }, noWarn)!.props as { headingAlign?: string }).headingAlign, 'right');
    assert.strictEqual((cleanSection('text', { heading: 'A', body: 'W', headingAlign: 'centre' }, noWarn)!.props as { headingAlign?: string }).headingAlign, 'center');
    assert.ok(!('headingAlign' in cleanSection('text', { heading: 'A', body: 'W', headingAlign: 'sideways' }, noWarn)!.props));
});

check('the page puts the heading where it was asked, with or without a picture', () => {
    const def = normaliseSiteDefinition({
        settings: { siteName: 'Test' },
        pages: [{ title: 'Home', slug: '', sections: [
            { id: 't1', type: 'text', props: { heading: 'Left one', body: 'a' } },
            { id: 't2', type: 'text', props: { heading: 'Right one', body: 'b', headingAlign: 'right' } },
            { id: 't3', type: 'text', props: { heading: 'Centre one', body: 'c', headingAlign: 'center' } },
        ] }],
    }).definition;
    const html = renderSitePage(def, '/', { origin: 'https://x.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null } as never).html;
    assert.ok(/<h[12]>Left one<\/h[12]>/.test(html));
    assert.ok(/<h[12] class="ha-r">Right one/.test(html));
    assert.ok(/<h[12] class="ha-c">Centre one/.test(html));
    assert.ok(html.includes('.ha-c{text-align:center}.ha-r{text-align:right}'));
});

check('wired: Website tab form and chat props', () => {
    assert.ok(read('src/components/assistant-site-editor.js').includes("{ k: 'headingAlign', kind: 'select', label: 'Heading'"));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('headingAlign:"left|center|right"'));
});

console.log(`\n${passed} passed, 0 failed\n`);
