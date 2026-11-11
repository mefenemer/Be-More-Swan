// tests/content-topics-3a.test.ts
// Blog and Email topics as records (docs/pillar-records-plan.md §7, phase 3a): the same content_pillars
// rows, named "topic", 8 on, derived back to blogTopics / newsletterTopics TEXT; each blog post and email
// records its topic and the next draft takes the topic used least.
//
// Run:  npx tsx tests/content-topics-3a.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PILLAR_PROFILES, pillarProfileFor, derivedContextValue, SOCIAL_PILLAR_PROFILE } from '../src/utils/pillar-profiles';
import { planNameSync, validatePillarFields, type Pillar } from '../src/utils/content-pillars-store';
import { countsForTopics, topicLine } from '../src/utils/topic-balance';
import { parsePillars, parsePillarsUpTo } from '../src/public/content-pillars.js';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const row = (id: number, name: string, sortOrder: number, isActive = true): Pillar => ({ id, name, description: null, sortOrder, isActive });

// ── Pure ────────────────────────────────────────────────────────────────────────────────────────

check('profiles: Social pillars (array, 5, 60 days); Blog and Email topics (text, 8, 90 days)', () => {
    assert.deepStrictEqual(
        Object.values(PILLAR_PROFILES).map((p) => [p.roleKey, p.contextKey, p.asText, p.maxActive, p.noun, p.balanceDays]),
        [
            ['social_media_manager', 'content_pillars', false, 5, 'pillar', 60],
            ['blog_writer', 'blogTopics', true, 8, 'topic', 90],
            ['newsletter_editor', 'newsletterTopics', true, 8, 'topic', 90],
        ]);
    assert.strictEqual(pillarProfileFor('lead_qualifier'), null);
    assert.strictEqual(pillarProfileFor(null), null);
});

check('derived value: an array for Social, "A, B, C" text for Blog and Email', () => {
    assert.deepStrictEqual(derivedContextValue(SOCIAL_PILLAR_PROFILE, ['A', 'B']), ['A', 'B']);
    assert.strictEqual(derivedContextValue(PILLAR_PROFILES.blog_writer, ['Dogs', 'Grooming tips']), 'Dogs, Grooming tips');
    assert.strictEqual(derivedContextValue(PILLAR_PROFILES.newsletter_editor, []), '');
});

check('one splitter, two caps: parsePillars stays at 5, parsePillarsUpTo(…, 8) keeps 8', () => {
    const text = 'a, b, c, d, e, f, g, h, i';
    assert.strictEqual(parsePillars(text).length, 5);
    assert.deepStrictEqual(parsePillarsUpTo(text, 8), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    assert.strictEqual(parsePillarsUpTo(text, 0).length, 5, 'a bad cap falls back to 5');
});

check('text sync respects the role cap', () => {
    assert.strictEqual(planNameSync([], 'a, b, c, d, e, f, g, h, i').creates.length, 5, 'default is the Social cap');
    assert.strictEqual(planNameSync([], 'a, b, c, d, e, f, g, h, i', [], 8).creates.length, 8);
    const rows = [row(1, 'Dogs', 0), row(2, 'Cats', 1)];
    const plan = planNameSync(rows, 'Dogs, Cats, Birds, Fish, Rabbits, Horses, Lizards', [], 8);
    assert.deepStrictEqual(plan.creates.map((c) => c.name), ['Birds', 'Fish', 'Rabbits', 'Horses', 'Lizards']);
    assert.deepStrictEqual(plan.archives, []);
});

check('messages say "topic" for Blog and Email', () => {
    assert.match((validatePillarFields({ name: ' ' }, PILLAR_PROFILES.blog_writer) as { error: string }).error, /Give the topic a name/);
    assert.match((validatePillarFields({ name: 'x'.repeat(61) }, PILLAR_PROFILES.newsletter_editor) as { error: string }).error, /A topic name/);
    assert.match((validatePillarFields({ name: ' ' }) as { error: string }).error, /Give the pillar a name/, 'Social unchanged');
});

check('topic counts: by id, then by name for drafts without one', () => {
    const topics = [{ id: 1, name: 'Dogs', description: null }, { id: 2, name: 'Cats', description: 'indoor cats' }, { id: null, name: 'Fish', description: null }];
    assert.deepStrictEqual(countsForTopics(topics, [
        { pillarId: 1, pillar: 'Old dogs name', n: 3 },
        { pillarId: null, pillar: 'Cats', n: 1 },
        { pillarId: null, pillar: 'Fish', n: 2 },
        { pillarId: 9, pillar: 'Cats', n: 5 },   // another row's id: not Cats (#2)
    ]), [3, 1, 2]);
    assert.strictEqual(topicLine(topics[1]), '"Cats" (what belongs under it: indoor cats)');
    assert.strictEqual(topicLine(topics[0]), '"Dogs"');
});

// ── Wiring (source scans) ───────────────────────────────────────────────────────────────────────

const sqlFile = read('db/z-content-topics.sql');
const schema = read('db/schema.ts');
const store = read('src/utils/content-pillars-store.ts');
const ctxSave = read('netlify/functions/update-assistant-context.ts');
const api = read('netlify/functions/content-pillars.ts');
const ideation = read('src/utils/blog-topic-ideation.ts');
const blogJobs = read('netlify/functions/process-blog-jobs.ts');
const email = read('netlify/functions/draft-newsletter-issues.ts');
const assistants = read('assistants.js');
const list = read('src/components/pillar-list.js');
const backfill = read('scripts/backfill-content-pillars.ts');

check('SQL: pillar_id + pillar on blog_posts and newsletter_issues; schema mirrors them', () => {
    for (const t of ['blog_posts', 'newsletter_issues']) {
        assert.match(sqlFile, new RegExp(`ALTER TABLE ${t}\\s+ADD COLUMN IF NOT EXISTS pillar_id INTEGER REFERENCES content_pillars\\(id\\) ON DELETE SET NULL,\\s+ADD COLUMN IF NOT EXISTS pillar TEXT;`));
    }
    assert.strictEqual((schema.match(/pillarId: integer\("pillar_id"\)\.references\(\(\) => contentPillars\.id/g) || []).length, 3, 'scheduled_posts, blog_posts, newsletter_issues');
});

check('store: the derived write uses the role\'s key and shape', () => {
    assert.match(store, /ARRAY\[\$\{prof\.contextKey\}\]::text\[\]/);
    assert.match(store, /const value = derivedContextValue\(prof, names\);/);
    assert.match(store, /return \{ key: prof\.contextKey, value: derivedContextValue\(prof, names\) \};/);
});

check('save path: carries the topic keys across and reconciles a text answer under the role\'s key', () => {
    assert.match(ctxSave, /const CARRY_ACROSS = \['content_pillars', 'blogTopics', 'newsletterTopics', /);
    assert.match(ctxSave, /const synced = await syncPillarsFromNames\(tx, orgId, assistantId, mergedContext\[pillarKey\]\);/);
    assert.match(ctxSave, /if \(synced\) mergedContext\[synced\.key\] = synced\.value;/);
});

check('endpoint: any role with a profile; words and cap from the role; Results stays Social for now', () => {
    assert.match(api, /const profile = pillarProfileFor\(asst\.roleKey\);/);
    assert.match(api, /noun: p\.noun, nounPlural: p\.nounPlural/);
    assert.match(api, /if \(profile\.contextKey !== 'content_pillars'\) return json\(200, \{ usage: null/);
});

check('Blog: an undirected slot gets the least-used topic, saved on the post', () => {
    assert.match(ideation, /table: 'blog_posts', days: PILLAR_PROFILES\.blog_writer\.balanceDays, slot/);
    assert.match(ideation, /const chosenTopic = guidance \|\| inspoTopic \? null : topicChoice\.chosen;/);
    assert.match(ideation, /Topic for THIS post \(write squarely within it/);
    assert.match(blogJobs, /pillarId: idea\.pillarId \?\? null,\s+pillar: idea\.pillar \?\? null,/);
});

check('Email: a lead topic per issue, the others as "may also mention", saved on the issue', () => {
    assert.match(email, /table: 'newsletter_issues', days: PILLAR_PROFILES\.newsletter_editor\.balanceDays/);
    assert.match(email, /pillarId: lead\?\.id \?\? null,\s+pillar: lead\?\.name \?\? null,/);
    assert.match(email, /It may also briefly mention: /);
    assert.ok(!email.includes('actx.newsletterTopics'), 'the whole text is no longer every issue\'s topic');
});

check('settings: a topics list in Operational Setup; the autosave never sends the topic keys', () => {
    assert.match(assistants, /const _TOPIC_RECORD_KEYS = \['blogTopics', 'newsletterTopics'\];/);
    assert.match(assistants, /<div id="topics-list" aria-labelledby="topics-heading"><\/div>/);
    assert.match(assistants, /for \(const k of _TOPIC_RECORD_KEYS\) delete newContext\[k\];/);
    assert.match(assistants, /window\.PillarList\?\.mount\(document\.getElementById\('topics-list'\)/);
    assert.match(list, /const value = isSocial\(\) \? names : names\.join\(', '\);/);
    assert.match(list, /if \(offerRedraft && isSocial\(\)\) window\.offerRedraftUpcoming/);
});

check('⚠️ customer words: Blog/Email copy says "topic", never "pillar"', () => {
    // The topics block in Operational Setup and the list's non-Social branches.
    const block = assistants.slice(assistants.indexOf('<h4 id="topics-heading"'), assistants.indexOf('<div id="topics-list"'));
    assert.ok(block.length > 0 && !/pillar/i.test(block), block);
    assert.match(list, /'No topics yet\. Add the subjects you want to write about\.'/);
});

check('a reply for another assistant never paints into the list (staging 2026-11-11: Misty into Mira)', () => {
    assert.match(list, /const stillFor = \(host, assistantId\) => state\.host === host && state\.assistantId === assistantId;/);
    assert.ok((list.match(/if \(!stillFor\(host, assistantId\)\) return;/g) || []).length >= 2, 'reload and run both check');
    assert.match(list, /if \(!box\.isConnected\) return;/, 'Results bars too');
});

check('backfill covers Blog and Email assistants', () => {
    assert.match(backfill, /inArray\(masterAssistants\.roleKey, Object\.keys\(PILLAR_PROFILES\)\)/);
    assert.match(backfill, /parsePillarsUpTo\(\(a\.ctx as Record<string, unknown> \| null\)\?\.\[prof\.contextKey\], prof\.maxActive\)/);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
