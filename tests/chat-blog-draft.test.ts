// tests/chat-blog-draft.test.ts
// Locks the Blog Writer chat's save-or-discard path end to end.
//
// The bug this closes: blog_writer had no route in the orchestrator, so it fell through to
// defaultRoute — whose prompt (correctly, for a route with no structured output) tells the model
// that nothing in the chat is stored anywhere. A Blog Writer would therefore write a finished,
// publish-ready post and then instruct the user to copy it out of the transcript and re-create it
// by hand in Blog Studio. The article was already written; only the wiring was missing.
//
// Pure: no network, no DB. Everything past the unit tests is a source scan, because the failures
// that matter here are silent — a renderer that stops dispatching, a listener that stops
// listening, a create that stops stamping AI provenance — and every one of them still typechecks.
// Run:  npx tsx tests/chat-blog-draft.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
    blogPostDraftFromUiElement, BLOG_POST_DRAFT_TYPE, MAX_TAGS, MAX_TITLE_CHARS,
} from '../src/utils/blog-chat-draft';
import { replyClaimsPostSaved, honestDraftReply } from '../src/utils/chat-draft-claims';
import { landmark, landmarkEnd } from './landmark';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }

const BODY = '# The swan and the paddling\n\nCalm above, working below.\n\n## Why it matters\n\nBecause it does.';

// ── The wire shape ───────────────────────────────────────────────────────────
console.log('\nblogPostDraftFromUiElement\n');

check('a well-formed draft comes back normalised', () => {
    const draft = blogPostDraftFromUiElement({
        type: BLOG_POST_DRAFT_TYPE, title: 'The swan and the paddling', bodyMarkdown: BODY, tags: ['saas', 'ops'],
    });
    assert.ok(draft);
    assert.equal(draft.title, 'The swan and the paddling');
    assert.equal(draft.bodyMarkdown, BODY);
    assert.deepEqual(draft.tags, ['saas', 'ops']);
});

check('anything that is not a blog draft is rejected', () => {
    assert.equal(blogPostDraftFromUiElement(null), null);
    assert.equal(blogPostDraftFromUiElement('a string'), null);
    assert.equal(blogPostDraftFromUiElement({ type: 'social_post_draft', caption: 'hi' }), null);
    assert.equal(blogPostDraftFromUiElement({ title: 'No type', bodyMarkdown: BODY }), null);
});

check('an empty body is not a draft — there is nothing to save', () => {
    // This is what the orchestrator's claim guard keys on: no body, no article, so a reply
    // saying one was written is a reply about nothing.
    assert.equal(blogPostDraftFromUiElement({ type: BLOG_POST_DRAFT_TYPE, title: 'T', bodyMarkdown: '' }), null);
    assert.equal(blogPostDraftFromUiElement({ type: BLOG_POST_DRAFT_TYPE, title: 'T', bodyMarkdown: '   \n\n ' }), null);
    assert.equal(blogPostDraftFromUiElement({ type: BLOG_POST_DRAFT_TYPE, title: 'T' }), null);
});

check('a missing title falls back to the body H1, never to a refusal', () => {
    // blog_posts.title is NOT NULL and the Blogs list renders it, so a title-less draft must
    // still save — the user can see the article, and "I could not save it" over a missing field
    // they never typed is the least explicable failure available.
    const draft = blogPostDraftFromUiElement({ type: BLOG_POST_DRAFT_TYPE, bodyMarkdown: BODY });
    assert.equal(draft?.title, 'The swan and the paddling');
});

check('with no H1 either, the first line becomes the title, stripped of markdown', () => {
    const draft = blogPostDraftFromUiElement({
        type: BLOG_POST_DRAFT_TYPE, title: '   ', bodyMarkdown: '**Calm above**, working below.\n\nMore text.',
    });
    assert.equal(draft?.title, 'Calm above, working below.');
});

check('titles are clamped, not truncated into the body', () => {
    const draft = blogPostDraftFromUiElement({
        type: BLOG_POST_DRAFT_TYPE, title: 'x'.repeat(MAX_TITLE_CHARS + 50), bodyMarkdown: BODY,
    });
    assert.equal(draft?.title.length, MAX_TITLE_CHARS);
});

check('tags are cleaned: hashes stripped, blanks and non-strings dropped, deduped, capped', () => {
    const draft = blogPostDraftFromUiElement({
        type: BLOG_POST_DRAFT_TYPE, title: 'T', bodyMarkdown: BODY,
        tags: ['#saas', ' saas ', '', 42, null, ...Array.from({ length: 20 }, (_, i) => `tag${i}`)],
    });
    assert.ok(draft);
    assert.equal(draft.tags.length, MAX_TAGS);
    assert.equal(draft.tags[0], 'saas');
    assert.equal(draft.tags.filter((t) => t === 'saas').length, 1, 'duplicate survived normalisation');
});

check('a non-array tags field is ignored rather than thrown on', () => {
    assert.deepEqual(blogPostDraftFromUiElement({ type: BLOG_POST_DRAFT_TYPE, title: 'T', bodyMarkdown: BODY, tags: 'saas' })?.tags, []);
});

// ── The honest reply ─────────────────────────────────────────────────────────
console.log('\nhonestDraftReply(blog_no_draft)\n');

check('the replacement reply does not itself read as a claim', () => {
    // Same trap the social replacements carry: this string is held to the detector that produced
    // it, and a guard that flags its own output loops in front of the user.
    assert.equal(replyClaimsPostSaved(honestDraftReply('blog_no_draft')), false);
});

check('it points at the blog surface, not the social Review Queue', () => {
    const reply = honestDraftReply('blog_no_draft');
    assert.ok(!/review queue/i.test(reply), 'blog drafts do not land in the Review Queue');
});

// ── Orchestrator wiring ──────────────────────────────────────────────────────
console.log('\nchat-orchestrator.ts\n');

const orchestrator = readFileSync('netlify/functions/chat-orchestrator.ts', 'utf8');
const routeStart = landmark(orchestrator, 'blog_writer: {');
const route = orchestrator.slice(routeStart, landmarkEnd(orchestrator, 'social_media_manager: {', routeStart));

check('blog_writer has a route of its own — not defaultRoute', () => {
    assert.ok(route.includes('parseResponse: parseStructuredReply'), 'the route stopped parsing a structured envelope');
});

check('the route keeps enough tokens for a whole article plus the envelope', () => {
    // A blog body is an order of magnitude longer than a caption, and the social route has
    // already shown what truncation costs: the JSON never parses and the finished post is
    // thrown away in front of the user.
    const maxTokens = route.match(/maxTokens:\s*(\d+)/);
    assert.ok(maxTokens, 'blog route has no maxTokens');
    assert.ok(Number(maxTokens[1]) >= 4096, `blog maxTokens fell back to ${maxTokens[1]}`);
});

check('the prompt tells the model the draft is NOT saved by emitting it', () => {
    assert.ok(/does NOT save anything/.test(route), 'the "not saved yet" contract left the prompt');
    assert.ok(/Save this draft/.test(route) && /Discard/.test(route), 'the prompt no longer names the two buttons');
});

check('the prompt still bans the false save claim and the copy-it-out instruction', () => {
    assert.ok(/NEVER say the post has been saved/.test(route), 'the ban on claiming a save is gone');
    assert.ok(/Never tell them to copy the text out/.test(route), 'the ban on "copy this into Blog Studio" is gone');
});

check('the wire shape the prompt asks for is the one the normaliser accepts', () => {
    assert.ok(route.includes(`"type": "${BLOG_POST_DRAFT_TYPE}"`), 'the prompt and BLOG_POST_DRAFT_TYPE disagree');
    for (const field of ['bodyMarkdown', 'title', 'tags']) {
        assert.ok(route.includes(`"${field}"`), `the prompt stopped asking for ${field}`);
    }
});

check('the turn normalises the draft before persisting the transcript', () => {
    // uiElementJson is stored verbatim and re-rendered on every reload, so an unusable draft
    // object has to be dropped here or it comes back as a broken card with a Save button on it.
    assert.ok(
        /blogDraft = route === ROUTES\.blog_writer \? blogPostDraftFromUiElement/.test(orchestrator),
        'the blog uiElement is no longer normalised',
    );
    assert.ok(
        /uiElement = blogDraft \? \{ type: BLOG_POST_DRAFT_TYPE, \.\.\.blogDraft \} : null/.test(orchestrator),
        'an unusable blog draft is no longer dropped',
    );
});

check('an unbacked blog claim is still replaced', () => {
    assert.ok(
        /route === ROUTES\.blog_writer && !blogDraft && replyClaimsPostSaved\(content\)/.test(orchestrator),
        'the blog claim guard is gone or no longer scoped to a draftless turn',
    );
    assert.ok(orchestrator.includes("honestDraftReply('blog_no_draft')"), 'the false reply is no longer replaced');
});

// ── The card ─────────────────────────────────────────────────────────────────
console.log('\ndisruptive-ui-registry.js\n');

const registry = readFileSync('src/components/disruptive-ui-registry.js', 'utf8');
const cardStart = landmark(registry, 'function renderBlogPostDraftCard(');
const card = registry.slice(cardStart, landmark(registry, "register('blog_post_draft'", cardStart));

check('the card is registered under the type the orchestrator emits', () => {
    assert.ok(registry.includes(`register('${BLOG_POST_DRAFT_TYPE}', renderBlogPostDraftCard)`), 'renderer is unregistered');
});

check('it offers BOTH a save and a discard', () => {
    assert.ok(card.includes('data-bpd-save') && card.includes('data-bpd-discard'), 'a button was removed');
    assert.ok(/Save this draft/.test(card), 'the save button was renamed away from the prompt wording');
});

check('it says the draft is unsaved before the user has to decide', () => {
    const label = landmark(card, 'Not saved yet');
    assert.ok(label < landmark(card, 'data-bpd-save'), 'the "not saved yet" line moved below the buttons');
});

check('the "not saved yet" eyebrow is corrected once the user decides', () => {
    // It is the first line read on the card. Left on "Not saved yet" above a status line saying
    // it saved, it is the contradiction this card exists to prevent, one paragraph higher up.
    assert.ok(card.includes("setEyebrow('Blog draft · Saved')"), 'a saved draft still calls itself unsaved');
    assert.ok(card.includes("setEyebrow('Blog draft · Discarded')"), 'a discarded draft still offers itself as pending');
    const failure = card.slice(landmark(card, 'setBusy(false)'));
    assert.ok(/setEyebrow\('Blog draft · Not saved yet'\)/.test(failure), 'a failed save leaves the card claiming it saved');
});

check('discarding saves nothing and says so', () => {
    const discard = card.slice(landmark(card, 'if (discard)'), landmark(card, 'blog:createDraft'));
    assert.ok(!discard.includes('fetch('), 'discard now writes something');
    assert.ok(/nothing was saved/i.test(discard), 'discard no longer tells the user nothing was kept');
});

check('saving hands the write to chat-session via the bubbling event', () => {
    assert.ok(card.includes("new CustomEvent('blog:createDraft'"), 'the save event was renamed');
    assert.ok(/bubbles: true/.test(card), 'the event no longer bubbles to the chat container');
    assert.ok(/respond\(\{ ok, deduped, error \}\)/.test(card), 'the outcome contract changed — a failed save may now claim success');
});

check('a failed save re-enables the buttons — this card holds the only copy', () => {
    const respond = card.slice(landmark(card, 'respond({ ok, deduped, error })'));
    assert.ok(/setBusy\(false\)/.test(respond), 'a transient error now strands the article behind two dead buttons');
});

check('the success line names the tab the draft actually lands in', () => {
    // The label is DB-of-record in the dashboard registry and has been renamed before elsewhere
    // ("Signal Inbox" → "Searches"). If it changes here, this sentence sends the user to a tab
    // that no longer exists.
    const dashboard = readFileSync('src/components/assistant-dashboard-registry.js', 'utf8');
    const blogRole = dashboard.slice(landmark(dashboard, 'blog_writer: {'));
    assert.ok(/reviewQueue: \{[^}]*label: 'Blogs'/.test(blogRole), "blog_writer's queue tab is no longer labelled 'Blogs'");
    assert.ok(/Blogs tab/.test(card), 'the saved message no longer names the Blogs tab');
    assert.ok(/Blog Studio/.test(card), 'the saved message no longer says where to edit it');
});

// ── The write ────────────────────────────────────────────────────────────────
console.log('\nchat-session.js → blog-posts.ts\n');

const chat = readFileSync('src/components/chat-session.js', 'utf8');

check('the chat listens for the card\'s event and posts to blog-posts', () => {
    assert.ok(chat.includes("container.addEventListener('blog:createDraft', onBlogDraftCreate)"), 'the listener is gone');
    const handler = chat.slice(landmark(chat, 'function onBlogDraftCreate('), landmark(chat, 'blog:created'));
    assert.ok(handler.includes("fetch('/.netlify/functions/blog-posts'"), 'the save no longer calls blog-posts');
    assert.ok(/bodyMarkdown: d\.bodyMarkdown/.test(handler), 'the body is no longer sent — the draft would save empty');
    assert.ok(/assistantId,/.test(handler), 'the post is no longer attributed to the authoring assistant');
});

check('a save with no assistant fails loudly instead of writing an orphan', () => {
    const handler = chat.slice(landmark(chat, 'function onBlogDraftCreate('), landmark(chat, 'blog:created'));
    assert.ok(/if \(!assistantId\)/.test(handler), 'the missing-assistant guard is gone');
});

check('a successful save tells the page, so the Blogs tab behind the modal refreshes', () => {
    assert.ok(chat.includes("new CustomEvent('blog:created'"), 'the blog:created dispatch is gone');
    const assistants = readFileSync('assistants.js', 'utf8');
    assert.ok(assistants.includes("document.addEventListener('blog:created'"), 'nothing listens for blog:created');
    const listener = assistants.slice(landmark(assistants, "document.addEventListener('blog:created'"));
    assert.ok(/_onBlogStudioChanged\(\)/.test(listener.slice(0, 900)), 'the listener no longer refreshes the list');
});

console.log('\nblog-posts.ts\n');

const blogPosts = readFileSync('netlify/functions/blog-posts.ts', 'utf8');
const create = blogPosts.slice(landmark(blogPosts, "if (event.httpMethod === 'POST')"), landmark(blogPosts, '// ---- Delete ----'));

check('a create can carry the finished body', () => {
    assert.ok(/body\.bodyMarkdown/.test(create), 'the create no longer accepts a body');
    assert.ok(/const \[post\] = await db\s*\n?\s*\.insert\(blogPosts\)/.test(create), 'the insert moved or was renamed');
});

check('⚠️ a machine-drafted body ALWAYS stamps its AI provenance', () => {
    // isAiAssisted() reads the PRESENCE of generation_reason, and the EU AI Act Art. 50 notice on
    // the widget, the permalink and every syndicated copy is derived from it. A body saved without
    // it publishes to the customer's own domain badged as human-written.
    assert.ok(/generationReason: ASSISTANT_DRAFT_REASON/.test(create), 'the AI provenance stamp is gone');
    const stamp = landmark(create, 'generationReason: ASSISTANT_DRAFT_REASON');
    assert.ok(/bodyMarkdown \? \{ generationReason/.test(create.slice(stamp - 60, stamp + 40)), 'the stamp is no longer tied to a body arriving');
});

check('pressing Save twice on a re-rendered transcript does not make two posts', () => {
    // A stored uiElement re-renders with its buttons every time the conversation is reopened.
    assert.ok(/deduped: true/.test(create), 'the re-press dedupe is gone');
    assert.ok(/eq\(blogPosts\.bodyMarkdown, bodyMarkdown\)/.test(create), 'the dedupe no longer compares the body — an edited redraft would collide');
});

console.log(`\n${passed} checks passed`);
