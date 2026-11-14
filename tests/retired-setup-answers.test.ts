// Retired Social set-up answers (2026-11-14): a customer's old weekday topic plan, saved once at hire
// as content_source_detail and uneditable, kept steering chat drafts as a MUST-obey rule after her
// business changed. src/constants/retired-setup-answers.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RETIRED_SETUP_ANSWER_KEYS, isRetiredSetupAnswer, withoutRetiredSetupAnswers } from '../src/constants/retired-setup-answers';
import { SOCIAL_WIZARD_EXCLUDED, SOCIAL_WIZARD_FIELDS, renderExcludedSetupAnswers } from '../src/utils/setup-field';
import { TAKE_ME_THERE_PLACES } from '../src/config/take-me-there';
import { SMM_ROLE_KEY } from '../src/constants/roles';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the wizard no longer asks or saves any retired answer', () => {
    const html = read('onboarding-social-media.html');
    for (const id of ['source_client', 'source_ai', 'source_hybrid']) assert.ok(!html.includes(`id="${id}"`), id);
    assert.ok(!html.includes('toggleContentSourceDetails'));
    const op = html.slice(html.indexOf('function collectOperationalSetup() {'), html.indexOf('\n  }', html.indexOf('function collectOperationalSetup() {')));
    for (const k of RETIRED_SETUP_ANSWER_KEYS) assert.ok(!new RegExp(`\\b${k}:`).test(op), `${k} still saved`);
    assert.ok(html.includes('<strong>Inspo</strong>'), 'points to where material to work from now goes');
});

test('chat never hands a retired answer to the model', () => {
    const src = read('netlify/functions/chat-orchestrator.ts');
    const fn = src.slice(src.indexOf('function buildSystemPrompt('), src.indexOf('<strict_configuration>', src.indexOf('function buildSystemPrompt(')));
    assert.ok(fn.includes('!isRetiredSetupAnswer(k)'), 'strict_configuration filters retired keys');
});

test('the Mentor no longer reads them, and they are not listed as wizard answers', () => {
    const listed = [...SOCIAL_WIZARD_FIELDS.map((f) => f.key), ...Object.keys(SOCIAL_WIZARD_EXCLUDED)];
    for (const k of RETIRED_SETUP_ANSWER_KEYS) assert.ok(!listed.includes(k), k);
    const old = { content_source_detail: 'Burnout on Mondays', trigger_timezone: 'Europe/London', trigger_schedule_frequency: '3x', content_source: 'hybrid' };
    const lines = renderExcludedSetupAnswers(SMM_ROLE_KEY, old).join('\n');
    assert.ok(!/Burnout|trigger_timezone|trigger_schedule_frequency/.test(lines), lines);
});

test('the blueprint drops them and reads the Posting Schedule, not the stale copies', () => {
    const ctx = { content_source_detail: 'x', trigger_timezone: 'America/New_York', posting_timezone: 'Europe/London', content_source: 'hybrid' };
    const clean = withoutRetiredSetupAnswers(ctx);
    assert.deepEqual(Object.keys(clean).sort(), ['content_source', 'posting_timezone']);
    assert.ok(isRetiredSetupAnswer('trigger_timezone') && !isRetiredSetupAnswer('posting_timezone'));
    const bp = read('src/utils/blueprint.ts');
    assert.ok(bp.includes('answers: withoutRetiredSetupAnswers(onboardingCtx)'));
    assert.ok(!bp.includes('onboardingCtx.trigger_timezone') && !bp.includes('onboardingCtx.content_source_detail'));
});

test('Take me there names the card the customer will actually see', () => {
    const label = TAKE_ME_THERE_PLACES.assistant_how_i_work.label;
    assert.ok(label.includes('When and how I post') && label.includes('When and how I work'), label);
});

test('the backup SQL copies before it removes, and covers every retired key', () => {
    const sql = read('db/z-retire-social-setup-answers-2026-11-14.sql');
    assert.ok(sql.indexOf('INSERT INTO retired_setup_answers') < sql.indexOf('UPDATE ai_assistants'));
    for (const k of RETIRED_SETUP_ANSWER_KEYS) assert.ok(sql.split(`'${k}'`).length >= 4, k);
});
