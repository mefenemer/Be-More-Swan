// tests/blog-archive-and-refresh.test.ts
// Three faults reported together on 2026-08-19, all from one place: the Blogs tab and Blog Studio
// disagreeing about what removing a draft means.
//
// 1. "Discard draft" ran blog-posts.ts's DELETE, which was a HARD delete — the row gone and its
//    blog_post_assets / blog_ab_stats cascaded away. One click, unrecoverable, from a button sitting
//    next to an Archive tab that implied the opposite.
// 2. That Archive tab could never show anything: _RQ_BLOG_STATUS.archived was [], under a comment
//    asserting "there's no rejected/archived blog state". set-draft-horizon.ts has always set
//    status='archived' on every draft beyond the window when a horizon SHRINKS — so those posts
//    were in the database and listed by no tab in the product.
// 3. Archiving from inside Blog Studio left the Review count one too high: closeBlogStudio() tore
//    down the modal and notified nobody, and the list, the column counts and the tab badge are all
//    written by the same render pass.
//
// Pure: source scans + a DOM-free check of the notify contract. No DB, no network.
// Run:  npx tsx tests/blog-archive-and-refresh.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { landmark } from './landmark';

let passed = 0;
const check = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

const api = read('../netlify/functions/blog-posts.ts');
const js = read('../assistants.js');
const modal = read('../src/components/blog-studio-modal.js');
const horizon = read('../netlify/functions/set-draft-horizon.ts');

console.log('\nRemoving a draft archives it — it does not destroy it\n');

check('blog-posts DELETE archives instead of deleting the row', () => {
    const start = landmark(api, "if (event.httpMethod === 'DELETE')");
    const slice = api.slice(start, start + 2200);
    assert.ok(/status: 'archived'/.test(slice), 'the handler no longer archives');
    assert.ok(!/db\.delete\(blogPosts\)/.test(slice),
        'the row is still being destroyed — assets and A/B stats cascade with it');
});

check('a published post is still refused', () => {
    // Archiving something live on the reader's site would silently pull it from the widget.
    const start = landmark(api, "if (event.httpMethod === 'DELETE')");
    const slice = api.slice(start, start + 2200);
    assert.ok(slice.includes("post.status === 'published'"), 'the published guard is gone');
    assert.ok(/statusCode: 409/.test(slice), 'a published post no longer 409s');
});

check('archiving frees the slot, so autopilot can redraft it', () => {
    // blog-gap-fill counts only pre-publication statuses as coverage; 'archived' must stay out of
    // that list or an archived draft would hold its slot empty forever.
    const gapFill = read('../src/utils/blog-gap-fill.ts');
    const start = landmark(gapFill, "status IN (");
    const slice = gapFill.slice(start, start + 160);
    assert.ok(!slice.includes('archived'), 'an archived draft would block its own slot from refilling');
});

console.log('\nThe Archive tab can actually show them\n');

check('_RQ_BLOG_STATUS.archived is wired to the archived status', () => {
    const start = landmark(js, 'const _RQ_BLOG_STATUS = {');
    const slice = js.slice(start, start + 400);
    assert.ok(/archived:\s*\['archived'\]/.test(slice),
        'the Archive tab is still an empty list — archived posts remain unreachable');
});

check('the comment denying an archived blog state is gone', () => {
    assert.ok(!js.includes("there's no rejected/archived blog state"),
        'the comment that justified the empty list is still there');
});

check('horizon shrink writes exactly the status the tab now lists', () => {
    // If these two ever drift, drafts vanish again — this is the pairing that failed.
    assert.ok(/\.set\(\{ status: 'archived'/.test(horizon), 'set-draft-horizon no longer archives');
    const start = landmark(js, 'const _RQ_BLOG_STATUS = {');
    assert.ok(js.slice(start, start + 400).includes("'archived'"));
});

console.log('\nThe UI stops promising permanence, and refreshes itself\n');

check('neither surface tells the user archiving cannot be undone', () => {
    assert.ok(!modal.includes('This cannot be undone'), 'Blog Studio still warns of permanence');
    const start = landmark(js, "if (action === 'delete')");
    const slice = js.slice(start, start + 700);
    assert.ok(!slice.includes('This cannot be undone.'), 'the list card still warns of permanence');
    assert.ok(/Archive this blog draft\?/.test(slice), 'the confirm still says delete');
});

check('the modal notifies the host page on every lifecycle move', () => {
    assert.ok(modal.includes('function notifyChanged('), 'no notify hook exists');
    // Archive, approve, manual schedule, unschedule, unpublish and publish each move a post
    // between columns. Counted on the bare name so an argument at any site still registers.
    const calls = modal.split(/\bnotifyChanged\(/).length - 1;
    assert.ok(calls >= 7, `expected the definition plus 6 call sites, found ${calls} occurrences`);
});

check('the host page turns that into a real refresh of list AND badge', () => {
    const start = landmark(js, 'window._onBlogStudioChanged = function(');
    const slice = js.slice(start, start + 1800);
    assert.ok(/detailRqRefresh/.test(slice), 'the list and its counts are never re-rendered');
    // detailRqRefresh is what recomputes the column counts and the Review tab badge.
    const refresh = js.slice(landmark(js, 'window.detailRqRefresh = function()'), landmark(js, 'window.detailRqRefresh = function()') + 400);
    assert.ok(refresh.includes('_detailRqRefreshColumnCounts'), 'the refresh no longer updates counts');
    assert.ok(refresh.includes('_detailRqRenderGroups'), 'the refresh no longer re-renders the column');
});

check('the autopilot card refreshes through its own renderer, not a hardcoded flag', () => {
    // _loadBlogAutopilotStats's 2nd arg gates the "Next post" line on the schedule being active;
    // passing true would advertise a next post for an on-demand assistant that has no schedule.
    const start = landmark(js, 'window._onBlogStudioChanged = function(');
    const slice = js.slice(start, start + 1800);
    assert.ok(/_renderAutopilotCard\?\.\(\)/.test(slice), 'the card is not refreshed via its renderer');
    assert.ok(!/_loadBlogAutopilotStats\([^)]*,\s*true\)/.test(slice),
        'scheduleActive is hardcoded true — on-demand assistants would show a phantom next post');
});

console.log(`\n${passed} checks passed\n`);
