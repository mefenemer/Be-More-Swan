// tests/workspace-review-fixes.test.ts
// Small fixes from the 2026-10-22 UI/UX review of Dashboard, My Assistants and Audience: a dead
// "Set rate" link, a hire button missing on phones, a Dashboard poll that outlived the page,
// unescaped assistant names on the card, and an Audience list held behind three requests.
//
// Run:  npx tsx tests/workspace-review-fixes.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const cards = read('assistants.js');
const dir = read('assistants-directory.html');
const dash = read('dashboard-content.html');
const aud = read('audience.js');

check('"Set rate → ROI" goes to a route that exists', () => {
    assert.ok(!cards.includes("loadView('account')"), 'there is no `account` route; loadView ignores it');
    assert.ok(/loadView\('settings'\)" title="Set your hourly rate to see financial ROI">Set rate → ROI<\/button>/.test(cards));
});

check('the card escapes the assistant name and role, and the chat button reads them from data attributes', () => {
    assert.ok(cards.includes("${_escapeHtml(assistant.name || '')}</h3>"));
    assert.ok(cards.includes('${_escapeHtml(role)}</p>'));
    assert.ok(cards.includes('data-chat-name="${_escapeHtml(assistant.name'), 'name travels as an attribute');
    assert.ok(!cards.includes("(assistant.name || 'Your assistant').replace(/'/g, '&#39;')"), '&#39; decodes back to \' before the JS runs');
});

check('keyboard users can open an assistant and follow Dashboard widget links', () => {
    assert.ok(/<button type="button" class="link text-sm font-bold"[^>]*>View Details &rarr;<\/button>/.test(cards));
    assert.ok(!dash.includes('<span class="dw-link">'), 'widget links are buttons, not spans');
    assert.ok(dash.includes('<button type="button" class="dw-link">Manage assistants →</button>'));
});

check('"Hire New Assistant" shows at phone width', () => {
    const btn = dir.slice(dir.indexOf('<button id="route-to-catalog-from-dir"'));
    assert.ok(btn.length > 0, 'button marker missing');
    const cls = (btn.match(/class="([^"]*)"/) || [])[1] || '';
    assert.ok(!/(^|\s)hidden(\s|$)/.test(cls), 'no `hidden` at the smallest width');
});

check('the Dashboard notifications poll stops when the Dashboard leaves the page', () => {
    assert.ok(dash.includes('clearInterval(window._dashNotificationsPoll);\n    window._dashNotificationsPoll = setInterval('));
    assert.ok(dash.includes('if (!grid.isConnected) { clearInterval(window._dashNotificationsPoll); return; }'));
});

check('Audience loads segments and API keys alongside the list, not ahead of it', () => {
    const i = aud.indexOf('const sidebar = Promise.all([loadSegments(), loadApiKeys()]);');
    assert.ok(i > 0, 'sidebar loads start together');
    const fields = aud.indexOf('await loadCustomFields();', i);
    const contacts = aud.indexOf('await loadContacts();', i);
    assert.ok(fields > i && contacts > fields, 'custom fields (the columns) still come before the rows');
    assert.ok(!aud.includes('await loadApiKeys();\n    await loadSegments();'));
});

check('every Audience overlay is a dialogs.js page dialog, with a close control Escape can press', () => {
    const html = read('audience.html');
    // Each overlay's markup runs from its own opening tag to the next overlay's.
    const starts = [...html.matchAll(/<div id="(aud-[a-z-]+)" data-dialog/g)];
    assert.deepStrictEqual(starts.map((m) => m[1]).sort(),
        ['aud-add-modal', 'aud-detail', 'aud-export-modal', 'aud-import-modal', 'aud-rule-modal']);
    starts.forEach((m, k) => {
        const body = html.slice(m.index, starts[k + 1]?.index);
        assert.ok(body.includes('data-dialog-cancel'), `${m[1]} has a data-dialog-cancel control`);
    });
    assert.ok(html.includes('<div id="aud-detail" data-dialog aria-labelledby="aud-detail-title"'), 'the slide-over has no heading; name it from its title');
    const icons = html.match(/<button type="button" data-aud-(?:rule-)?close data-dialog-cancel[^>]*>/g) || [];
    assert.strictEqual(icons.length, 2, 'both × buttons found');
    for (const b of icons) assert.ok(b.includes('aria-label="Close"'), b);
});

check('the Add-contact, import and segment-builder fields have real labels', () => {
    const html = read('audience.html');
    for (const id of ['aud-add-email', 'aud-add-first', 'aud-add-last', 'aud-add-company', 'aud-add-segment', 'aud-import-file', 'aud-import-segment']) {
        assert.ok(html.includes(`<label for="${id}"`), `${id} has a <label for>`);
    }
    assert.ok(aud.includes('<label for="aud-rule-name"') && aud.includes('<label for="aud-rule-match"'));
    for (const attr of ['data-rule-field', 'data-rule-op', 'data-rule-key']) {
        assert.ok(new RegExp(`<select ${attr}="\\$\\{i\\}" aria-label="Condition`).test(aud), `${attr} is named`);
    }
    const values = aud.match(/data-rule-value="\$\{i\}"[^>]*>/g) || [];
    assert.ok(values.length >= 6, 'every value control found');
    for (const v of values) assert.ok(v.includes('aria-label="Condition'), v);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — with FAILURES above' : ''}`);
