// tests/admin-feature-flag-edit.test.ts
// Admin → Feature flags: the Edit button must open the editor for every flag (2026-11-13).
//
// The button carried JSON.stringify'd lists ("[]", "[\"buster\"]") inside a double-quoted onclick
// attribute. The first " ended the attribute, so clicking Edit threw a syntax error and did nothing —
// for EVERY flag, tiers or not. This builds the attribute exactly as admin.html does, decodes it the way
// a browser does, and runs it.
//
// Run:  npx tsx tests/admin-feature-flag-edit.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'admin.html'), 'utf8');

// The page's own escaper and the button's template line, taken from admin.html.
const escLine = html.match(/^function escapeHtmlJs\(s\) \{[^\n]*\}$/m)?.[0];
const btnLine = html.match(/^\s*<button onclick="openFlagEditor\([^\n]*$/m)?.[0];

check('admin.html still has the escaper and the Edit button', () => {
    assert.ok(escLine, 'escapeHtmlJs not found');
    assert.ok(btnLine, 'Edit button not found');
});

type Flag = { key: string; enabled: boolean; rolloutPercentage: number; allowedTiers: string[] | null; allowedWorkspaceIds: number[] | null };

/** The onclick attribute's raw text, as the template renders it. */
function renderOnclick(f: Flag): string {
    const tpl = btnLine!.trim().replace(/^<button onclick="/, '').replace(/"\s*$/, '');
    const build = new Function('f', 'escapeHtmlJs', `return \`${tpl}\`;`) as (f: Flag, e: (s: unknown) => string) => string;
    const escapeHtmlJs = new Function(`${escLine}; return escapeHtmlJs;`)() as (s: unknown) => string;
    return build(f, escapeHtmlJs);
}

/** What a browser hands the handler: the attribute value up to the first unescaped ", entities decoded. */
function browserReads(attr: string): string {
    const cut = attr.split('"')[0];
    return cut.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

for (const f of [
    { key: 'email_assistant', enabled: false, rolloutPercentage: 0, allowedTiers: [], allowedWorkspaceIds: [58] },
    { key: 'business_mentor', enabled: true, rolloutPercentage: 25, allowedTiers: ['buster', 'saver'], allowedWorkspaceIds: [1, 2, 3] },
    { key: 'odd', enabled: false, rolloutPercentage: 0, allowedTiers: null, allowedWorkspaceIds: null },
] as Flag[]) {
    check(`Edit opens "${f.key}" with its own values`, () => {
        const attr = renderOnclick(f);
        assert.ok(!attr.includes('"'), `an unescaped " would end the attribute: ${attr}`);
        const js = browserReads(attr);
        let got: unknown[] | null = null;
        new Function('openFlagEditor', js)((...args: unknown[]) => { got = args; });
        assert.ok(got, 'handler never ran');
        const [key, enabled, rollout, tiersJson, vipsJson] = got as unknown as [string, boolean, number, string, string];
        assert.strictEqual(key, f.key);
        assert.strictEqual(enabled, f.enabled);
        assert.strictEqual(rollout, f.rolloutPercentage);
        assert.deepStrictEqual(JSON.parse(tiersJson), f.allowedTiers ?? []);
        assert.deepStrictEqual(JSON.parse(vipsJson), f.allowedWorkspaceIds ?? []);
    });
}

console.log(`\n${passed} checks passed${process.exitCode ? ' — with FAILURES above' : ''}`);
