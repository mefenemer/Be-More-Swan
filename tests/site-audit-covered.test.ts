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

console.log('\nThe score on the Results tab (owner, 2026-10-21)');

check('the score card lives in the Results tab; Checks keeps Check my site now and Settings', () => {
    const tab = read('src/components/assistant-site-audit.js');
    assert.match(tab, /host\.id = 'site-audit-results-host';[\s\S]{0,120}panel\.prepend\(host\);/);
    assert.match(tab, /host\.innerHTML = card\(scoreBlock\(audit, latest\)\) \+ card\(trendCardHtml\(audit\)\);/);
    const checks = tab.slice(tab.indexOf('function checksPanel('), tab.indexOf('function render()'));
    assert.ok(!checks.includes('scoreBlock('), 'the score card is not on Checks any more');
    assert.ok(checks.includes('data-sa-run') && checks.includes('data-sa-settings-open'), 'the two buttons stay');
    // No card round them any more (owner, 2026-10-21): no site name, score line, last-scored line or task note.
    const top = checks.slice(checks.indexOf('return `'), checks.indexOf('${goalBlock(audit)}'));
    assert.ok(!top.includes('card(') && !top.includes('Visitors should') && !top.includes('Score: '), 'the card is gone');
    assert.match(top, /data-sa-run[^>]*title="A check that re-scores uses 1 task/, 'the spend button still says what it costs');
    assert.match(top, /data-sa-past-checks[^>]*>\$\{state\.pastOpen \? 'Hide past checks' : 'View past checks'\}/, 'past checks behind a button beside Settings');
    assert.match(checks, /What the last check said<\/h3>\$\{lastAt \? `<span class="text-xs text-gray-500">\$\{esc\(when\(lastAt\)\)\}/, 'the summary is dated');
    assert.match(tab, /<details data-sa-why \$\{state\.whyOpen \? 'open' : ''\}>/, 'the score list folds');
    assert.match(tab, /String\(window\._currentAssistantId\) !== String\(state\.assistantId\)\) return;/, 'never paints into another assistant');
    assert.match(tab, /e\.target\.closest\('#site-audit-host, #site-audit-results-host'\)/, 'its buttons are handled');
});

check('each bar is green if it went up since the last check, red if down — with an arrow and the change in words', () => {
    const tab = read('src/components/assistant-site-audit.js');
    assert.match(tab, /const TREND = \{ up: '#15803d', down: '#dc2626', flat: '#9ca3af' \};/);
    assert.match(tab, /`\$\{d > 0 \? '▲ \+' : '▼ '\}\$\{Math\.abs\(d\)\} since last check`/, 'never colour alone');
    const api = read('netlify/functions/site-audits.ts');
    assert.match(api, /previousLenses = latest && scored\.length > 1 && scored\[scored\.length - 1\]\.id === latest\.id/);
});

check('the score over time: month, quarter or year, one line against the target, hover and a table view', () => {
    const tab = read('src/components/assistant-site-audit.js');
    assert.match(tab, /const RANGES = \[\['month', 'Month', 31\], \['quarter', 'Quarter', 92\], \['year', 'Year', 366\]\];/);
    assert.match(tab, /stroke-width="2" stroke-linejoin="round"/);
    assert.match(tab, /Target \$\{esc\(target\)\}/);
    assert.match(tab, /box\.onpointermove = /);
    assert.match(tab, /Show as a table/);
    const api = read('netlify/functions/site-audits.ts');
    assert.match(api, /inArray\(siteAuditRuns\.status, \['done', 'unchanged'\]\)[\s\S]{0,160}interval '366 days'/);
    assert.match(api, /pastIdeas, briefs, briefsAvailable, scoreHistory, previousLenses,/);
});

console.log('\nThe Website tab and My Assistants');

check('competitors are edited in Settings, which Needs attention opens at them', () => {
    const tab = read('src/components/assistant-site-audit.js');
    assert.ok(!tab.includes('function competitorsBlock('), 'the Competitors card is gone from Checks (owner, 2026-10-21)');
    assert.match(tab, /data-sa-edit-competitors[^>]*>Edit competitors</);
    assert.match(tab, /name="competitor"/);
    assert.match(tab, /t\('\[data-sa-edit-competitors\]'\)[\s\S]{0,120}state\.settingsOpen = true;/);
});

check('My Assistants has no dead "Orchestrations (coming soon)" link', () => {
    assert.ok(!read('assistants-directory.html').includes('route-to-orchestrations-from-dir'));
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
if (passed !== total) process.exit(1);
