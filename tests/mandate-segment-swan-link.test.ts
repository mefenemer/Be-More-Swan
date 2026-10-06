// tests/mandate-segment-swan-link.test.ts
// Three user asks from 2026-10-06, each a quiet regression if undone:
//   · every assistant's setup asks its Mandate and saves it where Profile ▸ Mandate reads it
//     (onboardingContext.problem_statement) — only the Social Media wizard used to ask it
//   · the email's "Send to" picker can create a segment in place instead of sending the user to
//     the Audience view and back
//   · the swan's "Suggest …" is swan + pink words, not a pink pill the pink swan disappears into
//
// Source scans. Run:  npx tsx tests/mandate-segment-swan-link.test.ts

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
const read = (f: string) => readFileSync(join(root, f), 'utf8');

const shell = read('src/components/assistant-onboarding-shell.js');
const setup = read('assistant-setup.html');
const detail = read('assistant-detail.html');

check('the setup shell asks the Mandate for every role, under the key the profile reads', () => {
    assert.match(shell, /const MANDATE_KEY = 'problem_statement';/);
    assert.match(detail, /id="edit_problem"/, 'Profile ▸ Mandate field moved');
    assert.match(read('assistants.js'), /_detailSetVal\('edit_problem', ctx\.problem_statement/, 'the profile no longer reads problem_statement');
    // Injected by the shell, not per-schema: schema fields also render under Operational Setup.
    assert.match(shell, /if \(props\.askMandate !== false && !schemaAsksMandate\) \{\s*steps\.splice\(/);
    assert.match(shell, /key: MANDATE_KEY,\s*type: 'mandate',/);
    assert.match(shell, /required: true,\s*requiredMessage: 'Please describe the bottleneck/);
});

check('no per-role schema asks it a second time', () => {
    assert.doesNotMatch(read('src/public/assistant-onboarding-schemas.js'), /key: 'problem_statement'/);
});

check('the Mandate step offers the role\'s quick-start chips, and setup loads them', () => {
    assert.match(shell, /case 'mandate': \{[\s\S]*?window\.MandateSuggestions/);
    assert.match(shell, /data-aos-mandate-chip/);
    assert.ok(setup.indexOf('/src/public/mandate-suggestions.js') >= 0, 'assistant-setup.html does not load mandate-suggestions.js');
    assert.ok(setup.indexOf('/src/public/mandate-suggestions.js') < setup.indexOf('/src/components/assistant-onboarding-shell.js'));
});

check('every schema-driven role has its own Mandate suggestions (not the social fallback)', () => {
    const schemas = read('src/public/assistant-onboarding-schemas.js');
    const suggestions = read('src/public/mandate-suggestions.js');
    const roles = [...schemas.matchAll(/^ {4}([a-z0-9_]+): \[/gm)].map((m) => m[1]);
    assert.ok(roles.length >= 8, `only found ${roles.length} roles`);
    for (const r of roles) assert.match(suggestions, new RegExp(`^ {4}${r}: \\[`, 'm'), `${r} has no Mandate suggestions`);
});

check('"Send to" offers "Create a new segment" and never saves the sentinel', () => {
    const nl = read('newsletter.js');
    assert.match(nl, /const NEW_SEGMENT = '__new_segment';/);
    assert.match(nl, /<option value="\$\{NEW_SEGMENT\}">\+ Create a new segment…<\/option>/);
    // The old choice is restored BEFORE the builder opens, so cancelling changes nothing.
    assert.match(nl, /if \(sel\.value === NEW_SEGMENT\) \{[\s\S]*?sel\.value = sel\.dataset\.prev \|\| '';[\s\S]*?AudienceSegmentBuilder\.open\(/);
});

check('the builder is the Audience view\'s own, injected and removed when opened elsewhere', () => {
    const aud = read('audience.js');
    assert.match(aud, /window\.AudienceSegmentBuilder = \{/);
    assert.match(aud, /data-aud-rule-injected/);
    assert.match(aud, /if \(modal\.hasAttribute\('data-aud-rule-injected'\)\) modal\.remove\(\);/);
    assert.doesNotMatch(aud, /hide\(\$\('aud-rule-modal'\)\)/, 'a close path bypasses closeRuleModal and leaves the injected copy behind');
});

check('the swan\'s "Suggest …" controls are swan + pink text, not a pink pill', () => {
    const css = read('style.css');
    assert.match(css, /\.btn-swan-link \{ background-color: transparent; color: #d6006b;/);
    assert.match(read('input.css'), /\.btn-swan-link \{ background-color: transparent; color: #d6006b;/);
    assert.match(detail, /id="btn-generate-name"[^>]*class="btn-swan-link /);
    assert.match(detail, /id="btn-goal-rationale-ai"[\s\S]{0,200}class="btn-swan-link /);
    assert.match(shell, /data-aos-suggest-name class="btn-swan-link aos-swan-btn"/);
    assert.doesNotMatch(detail + shell, /class="btn-assistant[^"]*"[^>]*>\s*<img src="[^"]*SwanAI[^"]*"[^>]*>\s*(Suggest|Ask )/);
});

console.log(`\n${passed} checks passed`);
