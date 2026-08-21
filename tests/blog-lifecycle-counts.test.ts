// tests/blog-lifecycle-counts.test.ts
// Three faults reported together on 2026-08-21, all downstream of one omission: the Blog Writer's
// Review Queue counted exactly ONE of its lifecycle columns, and Publish told nobody it had run.
//
// 1. Scheduling a blog left the Scheduled tab's count unchanged. _detailRqRefreshColumnCounts
//    returns early for blog queues ("the blog renderer sets its own badge"), and the blog renderer
//    only ever wrote `review` — and only while Review happened to be the open column. Every other
//    column's badge was therefore never written at all, by anything, ever.
// 2. Publishing a blog left the Published tab's count unchanged, for the same reason and one more:
//    the modal's Publish handler was the only lifecycle action that never called notifyChanged().
// 3. Publish gave no busy signal, kept the modal open on success, and left the author on Review
//    looking at a list their post had just left — with a live Unpublish button offering to undo it.
//
// Pure: source scans. No DB, no network.
// Run:  npx tsx tests/blog-lifecycle-counts.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { landmark } from './landmark';

let passed = 0;
const check = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

const js = read('../assistants.js');
const modal = read('../src/components/blog-studio-modal.js');
const detail = read('../assistant-detail.html');
const integrations = read('../integrations.js');
const store = read('../src/utils/blog-destinations/store.ts');
const syndicate = read('../src/utils/blog-destinations/syndicate.ts');
const blogPublish = read('../src/utils/blog-publish.ts');
const publishFn = read('../netlify/functions/publish-blog.ts');
const repushFn = read('../netlify/functions/publish-blog-destinations.ts');

console.log('\n(1) Every lifecycle column is counted, not just Review\n');

const paint = js.slice(landmark(js, 'function _detailRqPaintBlogCounts('),
                       landmark(js, 'async function _detailRqRenderBlog('));

check('the blog renderer paints EVERY visible column, not only the open one', () => {
    assert.ok(/Object\.keys\(_DETAIL_RQ_COLUMNS\)/.test(paint),
        'the counter still looks at one column — Scheduled and Published stay blank forever');
    assert.ok(/_detailRqSetColumnBadge\(key, n\)/.test(paint), 'nothing writes the per-column badge');
});

check('a column with no blog status is cleared, not skipped', () => {
    // 'attention' is a POST state (a publish attempt that failed); a blog post has none. Leaving it
    // unwritten would strand whatever the previously-viewed role left in that badge.
    assert.ok(/_RQ_BLOG_STATUS\[key\] \|\| \[\]/.test(paint), 'an unmapped column is not defaulted');
    assert.ok(/wanted\.length \? [\s\S]{0,80}: 0/.test(paint), 'an unmapped column is skipped rather than zeroed');
});

check('the counts come from ONE fetch, and it happens before the early return', () => {
    const render = js.slice(landmark(js, 'async function _detailRqRenderBlog('),
                            landmark(js, 'window._detailRqBlogAct = '));
    // Counting per column would re-fetch the whole list once per tab — blog-posts has no status filter.
    assert.strictEqual(render.split('/.netlify/functions/blog-posts?assistantId=').length - 1, 1,
        'the renderer fetches more than once per render');
    // A column blog posts cannot occupy still has to repaint the columns they DO occupy.
    assert.ok(landmark(render, 'blog-posts?assistantId=') < landmark(render, 'don’t have this state'),
        'the "no such state" bail-out runs before the fetch, so the other counts never repaint');
    assert.ok(landmark(render, '_detailRqPaintBlogCounts(all)') < landmark(render, 'don’t have this state'),
        'the counts are painted after the bail-out, so they never run for that column');
});

check('the Review pill and Autopilot card track Review from any open column', () => {
    // These used to sit inside `if (statusKey === 'review')`, so approving from the Scheduled tab
    // left the amber pill reading its pre-action value.
    assert.ok(/_setDetailRqTabBadge\(review\)/.test(paint), 'the amber tab pill is no longer written');
    assert.ok(/_setPendingReviewCount\?\.\(review\)/.test(paint), 'the Autopilot card no longer follows');
    assert.ok(/_updateOpSignals\?\.\(\{ pendingReview: review \}\)/.test(paint), 'op signals no longer follow');
});

check('_detailRqRefreshColumnCounts still delegates rather than double-counting', () => {
    const counts = js.slice(landmark(js, 'window._detailRqRefreshColumnCounts = async function('),
                            landmark(js, 'async function _detailRqRenderGroups('));
    assert.ok(/rq\.source === 'blog_posts'\) return;/.test(counts),
        'blog queues now count here too — that is one whole-list fetch per column');
});

console.log('\n(2) Publish reports itself to the page underneath\n');

const publish = modal.slice(landmark(modal, "el('bs-publish').addEventListener('click'"),
                            landmark(modal, "el('bs-pick-time').addEventListener('click'"));

check('publish notifies the host and names the column to open', () => {
    assert.ok(/notifyChanged\(\{ focusStatus: 'posted' \}\)/.test(publish),
        'publish still tells nobody — the Published count keeps its pre-publish value');
});

check('the host opens that column, and falls back to a plain refresh without one', () => {
    const host = js.slice(landmark(js, 'window._onBlogStudioChanged = function('),
                          landmark(js, "document.addEventListener('blog:created'"));
    assert.ok(/opts && opts\.focusStatus/.test(host), 'the requested column is ignored');
    assert.ok(/_DETAIL_RQ_COLUMNS\[focus\]/.test(host), 'an unknown column name is passed straight through');
    assert.ok(/detailRqOpenStatus\?\.\(focus\)/.test(host), 'the column is never actually opened');
    assert.ok(/detailRqRefresh\?\.\(\)/.test(host), 'the no-focus path no longer refreshes at all');
});

check('every other lifecycle move in the modal notifies too', () => {
    // Unschedule (Scheduled → Review) and unpublish (Published → Review) move two counts each and
    // were as silent as publish was.
    const unschedule = modal.slice(landmark(modal, "el('bs-unschedule').addEventListener('click'"),
                                   landmark(modal, "el('bs-unpublish').addEventListener('click'"));
    assert.ok(/notifyChanged\(/.test(unschedule), 'unschedule leaves both counts stale');
    const unpublish = modal.slice(landmark(modal, "el('bs-unpublish').addEventListener('click'"),
                                  landmark(modal, "el('bs-generate-hooks').addEventListener('click'"));
    assert.ok(/notifyChanged\(/.test(unpublish), 'unpublish leaves both counts stale');
});

check('the column the modal asks for is one the page actually has', () => {
    // A focusStatus naming a data-status that no button carries would silently do nothing.
    const asked = publish.match(/focusStatus: '([a-z]+)'/)?.[1];
    assert.ok(asked, 'publish names no column');
    assert.ok(detail.includes(`data-status="${asked}"`), `no lifecycle button carries data-status="${asked}"`);
    assert.ok(detail.includes(`id="detail-rq-col-count-${asked}"`), `the "${asked}" column has no count badge to write`);
});

console.log('\n(3) Publish looks like it is working, then gets out of the way\n');

check('the wait cursor is armed before the request and cleared on both outcomes', () => {
    assert.ok(landmark(publish, 'setBusy(true)') < landmark(publish, "api('publish-blog'"),
        'the busy state is set after the request is fired');
    // Twice: once at the head of the .then (covering both the ok and the server-error paths) and
    // once in the .catch. Cleared BEFORE the branch, so no early `return` can skip it.
    assert.strictEqual(publish.split('setBusy(false)').length - 1, 2,
        'expected setBusy(false) on the settled path and on the rejected one');
    assert.ok(landmark(publish, 'setBusy(false)', landmark(publish, "api('publish-blog'")) < landmark(publish, 'if (!res.ok)'),
        'the busy state is cleared inside a branch — the other branch stays frozen');
    // A rejected promise (network drop) must not strand the modal disabled under a wait cursor.
    assert.ok(/\}\)\.catch\(function \(\) \{\s*setBusy\(false\);/.test(publish),
        'a network failure leaves the modal frozen with no way out');
});

check('busy is a real cursor, not just a disabled button', () => {
    assert.ok(/#bms-blog-backdrop\.bs-busy[^']*cursor:progress !important/.test(modal),
        'nothing paints the wait cursor — !important is needed to beat .bs-btn:disabled');
    const busy = modal.slice(landmark(modal, 'function setBusy('), landmark(modal, 'function refreshReadout('));
    assert.ok(/classList\.toggle\('bs-busy'/.test(busy), 'the busy class is never applied');
    // Two publishes of the same post re-render the payload and re-run syndication.
    assert.ok(/b\.disabled = true;/.test(busy), 'the action row stays clickable mid-publish');
    // Unschedule/Unpublish are already disabled-and-hidden on a draft; a blanket re-enable would
    // hand the author buttons for states the post is not in.
    assert.ok(/dataset\.bsBusyDisabled/.test(busy), 'clearing busy re-enables buttons that were already off');
});

// Everything after the syndication-failure branch's own `return;` is the clean-publish path.
// Anchored FROM `if (failed.length)` — the first `return;` in the handler belongs to the
// server-error guard above it, and slicing from that would keep the failure branch in the tail.
const publishOk = publish.slice(landmark(publish, 'return;', landmark(publish, 'if (failed.length)')));

check('a successful publish closes the modal instead of offering to undo itself', () => {
    assert.ok(/closeBlogStudio\(\)/.test(publishOk), 'the modal stays open over the list it just changed');
    assert.ok(landmark(publish, "notifyChanged({ focusStatus: 'posted' })") < landmark(publish, 'closeBlogStudio()'),
        'the modal closes before it refreshes the page underneath');
    // Unpublish/re-push are revealed ONLY on the failure branch, where the modal stays up. On the
    // clean path the modal is closing, so offering to undo the thing just asked for is nonsense.
    assert.ok(!/bs-unpublish'\)\.classList\.remove/.test(publishOk),
        'the clean publish path still reveals Unpublish on a modal that is closing');
    // The green banner went with the modal, so the confirmation has to land somewhere visible.
    assert.ok(/showToast/.test(publishOk), 'nothing confirms the publish once the banner is gone');
});

check('an error keeps the modal open and says why', () => {
    assert.ok(/if \(!res\.ok\) \{[\s\S]{0,240}return;/.test(publish),
        'a failed publish falls through to the close-and-navigate path');
    assert.ok(/'bs-action-status'[\s\S]{0,120}'error'/.test(publish), 'the failure is not shown as one');
});

console.log('\n(4) Publishing says WHERE the post went\n');

// The fault this closes: a destination that is not connected is filtered out of syndication before
// any adapter runs — no error, no audit row — so publishing to nothing looked exactly like
// publishing to everything. In prod, swan_index_profiles was empty, so every post silently skipped
// The Swan Index while Blog Studio reported "Published ✓".

check('the row handed back carries the syndication outcomes, not the pre-syndication blob', () => {
    const slice = blogPublish.slice(landmark(blogPublish, 'syndicatePublishedPost(db, organisationId, updated)'));
    assert.ok(/updated\.destinations = \{ \.\.\.\(updated\.destinations/.test(slice),
        'the returned row still predates the destinations merge, so no caller can report the outcome');
    // The merge has to survive the best-effort catch: a thrown syndication must not take the
    // publish with it, which is why this is inside the try and not after it.
    assert.ok(landmark(slice, 'updated.destinations =') < landmark(slice, '} catch (err) {'),
        'the merge sits outside the try — a syndication throw would skip the publish’s own return');
});

check('the endpoints return labelled outcomes', () => {
    assert.ok(/summariseSyndication\(updated\.destinations\)/.test(publishFn), 'publish-blog reports nothing');
    assert.ok(/summariseSyndication\(results\)/.test(repushFn), 're-push reports nothing');
});

check('the summary drops the non-destination keys in the blob', () => {
    const fn = syndicate.slice(landmark(syndicate, 'export function summariseSyndication('),
                               landmark(syndicate, 'export async function syndicatePublishedPost('));
    // `destinations` also holds `widget` (a bare string) and the reserved `selected` array. Both
    // would otherwise render as platforms the author had pushed to.
    assert.ok(/for \(const id of BLOG_DESTINATION_IDS\)/.test(fn), 'the blob is walked by key, not by adapter id');
    assert.ok(/typeof entry !== 'object'\) continue/.test(fn), "`widget`'s bare string is reported as a destination");
});

check('Blog Studio distinguishes “went everywhere” from “went nowhere”', () => {
    assert.ok(/No other platforms are connected/.test(publishOk),
        'an empty syndication list still reports a bare success — the exact silence being fixed');
    assert.ok(/also sent to/.test(publishOk), 'a successful syndication is never named');
});

check('a destination that refused keeps the author on the screen', () => {
    const fail = publish.slice(landmark(publish, 'if (failed.length)'),
                               landmark(publish, 'return;', landmark(publish, 'if (failed.length)')));
    assert.ok(/'error'\)/.test(fail), 'the failure is not shown as one');
    assert.ok(/d\.error \|\| 'not connected'/.test(fail), 'the server’s own reason is dropped');
    assert.ok(!/closeBlogStudio/.test(fail), 'the modal closes over a failure the author has not read');
    // The post IS live on their own site, so the list behind has moved regardless.
    assert.ok(landmark(publish, 'notifyChanged(') < landmark(publish, 'if (failed.length)'),
        'the counts are only refreshed on the clean path — a partial publish leaves them stale');
});

console.log('\n(5) An already-published post can still be sent to a newly connected platform\n');

check('the re-push endpoint finally has callers', () => {
    // It existed, its own header named this exact scenario ("after connecting a new destination"),
    // and nothing in the product called it — so the only route was unpublish-and-republish.
    assert.ok(/publish-blog-destinations/.test(js), 'the review-queue card cannot re-push');
    assert.ok(/publish-blog-destinations/.test(modal), 'Blog Studio cannot re-push');
});

check('it is offered exactly where a published post is', () => {
    const actions = js.slice(landmark(js, 'function _rqBlogActions('), landmark(js, 'function _detailRqBlogCard('));
    const posted = actions.slice(landmark(actions, "statusKey === 'posted'"), landmark(actions, '} else {'));
    assert.ok(/btn\('repush'/.test(posted), 'the Posted column offers no way to syndicate');
    assert.ok(!/btn\('repush'/.test(actions.slice(0, landmark(actions, "statusKey === 'posted'"))),
        'a draft offers a re-push — there is nothing published to send');
    // Blog Studio reveals it on the same rule as Unpublish: published posts only.
    const load = modal.slice(landmark(modal, "if (post.status === 'published')"), landmark(modal, '}).catch(function () { setStatus'));
    assert.ok(/bs-repush'\)\.classList\.remove/.test(load), 'Blog Studio never reveals it for a published post');
});

check('both callers report per-destination outcomes rather than a bare “done”', () => {
    const act = js.slice(landmark(js, "if (action === 'repush')"), landmark(js, "if (action === 'unpublish')"));
    assert.ok(/No other platforms are connected/.test(act), 'a no-op re-push claims success');
    assert.ok(/d\.error \|\| 'not connected'/.test(act), 'a refusing destination is not named');
    assert.ok(/showToast/.test(act), 'a successful re-push says nothing');
});

console.log('\n(6) The first-party destination gets a card that fits it\n');

check('the server says which destination is first-party', () => {
    // Inferring it from credFields.length === 0 would misread a future paste destination that
    // happens to need no fields, and offer it a one-click connect that stores nothing.
    assert.ok(/firstParty: boolean;/.test(store), 'BlogDestinationStatus carries no first-party flag');
    assert.ok(/firstParty: true,/.test(store) && /firstParty: false,/.test(store),
        'the flag is declared but never set on both branches');
});

check('the card is its own renderer, not the paste form with no fields', () => {
    assert.ok(/if \(d\.firstParty\) return _firstPartyDestCard\(d\);/.test(integrations),
        'the first-party destination still renders through the paste-form card');
    const card = integrations.slice(landmark(integrations, 'function _firstPartyDestCard('),
                                    landmark(integrations, 'function _blogDestCard('));
    assert.ok(/_blogDestConnectFirstParty/.test(card), 'connecting still goes through the empty-form step');
    assert.ok(!/_blogDestToggleForm/.test(card), 'the empty paste form is still reachable from this card');
    // The editorial queue is the most surprising thing about this destination and was stated nowhere.
    assert.ok(/editor/i.test(card), 'nothing on the card mentions the editorial review step');
});

check('the connect posts the action the server routes on', () => {
    const fn = integrations.slice(landmark(integrations, 'window._blogDestConnectFirstParty = '),
                                  landmark(integrations, 'window._blogDestDisconnect = '));
    assert.ok(/action: 'connect'/.test(fn), 'the one-click connect sends no connect action');
    // connect-blog-destination branches on the ADAPTER's authKind, so the client sends nothing special.
    assert.ok(/authKind === 'firstparty'/.test(read('../netlify/functions/connect-blog-destination.ts')),
        'the server no longer routes first-party connects to connectSwanIndex');
});

check('disconnecting tells the truth about what it retracts', () => {
    const fn = integrations.slice(landmark(integrations, 'window._blogDestDisconnect = '),
                                  landmark(integrations, 'window._blogDestSetMode = '));
    // deleteBlogDestination withdraws every pending/live/featured piece AND the profile. The old
    // copy said "your posts will stop syndicating there", which would retract a back catalogue by
    // accident.
    assert.ok(/withdrawn from the magazine/.test(fn), 'the first-party disconnect understates what it does');
    // Driven by an argument the CARD passes, not by a lookup in _blogDestinations: a lookup miss
    // fails towards the mild sentence on the one destination where confirming retracts a back
    // catalogue. Both call sites must therefore be explicit about which they are.
    assert.ok(/firstParty != null \? !!firstParty :/.test(fn), 'the wording still rests on a lookup that can miss');
    assert.ok(/_blogDestDisconnect\('\$\{d\.id\}', true\)/.test(integrations), 'the first-party card does not declare itself');
    assert.ok(/_blogDestDisconnect\('\$\{d\.id\}', false\)/.test(integrations), 'the paste/OAuth card does not declare itself');
    assert.ok(!/window\.confirm\(/.test(fn), 'still the browser’s grey confirm box');
    assert.ok(/status: 'withdrawn'/.test(store), 'the copy describes a withdrawal the server no longer performs');
});

console.log(`\n${passed} checks passed\n`);
