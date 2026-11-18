// tests/linkedin-page-copy-and-label.test.ts
// After Company Page posting was proven on staging (2026-11-18):
//   1. The LinkedIn setup note no longer says Community Management access "has not been granted"; it names
//      Company Pages only where page posting is switched on (_linkedinPages).
//   2. The Blog Writer's LinkedIn card names the account the connection posts as NOW — a Company Page shows
//      its page name instead of the person saved when the card was switched on.
//
// Run:  npx tsx tests/linkedin-page-copy-and-label.test.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { socialAccountLabel } from '../src/utils/blog-destinations/store';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

check('a Company Page connection is labelled with its page name', () => {
    assert.equal(socialAccountLabel({ externalUserId: 'urn:li:organization:13506392', metadata: { linkedinPageName: 'Be More Swan' } }), 'Be More Swan (Company Page)');
    assert.equal(socialAccountLabel({ externalUserId: 'urn:li:organization:1', metadata: null }), 'Company Page (Company Page)');
    assert.equal(socialAccountLabel({ externalUserId: 'urn:li:organization:1', metadata: { linkedinPageName: '  ' } }), 'Company Page (Company Page)');
});

check('a personal-profile connection falls back to the saved label (it stores no name)', () => {
    assert.equal(socialAccountLabel({ externalUserId: 'pyv9R04pSC', metadata: {} }), null);
    assert.equal(socialAccountLabel({ externalUserId: null }), null);
});

check('the list uses the live label before the saved one', () => {
    const src = readFileSync('src/utils/blog-destinations/store.ts', 'utf8');
    assert.ok(src.includes('liveLabel.set(row.serviceName, socialAccountLabel(row));'));
    assert.ok(src.includes('accountLabel: connected ? (liveLabel.get(adapter.socialPlatform) ?? prefs.labels?.[id] ?? null) : null,'));
});

check('the LinkedIn note: no "not granted" claim; Company Pages only where page posting is on', () => {
    const js = readFileSync('integrations.js', 'utf8');
    assert.ok(!js.includes('which we have not been granted yet'));
    assert.ok(js.includes("note: 'Posts are published to your personal LinkedIn feed.',"));
    assert.ok(js.includes("notePages: 'Posts go to your personal LinkedIn feed, or to a Company Page you’re an admin of — you choose which when you connect. A Company Page also brings each post’s results and its comments back here, so you can reply as the Page.',"));
    assert.ok(js.includes('return (_linkedinPages && platform && platform.notePages) || (platform && platform.note) || \'\';'));
    assert.ok(js.includes('const note = _platformNote(platform);'));
});

console.log(`\n${passed} passed`);
