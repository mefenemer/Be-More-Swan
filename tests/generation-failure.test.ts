// tests/generation-failure.test.ts
// "A post couldn't be written": the reason in plain words (generation-failure.ts), where the
// notification leads (the assistant's Activity tab, not the media library), and "Try again"
// (retry-generation.ts). Reported 2026-10-15: "View content" opened My Content, which showed nothing.
//
// Run:  npx tsx tests/generation-failure.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { explainGenerationFailure } from '../src/utils/generation-failure';
import { getNotificationDefault } from '../src/utils/notification-templates-catalog';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

console.log('\nWhy, in plain words');

check('the 14 Oct emoji fault, the provider refusing us, a busy service, a cut-off reply — each explained, never the raw text', () => {
    const cases: Array<[string, string, boolean]> = [
        ['400 {"type":"error","error":{"message":"The request body is not valid JSON: unexpected end of hex escape at line 1 column 36012"}}', 'ours', true],
        ['400 Your credit balance is too low to access the Anthropic API.', 'ours', true],
        ['529 {"type":"overloaded_error"}', 'temporary', true],
        ['Request timed out', 'temporary', true],
        ['Model reply was cut off at the 4096-token ceiling before the JSON closed (wrote 4096 tokens) — retrying', 'temporary', true],
        ['SAFE_CONTENT_BLOCKED', 'theirs', false],
        ['Your monthly task allowance is used up, so this was not started.', 'theirs', false],
        ['insufficient_ai_credits', 'theirs', false],
        ['Blueprint not found', 'theirs', false],
        ['something nobody has seen before', 'ours', true],
    ];
    for (const [raw, owner, canRetry] of cases) {
        const e = explainGenerationFailure(raw);
        assert.strictEqual(e.owner, owner, raw);
        assert.strictEqual(e.canRetry, canRetry, raw);
        assert.ok(!e.reason.includes(raw), 'the raw error is never shown');
        assert.ok(!/anthropic|credit balance|hex escape|json|token/i.test(e.reason), `reason leaks internals: ${e.reason}`);
    }
});

check('a blog job says "article"', () => {
    assert.match(explainGenerationFailure('Request timed out', 'article').reason, /article|answer/);
    assert.ok(!/\bpost\b/.test(explainGenerationFailure('', 'article').reason));
});

console.log('\nWhere the notification leads');

check('"See why" opens the assistant\'s Activity tab on that post — not the media library', () => {
    const n = read('notifications.js');
    const block = n.slice(n.indexOf("if (notif.type === 'post_generation_failed' && meta.assistantId)"), n.indexOf("if (notif.type === 'post_publish_failed' && meta.postId"));
    assert.ok(block.includes("label: 'See why'") && block.includes("window._assistantDetailInitialTab = 'activity'") && block.includes('window._activityFocusJobId'));
    const tpl = getNotificationDefault('post_generation_failed')!;
    assert.strictEqual(tpl.message, '{{failure.reason}}');
    const jobs = read('netlify/functions/process-content-jobs.ts');
    assert.ok(jobs.includes('context: { failure: { reason: explainGenerationFailure(errorMessage).reason } }'));
    assert.ok(!jobs.includes('error: errorMessage }'), 'the raw error is not put in a customer\'s notification');
});

check('the Activity feed carries the reason and the retry, never the raw error', () => {
    const fn = read('netlify/functions/get-assistant-activity.ts');
    assert.ok(fn.includes("explainGenerationFailure(j.errorMessage, isBlog ? 'article' : 'post')"));
    assert.ok(fn.includes('failure: { jobId: j.jobId, canRetry: why.canRetry, action: why.action, owner: why.owner }'));
    assert.ok(!/description[^;]*errorMessage/.test(fn), 'errorMessage is not put in a description');
    const ui = read('assistants.js');
    assert.ok(ui.includes("window._retryGeneration('${f.jobId}', this)") && ui.includes('window._retryGeneration = async function'));
    assert.ok(ui.includes("if (window._activityFocusJobId) _activityTf = '30d';"));
});

console.log('\nTry again');

check('retry: own organisation, failed only, recent only, refuses what cannot clear, re-queues the same job and pokes the drain', () => {
    const fn = read('netlify/functions/retry-generation.ts');
    assert.ok(fn.includes('eq(contentGenerationJobs.organisationId, ctx.organisationId)'));
    assert.ok(fn.includes("if (job.status !== 'failed')"));
    assert.ok(fn.includes('gte(contentGenerationJobs.createdAt, since)'));
    assert.ok(fn.indexOf('if (!why.canRetry)') < fn.indexOf('db.update(contentGenerationJobs)'));
    assert.ok(fn.includes("status: 'queued', attempt: 0") && fn.includes("eq(contentGenerationJobs.status, 'failed')"), 'a double click re-queues once');
    assert.ok(fn.includes('targetPublishDate: null'), 'a slot that has passed is not reused');
    assert.ok(fn.includes('triggerContentDrain(') && fn.includes('triggerBlogDrain('));
});

console.log(`\n${passed}/${total} passed`);
