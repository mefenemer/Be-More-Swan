// tests/video-archive.test.ts
// Bulk archive / restore / delete on the Video Producer's Videos tab (owner, 2026-11-10), its chat twin,
// and "🎯 Select" in place of the tab's own "Talk it through" wording.
//
// Run:  npx tsx tests/video-archive.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const fn = read('netlify/functions/video-projects.ts');
const tab = read('src/components/assistant-videos.js');

check('the column exists in SQL and the Drizzle mirror', () => {
    assert.ok(read('db/z-video-archive.sql').includes('ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;'));
    assert.ok(read('db/schema.ts').includes('archivedAt: timestamp("archived_at"),'));
});

check('archive / restore / delete: org-scoped, before the plan gate, never on a video being made', () => {
    const at = fn.indexOf("if (action === 'archive' || action === 'restore' || action === 'delete')");
    assert.ok(at > 0);
    assert.ok(at < fn.indexOf('// The gate, before anything is planned or spent.'), 'tidying needs no video plan');
    const block = fn.slice(at, fn.indexOf('// The gate, before anything is planned or spent.'));
    assert.ok(block.includes('eq(videoProjects.organisationId, orgId), inArray(videoProjects.id, ids)'), 'reads only this workspace');
    assert.ok(block.includes('eq(videoProjects.organisationId, orgId), inArray(videoProjects.id, ok)'), 'writes only this workspace');
    assert.ok(block.includes('BULK_BUSY.includes(r.status)'));
    assert.ok(block.includes("NOT IN ('reviewing','planning','building','rendering')"), 'checked again in the write');
    assert.ok(fn.includes("const BULK_BUSY = ['reviewing', 'planning', 'building', 'rendering'];"));
    assert.ok(tab.includes("const MAKING = ['reviewing', 'planning', 'building', 'rendering'];"), 'the tab disables the same ones');
    assert.ok(!block.includes('contentAssets'), 'delete never touches the finished file in My Content');
});

check('the list keeps 50 live videos and returns the archived ones beside them', () => {
    assert.ok(fn.includes('and(scope, isNull(videoProjects.archivedAt))'));
    assert.ok(fn.includes('and(scope, isNotNull(videoProjects.archivedAt))'));
    assert.ok(read('src/utils/video-producer.ts').includes('archivedAt: row.archivedAt ?? null,'));
});

check('the tab: an Archived pill, select boxes, a bar, delete asks first', () => {
    assert.ok(tab.includes("{ key: 'archived', label: 'Archived', statuses: [] }"));
    assert.ok(tab.includes("return state.videos.filter((v) => !v.archivedAt && st.statuses.includes(v.status));"), 'archived videos leave every other stage');
    assert.ok(tab.includes('data-vid-pick="${v.id}"'));
    assert.ok(tab.includes('data-vid-act="pick-all"') && tab.includes('data-vid-bulkbar'));
    const bulk = tab.slice(tab.indexOf('async function bulk('), tab.indexOf('function render()'));
    assert.ok(bulk.indexOf('window.confirmModal') > 0 && bulk.indexOf('window.confirmModal') < bulk.indexOf("call('POST'"), 'delete is confirmed before it is sent');
    assert.ok(tab.includes("const waits = (v) => !v.archivedAt &&"), 'archived storyboards stop counting as Needs you');
});

check('the tick box is read on change, and the pill change clears the selection', () => {
    assert.ok(tab.includes("t.matches('[data-vid-pick]')"));
    assert.ok(tab.includes('state.selected.clear(); state.bulkNote = null; render();'));
});

check('chat: a card for it, the same actions, and archived videos out of the working list', () => {
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.ok(reg.includes("register('video_tidy_proposal', renderVideoTidyProposalCard);"));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('"type": "video_tidy_proposal"'));
    const vp = read('src/utils/video-producer.ts');
    assert.ok(vp.includes('eq(videoProjects.aiAssistantId, assistantId), isNull(videoProjects.archivedAt)))'));
    assert.ok(vp.includes('ARCHIVED VIDEOS (on the "Archived" pill'));
    assert.ok(read('src/utils/review-waiting.ts').includes("eq(videoProjects.status, 'planned'), isNull(videoProjects.archivedAt)"));
});

check('"🎯 Select" on a video, as on every assistant — not "Talk it through"', () => {
    assert.ok(!tab.includes('>Talk it through<'));
    assert.ok(tab.includes('title="Ask ${who()} about this video" class="text-xs font-bold text-indigo-700 hover:underline shrink-0 whitespace-nowrap">🎯 Select</button>'));
});

check('help article section is guarded and has no semicolons in its body', () => {
    const sql = read('db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzz-video-archive.sql');
    const body = sql.slice(sql.indexOf('$$') + 2, sql.lastIndexOf('$$'));
    assert.ok(!body.includes(';'));
    assert.ok(sql.includes("AND content_md NOT LIKE '%## Archiving and deleting videos%'"));
});

console.log(`\n${passed} passed`);
