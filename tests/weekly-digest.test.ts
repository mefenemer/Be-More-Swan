// tests/weekly-digest.test.ts
// The weekly digest (netlify/functions/weekly-digest.ts) has never run in production. Its first
// version would have emailed only the plan's purchaser, counted different numbers from the
// dashboard it links to, and compared a raw task_runs count against the task cap. These checks pin
// the corrected shape so it cannot drift back before anyone schedules it.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATE_DEFAULTS } from '../src/utils/email-templates-catalog';
import { EMAIL_VARIABLES, validateMergeVars, renderMergeVars } from '../src/utils/email-template';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const src = read('netlify/functions/weekly-digest.ts');
// Strip comments so prose explaining the old bug cannot satisfy or trip a code assertion.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const template = TEMPLATE_DEFAULTS.find(t => t.triggerKey === 'weekly_digest');

check('recipients come from org membership, not the plan purchaser', () => {
    assert.ok(!/eq\(plans\.userId/.test(code), 'must not join plans.userId — plan rows are org-scoped');
    assert.ok(code.includes('userOrganisations.organisationId'), 'recipients must be resolved per org');
    assert.ok(code.includes('DIGEST_ROLES'), 'recipients must be filtered by role');
});

check('activity is counted through roi-activity.ts, the dashboard\'s own definition', () => {
    assert.ok(code.includes('countRoiActivity('), 'must call countRoiActivity');
    assert.ok(code.includes('activeAssistantIds('), 'archived assistants must be excluded the same way');
    assert.ok(!/from\(taskRuns\)/.test(code), 'must not count task_runs directly');
    assert.ok(code.includes('activity.degraded'), 'a degraded count must not be emailed');
});

check('tasks used is read from usage_counters, the counter the cap enforces', () => {
    assert.ok(code.includes('usage_counters'), 'must read usage_counters');
    assert.ok(code.includes('resolveTaskLimit('), 'must resolve the limit the same way the cap does');
});

check('opt-out honours the category toggle and the legacy weekly_digest key', () => {
    assert.ok(code.includes("isEmailEnabled(prefs, 'assistant_task')"));
    assert.ok(code.includes('prefs.weekly_digest !== false'));
});

check('the email renders through the admin-editable weekly_digest template', () => {
    assert.ok(code.includes("triggerKey: 'weekly_digest'"));
    assert.ok(!code.includes('sendEmail('), 'no hand-built HTML bypassing the template shell');
});

check('every merge tag in the default template is a known variable', () => {
    assert.ok(template, 'weekly_digest default exists');
    const keys = EMAIL_VARIABLES.map(v => v.key);
    for (const text of [template!.subject, template!.bodyHtml]) {
        const v = validateMergeVars(text, keys);
        assert.deepStrictEqual(v.unknown, [], `unknown tags: ${v.unknown.join(', ')}`);
        assert.deepStrictEqual(v.malformed, [], `malformed tags: ${v.malformed.join(', ')}`);
    }
});

check('the function supplies every digest.* tag the template uses', () => {
    const used = [...template!.bodyHtml.matchAll(/\{\{\s*digest\.([a-z_]+)/g)].map(m => m[1]);
    assert.ok(used.length > 0, 'template shows the figures');
    for (const k of used) assert.ok(new RegExp(`\\b${k}:`).test(code), `function must set digest.${k}`);
    const rendered = renderMergeVars(template!.bodyHtml, {
        digest: { tasks_handled: '3', hours_saved: '1.5', tasks_used: '10', task_allowance: '500' },
    });
    assert.ok(!/\{\{/.test(rendered), 'no tag left unrendered');
});

console.log(`\nweekly-digest: ${passed} passed`);
