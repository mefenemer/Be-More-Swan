// tests/detail-autosave-role-fields.test.ts
// The assistant settings page saves the whole onboarding_context in one PUT (update-assistant-context).
// It used to write every Social Media field for every role. Renaming the test Shopkeeper on staging
// (2026-11-16) sent posting_frequency "3 times a week", Mon–Fri posting days, 09:00, platform_strategy,
// publishPolicy, strategyAgentEnabled, trigger_type… into a role that posts nothing. It also sent
// disclosureText '' on every save, which the server refuses on an active assistant with none stored
// (422 DISCLOSURE_MISSING), so the rename failed.
//
// Now each field is written only when its card shows for the role (registry profileKeysOff, the same
// flags that show the cards), and the disclosure is sent only when it changed.
//
// Run:  npx tsx tests/detail-autosave-role-fields.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const REG_SRC = read('src/components/assistant-dashboard-registry.js');
const APP = read('assistants.js');
const PAGE = read('assistant-detail.html');

type Registry = {
    get: (k: string) => { modules?: Record<string, unknown>; strategyTab?: unknown };
    REGISTRY: Record<string, unknown>;
    PROFILE_FIELD_GROUPS: { card: string; keys: string[] }[];
    profileKeysOff: (k: string) => string[];
};
const regSandbox: { window: { AssistantDashboardRegistry?: Registry }; document: unknown } = { window: {}, document: { getElementById: () => null } };
vm.runInNewContext(REG_SRC, regSandbox);
const REG = regSandbox.window.AssistantDashboardRegistry!;

const SOCIAL_KEYS = ['posting_frequency', 'posting_days', 'posting_times', 'posting_timezone', 'platform_strategy', 'publishPolicy', 'allowAiMediaAutoPublish', 'strategyAgentEnabled'];

console.log('\nWhich fields belong to which card');

check('a Shopkeeper writes none of the Social Media fields or the creative brief', () => {
    const off = REG.profileKeysOff('shopkeeper');
    for (const k of [...SOCIAL_KEYS, 'primary_objective', 'core_message', 'cta', 'incentive', 'target_audience', 'tone_of_voice', 'reference_style_url', 'sales_objections']) {
        assert.ok(off.includes(k), `${k} should be off for the Shopkeeper`);
    }
});

check('the Social Media Manager (and any unknown role) keeps every card it shows', () => {
    // Only the Strategy Proposals switch is off: that card belongs to roles with a Strategy tab.
    assert.deepStrictEqual([...REG.profileKeysOff('social_media_manager')], ['strategyAgentEnabled']);
    assert.deepStrictEqual([...REG.profileKeysOff('a_role_from_tomorrow')], ['strategyAgentEnabled']);
    assert.ok(!REG.profileKeysOff('lead_qualifier').includes('strategyAgentEnabled'), 'the Lead Generator has the Strategy tab');
});

check('no non-posting role writes the posting schedule', () => {
    for (const [key, cfg] of Object.entries(REG.REGISTRY) as [string, { modules?: Record<string, unknown> }][]) {
        const m = cfg.modules || {};
        if (m.hasPostingSchedule === false || m.hasScheduleCard === false) {
            assert.ok(REG.profileKeysOff(key).includes('posting_frequency'), key);
        }
    }
});

check('each group names a real card, shown by the same flag on the page', () => {
    for (const g of REG.PROFILE_FIELD_GROUPS) assert.ok(PAGE.includes(`id="${g.card}"`), `${g.card} is not on assistant-detail.html`);
    assert.ok(APP.includes("toggle('module-posting-schedule', mods.hasPostingSchedule !== false && mods.hasScheduleCard !== false);"));
    assert.ok(APP.includes("toggle('module-social-strategy', mods.hasSocialStrategy !== false);"));
    for (const id of ['module-creative-objective', 'module-creative-audience', 'module-reference-style']) assert.ok(APP.includes(`toggle('${id}', mods.hasCreativeBrief !== false);`), id);
    assert.ok(APP.includes("toggle('module-sales-context', mods.hasSalesContext !== false);"));
    assert.ok(APP.includes("toggle('module-content-automation', mods.hasContentAutomation !== false);"));
    assert.ok(APP.includes("toggle('module-strategy-agent', !!strategy);") && APP.includes('const strategy = cfg.strategyTab;'));
});

check('every key the page writes is in a group or deliberately generic', () => {
    const start = APP.indexOf('function _detailCollect(currentData) {');
    const lit = APP.slice(APP.indexOf('const newContext = {', start), APP.indexOf('    };', APP.indexOf('const newContext = {', start)));
    const keys = [...lit.matchAll(/^\s{8}(\w+):/gm)].map((m) => m[1]);
    assert.ok(keys.length > 15, 'parsed the newContext literal');
    const grouped = new Set(REG.PROFILE_FIELD_GROUPS.flatMap((g) => g.keys));
    // Shown for every role (problem), records-guarded (pillars), or kept when hidden (trigger/source/platforms).
    const generic = new Set(['problem_statement', 'content_pillars', 'trigger_type', 'content_source', 'primary_platforms']);
    for (const k of keys) assert.ok(grouped.has(k) || generic.has(k), `${k} is written for every role: put it in a PROFILE_FIELD_GROUPS card`);
});

console.log('\nThe real _detailCollect, run in a sandbox');

function runCollect(roleKey: string, genericShown: boolean, context: Record<string, unknown>, inputs: Record<string, unknown>) {
    const fnSrc = APP.slice(APP.indexOf('function _detailCollect(currentData) {'), APP.indexOf('\nfunction _detailSetSaveStatus'));
    const fields: Record<string, { value?: string; checked?: boolean }> = {
        edit_frequency: { value: '3 times a week' }, edit_timezone: { value: 'Europe/London' }, edit_problem: { value: '' },
        edit_strategy_agent: { checked: true }, edit_allow_ai_media: { checked: false },
    };
    const sandbox: Record<string, unknown> = {
        window: { AssistantDashboardRegistry: REG, _pillarsTextDirty: false },
        document: {
            getElementById: (id: string) => id === 'operation-generic'
                ? { classList: { contains: (c: string) => c === 'hidden' && !genericShown } }
                : fields[id] ?? null,
            querySelector: () => null,
            querySelectorAll: () => [],
        },
        _collectStrictRules: () => [], _collectPostingDays: () => ['mon', 'tue', 'wed', 'thu', 'fri'], _collectPostingTimes: () => ['09:00'],
        _POSTING_DEFAULT_TZ: 'Europe/London', _parsePillars: () => [], _collectPlatformStrategy: (p: unknown) => p ?? {},
        _collectPublishPolicy: (p: unknown) => ({ ...(p as object || {}) }), _TOPIC_RECORD_KEYS: ['blogTopics', 'newsletterTopics'],
        _collectContentMix: () => null, _OPERATIONAL_LABELS: {},
    };
    vm.runInNewContext(`${fnSrc}\nresult = _detailCollect(data);`, Object.assign(sandbox, {
        data: { roleKey, context, configuration: { type: roleKey, active: true, inputs } },
    }));
    return sandbox.result as { newContext: Record<string, unknown>; newConfiguration: { inputs: Record<string, unknown> } };
}

check('a Shopkeeper rename saves its set-up answers unchanged (the staging request, replayed)', () => {
    const stored = { hasWebsite: 'none', completedAt: '2026-11-16T05:41:20.845Z', whatYouSell: 'Small-batch coffee beans and gift boxes' };
    const { newContext, newConfiguration } = runCollect('shopkeeper', false, stored, {});
    assert.deepStrictEqual(JSON.parse(JSON.stringify(newContext)), { ...stored, problem_statement: "" });
    for (const k of ['trigger_type', 'content_source', 'triggerText', 'sourceText', 'platforms']) assert.ok(!(k in newConfiguration.inputs), `inputs.${k}`);
});

check('a hidden card keeps a stored value rather than dropping it', () => {
    const stored = { whatYouSell: 'Beans', posting_frequency: 'daily', trigger_type: 'scheduled' };
    const { newContext } = runCollect('shopkeeper', false, stored, { trigger_type: 'scheduled' });
    assert.strictEqual(newContext.posting_frequency, 'daily');
    assert.strictEqual(newContext.trigger_type, 'scheduled');
});

check('the Social Media Manager still saves its schedule and settings', () => {
    const { newContext } = runCollect('social_media_manager', true, { primary_platforms: ['instagram'] }, {});
    assert.strictEqual(newContext.posting_frequency, '3 times a week');
    assert.deepStrictEqual([...(newContext.posting_days as string[])], ['mon', 'tue', 'wed', 'thu', 'fri']);
    assert.ok('platform_strategy' in newContext && 'publishPolicy' in newContext && 'allowAiMediaAutoPublish' in newContext);
    assert.deepStrictEqual([...(newContext.primary_platforms as string[])], ['instagram']);
    assert.ok(!('strategyAgentEnabled' in newContext), 'no Strategy tab, so the default (on) stands');
});

console.log('\nAI disclosure');

check('the disclosure is sent only when it changed', () => {
    const save = APP.slice(APP.indexOf('async function persistChanges() {'), APP.indexOf("fetch('/.netlify/functions/update-assistant-context'", APP.indexOf('async function persistChanges() {')));
    assert.ok(save.includes("_disclosureNow !== String(currentData.disclosureText || '').trim()"));
    assert.ok(save.includes('if (disclosureText !== undefined) body.disclosureText = disclosureText;'));
    // The server still refuses clearing a stored one.
    assert.ok(read('netlify/functions/update-assistant-context.ts').includes("if (disclosureText !== undefined && !disclosureText?.trim() && existingAssistant.isActive)"));
});

console.log(`\n${passed}/${total} passed`);
