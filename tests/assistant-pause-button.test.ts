// tests/assistant-pause-button.test.ts
// The Profile drawer's "Pause Assistant" button (#btn-toggle-status) had a label but no click handler
// once the Kick-Off card's own pause button went (issue #115) — clicking it did nothing. It must be
// wired, pause through manage-assistant, and send Resume through the Kick-Off card (US4 AC4.4).
//
// Run:  npx tsx tests/assistant-pause-button.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

let passed = 0, total = 0;
function test(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

console.log('Assistant detail: Pause Assistant button');

const html = read('assistant-detail.html');
const js = read('assistants.js');

test('the button is on the page', () => {
    assert.ok(html.includes('id="btn-toggle-status"'));
});

test('assistants.js binds a click handler to it', () => {
    const at = js.indexOf("toggleStatusBtn.onclick = async");
    assert.ok(at !== -1, 'no onclick bound to #btn-toggle-status');
});

test('pause goes through manage-assistant; resume goes to the Kick-Off card', () => {
    const at = js.indexOf("toggleStatusBtn.onclick = async");
    assert.ok(at !== -1);
    const body = js.slice(at, at + 2500);
    assert.ok(body.includes("action: 'pause'"), 'does not send the pause action');
    assert.ok(body.includes('/.netlify/functions/manage-assistant'), 'does not call manage-assistant');
    assert.ok(body.includes("getElementById('kickoff-card')"), 'resume does not route to the Kick-Off card');
    assert.ok(!body.includes("action: 'resume'"), 'resume must not bypass the kick-off');
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
