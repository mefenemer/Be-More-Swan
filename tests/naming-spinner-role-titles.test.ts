// tests/naming-spinner-role-titles.test.ts
// Reported 2026-10-02: (1) only the Social Media wizard asked the user to name their assistant;
// (2/3) "busy" was a mouse cursor, not the pink spinner; (4/5) the detail page's name and swan
// didn't look clickable; (6) the Brand Protected pill; (8) chat called itself "Social Media
// Manager" — a role title that should come from master_assistants.name everywhere.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const SHELL = read('src/components/assistant-onboarding-shell.js');
const SETUP = read('assistant-setup.html');
const DIALOGS = read('dialogs.js');
const W = read('workspace.html');
const DETAIL = read('assistant-detail.html');

console.log('\n──── every setup wizard names the assistant ────');

check('the shell opens with a naming step unless told not to', () => {
    assert.match(SHELL, /if \(props\.askName !== false\) \{[\s\S]{0,200}steps\.unshift\(\{\s*title: 'Name your assistant'/);
    assert.match(SHELL, /type: 'assistant_name'/);
});

check('the swan suggests names for THIS role, with a local fallback', () => {
    assert.match(SHELL, /data-aos-suggest-name/);
    assert.match(SHELL, /BeMoreSwan_SwanAI\.png/);
    assert.match(SHELL, /role: roleLabel \|\| 'Digital Assistant'/);
    assert.match(SHELL, /FALLBACK_NAMES\[/);
});

check('the name is saved as newName, never into onboardingContext', () => {
    const save = SHELL.slice(landmark(SHELL, 'async function completeSetup()'), landmark(SHELL, 'let checkingName = false;'));
    assert.match(save, /const \{ \[NAME_KEY\]: chosenName, \.\.\.contextAnswers \} = answers;/);
    assert.match(save, /newContext: \{ \.\.\.contextAnswers,/);
    assert.match(save, /\{ newName \}/);
});

check('a taken name is caught before leaving the step, and by the server', () => {
    assert.match(SHELL, /CHECK_NAME_URL/);
    assert.match(read('netlify/functions/update-assistant-context.ts'), /code: 'NAME_TAKEN'/);
});

check('the setup page passes the live role title and the instance\'s own name', () => {
    assert.match(SETUP, /roleLabel: hire\.roleName \|\| hire\.name/);
    const hire = read('netlify/functions/hire-assistant.ts');
    assert.match(hire, /name: existing\.name \|\| master\.name, roleName: master\.name/);
});

console.log('\n──── busy is the pink spinner, not a cursor ────');

check('dialogs.js owns one refcounted, debounced spinner', () => {
    assert.match(DIALOGS, /window\.bmsBusy = function \(on\)/);
    assert.match(DIALOGS, /depth = Math\.max\(0, depth \+ \(on \? 1 : -1\)\)/);
    assert.match(DIALOGS, /border-top-color:#ff007f/);
    assert.match(DIALOGS, /pointer-events:none/);
});

check('no wait/progress cursor is left as the busy signal', () => {
    assert.doesNotMatch(W, /cursor: wait !important/);
    assert.doesNotMatch(read('src/components/chat-session.js'), /cursor = 'progress'/);
    assert.doesNotMatch(read('src/components/blog-studio-modal.js'), /cursor:progress/);
    assert.match(W, /window\.setBusyCursor = function \(on\) \{ window\.bmsBusy\?\.\(on\); \};/);
});

check('every view navigation shows the spinner and always clears it', () => {
    const lv = W.slice(landmark(W, 'async function loadView(routeKey, param = null) {'), landmark(W, 'async function _loadViewInner('));
    assert.match(lv, /window\.bmsBusy\?\.\(true\);\s*try \{ return await _loadViewInner\(routeKey, param\); \}\s*finally \{ window\.bmsBusy\?\.\(false\); \}/);
});

check('"Loading…" placeholders get the spinner automatically', () => {
    assert.match(DIALOGS, /var LOADING_RE = /);
    assert.match(DIALOGS, /new MutationObserver/);
    // never inside a control — a button's "Checking…" or an <option>
    assert.match(DIALOGS, /OPTION: 1, SELECT: 1, BUTTON: 1/);
});

console.log('\n──── the detail header ────');

check('the name looks editable and the swan says what it does', () => {
    assert.match(DETAIL, /title="Click to rename your assistant"/);
    assert.match(DETAIL, /class="detail-name-edit"/);
    assert.match(DETAIL, /#detail-name-input \{ border-bottom: 2px dashed/);
    assert.match(DETAIL, /class="ai-wand-img"> Suggest a name/);
});

check('the Brand Protected pill is gone', () => {
    assert.doesNotMatch(DETAIL, /Brand Protected/);
    assert.doesNotMatch(read('assistants.js'), /_updateGuardrailsBadge/);
});

console.log('\n──── role titles come from master data ────');

check('chat reads the live role title, not the hire-time snapshot', () => {
    const chat = read('netlify/functions/chat-orchestrator.ts');
    assert.doesNotMatch(chat, /jobRole: aiAssistants\.aiAssistantJobRole/);
    assert.match(chat, /jobRole: liveRoleLabel/);
    assert.match(read('src/utils/live-role-label.ts'), /coalesce\(\(select ma\.name from master_assistants ma where ma\.id = \$\{aiAssistants\.masterAssistantId\}\), \$\{aiAssistants\.aiAssistantJobRole\}\)/);
});

check('prompt and display reads of the role all go through liveRoleLabel', () => {
    for (const f of ['assistant-command', 'get-time-saved', 'autonomous-goal-optimizer', 'kickoff-assistant', 'get-assistant-readiness', 'goal-ai', 'notifications']) {
        assert.doesNotMatch(read(`netlify/functions/${f}.ts`), /(role|jobRole): aiAssistants\.aiAssistantJobRole/, `${f} still reads the stale snapshot`);
    }
});

check('client copy names roles through RoleLabels, not literals', () => {
    assert.doesNotMatch(read('integrations.html'), /Social Media Manager|Blog Writer|Lead Generator/);
    assert.doesNotMatch(read('src/components/assistant-welcome-messages.js'), /role: 'your (Social Media Manager|Blog Writer|Lead Qualifier|Campaign Orchestrator)'/);
    assert.doesNotMatch(read('onboarding-social-media.html'), /const role = "Social Media Manager"/);
    assert.match(read('src/public/role-labels.js'), /fetch\('\/\.netlify\/functions\/master-assistants'/);
});

console.log(`\n${passed} checks passed`);
