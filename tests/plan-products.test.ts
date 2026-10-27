// tests/plan-products.test.ts
// Be More Swan's own plans in its own Products & Services read as the plan settings say (owner,
// 2026-10-27): blog drafts said the Busywork Buster gave "three distinct assistants" — a July row,
// never updated — and the Business Mentor is included on both plans. Plus: Meet the Assistants scrolls
// to the first card when a category is chosen.
//
// Run:  npx tsx tests/plan-products.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isPlanProduct, planFactLine, planFactLines, withPlanFacts, type PlanFacts } from '../src/utils/plan-products';

let passed = 0, total = 0;
function test(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

const BUSTER: PlanFacts = {
    name: 'The Busywork Buster', monthlyPriceGbp: '69.00', assistantLimit: null, monthlyTaskLimit: 2750,
    description: 'Every assistant, working as one team on your social media, blog, email and leads.',
    features: { business_mentor: true, ai_video_generation: true, ai_image_generation: true },
};
const SAVER: PlanFacts = {
    name: 'The Workflow Saver', monthlyPriceGbp: '29.00', assistantLimit: 1, monthlyTaskLimit: 600,
    description: 'One assistant on the job you most want off your plate each day.',
    features: { business_mentor: true, ai_video_generation: false, ai_image_generation: true },
};
const PLANS = [SAVER, BUSTER];

// The prod row as it stood on 27 Oct.
const JULY_ROW = {
    name: 'The Busywork Buster', url: 'https://bemoreswan.com/pricing.html', price: '£69',
    description: 'Scale your business with autonomous goal tracking, advanced analytics, and your own mini digital department.',
    benefits: '50 AI Media Credits / month\n3 Distinct Digital Assistants\nConnect Standard Apps You Use\nAutonomous Goal Tracking\nAdvanced Analytics & Time-Saved Dashboard\nThe In-House Editor\nBe the First to Hire New Assistants\nFast-Track Support',
};

console.log('plan products — the plan settings are the truth');

test('the July row reads as the plan is now', () => {
    const r = withPlanFacts(JULY_ROW, PLANS);
    assert.doesNotMatch(r.benefits!, /3 Distinct|Media Credits/i);
    assert.deepEqual(r.benefits!.split('\n').slice(0, 4), [
        'Every Digital Assistant, with no limit on how many you hire',
        'The Business Mentor Assistant included, on top of your other assistants',
        '2,750 tasks a month',
        'AI video, images & music from your tasks',
    ]);
    for (const own of ['Connect Standard Apps You Use', 'Autonomous Goal Tracking', 'The In-House Editor', 'Be the First to Hire New Assistants', 'Fast-Track Support']) {
        assert.ok(r.benefits!.split('\n').includes(own), `kept the owner's line: ${own}`);
    }
    assert.equal(r.description, BUSTER.description);
    assert.equal(r.price, '£69');
});

test('the Workflow Saver: 1 assistant, the Business Mentor too, no video', () => {
    const r = withPlanFacts({ name: 'The Workflow Saver', url: 'https://bemoreswan.com/pricing.html', benefits: '20 AI Media Credits / month\nMonthly Recap', price: '£29' }, PLANS);
    assert.deepEqual(r.benefits!.split('\n'), ['1 Digital Assistant', 'The Business Mentor Assistant included, on top of your other assistants', '600 tasks a month', 'AI images & music from your tasks', 'Monthly Recap']);
});

test('a plan change is true on the next read — nothing to sync', () => {
    const r = withPlanFacts(JULY_ROW, [{ ...BUSTER, assistantLimit: 5, monthlyTaskLimit: 3000, monthlyPriceGbp: '79.50' }]);
    assert.match(r.benefits!, /^5 Digital Assistants\n/);
    assert.match(r.benefits!, /3,000 tasks a month/);
    assert.equal(r.price, '£79.50');
});

test('only Be More Swan\'s own plan rows are touched', () => {
    assert.ok(isPlanProduct(JULY_ROW, PLANS));
    assert.equal(isPlanProduct({ ...JULY_ROW, url: 'https://someone-else.example/busywork-buster' }, PLANS), null, 'a namesake elsewhere');
    assert.equal(isPlanProduct({ ...JULY_ROW, url: null }, PLANS), null);
    assert.equal(isPlanProduct({ ...JULY_ROW, url: 'https://notbemoreswan.com/x' }, PLANS), null);
    assert.equal(isPlanProduct({ name: 'Website audit', url: 'https://bemoreswan.com/x' }, PLANS), null);
    const other = { name: 'Dog groom', url: 'https://groomers.example', benefits: '3 assistants on every groom' };
    assert.deepEqual(withPlanFacts(other, PLANS), other);
});

test('stale fact lines are recognised; marketing lines are not', () => {
    for (const l of ['3 Distinct Digital Assistants', '50 AI Media Credits / month', '2,500 tasks a month', 'Three assistants', 'Business Mentor included', 'AI images & music from your tasks']) assert.ok(planFactLine(l), l);
    for (const l of ['Be the First to Hire New Assistants', 'Autonomous Goal Tracking', 'Sounds Just Like You', 'The In-House Editor']) assert.ok(!planFactLine(l), l);
});

test('no Business Mentor line on a plan without it', () => {
    assert.ok(!planFactLines({ ...SAVER, features: {} }).some((l) => /Business Mentor/.test(l)));
});

test('every assistant and the Products & Services page read through it', () => {
    assert.match(read('src/utils/org-products.ts'), /return await applyPlanFacts\(db, await db/);
    assert.match(read('netlify/functions/org-products.ts'), /const products = await applyPlanFacts\(db, await db\.select\(COLUMNS\)/);
});

test('Meet the Assistants: a new category starts at its first card', () => {
    const page = read('assistants.html');
    const handler = page.slice(page.indexOf("document.getElementById('category-tabs').addEventListener"), page.indexOf('// ── Search'));
    assert.match(handler, /renderGrid\(\);\n\s*scrollToResults\(\);/);
    assert.match(page, /id="assistants-filter-bar" class="sticky/);
    assert.match(page, /id="results-start"/);
    assert.match(page, /if \(window\.scrollY > target\) window\.scrollTo\(\{ top: target, behavior: 'smooth' \}\);/);
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
