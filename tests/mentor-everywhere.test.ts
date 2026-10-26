// tests/mentor-everywhere.test.ts
// The Business Mentor beyond its own page (docs/business-mentor-plan.md §8.6, 2026-10-26):
//   - Ask Your Team (assistant-command.ts) sends business questions to the workspace's active Mentor,
//     with a "Talk to <Mentor> →" button that opens its chat with the question typed in, never sent.
//   - Every other assistant's chat may point the user at the Mentor for the wider picture, only when the
//     workspace has an active one, and never hands work to it.

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
const CMD = read('netlify/functions/assistant-command.ts');
const ORCH = read('netlify/functions/chat-orchestrator.ts');
const WS = read('workspace.html');

check('Ask Your Team: only an ACTIVE Mentor of this workspace, found by role', () => {
    assert.match(CMD, /const mentor = allAssistants\.find\(a => a\.roleKey === MENTOR_ROLE_KEY && a\.lifecycleStatus === 'working'\) \?\? null;/);
});

check('Ask Your Team: the routing rule exists only when there is a Mentor', () => {
    assert.match(CMD, /\$\{mentor \? `- Business advice/);
    assert.match(CMD, /Do not give the advice yourself/);
    assert.match(CMD, /"openMentor": <true\|false>/);
});

check('Ask Your Team: the button carries the Mentor the server found, never the model\'s id', () => {
    const at = CMD.indexOf('if (parsed.openMentor === true && mentor) {');
    assert.ok(at > 0);
    const block = CMD.slice(at, at + 300);
    assert.match(block, /out\.openAssistantId = mentor\.id;/);
    assert.match(block, /out\.draft = command;/);
});

check('the bar draws "Talk to <Mentor> →" and opens its chat with the question as a draft', () => {
    assert.match(WS, /if \(d\.openAssistantId && window\.openAssistantChat\) actions\.push\(\[`Talk to \$\{d\.openAssistantName \|\| 'your Mentor'\} →`, \(\) => window\.openAssistantChat\(\{ assistantId: d\.openAssistantId, draft: d\.draft \|\| '' \}\)\]\);/);
    assert.match(WS, /btn\.textContent = actions\[i\]\[0\];/, 'labels are text, so a name can\'t inject markup');
});

check('other assistants: a Mentor pointer only when the workspace has an active Mentor, never on its own route', () => {
    assert.match(ORCH, /const mentorPointerBlock = route === ROUTES\.business_mentor \? '' :/);
    const at = ORCH.indexOf('const mentorPointerBlock');
    const block = ORCH.slice(at, at + 1400);
    assert.match(block, /eq\(aiAssistants\.lifecycleStatus, 'working'\)/);
    assert.match(block, /Never pass work to it or say you have asked it/);
    assert.match(ORCH, /myAccountBlock, mentorPointerBlock, mentorNoPlanBlock\]\.filter\(Boolean\)/);
});

check('pricing: the Business Mentor row is in the SQL and the seed, ticked on every plan', () => {
    const sqlFile = read('db/z-business-mentor-plan-feature.sql');
    assert.match(sqlFile, /'business_mentor',\s*'Business Mentor'/);
    assert.match(sqlFile, /'Core Features — included on every plan'/);
    assert.match(sqlFile, /\|\| '\{"business_mentor": true\}'::jsonb/);
    const seed = read('db/seed-plan-features.ts');
    assert.match(seed, /key: 'business_mentor', label: 'Business Mentor'[\s\S]{0,400}values: \{ saver: CHECK, buster: CHECK, employee: CHECK \}/, 'a re-seed must keep it');
});

check('FAQ: three Mentor answers, and no claim the competitor check does not back', () => {
    const faq = read('faq.html');
    for (const q of ['What is the Business Mentor?', 'Does the Business Mentor cost extra or use my tasks?', 'What can the Business Mentor see?']) assert.ok(faq.includes(q), q);
    const at = faq.indexOf('<!-- Business Mentor (docs/business-mentor-plan.md');
    const block = faq.slice(at, faq.indexOf('What can the Business Mentor see?') + 1200);
    assert.doesNotMatch(block.replace(/<!--[\s\S]*?-->/g, ''), /\b(the first|first (platform|tool|AI|of its kind)|unique|disruptive|only platform|nobody else)\b/i);
});

console.log(`\n${passed} passed`);
