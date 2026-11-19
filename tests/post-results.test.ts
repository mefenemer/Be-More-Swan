// tests/post-results.test.ts
// A published post's own results on its "Posted" note: the pure view (src/utils/post-results.ts), the
// endpoint that attaches it (get-social-drafts.ts) and the note that shows it (workspace.html).
// Run:  npx tsx tests/post-results.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { RESULTS_PLATFORMS, RESULTS_WINDOW_DAYS, postResultsView, resultsExpectation } from '../src/utils/post-results';

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

check('a row becomes the note’s numbers; reactions come from likes', () => {
    const v = postResultsView({ impressions: 12, reach: 9, likes: 1, comments: 2, shares: 0, videoViews: null, fetchedAt: new Date('2026-11-19T10:00:00Z') });
    assert.deepEqual(v, { impressions: 12, reach: 9, reactions: 1, comments: 2, shares: 0, videoViews: null, fetchedAt: '2026-11-19T10:00:00.000Z' });
});

check('a metric the platform doesn’t give stays null, never 0; junk is dropped', () => {
    const v = postResultsView({ impressions: null, reach: -1, likes: Number.NaN, comments: 3, shares: null, videoViews: null, fetchedAt: null });
    assert.equal(v.impressions, null);
    assert.equal(v.reach, null);
    assert.equal(v.reactions, null);
    assert.equal(v.comments, 3);
    assert.equal(v.fetchedAt, null);
});

check('only platforms with an ingest get results', () => {
    assert.deepEqual([...RESULTS_PLATFORMS], ['linkedin', 'facebook', 'instagram']);
    for (const p of RESULTS_PLATFORMS) assert.ok(read(`netlify/functions/ingest-${p}-insights.ts`).length > 0, `${p} has an ingest`);
});

check('get-social-drafts attaches results for published posts only, scoped to the workspace, never fatal', () => {
    const src = read('netlify/functions/get-social-drafts.ts');
    assert.ok(src.includes("d.status === 'published' && (RESULTS_PLATFORMS as readonly string[]).includes(String(d.platform))"));
    assert.ok(src.includes('eq(postInsights.organisationId, organisationId)'), 'org-scoped');
    assert.ok(src.includes('results: results.get(d.id) ?? null,'));
    const at = src.indexOf('const results = new Map<number, PostResults>()');
    assert.ok(at > 0 && src.slice(at, at + 1600).includes('} catch (err) {'), 'a failed lookup never empties the queue');
});

check('the Posted note shows them, and says when they’ll come before the first ingest', () => {
    const html = read('workspace.html');
    assert.ok(html.includes('${_rqResultsHtml(post)}'), 'called from the published branch');
    const fn = html.slice(html.indexOf('function _rqResultsHtml(post) {'), html.indexOf('function _rqCopyElsewhereHtml() {'));
    assert.ok(fn.length > 0);
    assert.ok(fn.includes('They appear here a few hours after the post goes out.'));
    assert.ok(fn.includes("one(r.impressions, 'impression', 'impressions')") && fn.includes("one(r.reach, 'person reached', 'people reached')"));
    assert.ok(fn.includes("(v == null ? null :"), 'a null metric is left out, not shown as 0');
    assert.ok(fn.includes('_rqEsc(ago)'));
});

check('results are promised only when an ingest will read the post', () => {
    const now = Date.parse('2026-11-19T12:00:00Z');
    const day = 24 * 60 * 60 * 1000;
    const recent = new Date(now - day);
    assert.equal(resultsExpectation({ platform: 'linkedin', publishedAt: recent, platformAuthorUrn: 'urn:li:organization:135063921' }, now), 'pending');
    assert.equal(resultsExpectation({ platform: 'linkedin', publishedAt: recent, platformAuthorUrn: 'urn:li:person:abc' }, now), 'personal_profile', 'members get no post results');
    assert.equal(resultsExpectation({ platform: 'linkedin', publishedAt: recent, platformAuthorUrn: null }, now), null, 'no recorded author: could be a Page post, so say nothing');
    assert.equal(resultsExpectation({ platform: 'facebook', publishedAt: recent, platformAuthorUrn: null }, now), 'pending');
    assert.equal(resultsExpectation({ platform: 'instagram', publishedAt: new Date(now - (RESULTS_WINDOW_DAYS + 1) * day), platformAuthorUrn: null }, now), null, 'outside the window: nothing is coming');
    assert.equal(resultsExpectation({ platform: 'x', publishedAt: recent, platformAuthorUrn: null }, now), null, 'no ingest');
    assert.equal(resultsExpectation({ platform: 'facebook', publishedAt: null, platformAuthorUrn: null }, now), null);
});

check('the note says "a few hours" only for a pending post, and the truth for a personal profile', () => {
    const html = read('workspace.html');
    const fn = html.slice(html.indexOf('function _rqResultsHtml(post) {'), html.indexOf('function _rqCopyElsewhereHtml() {'));
    const pending = fn.indexOf("post.resultsExpected === 'pending'");
    assert.ok(pending > 0 && pending < fn.indexOf('They appear here a few hours'), 'the promise is behind the flag');
    assert.ok(fn.includes("LinkedIn doesn't share results for posts on a personal profile."));
    const src = read('netlify/functions/get-social-drafts.ts');
    assert.ok(src.includes("resultsExpected: d.status === 'published' && !results.has(d.id) ? resultsExpectation(d) : null,"));
    assert.ok(src.includes('platformAuthorUrn: scheduledPosts.platformAuthorUrn,'));
});

console.log(`\n${passed} passed`);
