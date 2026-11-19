// tests/linkedin-page-comments.test.ts
// LinkedIn Company Page statistics + comments (Community Management API): the parsers written to
// LinkedIn's documented field tables, the calls' URLs and bodies (fetch stubbed — nothing reaches
// LinkedIn), which comments the tab keeps, the chat card's shape check, and the wiring that makes the
// tab, the ingest and the scopes exist at all.
// Run:  npx tsx tests/linkedin-page-comments.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
    callTimeoutMs, commentThreadUrn, fetchCommentReplies, fetchPageFollowerCount, replyDefinitelyRefused, fetchPostComments, fetchPostStatistics, linkedInCommentUrl, parseComment,
    parseShareStatistics, parseShareStatisticsResponse, postUrnKind, replyErrorMessage, replyToComment, restliList,
} from '../src/utils/linkedin-page-api';
import { classifyComments, commentView, settledUrns, tidyReply, MAX_REPLY_CHARS, REPLY_RULES, TAB_SYNC_BUDGET_MS } from '../src/utils/page-comments';
import { commentActionFromUiElement } from '../src/utils/chat-comment-action';
import { LINKEDIN_PAGE_DEFAULT_SCOPES } from '../src/config/linkedin-capabilities';

let passed = 0;
// One at a time: the network checks swap globalThis.fetch, so two must never overlap.
let queue: Promise<void> = Promise.resolve();
function check(name: string, fn: () => void | Promise<void>): void {
    queue = queue.then(async () => {
        try { await fn(); passed++; console.log(`  ✓ ${name}`); }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
    });
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

type Call = { url: string; init?: RequestInit };
async function withFetch(responder: (url: string, init?: RequestInit) => Response, fn: (calls: Call[]) => Promise<void>) {
    const real = globalThis.fetch;
    const calls: Call[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return responder(String(url), init); }) as typeof fetch;
    try { await fn(calls); } finally { globalThis.fetch = real; }
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const ORG = 'urn:li:organization:13506392';

// ── Statistics ─────────────────────────────────────────────────────────────────────────────────

check('post URN kinds: share and ugcPost only', () => {
    assert.equal(postUrnKind('urn:li:share:7132564752928563200'), 'share');
    assert.equal(postUrnKind('urn:li:ugcPost:1000000'), 'ugcPost');
    assert.equal(postUrnKind('urn:li:activity:1'), null);
    assert.equal(postUrnKind('posted'), null);
});

check('Rest.li List() encodes each URN', () => {
    assert.equal(restliList(['urn:li:share:1', 'urn:li:share:2']), 'List(urn%3Ali%3Ashare%3A1,urn%3Ali%3Ashare%3A2)');
});

check('totalShareStatistics → counters, from the documented sample', () => {
    const s = parseShareStatistics({ clickCount: 78, commentCount: 24, engagement: 0.0228, impressionCount: 5287, likeCount: 14, shareCount: 5, uniqueImpressionsCount: 3100 });
    assert.deepEqual(s, { impressions: 5287, uniqueImpressions: 3100, clicks: 78, likes: 14, comments: 24, shares: 5, engagement: 0.0228 });
});

check('a negative likeCount is shown as 0, and the plural unique field is read', () => {
    const s = parseShareStatistics({ likeCount: -2, uniqueImpressionsCounts: 40 });
    assert.equal(s.likes, 0);
    assert.equal(s.uniqueImpressions, 40);
    assert.equal(s.impressions, null);
});

check('a statistics response is keyed by share or ugcPost', () => {
    const m = parseShareStatisticsResponse({ elements: [
        { share: 'urn:li:share:1', totalShareStatistics: { impressionCount: 10 } },
        { ugcPost: 'urn:li:ugcPost:2', totalShareStatistics: { impressionCount: 20 } },
    ] });
    assert.equal(m.get('urn:li:share:1')?.impressions, 10);
    assert.equal(m.get('urn:li:ugcPost:2')?.impressions, 20);
});

check('fetchPostStatistics: one call per kind, missing posts are zeros, a refused call leaves posts out', async () => {
    await withFetch((url) => url.includes('shares=')
        ? json({ elements: [{ share: 'urn:li:share:1', totalShareStatistics: { impressionCount: 9, likeCount: 2 } }] })
        : json({ message: 'nope' }, 403),
    async (calls) => {
        const m = await fetchPostStatistics('tok', ORG, ['urn:li:share:1', 'urn:li:share:3', 'urn:li:ugcPost:5', 'posted']);
        assert.equal(calls.length, 2);
        assert.match(calls[0].url, /organizationalEntityShareStatistics\?q=organizationalEntity&organizationalEntity=urn%3Ali%3Aorganization%3A13506392&shares=List\(/);
        assert.match(calls[1].url, /&ugcPosts=List\(urn%3Ali%3AugcPost%3A5\)/);
        assert.equal((calls[0].init?.headers as Record<string, string>)['X-Restli-Protocol-Version'], '2.0.0');
        assert.equal(m.get('urn:li:share:1')?.impressions, 9);
        assert.equal(m.get('urn:li:share:3')?.impressions, 0, 'left out of a good response = no activity');
        assert.equal(m.has('urn:li:ugcPost:5'), false, 'a refused call is not zeros');
    });
});

check('follower total from networkSizes firstDegreeSize', async () => {
    await withFetch(() => json({ firstDegreeSize: 219145 }), async (calls) => {
        assert.equal(await fetchPageFollowerCount('tok', ORG), 219145);
        assert.match(calls[0].url, /\/rest\/networkSizes\/urn%3Ali%3Aorganization%3A13506392\?edgeType=COMPANY_FOLLOWED_BY_MEMBER$/);
    });
    assert.equal(await fetchPageFollowerCount('tok', 'some-member-sub'), null);
});

// ── Comments ───────────────────────────────────────────────────────────────────────────────────

const C1 = 'urn:li:comment:(urn:li:activity:6631349431612559360,6636062862760562688)';

check('a documented comment element parses; names from actor~ when present', () => {
    const c = parseComment({
        actor: 'urn:li:person:abc', commentUrn: C1, id: '6636062862760562688',
        created: { actor: 'urn:li:person:abc', time: 1582160678569 }, message: { attributes: [], text: 'Do you ship to Leeds?' },
        object: 'urn:li:activity:6631349431612559360', 'actor~': { localizedFirstName: 'Sam', localizedLastName: 'Lee' },
    });
    assert.ok(c);
    assert.equal(c!.actorName, 'Sam Lee');
    assert.equal(c!.objectUrn, 'urn:li:activity:6631349431612559360');
    assert.equal(c!.createdAt?.getTime(), 1582160678569);
    assert.equal(parseComment({ commentUrn: C1, message: { text: '   ' } }), null, 'no text, no row');
    assert.equal(parseComment({ message: { text: 'hi' } }), null, 'no URN, no row');
});

check('the Page’s own comments are not kept; its replies mark their parent answered; side-threads are left out', () => {
    const list = [
        { commentUrn: C1, objectUrn: 'p', actorUrn: 'urn:li:person:a', actorName: null, text: 'Q', createdAt: null, parentCommentUrn: null, replyCount: null },
        { commentUrn: 'urn:li:comment:(urn:li:activity:1,2)', objectUrn: 'p', actorUrn: ORG, actorName: null, text: 'Thanks!', createdAt: null, parentCommentUrn: C1, replyCount: null },
        { commentUrn: 'urn:li:comment:(urn:li:activity:1,3)', objectUrn: 'p', actorUrn: ORG, actorName: null, text: 'Our own note', createdAt: null, parentCommentUrn: null, replyCount: null },
        { commentUrn: 'urn:li:comment:(urn:li:activity:1,4)', objectUrn: 'p', actorUrn: 'urn:li:person:b', actorName: null, text: 'me too', createdAt: null, parentCommentUrn: C1, replyCount: null },
    ];
    const { toKeep, answeredParents } = classifyComments(ORG, list);
    assert.deepEqual(toKeep.map((c) => c.commentUrn), [C1]);
    assert.equal(answeredParents.get(C1)?.text, 'Thanks!');
});

check('fetchPostComments asks with the name projection, then without when refused; null only when both fail', async () => {
    await withFetch((url) => url.includes('projection=') ? json({}, 403) : json({ elements: [{ commentUrn: C1, message: { text: 'hi' } }] }), async (calls) => {
        const got = await fetchPostComments('tok', 'urn:li:share:9');
        assert.equal(got?.length, 1);
        assert.equal(calls.length, 2);
        assert.match(calls[1].url, /\/rest\/socialActions\/urn%3Ali%3Ashare%3A9\/comments\?start=0&count=50$/);
    });
    await withFetch(() => json({}, 500), async () => {
        assert.equal(await fetchPostComments('tok', 'urn:li:share:9'), null);
    });
});

check('a reply posts AS the Page with object + parentComment, and rebuilds the new comment URN', async () => {
    await withFetch(() => json({}, 201, { 'x-restli-id': '6643206422739898368' }), async (calls) => {
        const r = await replyToComment('tok', { orgUrn: ORG, objectUrn: 'urn:li:share:9', commentUrn: C1, text: '  Yes, we do!  ' });
        assert.deepEqual(r, { ok: true, commentUrn: 'urn:li:comment:(urn:li:activity:6631349431612559360,6643206422739898368)' });
        assert.equal(calls[0].init?.method, 'POST');
        assert.match(calls[0].url, /\/rest\/socialActions\/urn%3Ali%3Acomment%3A%28urn%3Ali%3Aactivity%3A6631349431612559360%2C6636062862760562688%29\/comments$/);
        assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { actor: ORG, object: 'urn:li:share:9', parentComment: C1, message: { text: 'Yes, we do!' } });
    });
    await withFetch(() => json({ message: 'Comment create throttled' }, 429), async () => {
        const r = await replyToComment('tok', { orgUrn: ORG, objectUrn: 'urn:li:share:9', commentUrn: C1, text: 'x' });
        assert.equal(r.ok, false);
        assert.match((r as { error: string }).error, /limiting how fast/);
    });
});

check('a reply LinkedIn never answered (timeout, network, 5xx) is UNCONFIRMED; only a 4xx is a refusal', async () => {
    assert.equal(replyDefinitelyRefused(403), true);
    assert.equal(replyDefinitelyRefused(503), false);
    assert.equal(replyDefinitelyRefused(null), false);
    await withFetch(() => json({ message: 'boom' }, 503), async () => {
        const r = await replyToComment('tok', { orgUrn: ORG, objectUrn: 'urn:li:share:9', commentUrn: C1, text: 'x' });
        assert.deepEqual([r.ok, (r as { unconfirmed: boolean }).unconfirmed], [false, true]);
    });
    await withFetch(() => { throw new Error('The operation was aborted due to timeout'); }, async () => {
        const r = await replyToComment('tok', { orgUrn: ORG, objectUrn: 'urn:li:share:9', commentUrn: C1, text: 'x' });
        assert.deepEqual([r.ok, (r as { unconfirmed: boolean }).unconfirmed], [false, true]);
    });
    await withFetch(() => json({ message: 'no' }, 403), async () => {
        const r = await replyToComment('tok', { orgUrn: ORG, objectUrn: 'urn:li:share:9', commentUrn: C1, text: 'x' });
        assert.equal((r as { unconfirmed: boolean }).unconfirmed, false);
    });
});

check('postReply rolls back only on a definite refusal, and keeps an unconfirmed reply under Replied', () => {
    const src = read('src/utils/page-comments.ts');
    const body = src.slice(src.indexOf('export async function postReply('));
    const unconfirmed = body.indexOf('if (!result.ok && result.unconfirmed)');
    const rollback = body.indexOf('status: row.c.status, repliedVia: null');
    assert.ok(unconfirmed > 0 && rollback > unconfirmed, 'the unconfirmed branch returns before the rollback');
    assert.ok(body.slice(unconfirmed, rollback).includes('return {'), 'and returns without un-filing');
    assert.ok(body.includes("?? 'confirmed'"), 'a confirmed reply never has a null URN');
});

check('the Page’s replies are fetched from UNDER each comment and mark it answered', async () => {
    await withFetch(() => json({ elements: [{ commentUrn: 'urn:li:comment:(urn:li:activity:6631349431612559360,7)', actor: ORG, message: { text: 'Thanks Sam!' } }] }), async (calls) => {
        const replies = await fetchCommentReplies('tok', C1);
        assert.match(calls[0].url, /\/rest\/socialActions\/urn%3Ali%3Acomment%3A%28/);
        assert.equal(replies?.[0].parentCommentUrn, C1, 'parent implied by the path is filled in');
        const top = parseComment({ commentUrn: C1, actor: 'urn:li:person:a', message: { text: 'Q' }, commentsSummary: { aggregatedTotalComments: 1 } })!;
        assert.equal(top.replyCount, 1);
        const { toKeep, answeredParents } = classifyComments(ORG, [top, ...replies!]);
        assert.equal(toKeep.length, 1);
        assert.equal(answeredParents.get(C1)?.text, 'Thanks Sam!');
    });
    const src = read('src/utils/page-comments.ts');
    assert.ok(src.includes('await fetchCommentReplies(opts.token, c.commentUrn, opts.deadline)'), 'the sync asks for replies');
});

check('archived assistants gather no comments, and the post cap is logged, not silent', () => {
    const src = read('src/utils/page-comments.ts');
    assert.ok(src.includes('notArchivedAssistant(scheduledPosts.assistantId)'));
    assert.ok(src.includes('if (rows.length === MAX_PAGE_POSTS)'));
});

check('reply lookups skip comments already settled; both callers carry a time budget', () => {
    const settled = settledUrns([
        { commentUrn: 'a', status: 'new', replyCommentUrn: null },
        { commentUrn: 'b', status: 'dismissed', replyCommentUrn: null },
        { commentUrn: 'c', status: 'replied', replyCommentUrn: 'urn:li:comment:(urn:li:activity:1,2)' },
        { commentUrn: 'd', status: 'replied', replyCommentUrn: null },
    ]);
    assert.deepEqual([...settled].sort(), ['b', 'c'], 'new and unconfirmed still get looked up');
    assert.ok(TAB_SYNC_BUDGET_MS < 10_000, 'inside an on-demand function');
    const src = read('src/utils/page-comments.ts');
    assert.ok(src.includes('!settled.has(c.commentUrn)'));
    assert.ok(src.includes('posts: g.posts, deadline }'));
    assert.ok(read('netlify/functions/ingest-linkedin-insights.ts').includes('deadline: commentsDeadline'));
});

check('a late-seen Page reply confirms an unconfirmed one; an unconfirmed reply can go back to New, never to Dismissed', () => {
    const src = read('src/utils/page-comments.ts');
    assert.ok(src.includes("eq(pageComments.repliedVia, 'app'), isNull(pageComments.replyCommentUrn)"));
    const fn = src.slice(src.indexOf('export async function setCommentStatus('), src.indexOf('export function tidyReply('));
    assert.match(fn, /status === 'new'\s*\?\s*sql`/);
    assert.ok(fn.includes(": inArray(pageComments.status, ['new', 'dismissed'])"));
});

check('one slow call can’t overrun the budget: each read waits at most the time left (at least 0.5 s)', () => {
    assert.equal(callTimeoutMs(undefined), 10_000);
    assert.equal(callTimeoutMs(1_000 + 3_000, 1_000), 3_000);
    assert.equal(callTimeoutMs(1_000 + 60_000, 1_000), 10_000);
    assert.equal(callTimeoutMs(1_000, 5_000), 500, 'past the deadline still gets a short try');
    const src = read('src/utils/page-comments.ts');
    assert.ok(src.includes('fetchPostComments(opts.token, post.platformPostId, opts.deadline, (f) => { failure = f; })'));
    assert.ok(src.includes('fetchCommentReplies(opts.token, c.commentUrn, opts.deadline)'));
});

check('a read cut off by the deadline counts as left for later, never as LinkedIn refusing', async () => {
    const src = read('src/utils/page-comments.ts');
    const at = src.indexOf('if (!topLevel) {');
    assert.ok(at > 0);
    const block = src.slice(at, at + 400);
    assert.ok(block.indexOf('{ r.skippedForTime++; continue; }') > 0 && block.indexOf('{ r.skippedForTime++; continue; }') < block.indexOf('r.failedPosts++'), 'past the deadline → deferred, before any failure is counted');
    // Past the deadline, the plain retry is skipped: one call, not two.
    await withFetch(() => json({}, 504), async (calls) => {
        assert.equal(await fetchPostComments('tok', 'urn:li:share:9', Date.now() - 1), null);
        assert.equal(calls.length, 1);
    });
});

check('the tab says when posts were left for the next automatic check', () => {
    const js = read('src/components/assistant-comments.js');
    assert.ok(js.includes('r.result?.skippedForTime'));
    assert.ok(js.includes('picked up by the next automatic check'));
});

check('thread URN and LinkedIn link from a comment URN', () => {
    assert.equal(commentThreadUrn(C1), 'urn:li:activity:6631349431612559360');
    assert.equal(commentThreadUrn('nonsense'), null);
    assert.match(linkedInCommentUrl('urn:li:share:9', C1)!, /^https:\/\/www\.linkedin\.com\/feed\/update\/urn%3Ali%3Ashare%3A9\/\?commentUrn=/);
    assert.equal(linkedInCommentUrl(null, C1), null);
});

check('refusals read as something a Page owner can act on', () => {
    assert.match(replyErrorMessage(401), /Reconnect/);
    assert.match(replyErrorMessage(403), /Page admin/);
    assert.match(replyErrorMessage(404), /no longer on LinkedIn/);
    assert.match(replyErrorMessage(400, 'bad'), /bad/);
});

check('replies are tidied to LinkedIn’s 1,250 characters', () => {
    assert.equal(MAX_REPLY_CHARS, 1250);
    assert.equal(tidyReply('a\r\n\n\n\nb  '), 'a\n\nb');
    assert.equal(tidyReply('x'.repeat(2000)).length, 1250);
});

check('the view never shows a blank author', () => {
    const base = { id: 1, organisationId: 1, aiAssistantId: 1, connectionId: 1, scheduledPostId: 2, platform: 'linkedin', commentUrn: C1, objectUrn: 'urn:li:share:9', body: 'hi', commentedAt: null, draftReply: null, status: 'new', repliedVia: null, replyText: null, replyCommentUrn: null, decidedBy: null, decidedAt: null, createdAt: new Date(), updatedAt: new Date() };
    assert.equal(commentView({ ...base, authorUrn: 'urn:li:person:a', authorName: null }).authorName, 'A LinkedIn member');
    assert.equal(commentView({ ...base, authorUrn: 'urn:li:organization:5', authorName: '' }).authorName, 'A LinkedIn Page');
    assert.equal(commentView({ ...base, authorUrn: 'urn:li:person:a', authorName: 'Sam Lee' }, 'Our   new menu').postExcerpt, 'Our new menu');
    const replied = { ...base, authorUrn: 'urn:li:person:a', authorName: 'Sam', status: 'replied', repliedVia: 'app' };
    assert.equal(commentView({ ...replied, replyCommentUrn: null }).replyUnconfirmed, true);
    assert.equal(commentView({ ...replied, replyCommentUrn: 'confirmed' }).replyUnconfirmed, false);
});

check('the drafting rules never let the model invent facts or post on its own', () => {
    assert.match(REPLY_RULES, /Never invent facts/);
    assert.match(REPLY_RULES, /empty string/);
});

// ── Chat card ──────────────────────────────────────────────────────────────────────────────────

check('comment_action_proposal: shape check', () => {
    assert.deepEqual(commentActionFromUiElement({ type: 'comment_action_proposal', action: 'draft', commentId: '#12', instruction: ' shorter ' }), { action: 'draft', commentId: 12, instruction: 'shorter' });
    assert.deepEqual(commentActionFromUiElement({ type: 'comment_action_proposal', action: 'post_reply', commentId: 3, instruction: 'ignored' }), { action: 'post_reply', commentId: 3, instruction: null });
    assert.equal(commentActionFromUiElement({ type: 'comment_action_proposal', action: 'like', commentId: 3 }), null);
    assert.equal(commentActionFromUiElement({ type: 'comment_action_proposal', action: 'dismiss' }), null);
    assert.equal(commentActionFromUiElement({ type: 'discussion_action_proposal', action: 'dismiss', commentId: 3 }), null);
});

// ── Wiring ─────────────────────────────────────────────────────────────────────────────────────

check('the Community app asks for the comment scopes', () => {
    const scopes = LINKEDIN_PAGE_DEFAULT_SCOPES.split(' ');
    for (const s of ['rw_organization_admin', 'w_organization_social', 'r_organization_social', 'r_organization_social_feed', 'w_organization_social_feed']) assert.ok(scopes.includes(s), s);
});

check('the ingest is scheduled and driven on staging', () => {
    assert.match(read('netlify.toml'), /\[functions\.ingest-linkedin-insights\]\n\s+schedule = "15 \*\/6 \* \* \*"/);
    const run = read('netlify/functions/run-insights-ingest.ts');
    assert.match(run, /await ingestLinkedInInsights\(\)/);
    assert.ok(read('netlify/functions/ingest-linkedin-insights.ts').includes('linkClicks: null'), 'clickCount is not link clicks');
});

check('the Comments tab is declared for Social Media and wired into the page', () => {
    assert.match(read('src/components/assistant-dashboard-registry.js'), /^\s*commentsTab: \{ label: 'Comments' \},/m);
    const html = read('assistant-detail.html');
    assert.ok(html.includes('id="maintab-btn-comments" data-maintab="comments"'));
    assert.ok(html.includes('<div id="comments-host"></div>'));
    assert.ok(read('workspace.html').includes('<script src="/src/components/assistant-comments.js"></script>'));
    const js = read('assistants.js');
    assert.ok(js.includes("if (name === 'comments') window.AssistantComments?.activate();"));
    assert.ok(js.includes('window.AssistantComments?.init({ assistantId: data.id, assistantName: data.name });'));
});

check('the chat sees the tab, resolves the card from the row, and the click goes to the tab’s endpoint', () => {
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(orch.includes('usesPageComments: true,'));
    assert.ok(orch.includes('rc.commentsBlock ?? \'\','));
    assert.ok(orch.includes('resolveCommentActionProposal(db, orgId, session.aiAssistantId, commentReq)'));
    assert.ok(read('src/components/disruptive-ui-registry.js').includes("register('comment_action_proposal', renderCommentActionProposalCard);"));
    const cs = read('src/components/chat-session.js');
    assert.ok(cs.includes("container.addEventListener('comment:action', onCommentAction);"));
    assert.ok(cs.includes("fetch('/.netlify/functions/page-comments'"));
});

check('only postReply calls LinkedIn’s write endpoint', () => {
    const src = read('src/utils/page-comments.ts');
    assert.equal(src.split('replyToComment(').length - 1, 1, 'one call site');
    assert.ok(src.indexOf('replyToComment(') > src.indexOf('export async function postReply('));
});

check('Page posts are chosen by the account that WROTE them, not by connection_id', () => {
    // Staging 2026-11-19: post 202 went out from a personal profile; the same connection row was later
    // reconnected as the Company Page (social-oauth-callback.ts updates in place), so a connection_id
    // match claimed the profile's post for the Page. The recorded author is the only safe key.
    const pc = read('src/utils/page-comments.ts');
    const fn = pc.slice(pc.indexOf('export async function loadPagePosts('), pc.indexOf('export async function pageToken('));
    assert.ok(fn.length > 0, 'loadPagePosts found');
    assert.ok(fn.includes('eq(systemConnections.externalUserId, scheduledPosts.platformAuthorUrn)'), 'joined on the recorded author');
    assert.ok(fn.includes("like(scheduledPosts.platformAuthorUrn, 'urn:li:organization:%')"), 'only posts a Page wrote');
    assert.ok(fn.includes('eq(systemConnections.organisationId, scheduledPosts.organisationId)'), 'never another workspace\'s connection');
    assert.ok(!fn.includes('scheduledPosts.connectionId'), 'connection_id plays no part — it can change identity on reconnect');
    assert.ok(!fn.includes('COALESCE('), 'the NULL-connection guess is gone');
    assert.ok(fn.includes('if (seen.has(row.id)) continue;'), 'a post is read once even if two connections match');
    const pub = read('netlify/functions/publish-social-posts.ts');
    assert.ok(pub.includes("`UPDATE scheduled_posts SET platform_author_urn = '${esc(String(creds.externalUserId))}' WHERE id = ${post.id}`"), 'publisher records the author');
    const authorAt = pub.indexOf('SET platform_author_urn');
    const publishedAt = pub.indexOf("UPDATE scheduled_posts SET status = 'published'");
    assert.ok(publishedAt > 0 && authorAt > publishedAt, 'after the post is marked published, in its own statement');
    assert.ok(pub.slice(authorAt, authorAt + 400).includes('.catch('), 'never fatal — a missing column must not strand the post as publishing');
    assert.ok(read('db/schema.ts').includes('platformAuthorUrn: text("platform_author_urn"),'));
    assert.ok(read('db/z-scheduled-posts-author.sql').includes('ADD COLUMN IF NOT EXISTS platform_author_urn TEXT'));
});

check('a reply goes out AS the Page only under a post the Page wrote', () => {
    const src = read('src/utils/page-comments.ts');
    const fn = src.slice(src.indexOf('export async function postReply('));
    const guard = fn.indexOf("if (!post || post.author !== conn.externalUserId)");
    assert.ok(guard > 0, 'author checked against the Page connection');
    assert.ok(guard < fn.indexOf('replyToComment('), 'before anything is posted');
    assert.ok(guard < fn.indexOf('// Claim the row first'), 'before the row is claimed');
    assert.ok(fn.includes("code: 'not_page_post'"));
});

check('a post deleted on LinkedIn (404) is an empty list, not a refused read; other refusals say why', async () => {
    await withFetch(() => json({ message: 'Not Found' }, 404), async () => {
        let reported = false;
        assert.deepEqual(await fetchPostComments('tok', 'urn:li:share:9', undefined, () => { reported = true; }), []);
        assert.equal(reported, false, 'gone is not a failure');
    });
    await withFetch(() => json({ message: 'Not enough permissions to access: GET /socialActions' }, 403), async (calls) => {
        let got: { status: number; message: string } | null = null;
        assert.equal(await fetchPostComments('tok', 'urn:li:share:9', undefined, (f) => { got = f; }), null);
        assert.equal(calls.length, 2, 'name projection, then plain');
        assert.equal(got!.status, 403);
        assert.ok(got!.message.includes('Not enough permissions'));
    });
    const ingest = read('netlify/functions/ingest-linkedin-insights.ts');
    assert.ok(ingest.includes('comments.failures.push(f)'), 'the ingest result carries the reasons');
    assert.ok(ingest.includes('if (!isMissingTable(err)) throw err;'), 'a missing author column skips the tick instead of failing it');
});

queue.then(() => console.log(`\n${passed} passed`));
