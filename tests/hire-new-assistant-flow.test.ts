// tests/hire-new-assistant-flow.test.ts
// "Hire a New Assistant": the set-up wizard stays out of the way until a role is picked, the
// catalogue puts what can be hired first and shows hired roles as hired, and the server keeps one
// assistant per role on every hire path.
//
// Run:  npx tsx tests/hire-new-assistant-flow.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const workspace = read('workspace.html');
const catalogue = read('assistant-catalogue.html');

console.log('\nHire a New Assistant');

check('the wizard does NOT open when Hire a New Assistant is clicked — only once a role is picked', () => {
    const at = workspace.indexOf('async function openForNewAssistant()');
    const fn = workspace.slice(at, workspace.indexOf('\n  }\n', at));
    assert.ok(at > -1);
    assert.ok(!/\bopen\(\);/.test(fn), 'openForNewAssistant must not open the drawer');
    assert.match(fn, /sessionStorage\.setItem\(AWAIT_PICK_KEY, '1'\)/);
    assert.match(workspace, /if \(isAwaitingPick\(\)\) \{ setOpen\(false\); showFab\(false\); return; \}/);
    assert.match(catalogue, /window\.SetupWizard\?\.onAssistantPicked\?\.\(\);/);
});

check('leaving the catalogue without picking drops the add-assistant journey', () => {
    assert.match(workspace, /if \(isAwaitingPick\(\) && routeKey && routeKey !== 'catalog'\) \{\s*clearAddMode\(\);/);
});

check('the catalogue groups Available to hire / Already on your team / Coming soon, and says when none can be hired', () => {
    for (const h of ["heading('Available to hire', true)", "heading('Already on your team')", "heading('Coming soon')"]) assert.ok(catalogue.includes(h), h);
    assert.ok(catalogue.includes('There are no new assistants to hire right now'));
    assert.match(catalogue, /if \(_catHired\[roleKey\]\) \{ window\._catOpenHired\(roleKey\); return; \}/);
});

check('one assistant per role on the Social Media path too (hire-assistant already did this)', () => {
    const src = read('netlify/functions/onboarding.ts');
    assert.match(src, /code: 'ALREADY_HIRED'/);
    assert.match(read('netlify/functions/hire-assistant.ts'), /alreadyHired: true/);
});

check('My Account no longer has a "Resume setup guide" link', () => {
    assert.ok(!read('user-settings.html').includes('Resume setup guide'));
    assert.ok(!workspace.includes("getElementById('resume-wizard-btn')"));
});

console.log(`\n${passed}/${total} passed`);
