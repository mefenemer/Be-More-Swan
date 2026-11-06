// tests/basic-work-charging.test.ts
// Chat, helpers, free design rounds and finished designs cost tasks only after the dated switch
// (docs/basic-work-charging.md): customers were promised otherwise, so it must be off by default.
//
// Run:  npx tsx tests/basic-work-charging.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { basicWorkCharged, DEFAULT_TASK_COSTS, DEFAULT_TASK_WEIGHTS, WORK_KIND_LABELS } from '../src/config/task-weights';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

check('the switch is off unless set, and a date only counts from that day', () => {
    const before = process.env.BASIC_WORK_CHARGED_FROM;
    delete process.env.BASIC_WORK_CHARGED_FROM;
    assert.strictEqual(basicWorkCharged(), false);
    process.env.BASIC_WORK_CHARGED_FROM = '2026-12-10';
    assert.strictEqual(basicWorkCharged(new Date('2026-12-09T23:59:00Z')), false);
    assert.strictEqual(basicWorkCharged(new Date('2026-12-10T00:00:00Z')), true);
    process.env.BASIC_WORK_CHARGED_FROM = 'on';
    assert.strictEqual(basicWorkCharged(), true);
    if (before === undefined) delete process.env.BASIC_WORK_CHARGED_FROM; else process.env.BASIC_WORK_CHARGED_FROM = before;
});

check('the agreed prices', () => {
    assert.strictEqual(DEFAULT_TASK_COSTS.chatMessagesPerTask, 10);
    for (const k of ['chat_messages', 'editing_helper', 'design_round', 'finished_design', 'background_removal'] as const) {
        assert.strictEqual(DEFAULT_TASK_WEIGHTS[k], 1, k);
        assert.ok(WORK_KIND_LABELS[k], k);
    }
});

check('every charge in the module is behind the switch', () => {
    const src = read('src/utils/basic-work.ts');
    for (const fn of ['chargeHelper', 'chargeChatMessage', 'chargeFinishedDesign']) {
        const at = src.indexOf(`export async function ${fn}`);
        assert.ok(at > 0, fn);
        const guard = src.indexOf('basicWorkCharged()', at);
        assert.ok(guard > at && guard < src.indexOf('recordCompletedWork', at), `${fn} charges before checking the switch`);
    }
});

check('helpers charge only after they have succeeded', () => {
    const after: Array<[string, string]> = [
        ['netlify/functions/apply-post-suggestions.ts', "if (!after) return json(502"],
        ['netlify/functions/generate-hooks.ts', 'await db.update(blogPosts)'],
        ['netlify/functions/rewrite-section.ts', 'if (!rewrittenText) throw'],
        ['netlify/functions/rewrite-post-text.ts', "if (!tags) throw new Error('No hashtags returned.')"],
        ['netlify/functions/suggest-overlay-text.ts', "if (!text) throw new Error('Empty suggestion.')"],
        ['netlify/functions/review-post-quality.ts', 'await runQualityReview('],
        ['netlify/functions/lead-generation.ts', 'if (!preview) {'],
        ['netlify/functions/process-blog-jobs.ts', 'await resizeBlogBody('],
        ['netlify/functions/verify-compliance-warning-background.ts', 'if (!stored) {'],
        ['src/utils/mentor-feedback.ts', 'if (!feedback) return'],
        ['src/utils/discussions.ts', 'await improveTopicWording('],
    ];
    for (const [file, marker] of after) {
        const src = read(file);
        const charge = src.indexOf('await chargeHelper(');
        assert.ok(charge > -1, `${file} never charges`);
        assert.ok(charge > src.indexOf(marker) && src.indexOf(marker) > -1, `${file} charges before it has delivered`);
    }
});

check('a chat turn counts only once its reply is saved, and help-only Mentor replies are free', () => {
    const src = read('netlify/functions/chat-orchestrator.ts');
    const at = src.indexOf('if (!mentorNoPlan) await chargeChatMessage(');
    assert.ok(at > src.indexOf("role: 'assistant', content, uiElement: uiElement") || at > src.indexOf(".values({ chatSessionId: session.id, role: 'assistant', content, uiElementJson: uiElement })"));
});

check('at the limit, chat and metered helpers stop', () => {
    const src = read('src/utils/task-credit.ts');
    assert.match(src, /basicWorkCharged\(\) && !\(await hasTaskCapacity\(db, organisationId\)\)/);
    for (const f of ['netlify/functions/generate-hooks.ts', 'netlify/functions/rewrite-section.ts', 'netlify/functions/newsletter-issues.ts']) {
        assert.match(read(f), /helperCapacity\(db, /, f);
    }
});

check('a round charges once, only for what it made; a finished design charges once and a repeat download is free', () => {
    const src = read('src/utils/visual-briefs.ts');
    assert.match(src, /if \(ended && basicsProduced && basicWorkCharged\(\)\)/);
    const work = read('src/utils/basic-work.ts');
    assert.match(work, /basicWorkCharged\(\) \|\| await designAlreadyCharged\(db, organisationId, optionId\)\) return true/);
    const route = read('netlify/functions/brand-briefs.ts');
    assert.ok(route.indexOf('finishedDesignCapacity(db, orgId, optionId)') < route.indexOf('await downloadDesignPdf('));
    assert.ok(route.indexOf('await chargeFinishedDesign(') > route.indexOf('await downloadDesignPdf('));
});

console.log(`\n${passed} passed`);
