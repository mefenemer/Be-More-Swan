// tests/content-topics-3b.test.ts
// Blog and Email topics phase 3b (docs/pillar-records-plan.md §7): the chat's one-topic card on the Blog and
// Email routes (kept through their uiElement rebuilds), Results ▸ Posts / Emails by topic, and the help text.
//
// Run:  npx tsx tests/content-topics-3b.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPillarCard, pillarPromptBlock, settingsPlaceFor } from '../src/utils/chat-pillar-card';
import { PILLAR_PROFILES } from '../src/utils/pillar-profiles';
import type { Pillar } from '../src/utils/content-pillars-store';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const row = (id: number, name: string, sortOrder: number, isActive = true): Pillar => ({ id, name, description: null, sortOrder, isActive });
const BLOG = PILLAR_PROFILES.blog_writer, EMAIL = PILLAR_PROFILES.newsletter_editor;

check('the Blog prompt says "topics", never "pillars", with its own cap and place', () => {
    const block = pillarPromptBlock(23, [row(1, 'Dogs', 0), row(2, 'Cats', 1, false)], [], BLOG)!;
    assert.match(block, /^YOUR TOPICS \(/);
    assert.match(block, /each new article takes the topic used least lately/);
    assert.match(block, /1 of 8 switched on/);
    assert.match(block, /Call them topics, never pillars/);
    assert.match(block, /Do not change topics through the set-up answer card/);
    assert.ok(!/redraft_upcoming_proposal/.test(block), 'no Social redraft offer');
    assert.ok(!/one pillar per card|ONE pillar/i.test(block));
    assert.match(pillarPromptBlock(9, [], [], EMAIL)!, /each new email takes the topic/);
});

check('the Blog / Email card: 8 on, "topic" words, noun on the card', () => {
    const seven = [1, 2, 3, 4, 5, 6, 7].map((i) => row(i, `T${i}`, i));
    const ok = buildPillarCard(23, { action: 'add', name: 'Eighth' }, seven, [], BLOG);
    assert.ok(!('error' in ok));
    assert.strictEqual(ok.noun, 'topic');
    assert.strictEqual(ok.maxActive, 8);
    const eight = seven.concat(row(8, 'T8', 8));
    assert.match((buildPillarCard(23, { action: 'add', name: 'Ninth' }, eight, [], BLOG) as { error: string }).error, /8 topics are already switched on/);
    assert.match((buildPillarCard(23, { action: 'add', name: 't1' }, seven, [], EMAIL) as { error: string }).error, /already a topic called "T1"/);
    assert.match((buildPillarCard(23, { action: 'archive', pillarId: 99 }, seven, [], BLOG) as { error: string }).error, /That topic isn't in the list/);
    const social = buildPillarCard(20, { action: 'add', name: 'New' }, [], []);
    assert.ok(!('error' in social) && social.noun === 'pillar' && social.maxActive === 5, 'Social unchanged');
});

check('names are listed in curly quotes, so the model\'s JSON reply stays readable (staging 2026-11-11)', () => {
    const block = pillarPromptBlock(23, [row(32, 'Behind the camera', 0)], [row(33, 'Old one', 1, false)], BLOG)!;
    assert.match(block, /#32 “Behind the camera”/);
    assert.match(block, /#33 “Old one”/);
    assert.ok(!/#\d+ "/.test(block), 'no straight-quoted names');
    assert.match(block, /never straight double quotes/);
});

check('settings place per role', () => {
    assert.strictEqual(settingsPlaceFor(BLOG), '“Topics & themes” under “When and how I work” in my settings');
    assert.strictEqual(settingsPlaceFor(PILLAR_PROFILES.social_media_manager), '“What I post about” in my settings');
});

const orch = read('netlify/functions/chat-orchestrator.ts');
const registry = read('src/components/disruptive-ui-registry.js');
const store = read('src/utils/content-pillars-store.ts');
const api = read('netlify/functions/content-pillars.ts');
const list = read('src/components/pillar-list.js');
const detail = read('assistant-detail.html');
const help = read('db/z-content-topics-help-2026-11-11.sql');

check('orchestrator: the card on Social, Blog and Email routes; kept through the Blog and Email rebuilds', () => {
    assert.match(orch, /const ownRoute = route === ROUTES\.social_media_manager \|\| route === ROUTES\.blog_writer \|\| route === ROUTES\.newsletter_editor;/);
    assert.match(orch, /: blogAction \?\? blogBlockEdit \?\? pillarCard \?\? profileCard;/);
    assert.match(orch, /: emailAction \?\? emailPartCard \?\? audienceCard \?\? reviewsCard \?\? pillarCard \?\? profileCard;/);
    assert.ok((orch.match(/!pillarCard && replyClaimsPostSaved\(content\)|!profileCard && !pillarCard\) \{/g) || []).length >= 3, 'no false "nothing was saved" apology');
});

check('chat card: topic words, the Blog/Email settings place, no Social redraft offer', () => {
    const i = registry.indexOf("register('pillar_proposal'");
    const body = registry.slice(i, registry.indexOf("register('share_for_review_proposal'"));
    assert.match(body, /const isTopic = ui\.noun === 'topic';/);
    assert.ok(body.includes('“Topics & themes” under “When and how I work” in my settings'));
    assert.match(body, /if \(!isTopic && \(action !== 'restore' \|\| !data\.switchedOff\)\) window\.offerRedraftUpcoming/);
});

check('Results: blog_posts and newsletter_issues counted over the role window; heading from the server', () => {
    assert.match(store, /FROM blog_posts[\s\S]*?make_interval\(days => \$\{prof\.balanceDays\}\)/);
    assert.match(store, /FROM newsletter_issues[\s\S]*?make_interval\(days => \$\{prof\.balanceDays\}\)/);
    assert.match(api, /const label = social \? 'Posts by pillar' : profile\.contextKey === 'blogTopics' \? 'Posts by topic' : 'Emails by topic';/);
    assert.match(detail, /<h4 id="pillar-usage-label"/);
    assert.match(list, /if \(label && data\.label\) label\.textContent = String\(data\.label\);/);
});

check('help: a Blog and Email section, upserted, no semicolons in the body', () => {
    assert.match(help, /ON CONFLICT \(title\) DO UPDATE SET/);
    const start = help.indexOf("', $$") + 4;
    const body = help.slice(start, help.indexOf('$$', start));
    assert.ok(body.includes('## Blog and Email: Topics'));
    assert.ok(body.includes('Results ▸ Emails by topic'));
    assert.ok(!body.includes(';'));
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
