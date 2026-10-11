// tests/onboarding-recommendations.test.ts
// "Recommended for you" in the setup guide must never block anything: it is a separate list, not
// steps, so it can never reopen the wizard over a live customer's work or hold up go-live.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const REC = read('src/utils/onboarding-recommendations.ts');
const PROGRESS = read('src/utils/onboarding-progress.ts');
const STATE = read('netlify/functions/get-wizard-state.ts');
const WS = read('workspace.html');

check('recommendations are not wizard steps — they cannot gate go-live', () => {
    assert.ok(!/onboarding-recommendations/.test(PROGRESS), 'computeOnboardingProgress must not fold them into steps');
    assert.match(STATE, /recommended,/);
});
check('a failure to compute them never breaks the wizard', () => {
    assert.match(STATE, /try \{ recommended = await computeRecommendations/);
    assert.match(REC, /async function soft/);
});
check('they are tailored to the hired roles', () => {
    for (const role of ['lead_qualifier', 'newsletter_editor', 'blog_writer']) assert.ok(REC.includes(`'${role}'`), role);
});
check('the mailbox tick reads workspace_integrations, where Gmail and Outlook are stored', () => {
    assert.match(REC, /workspaceIntegrations\.provider, \['gmail', 'outlook'\]/);
});
check('the drawer renders them on the in-progress list AND the live screen', () => {
    assert.strictEqual((WS.match(/wireRecommended\(data\);/g) || []).length, 2);
});
console.log(`\n${passed} checks passed.`);
