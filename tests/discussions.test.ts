// tests/discussions.test.ts
// The Lead Generator's Discussions tab: forum threads worth replying to, each with a drafted reply
// the user posts themselves.
//
// WHY THIS EXISTS. The owner asked (2026-10-29) for Reddit-style listening that recommends the
// business. The line it must hold is that NOTHING posts for the user and EVERY reply says it comes
// from the business — automated or undisclosed self-promotion breaks the sites' rules and the DMCC
// Act. These pin: the disclosure line is added in code and never doubled; searches stay on the
// watched site and recent; one thread is one row; the chat card is rebuilt, never trusted; the GUI
// and chat call the same endpoint; and no code path talks to a site's posting API.
//
// Run:  npx tsx tests/discussions.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
    DISCUSSION_SITE_KEYS, MAX_TOPICS, discussionDisclosure, discussionQuery, hasDisclosure, looksLikeThread,
    normaliseSites, normaliseThreadUrl, normaliseTopics, plainForSite, postedAgeDays, siteForUrl, withDisclosure,
    MAX_OWN_FORUMS, normaliseForumAddress, sourceInfo,
} from '../src/config/discussion-sites';
import { discussionActionFromUiElement } from '../src/utils/chat-discussion-action';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const root = path.resolve(__dirname, '..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

console.log('\n──── the disclosure line ────');

check('every reply ends with exactly one disclosure line naming the business', () => {
    const r = withDisclosure('Try a booking tool with reminders.', 'Petal & Stem');
    assert.ok(r.endsWith('(Full disclosure: I work at Petal & Stem, so I’m biased.)'));
    assert.strictEqual(withDisclosure(r, 'Petal & Stem'), r, 'a redraft must not stack a second line');
    assert.strictEqual((withDisclosure(r, 'Other Ltd').match(/Full disclosure/g) || []).length, 1);
});
check('no business name still discloses an interest', () => {
    assert.match(discussionDisclosure(''), /I sell something in this space/);
});
check('hasDisclosure spots a reply the user stripped it from', () => {
    assert.strictEqual(hasDisclosure(withDisclosure('Hi.', 'X')), true);
    assert.strictEqual(hasDisclosure('Hi, use X.'), false);
});
check('the triage prompt tells the model NOT to write a disclosure (code adds it)', () => {
    assert.match(read('src/lib/discussion-triage.ts'), /Do NOT add any disclosure/);
    assert.match(read('src/utils/discussions.ts'), /draftReply: withDisclosure\(plainForSite\(v\.reply, c\.site\), sender\.businessName\)/);
});

check('markdown emphasis is kept on Reddit and stripped elsewhere', () => {
    const r = 'Try **Letterboxd** lists, or *Searching for Sugar Man*. Use `site:` search. 2 * 3 stays.';
    assert.strictEqual(plainForSite(r, 'reddit'), r);
    assert.strictEqual(plainForSite(r, 'quora'), 'Try Letterboxd lists, or Searching for Sugar Man. Use site: search. 2 * 3 stays.');
    assert.match(read('src/utils/discussions.ts'), /withDisclosure\(plainForSite\(reply, site\), sender\.businessName\)/);
});

console.log('\n──── your own forums ────');

check('a forum address is cleaned to host[/path]; built-ins and junk are refused', () => {
    assert.strictEqual(normaliseForumAddress('https://www.ContractorTalk.com/forums/?x=1#top'), 'contractortalk.com/forums');
    assert.strictEqual(normaliseForumAddress('biggerpockets.com/forums/'), 'biggerpockets.com/forums');
    assert.strictEqual(normaliseForumAddress('reddit.com/r/smallbusiness'), null, 'tick Reddit instead');
    assert.strictEqual(normaliseForumAddress('old.reddit.com'), null);
    assert.strictEqual(normaliseForumAddress('localhost'), null);
    assert.strictEqual(normaliseForumAddress('192.168.0.1'), null);
    assert.strictEqual(normaliseForumAddress('not a domain'), null);
});
check('own forums ride in the sites list after the built-ins, deduped and capped', () => {
    const many = Array.from({ length: 8 }, (_, i) => `forum:forum${i}.com`);
    const s = normaliseSites(['forum:WWW.indiehackers.com/', 'quora', 'forum:indiehackers.com', 'reddit', 'forum:reddit.com', ...many]);
    assert.deepStrictEqual(s.slice(0, 3), ['reddit', 'quora', 'forum:indiehackers.com']);
    assert.strictEqual(s.filter((x) => x.startsWith('forum:')).length, MAX_OWN_FORUMS);
});
check('an own forum is searched with site:, kept to its host and path, and labelled', () => {
    assert.strictEqual(discussionQuery('need a roofer', 'forum:contractortalk.com'), 'site:contractortalk.com need a roofer');
    assert.strictEqual(siteForUrl('https://www.biggerpockets.com/forums/899/topics/1-x', ['forum:biggerpockets.com/forums']), 'forum:biggerpockets.com/forums');
    assert.strictEqual(siteForUrl('https://biggerpockets.com/blog/x', ['forum:biggerpockets.com/forums']), null);
    assert.strictEqual(sourceInfo('forum:indiehackers.com').label, 'Indie Hackers');
    assert.strictEqual(sourceInfo('forum:example-forum.org').label, 'example-forum.org');
});
check('the generic thread check drops home, file, member and search pages', () => {
    const f = 'forum:forum.wordreference.com' as const;
    assert.strictEqual(looksLikeThread('https://forum.wordreference.com/threads/a-question.123/', f), true);
    assert.strictEqual(looksLikeThread('https://forum.wordreference.com/', f), false);
    assert.strictEqual(looksLikeThread('https://forum.wordreference.com/attachments/x-pdf.1/', f), false);
    assert.strictEqual(looksLikeThread('https://forum.wordreference.com/doc.pdf', f), false);
    assert.strictEqual(looksLikeThread('https://forum.wordreference.com/members/jane.12/', f), false);
});
check('own-forum replies are plain text; a bad address is refused out loud', () => {
    assert.strictEqual(plainForSite('use **this**', 'forum:indiehackers.com'), 'use this');
    assert.match(read('netlify/functions/discussions.ts'), /isn’t a forum address we can watch/);
});

console.log('\n──── searching ────');

check('a query is the site filter plus the topic', () => {
    assert.strictEqual(discussionQuery('need a florist in Leeds', 'reddit'), 'site:reddit.com need a florist in Leeds');
    assert.strictEqual(discussionQuery('x', 'linkedin'), 'site:linkedin.com/posts x');
});
check('topics are cleaned, deduped and capped — a user cannot rewrite the site filter', () => {
    const t = normaliseTopics(['  best CRM  ', 'best crm', '"quoted" site:evil.com thing', '', 'a', 'b', 'c', 'd', 'e']);
    assert.strictEqual(t.length, MAX_TOPICS);
    assert.deepStrictEqual(t.slice(0, 2), ['best CRM', 'quoted thing']);
});
check('unknown sites are dropped', () => {
    assert.deepStrictEqual(normaliseSites(['reddit', 'facebook', 'quora']), ['reddit', 'quora']);
    assert.deepStrictEqual([...DISCUSSION_SITE_KEYS], ['reddit', 'ukbf', 'quora', 'linkedin']);
});
check('results off the watched site are dropped', () => {
    assert.strictEqual(siteForUrl('https://old.reddit.com/r/smallbusiness/comments/abc/x', ['reddit']), 'reddit');
    assert.strictEqual(siteForUrl('https://notreddit.com/r/a', ['reddit']), null);
    assert.strictEqual(siteForUrl('https://www.ukbusinessforums.co.uk/threads/x.1/', ['reddit']), null);
});
check('only threads, not listing or profile pages', () => {
    assert.strictEqual(looksLikeThread('https://reddit.com/r/smallbusiness/comments/1abc2/need_help', 'reddit'), true);
    assert.strictEqual(looksLikeThread('https://reddit.com/r/smallbusiness', 'reddit'), false);
    assert.strictEqual(looksLikeThread('https://ukbusinessforums.co.uk/threads/best-epos.123/', 'ukbf'), true);
    assert.strictEqual(looksLikeThread('https://quora.com/profile/Jane', 'quora'), false);
    assert.strictEqual(looksLikeThread('https://linkedin.com/in/jane', 'linkedin'), false);
});
check('one thread is one URL however it was reached', () => {
    const a = normaliseThreadUrl('https://www.reddit.com/r/x/comments/abc/t/?utm_source=share#c1');
    const b = normaliseThreadUrl('https://old.reddit.com/r/x/comments/abc/t');
    assert.strictEqual(a, 'https://reddit.com/r/x/comments/abc/t');
    assert.strictEqual(a, b);
    assert.strictEqual(normaliseThreadUrl('javascript:alert(1)'), null);
});
check('Google’s age label is read; a thread past a week is old', () => {
    assert.strictEqual(postedAgeDays('3 days ago'), 3);
    assert.strictEqual(postedAgeDays('2 weeks ago'), 14);
    assert.strictEqual(postedAgeDays(null), null);
    assert.ok((postedAgeDays('1 Oct 2026', new Date('2026-10-29T00:00:00Z')) ?? 0) > 7);
});
check('the scan asks Google for the last week only', () => {
    assert.match(read('src/utils/discussions.ts'), /recency: 'week'/);
    assert.match(read('src/lib/discovery-search.ts'), /recency === 'week' \? 'qdr:w'/);
});

console.log('\n──── nothing posts ────');

check('no Discussions code calls a site’s API or posts anywhere', () => {
    const files = ['src/config/discussion-sites.ts', 'src/lib/discussion-triage.ts', 'src/utils/discussions.ts',
        'src/utils/chat-discussion-action.ts', 'netlify/functions/discussions.ts', 'src/components/assistant-discussions.js'];
    for (const f of files) {
        const s = read(f);
        assert.doesNotMatch(s, /oauth\.reddit\.com|api\/comment|api\/submit|quora\.com\/api|api\.linkedin\.com/i, `${f} reaches a posting API`);
    }
});
check('Reddit is read only through Google and robots.txt is honoured for thread pages', () => {
    const s = read('src/utils/discussions.ts');
    assert.match(s, /robotsAllows\(u\.hostname, u\.pathname/);
    assert.doesNotMatch(s, /\.json['"`]/, 'reddit .json endpoints are the Data API');
});
check('a scan spends one task, asked before and recorded after the work', () => {
    const s = read('src/utils/discussions.ts');
    const run = s.slice(s.indexOf('export async function runScan'));
    assert.ok(run.indexOf('hasTaskCapacity') > -1 && run.indexOf('hasTaskCapacity') < run.indexOf('triageThreads('));
    assert.ok(run.indexOf("recordCompletedWork(db, orgId, 'lead_search'") > run.indexOf('triageThreads('));
});

console.log('\n──── chat ────');

check('a proposal is shape-checked; ids accept "#12"', () => {
    assert.deepStrictEqual(discussionActionFromUiElement({ type: 'discussion_action_proposal', action: 'mark_replied', discussionId: '#12' })?.discussionId, 12);
    assert.strictEqual(discussionActionFromUiElement({ type: 'discussion_action_proposal', action: 'dismiss' }), null, 'needs a thread');
    assert.strictEqual(discussionActionFromUiElement({ type: 'discussion_action_proposal', action: 'post_reply', discussionId: 1 }), null, 'there is no post action');
    assert.strictEqual(discussionActionFromUiElement({ type: 'discussion_action_proposal', action: 'set_watch' }), null, 'set_watch must change something');
    const w = discussionActionFromUiElement({ type: 'discussion_action_proposal', action: 'set_watch', topics: ['a', 'a', 'b'], sites: ['reddit', 'myspace'] });
    assert.deepStrictEqual(w?.topics, ['a', 'b']);
    assert.deepStrictEqual(w?.sites, ['reddit']);
});
check('the chat card is rebuilt server-side and the prompt names the tab', () => {
    const o = read('netlify/functions/chat-orchestrator.ts');
    assert.match(o, /resolveDiscussionActionProposal\(db, orgId, session\.aiAssistantId, discussionReq\)/);
    assert.match(o, /"Discussions" tab — public forum threads/);
    assert.match(o, /buildDiscussionsChatBlock\(db, orgId, session\.aiAssistantId\)/);
});
check('the chat may not claim a card’s action has happened, and sends one card at a time', () => {
    const s = read('src/utils/discussions.ts');
    assert.match(s, /have marked, dismissed or rewritten anything, or are doing so/);
    assert.match(s, /ONE card per message\. When they ask for two things at once/);
});
check('GUI and chat call the same endpoint', () => {
    assert.match(read('src/components/assistant-discussions.js'), /const API = '\/\.netlify\/functions\/discussions'/);
    assert.match(read('src/components/chat-session.js'), /fetch\('\/\.netlify\/functions\/discussions'/);
    assert.match(read('src/components/disruptive-ui-registry.js'), /register\('discussion_action_proposal', renderDiscussionActionProposalCard\);/);
});

console.log('\n──── wiring ────');

check('the tab is declared, placed and loaded', () => {
    assert.match(read('src/components/assistant-dashboard-registry.js'), /discussionsTab: \{\s*label: 'Discussions',/);
    const html = read('assistant-detail.html');
    assert.match(html, /id="maintab-btn-discussions" data-maintab="discussions"/);
    assert.match(html, /<div id="discussions-host"><\/div>/);
    assert.match(read('workspace.html'), /<script src="\/src\/components\/assistant-discussions\.js"><\/script>/);
    const js = read('assistants.js');
    assert.match(js, /if \(name === 'discussions'\) window\.AssistantDiscussions\?\.activate\(\);/);
    assert.match(js, /window\.AssistantDiscussions\?\.init\(\{ assistantId: data\.id \}\);/);
});
check('the daily scan is scheduled, and staging pokes it', () => {
    assert.match(read('netlify.toml'), /\[functions\.dispatch-discussion-scans\]\n {2}schedule = "50 6 \* \* \*"/);
    assert.match(read('.github/workflows/staging-crons.yml'), /run-discussion-scan-dispatch 21600 120/);
    assert.ok(readdirSync(path.join(root, 'netlify/functions')).includes('run-discussion-scan-background.ts'));
});
check('the SQL and the Drizzle mirror agree on the checks', () => {
    const sqlFile = read('db/z-discussions.sql');
    const schema = read('db/schema.ts');
    for (const v of ["'asking_for', 'can_help'", "'page', 'snippet'", "'new', 'replied', 'dismissed'", "'idle', 'running'"]) {
        assert.ok(sqlFile.includes(v), `SQL lacks ${v}`);
        assert.ok(schema.includes(v.replace(/, /g, ',')), `schema lacks ${v}`);
    }
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
