// tests/site-audit-covered.test.ts
// The Mystery Shopper's "Ideas for your other assistants" must not repeat what is already covered:
// ideas suggested before, briefs the user sent, and what the receiving assistants already wrote
// (owner, 2026-10-21 — the same ideas came back, reworded, after every check).
// Run:  npx tsx tests/site-audit-covered.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { coveredBlock, normaliseIdea, sameIdea, type CoveredItem } from '../src/utils/site-audit-covered';
import { buildSummaryPrompt, sanitiseSummary, type SummaryInput } from '../src/utils/site-audit-prompts';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

// Titles taken from four real consecutive checks on prod (2026-10-15 → 10-21).
const covered: CoveredItem[] = [
    { target: 'social_media_manager', text: 'Write outcome-led social posts for small business owners', how: 'suggested before' },
    { target: 'blog_writer', text: "Write a founder's time-saving guide", how: 'briefed' },
    { target: 'blog_writer', text: 'How small businesses reclaim hours with AI assistants', how: 'already written' },
];

const input = (extra: Partial<SummaryInput> = {}): SummaryInput => ({
    brief: { url: 'https://example.com/', icp: null, conversionGoal: null, productsBlock: null, rulesBlock: null } as SummaryInput['brief'],
    score: { overall: 50, lenses: { clarity: { score: 50 }, compete: { score: 50 }, ai: { score: 50 } }, failures: [], outcomes: [] } as unknown as SummaryInput['score'],
    previousScore: null,
    fixes: [],
    competitorChanges: [],
    covered,
    ...extra,
});

console.log('\nTelling two ideas apart');

check('the same idea in other words is the same idea', () => {
    assert.ok(sameIdea('Write outcome-led social posts for small business owners', 'Outcome-led posts for small business owners'));
    assert.ok(sameIdea("Write a founder's time-saving guide", "A founder's guide to time-saving"));
});

check('different ideas stay different', () => {
    assert.ok(!sameIdea('Write outcome-led social posts for small business owners', 'Competitor alert: Delegated goes one-time fee'));
    assert.ok(!sameIdea('Promote the free trial', "Write a founder's time-saving guide"));
});

check('filler words do not make two ideas match', () => {
    assert.strictEqual(normaliseIdea('Write a blog post for the social'), '');
    assert.ok(!sameIdea('Write a post', 'Write a blog post'), 'nothing meaningful in common → not the same');
});

console.log('\nThe summary call is told, and a repeat is dropped anyway');

check('the prompt lists what is covered and says an empty list is the right answer', () => {
    const p = buildSummaryPrompt(input()).user;
    assert.match(p, /<already_covered>/);
    assert.match(p, /\[Social Media Assistant\] \(suggested before\) Write outcome-led social posts/);
    assert.match(p, /\[Blog Writer\] \(already written\) How small businesses reclaim hours/);
    assert.match(p, /return "handoffs": \[\]/);
    assert.doesNotMatch(buildSummaryPrompt(input({ covered: [] })).user, /<already_covered>\nThese are already/, 'nothing covered → no block');
});

check('an idea that repeats a covered one is dropped; a new one is kept', () => {
    const out = sanitiseSummary({
        summary: 'Fine.',
        priorities: [],
        handoffs: [
            { target: 'social_media_manager', title: 'Outcome-led posts for small business owners', brief: 'Posts that lead with the outcome.' },
            { target: 'blog_writer', title: 'What a one-time fee really costs you', brief: 'An article answering the competitor.' },
        ],
    }, input());
    assert.deepStrictEqual(out.handoffs.map((h) => h.title), ['What a one-time fee really costs you']);
});

check('a repeat for a DIFFERENT assistant is not a repeat', () => {
    const out = sanitiseSummary({
        summary: 'Fine.', priorities: [],
        handoffs: [{ target: 'campaign_orchestrator', title: 'Outcome-led posts for small business owners', brief: 'A campaign.' }],
    }, input());
    assert.strictEqual(out.handoffs.length, 1);
});

check('the check run loads what is covered before it writes ideas', () => {
    const run = read('src/utils/site-audit.ts');
    assert.match(run, /const covered = await loadAlreadyCovered\(db, orgId, audit\.id\);/);
    assert.match(run, /previousScore: audit\.currentScore,\s*covered,/);
    const mod = read('src/utils/site-audit-covered.ts');
    for (const t of ['siteAuditRuns', 'siteAuditBriefs', 'scheduledPosts', 'blogPosts', 'campaigns']) assert.ok(mod.includes(`from(${t})`), t);
    assert.strictEqual(coveredBlock([]), '');
});

console.log('\nThe Website tab and My Assistants');

check('competitors can be edited from their own card', () => {
    const tab = read('src/components/assistant-site-audit.js');
    assert.match(tab, /data-sa-edit-competitors[^>]*>\$\{comps\.length \? 'Edit competitors' : 'Add competitors'\}/);
    assert.match(tab, /t\('\[data-sa-edit-competitors\]'\)[\s\S]{0,120}state\.settingsOpen = true;/);
});

check('My Assistants has no dead "Orchestrations (coming soon)" link', () => {
    assert.ok(!read('assistants-directory.html').includes('route-to-orchestrations-from-dir'));
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
if (passed !== total) process.exit(1);
