// tests/content-pillars-phase2.test.ts
// Content pillars phase 2 (docs/pillar-records-plan.md): the Social chat's one-pillar card, "Bring back"
// for archived pillars, posts per pillar on Results, and the help article.
//
// Run:  npx tsx tests/content-pillars-phase2.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPillarCard, pillarPromptBlock, PILLAR_CARD_TYPE } from '../src/utils/chat-pillar-card';
import { pillarUsageRows, type Pillar } from '../src/utils/content-pillars-store';
import { assistantSetupFieldBlock } from '../src/utils/chat-setup-field';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const row = (id: number, name: string, sortOrder: number, isActive = true, description: string | null = null): Pillar =>
    ({ id, name, description, sortOrder, isActive });

const LIVE = [row(1, 'Time saving', 0, true, 'hours back'), row(2, 'Revenue', 1), row(3, 'Food', 2, false)];
const ARCHIVED = [row(9, 'Customer stories', 3, false, 'real clients')];
const card = (req: Record<string, unknown>, live = LIVE, archived = ARCHIVED) => buildPillarCard(20, { type: PILLAR_CARD_TYPE, ...req }, live, archived);

// ── The chat card ───────────────────────────────────────────────────────────────────────────────

check('add: a new name, switched on, with its description', () => {
    const c = card({ action: 'add', name: '  Quick   tips ', description: 'one tip a post', summary: 'Add tips' });
    assert.ok(!('error' in c));
    assert.deepStrictEqual(c.change, { name: 'Quick tips', description: 'one tip a post' });
    assert.strictEqual(c.pillarId, null);
    assert.strictEqual(c.assistantId, 20);
});

check('add: a live name is refused; an ARCHIVED name becomes "bring back" (keeps its history)', () => {
    assert.match((card({ action: 'add', name: 'revenue' }) as { error: string }).error, /already a pillar called "Revenue"/);
    const c = card({ action: 'add', name: 'customer stories' });
    assert.ok(!('error' in c));
    assert.strictEqual(c.action, 'restore');
    assert.strictEqual(c.pillarId, 9);
});

check('add with five on is refused; switched off is allowed', () => {
    const five = [1, 2, 3, 4, 5].map((i) => row(i, `P${i}`, i));
    assert.match((card({ action: 'add', name: 'Six' }, five) as { error: string }).error, /5 pillars are already switched on/);
    const off = card({ action: 'add', name: 'Six', isActive: false }, five);
    assert.ok(!('error' in off));
    assert.deepStrictEqual(off.change, { name: 'Six', isActive: false });
});

check('update: only what changes; nothing changing is refused; renames cannot collide', () => {
    const c = card({ action: 'update', pillarId: 1, name: 'Time saving', description: 'Hours back each week' });
    assert.ok(!('error' in c));
    assert.deepStrictEqual(c.change, { description: 'Hours back each week' });
    assert.deepStrictEqual(c.before, { name: 'Time saving', description: 'hours back', isActive: true });
    assert.match((card({ action: 'update', pillarId: 1, description: 'hours back' }) as { error: string }).error, /nothing would change/);
    assert.match((card({ action: 'update', pillarId: 1, name: 'revenue' }) as { error: string }).error, /already a pillar/);
    const clear = card({ action: 'update', pillarId: 1, description: '' });
    assert.ok(!('error' in clear));
    assert.deepStrictEqual(clear.change, { description: null }, '"" clears the description');
});

check('update: switching on respects the five', () => {
    const five = [1, 2, 3, 4, 5].map((i) => row(i, `P${i}`, i)).concat(row(6, 'Off one', 6, false));
    assert.match((card({ action: 'update', pillarId: 6, isActive: true }, five) as { error: string }).error, /already switched on/);
    const on = card({ action: 'update', pillarId: 3, isActive: true });
    assert.ok(!('error' in on));
    assert.deepStrictEqual(on.change, { isActive: true });
});

check('archive and restore name real rows only', () => {
    assert.ok(!('error' in card({ action: 'archive', pillarId: 2 })));
    assert.match((card({ action: 'archive', pillarId: 99 }) as { error: string }).error, /isn't in the list/);
    const r = card({ action: 'restore', pillarId: 9 });
    assert.ok(!('error' in r));
    assert.strictEqual(r.landsOff, false);
    assert.match((card({ action: 'restore', pillarId: 2 }) as { error: string }).error, /archived pillar isn't in the list/);
    assert.match((card({ action: 'delete', pillarId: 2 }) as { error: string }).error, /add, change, archive or bring back/);
});

check('the prompt lists pillars with ids, archived ones, and the card shape', () => {
    const block = pillarPromptBlock(20, LIVE, ARCHIVED)!;
    assert.match(block, /2 of 5 switched on/);
    assert.match(block, /#1 "Time saving" — hours back/);
    assert.match(block, /#3 "Food" \(switched off\)/);
    assert.match(block, /#9 "Customer stories"/);
    assert.match(block, /"type":"pillar_proposal"/);
    assert.match(block, /Never say a pillar has been changed/);
    assert.strictEqual(pillarPromptBlock(20, null, []), null, 'no card before the SQL');
});

check('the Social set-up answers leave content_pillars out when the pillar card is offered', () => {
    const ctx = { content_pillars: ['A', 'B'], tone_of_voice: 'Warm', target_audience: 'Makers' };
    const withAll = assistantSetupFieldBlock('social_media_manager', 20, ctx)!;
    assert.match(withAll, /- content_pillars —/);
    const without = assistantSetupFieldBlock('social_media_manager', 20, ctx, { omitKeys: ['content_pillars'] })!;
    assert.ok(!/content_pillars —/.test(without));
    assert.match(without, /- tone_of_voice —/, 'other answers stay');
});

// ── Results: posts per pillar ───────────────────────────────────────────────────────────────────

check('usage: every live pillar (0 included), counted by id, then by name; archived names kept', () => {
    const rows = pillarUsageRows(LIVE, ARCHIVED, [
        { pillarId: 1, pillar: 'Old name for time saving', n: 4 },  // renamed: still counts for #1
        { pillarId: null, pillar: 'revenue', n: 2 },                 // pre-records post, by name
        { pillarId: 9, pillar: 'Customer stories', n: 3 },           // archived pillar with posts
        { pillarId: null, pillar: 'Gone theme', n: 1 },              // an old text pillar
    ]);
    assert.deepStrictEqual(rows.map((r) => [r.name, r.posts, r.isActive, r.archived]), [
        ['Time saving', 4, true, false],
        ['Revenue', 2, true, false],
        ['Food', 0, false, false],
        ['Customer stories', 3, false, true],
        ['Gone theme', 1, false, true],
    ]);
});

// ── Wiring (source scans) ───────────────────────────────────────────────────────────────────────

const orch = read('netlify/functions/chat-orchestrator.ts');
const api = read('netlify/functions/content-pillars.ts');
const registry = read('src/components/disruptive-ui-registry.js');
const list = read('src/components/pillar-list.js');
const detail = read('assistant-detail.html');
const assistants = read('assistants.js');
const help = read('db/z-content-pillars-help-2026-11-11.sql');

check('orchestrator: pillar block on the Social route, card rebuilt from rows, set-up card refuses pillars', () => {
    assert.match(orch, /assistantRow\.roleKey === 'social_media_manager'\s*\? await buildPillarChatBlock\(db, orgId, session\.aiAssistantId\)/);
    assert.match(orch, /scheduleBlock, setupFieldBlock, pillarsBlock, platformsBlock,/);
    assert.match(orch, /await resolvePillarProposal\(db, orgId, session\.aiAssistantId, pillarReq\)/);
    assert.match(orch, /!isMentor && pillarsBlock && setupReq\.key === 'content_pillars'/);
});

check('endpoint: restore, archived list, and usage', () => {
    assert.ok(api.includes("case 'restore':"));
    assert.match(api, /archived: await listRestorablePillars\(db, orgId, assistantId\)/);
    assert.match(api, /queryStringParameters\?\.usage === '1'/);
});

check('chat card applies through the same endpoint, reloads the list, offers a redraft', () => {
    assert.ok(registry.includes("register('pillar_proposal'"));
    const i = registry.indexOf("register('pillar_proposal'");
    const body = registry.slice(i, registry.indexOf("register('share_for_review_proposal'"));
    assert.ok(body.includes("fetch('/.netlify/functions/content-pillars'"));
    assert.ok(body.includes('window.PillarList?.reload()'));
    assert.ok(body.includes('window.offerRedraftUpcoming?.('));
});

check('profile: archived pillars with "Bring back"; Results: posts by pillar', () => {
    assert.match(list, /data-act="restore"/);
    assert.match(list, /run\(\{ action: 'restore', pillarId: id \}\)/);
    assert.match(detail, /<div id="autopilot-pillars" class="mt-4 pt-4 border-t border-gray-100 hidden">/);
    assert.match(assistants, /if \(currentData\.roleKey === 'social_media_manager'\) window\.PillarList\?\.renderUsage\(assistantId\);/);
});

check('help article: upserted, $$-quoted, no semicolons in the body', () => {
    assert.match(help, /INSERT INTO help_articles \(category, sort_order, title, content_md, is_published\) VALUES/);
    assert.match(help, /ON CONFLICT \(title\) DO UPDATE SET/);
    const start = help.indexOf("', $$") + 4;
    const bodyText = help.slice(start, help.indexOf('$$', start));
    assert.ok(bodyText.includes('# Content Pillars'), 'found the body');
    assert.ok(!bodyText.includes(';'), 'the Neon editor splits pasted scripts on semicolons');
    for (const s of ['Bring back', 'Posts by pillar', 'Archive', 'Description']) assert.ok(bodyText.includes(s), s);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
