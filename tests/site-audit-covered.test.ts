// tests/site-audit-covered.test.ts
// The Mystery Shopper's "Ideas for your other assistants" must not repeat what is already covered:
// ideas suggested before, briefs the user sent, and what the receiving assistants already wrote
// (owner, 2026-10-21 — the same ideas came back, reworded, after every check).
// Run:  npx tsx tests/site-audit-covered.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { coveredBlock, normaliseIdea, sameIdea, type CoveredItem } from '../src/utils/site-audit-covered';
import { buildSummaryPrompt, rejectedFixesBlock, sanitiseSummary, type SummaryInput } from '../src/utils/site-audit-prompts';

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

console.log('\nRejecting, and learning from it (owner, 2026-10-21)');

check('a rejected fix is listed to every later check, which must not suggest it again', () => {
    const block = rejectedFixesBlock([{ location: 'Pricing', beforeText: 'No hidden tiers.', afterText: 'Plans start at £29/month' }]);
    assert.match(String(block), /<rejected_by_owner>[\s\S]*Never suggest them again[\s\S]*Pricing: "No hidden tiers\." → "Plans start at £29\/month"/);
    assert.strictEqual(rejectedFixesBlock([]), null);
    // briefBlock is shared by every lens prompt and the summary prompt; the summary is the easy one to build here.
    const p = buildSummaryPrompt(input({ brief: { url: 'https://example.com/', icp: null, conversionGoal: null, productsBlock: null, rulesBlock: null, rejectedBlock: block } as SummaryInput['brief'] })).user;
    assert.ok(p.includes('<rejected_by_owner>'), 'the brief carries it');
    assert.match(read('src/utils/site-audit-prompts.ts'), /brief\.rejectedBlock \? `\\n\$\{brief\.rejectedBlock\}` : ''/);
    const run = read('src/utils/site-audit.ts');
    assert.match(run, /eq\(siteAuditFixes\.status, 'dismissed'\)[\s\S]{0,120}limit\(15\)\);/);
    assert.match(run, /productsBlock, rulesBlock, rejectedBlock \}/);
});

check('a reason given when rejecting a fix becomes one of the Mystery Shopper\'s Rules', () => {
    const api = read('netlify/functions/site-audits.ts');
    assert.match(api, /if \(status === 'dismissed' && reason\)[\s\S]{0,600}db\.insert\(contentRules\)[\s\S]{0,200}ruleText: `Website suggestions: \$\{reason\}`/);
    assert.match(api, /origin: 'rejection_feedback'/);
    const tab = read('src/components/assistant-site-audit.js');
    assert.match(tab, /data-sa-reject-fix="\$\{esc\(f\.id\)\}"[^>]*>Reject</);
    assert.match(tab, /window\.promptModal\([\s\S]{0,400}multiline: true/);
    assert.match(tab, /status: 'dismissed', reason:/);
});

check('an idea can be rejected: recorded as a rejected_idea, moved to Archived, never suggested again', () => {
    const tab = read('src/components/assistant-site-audit.js');
    assert.match(tab, /data-sa-reject-idea="\$\{i\}" data-run="\$\{esc\(runId\)\}"[^>]*>Reject</);
    assert.match(tab, /source: 'rejected_idea', runId:/);
    assert.match(tab, /archived: \[[\s\S]*source === 'rejected_idea'\)\.map\(\(x\) => \(\{ kind: 'rejected'/);
    assert.match(tab, /const briefs = \(\) => allBriefs\(\)\.filter\(\(b\) => b\.source !== 'rejected_idea'\);/, 'a rejection is not a brief');
    const api = read('netlify/functions/site-audits.ts');
    assert.match(api, /const BRIEF_SOURCES = \['idea', 'stalled_fix', 'chat', 'rejected_idea'\] as const;/);
    assert.match(api, /if \(!who && source !== 'rejected_idea'\)/);
    assert.match(api, /code === '23514' && source === 'rejected_idea'/, 'before the SQL is applied it says so instead of a 500');
    const sql = read('db/z-mystery-shopper-rejected-ideas.sql');
    assert.match(sql, /CHECK \(source IN \('idea', 'stalled_fix', 'chat', 'rejected_idea'\)\)/);
    assert.match(sql, /site_audit_briefs_rejected_idea_uq/);
    assert.match(read('src/utils/site-audit-covered.ts'), /b\.source === 'rejected_idea' \? 'rejected by the owner'/);
    assert.match(read('src/utils/site-audit-snapshot.ts'), /Ideas for other assistants they rejected/);
});

check('an unusable lens reply is tried once more, with more room, before it is scored on code checks alone', () => {
    const run = read('src/utils/site-audit.ts');
    assert.match(run, /for \(const maxTokens of \[LENS_MAX_TOKENS, LENS_RETRY_MAX_TOKENS\]\)/);
    assert.match(run, /const LENS_RETRY_MAX_TOKENS = 4000;/);
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
