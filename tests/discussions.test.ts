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
    MAX_OWN_FORUMS, normaliseForumAddress, sitesFromChat, sourceInfo, DISCUSSIONS_ENABLED,
} from '../src/config/discussion-sites';
import { buildDiscussionsChatBlock, dispatchDueScans, startScan } from '../src/utils/discussions';
import { TEAM_FEATURES } from '../src/config/team-features';
import { discussionActionFromUiElement } from '../src/utils/chat-discussion-action';
import { SITE_PAGES_IN_DISCUSSIONS, businessBlock, discussionAudienceBlock, topicSuggestionsFromModel } from '../src/lib/discussion-triage';
import { renderMentorSnapshot, renderTeamFeatures } from '../src/utils/mentor-snapshot';

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
    // Script-page forums keep the thread id, minus tracking and session params.
    assert.strictEqual(normaliseThreadUrl('https://forum.blu-ray.com/showthread.php?t=123&s=abc&utm_source=x'), 'https://forum.blu-ray.com/showthread.php?t=123');
    assert.notStrictEqual(normaliseThreadUrl('https://x.org/viewtopic.php?t=1'), normaliseThreadUrl('https://x.org/viewtopic.php?t=2'));
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
    // Paused 2026-11-10: the prompt no longer describes the tab (see DISCUSSIONS_ENABLED).
    if (DISCUSSIONS_ENABLED) assert.match(o, /"Discussions" tab — public forum threads/);
    else assert.doesNotMatch(o, /"Discussions" tab — /);
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

console.log('\n──── chat: own forums ────');

check('chat sites accept keys, labels, addresses and bare forum addresses', () => {
    const r = sitesFromChat(['Reddit', 'ukbf', 'https://www.quora.com/', 'contractortalk.com', 'forum:BiggerPockets.com/forums/', 'Indie Hackers']);
    assert.deepStrictEqual(r.sites, ['reddit', 'ukbf', 'quora', 'forum:contractortalk.com', 'forum:biggerpockets.com/forums', 'forum:indiehackers.com']);
    assert.deepStrictEqual(r.rejected, []);
    assert.strictEqual(r.tooMany, false);
});
check('a forum the chat can’t watch, or a sixth own forum, reaches the card — never dropped quietly', () => {
    const bad = discussionActionFromUiElement({ type: 'discussion_action_proposal', action: 'set_watch', sites: ['reddit', 'my local forum'] });
    assert.deepStrictEqual(bad?.rejectedSites, ['my local forum']);
    const many = discussionActionFromUiElement({ type: 'discussion_action_proposal', action: 'set_watch', sites: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com'] });
    assert.strictEqual(many?.tooManyForums, true);
    const src = read('src/utils/chat-discussion-action.ts');
    assert.match(src, /isn’t a forum address I can watch/);
    assert.match(src, /You can watch up to \$\{MAX_OWN_FORUMS\} forums of your own/);
});

console.log('\n──── "Ask … to improve" topic wording ────');

check('suggestions line up with the user’s topics, cleaned like a saved topic', () => {
    const r = topicSuggestionsFromModel(['can anyone recommend a really good bookkeeper for my small cafe', 'google reviews'], [
        { topic: 'site:reddit.com "recommend a bookkeeper"', why: 'Shorter — the words people post.' },
        { topic: 'google reviews', why: 'unchanged' },
    ]);
    assert.deepStrictEqual(r, [
        { from: 'can anyone recommend a really good bookkeeper for my small cafe', to: 'recommend a bookkeeper', why: 'Shorter — the words people post.' },
        { from: 'google reviews', to: 'google reviews', why: '' },
    ]);
    // A missing or junk row keeps the user's own topic — never drops it.
    assert.deepStrictEqual(topicSuggestionsFromModel(['a', 'b'], [{ topic: 'x' }])?.map((x) => x.to), ['x', 'b']);
    assert.strictEqual(topicSuggestionsFromModel(['a'], null), null);
    assert.strictEqual(topicSuggestionsFromModel(['a'], []), null);
});
check('one wording rule for the swan and the chat, written for site: searches', () => {
    assert.match(read('src/config/discussion-sites.ts'), /export const TOPIC_WORDING_RULES = `HOW A DISCUSSIONS TOPIC IS WORDED — each topic is searched on Google as "site:<forum> <topic>"/);
    assert.match(read('src/lib/discussion-triage.ts'), /\$\{TOPIC_WORDING_RULES\}\n\nRewrite EACH topic/);
    assert.match(read('src/utils/discussions.ts'), /from what this business sells — not the business's own name\.\n\$\{TOPIC_WORDING_RULES\}/);
});
// 2026-11-03: "Ask Zaphod to improve" told Be More Swan "You don't build websites" and swapped
// "I need a website" for a blog topic — it saw only the description and catalogue, which named the
// Blog Writer. Every Discussions prompt now sees the site's pages, Brand Knowledge, Rules and who
// the business sells to, and the wording rule keeps the owner's subject.
check('every Discussions prompt sees the site pages, Brand Knowledge, Rules and audience', () => {
    const block = businessBlock({
        businessName: 'Be More Swan', businessDescription: 'AI assistants that write your blog',
        siteDirectoryBlock: "YOUR WEBSITE'S PAGES — …\n- /ai-website-assistant — Website Assistant: builds and hosts your website",
        knowledgeBlock: 'BUSINESS KNOWLEDGE — …', rulesBlock: 'RULES FROM YOUR USER — …\n- never mention price',
        audienceBlock: 'Who it sells to: start-ups.',
    });
    for (const part of ['Website Assistant: builds and hosts your website', SITE_PAGES_IN_DISCUSSIONS, 'BUSINESS KNOWLEDGE', 'RULES FROM YOUR USER', 'Who it sells to: start-ups.']) {
        assert.ok(block.includes(part), `missing: ${part}`);
    }
    assert.match(block, /a service named anywhere in it \(its website's pages included\) is one it really provides/);
    assert.ok(block.indexOf('RULES FROM YOUR USER') > block.indexOf('BUSINESS KNOWLEDGE'), 'Rules come last');
    // Absent blocks print nothing — no empty headings.
    assert.doesNotMatch(businessBlock({ businessName: 'X' }), /PAGES|KNOWLEDGE|RULES|Who it sells/);
    const s = read('src/utils/discussions.ts');
    assert.strictEqual((s.match(/loadDiscussionSender\(db, (orgId|organisationId), assistantId\)/g) ?? []).length, 3, 'scan, Redraft and improve all load it');
    assert.strictEqual((s.match(/loadSenderIdentity\(/g) ?? []).length, 1, 'only loadDiscussionSender loads the bare sender');
    const fn = s.slice(s.indexOf('export async function loadDiscussionSender'), s.indexOf('/** "Redraft"'));
    for (const l of ['loadBusinessKnowledgeBlock(db, organisationId)', 'loadAssistantRulesBlock(db, { assistantId, organisationId })', 'getIcpSnapshot(db, { aiAssistantId: assistantId })']) assert.ok(fn.includes(l), l);
});
check('audience block: target industries and exclusions, null when unanswered', () => {
    assert.strictEqual(discussionAudienceBlock({ targetIndustries: ['salons', ' ', 'cafés'], excludeProfile: 'agencies' }), 'Who it sells to: salons, cafés.\nNot its customers: agencies.');
    assert.strictEqual(discussionAudienceBlock({ targetIndustries: 'trades' }), 'Who it sells to: trades.');
    assert.strictEqual(discussionAudienceBlock({ targetIndustries: null, excludeProfile: null }), null);
    assert.strictEqual(discussionAudienceBlock(null), null);
});
check('topic wording keeps the owner’s subject — never swaps it for another service', () => {
    const rules = read('src/config/discussion-sites.ts');
    assert.match(rules, /Keep the owner's subject: reword it, never swap it for a different product or service\./);
    assert.match(rules, /say in "why" that it isn't in Products & Services yet/);
    assert.doesNotMatch(rules, /never widen a topic into something it doesn't offer/);
    assert.match(read('src/lib/discussion-triage.ts'), /wording most likely to find relevant threads about the SAME subject/);
});
check('the suggestion saves nothing, is metered as a helper, and uses the role’s model', () => {
    const s = read('src/utils/discussions.ts');
    const fn = s.slice(s.indexOf('export async function suggestTopicWording'), s.indexOf('// ── Chat ──'));
    assert.ok(fn.indexOf("meterInteraction(db, organisationId, 'helpers')") > -1 && fn.indexOf("meterInteraction(db, organisationId, 'helpers')") < fn.indexOf('improveTopicWording('));
    assert.match(fn, /loadRoleModel\(db, roleKey \?\? 'lead_qualifier'\)/);
    assert.doesNotMatch(fn, /saveWatch|db\.(update|insert)/, 'improving topics must not write the watch');
    const tri = read('src/lib/discussion-triage.ts');
    const call = tri.slice(tri.indexOf('export async function improveTopicWording'), tri.indexOf('export function topicSuggestionsFromModel'));
    assert.match(call, /withRoleModel\(modelChoice, TRIAGE_MODEL/);
    assert.match(call, /adaptForModel\(/);
    assert.match(call, /replyText\(resp\.content\)/);
    assert.match(read('netlify/functions/discussions.ts'), /if \(action === 'improve_topics'\) \{\n\s+const r = await suggestTopicWording\(db, orgId, assistantId, body\.topics\);/);
});
check('the swan sits beside Topics, names the assistant, and only fills the box on “Use”', () => {
    const js = read('src/components/assistant-discussions.js');
    assert.match(js, /const askLabel = \(\) => `Ask \$\{state\.assistantName \|\| 'your assistant'\} to improve`;/);
    const topicsAt = js.indexOf('for="disc-topics">Topics</label>');
    const swanAt = js.indexOf('data-disc-improve-topics title=');
    assert.ok(topicsAt > -1 && swanAt > topicsAt && swanAt < js.indexOf('<textarea id="disc-topics"'), 'swan button between the Topics label and the box');
    assert.match(js, /<img src="\$\{SWAN\}" alt=""/);
    assert.match(js, /const SWAN = '\/images\/BeMoreSwan_SwanAI\.png';/);
    const improve = js.slice(js.indexOf('async function improveTopics'), js.indexOf('function useSuggestions'));
    assert.match(improve, /call\('improve_topics', \{ topics \}\)/);
    assert.doesNotMatch(improve, /watchDraft =|save_watch/, 'asking must not touch the box or save');
    const use = js.slice(js.indexOf('function useSuggestions'), js.indexOf('async function scanNow'));
    assert.doesNotMatch(use, /call\(/, '"Use" fills the box; the user still presses Save');
    assert.match(js, /data-disc-topic-keep/);
});
check('the chat proposes improve_topics; its card calls the same action and saves only on “Use these topics”', () => {
    assert.strictEqual(discussionActionFromUiElement({ type: 'discussion_action_proposal', action: 'improve_topics' })?.action, 'improve_topics');
    assert.match(read('src/utils/discussions.ts'), /When the user asks you to improve, reword or check their topics[\s\S]{0,300}send "improve_topics"/);
    const act = read('src/utils/chat-discussion-action.ts');
    assert.match(act, /There are no topics to improve yet — add one first\./);
    assert.match(act, /const topics = w\.topics;/, 'the card rewords the SAVED topics, never the model’s list');
    assert.match(read('src/utils/discussions.ts'), /don't say you have suggested anything yet/);
    const cs = read('src/components/chat-session.js');
    assert.match(cs, /await call\(\{ action: 'improve_topics', topics: d\.topics \|\| undefined \}\);\n\s+respond\(\{ ok: true, suggestions: r\.suggestions \|\| \[\] \}\);\n\s+return;/);
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.match(reg, /improve_topics: \{ head: 'Better wording for your topics', button: 'Suggest wording', busy: 'Thinking…' \},/);
    assert.match(reg, /action: 'set_watch', assistantId: Number\(ui\.assistantId\) \|\| null, proposed: \{ topics: suggested \},/);
});

console.log('\n──── Business Mentor ────');

check('the Mentor is told about the Discussions tab and where it stands, as counts only (only while it is on)', () => {
    const base = {
        business: { description: 'Bookkeeping', industry: null, website: null }, products: [], productCount: 0,
        offerKinds: ['services'], introOfferAnswered: true, goals: [], plan: { status: 'active' as const, freeSlots: 1 },
        team: [{ id: 7, name: 'Lena', role: 'Lead Generator', state: 'active' as const, roleKey: 'lead_qualifier' }],
    };
    if (!DISCUSSIONS_ENABLED) {
        // Paused: no feature line, and buildMentorSnapshot passes discussions: undefined.
        assert.ok(!TEAM_FEATURES.lead_qualifier);
        assert.deepStrictEqual(renderTeamFeatures({ ...base, discussions: undefined }), []);
        assert.match(read('src/utils/mentor-snapshot.ts'), /!DISCUSSIONS_ENABLED \? undefined/);
        return;
    }
    const off = renderTeamFeatures({ ...base, discussions: [] }).join('\n');
    assert.match(off, /Lena — Discussions tab \(new 2026-10-30\)/);
    assert.match(off, /the USER posts it/);
    assert.match(off, /Lena's Discussions: not set up yet/);
    const on = renderTeamFeatures({ ...base, discussions: [{ assistantId: 7, topics: ['need a bookkeeper'], sites: ['Reddit', 'contractortalk.com'], enabled: true, newCount: 3, repliedCount: 1, lastScannedAt: new Date('2026-10-30T07:00:00Z') }] }).join('\n');
    assert.match(on, /watching "need a bookkeeper" on Reddit, contractortalk\.com; daily scan on; last scan 2026-10-30; 3 new threads waiting for a reply, 1 replied/);
    assert.match(renderTeamFeatures({ ...base, discussions: null }).join('\n'), /never assume it isn't set up/);
    assert.deepStrictEqual(renderTeamFeatures({ ...base, team: [{ ...base.team[0], roleKey: 'social_media_manager' }] }), []);
    assert.match(renderMentorSnapshot({ ...base, discussions: [] }), /WHAT YOUR TEAM CAN DO/);
});

console.log('\n──── wiring ────');

check('the tab is declared, placed and loaded', () => {
    const reg = read('src/components/assistant-dashboard-registry.js');
    if (DISCUSSIONS_ENABLED) assert.match(reg, /^\s*discussionsTab: \{\s*label: 'Discussions',/m);
    else assert.doesNotMatch(reg, /^\s*discussionsTab:/m, 'paused: the registry entry must stay commented out');
    const html = read('assistant-detail.html');
    assert.match(html, /id="maintab-btn-discussions" data-maintab="discussions"/);
    assert.match(html, /<div id="discussions-host"><\/div>/);
    assert.match(read('workspace.html'), /<script src="\/src\/components\/assistant-discussions\.js"><\/script>/);
    const js = read('assistants.js');
    assert.match(js, /if \(name === 'discussions'\) window\.AssistantDiscussions\?\.activate\(\);/);
    assert.match(js, /window\.AssistantDiscussions\?\.init\(\{ assistantId: data\.id, assistantName: data\.name \}\);/);
});
check('paused: the endpoint answers 410 and chat cards are dropped', () => {
    if (DISCUSSIONS_ENABLED) return;
    assert.match(read('netlify/functions/discussions.ts'), /if \(!DISCUSSIONS_ENABLED\) return json\(410/);
    assert.match(read('src/utils/chat-discussion-action.ts'), /if \(!DISCUSSIONS_ENABLED\) return null;/);
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

// Paused: no scan starts (daily or "Scan now") and chat gets no Discussions block — checked against a DB
// that throws if touched.
(async () => {
    if (!DISCUSSIONS_ENABLED) {
        total++;
        try {
            const fakeDb = new Proxy({}, { get() { throw new Error('paused code must not touch the DB'); } }) as any;
            assert.deepStrictEqual(await dispatchDueScans(fakeDb), { considered: 0, queued: 0, alreadyRunning: 0, failedToStart: 0, deferred: 0 });
            assert.strictEqual(((await startScan(fakeDb, 1, 1)) as { code?: string }).code, 'paused');
            assert.strictEqual(await buildDiscussionsChatBlock(fakeDb, 1, 1), null);
            passed++; console.log('  ✓ paused: no scan starts and chat gets no Discussions block');
        } catch (err) { console.error(`  ✗ paused: no scan starts\n    ${(err as Error).message}`); }
    }
    console.log(`\n${passed}/${total} passed`);
    if (passed !== total) process.exit(1);
})();
