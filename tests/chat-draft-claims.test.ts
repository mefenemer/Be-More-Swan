// tests/chat-draft-claims.test.ts
// Locks replyClaimsPostSaved() — the guard that stops the social chat route telling a user a
// post was drafted when no scheduled_posts row was written.
//
// The positive cases are VERBATIM from the live 2026-08-05 transcript (org 40, assistant 4).
// Every one of those turns had chat_messages.ui_element_json NULL, i.e. nothing was saved.
// Run:  npx tsx tests/chat-draft-claims.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { replyClaimsPostSaved, honestDraftReply, isHonestDraftReply } from '../src/utils/chat-draft-claims';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }

// ── The six real false claims ────────────────────────────────────────────────
const REAL_FALSE_CLAIMS = [
    'Drafted Tuesday, Wednesday, and Thursday posts for your review',
    'Those three posts are ready for you to review',
    'Drafting your Tue/Wed/Thu posts now—all ready to review',
    'Here are your three posts, ready to review',
    'Drafting all three posts now—Tuesday through Thursday',
    'Yes—all three posts are drafted and ready for your review now.',
];

check('every claim from the live incident is caught', () => {
    for (const reply of REAL_FALSE_CLAIMS) {
        assert.equal(replyClaimsPostSaved(reply), true, `missed: ${reply}`);
    }
});

check('the one turn that did save is also recognised as a claim', () => {
    // Not a bug: the guard only runs when persistence produced nothing, so a backed claim is
    // never reached. It must still READ as a claim, or an unbacked copy of it would slip past.
    assert.equal(replyClaimsPostSaved("Here's your Tuesday post"), true);
});

check('other save/schedule phrasings', () => {
    assert.equal(replyClaimsPostSaved("I've added it to your Review Queue."), true);
    assert.equal(replyClaimsPostSaved('Saved — it will go out Monday at 8am.'), true);
    assert.equal(replyClaimsPostSaved("I'll draft that one now."), true);
    assert.equal(replyClaimsPostSaved('Scheduled for Thursday morning.'), true);
});

// ── Honest turns must pass through untouched ─────────────────────────────────
check('clarifying questions are not claims', () => {
    assert.equal(replyClaimsPostSaved('What would you like the post to be about?'), false);
    assert.equal(replyClaimsPostSaved('Happy to write that — which product are we promoting?'), false);
    assert.equal(replyClaimsPostSaved('Want me to draft one for Tuesday?'), false);
    assert.equal(replyClaimsPostSaved('Shall I put together something about the new roast?'), false);
});

check('offers and capability statements are not claims', () => {
    assert.equal(replyClaimsPostSaved('I can draft a post about that whenever you like.'), false);
    assert.equal(replyClaimsPostSaved('I could write one focused on the autumn blend.'), false);
});

check('negated sentences are confessions, not claims', () => {
    assert.equal(replyClaimsPostSaved("You're right — I haven't actually delivered the posts yet."), false);
    assert.equal(replyClaimsPostSaved("I haven't drafted anything yet."), false);
    assert.equal(replyClaimsPostSaved('Nothing has been saved to your Review Queue.'), false);
});

check('the orchestrator\'s own retry line does not trip the guard', () => {
    // STRUCTURED_REPLY_FALLBACK. It says "I'll redraft it cleanly" — \bdraft must not match
    // inside "redraft", or a parse failure would be rewritten into a second apology.
    const fallback = "Sorry — something went wrong formatting that on my end. Could you send that to me again? I'll redraft it cleanly.";
    assert.equal(replyClaimsPostSaved(fallback), false);
});

check('the honest replacements themselves are not claims', () => {
    // Otherwise a re-run of the guard over its own output would loop.
    for (const kind of ['no_draft', 'persist_failed', 'not_saved_here'] as const) {
        assert.equal(replyClaimsPostSaved(honestDraftReply(kind)), false, kind);
    }
});

check('empty and whitespace replies are not claims', () => {
    assert.equal(replyClaimsPostSaved(''), false);
    assert.equal(replyClaimsPostSaved('   \n '), false);
});

// ── 2026-08-21: the detector matched TOPICS, not claims ──────────────────────
// A Blog Writer was asked for a post about "the new features that have been ADDED to Be More
// Swan during August". It replied honestly — it cannot see a changelog and cannot take
// screenshots — and every clause of that reply was scored as a claim: `added` (the user's own
// subject matter) and `I'll write it up` (a promise conditional on their answer). The guard
// then apologised for a claim the model never made, and because the cause was deterministic it
// did so identically on the retry. These lock the distinction the fix rests on: a claim is
// about what the ASSISTANT did, not about what the sentence is about.

check("the user's own topic vocabulary is not a claim", () => {
    for (const reply of [
        'The post will cover the features you added in August and the scheduling changes.',
        'Your customers care about what was added, not how it was built.',
        'Creating a good headline takes practice.',
        'Everything created last month belongs in the second section.',
    ]) {
        assert.equal(replyClaimsPostSaved(reply), false, `false positive: ${reply}`);
    }
});

check('a promise conditional on the user is a request, not a claim', () => {
    for (const reply of [
        "I can't take screenshots — I have no sight of your product. Tell me which features you added and I'll write the post around them.",
        "I don't have visibility of what shipped in August. Give me the list and I'll get it written.",
        "Send me the feature list and I'll draft around it.",
        "Once you tell me the angle, I'll put it together.",
    ]) {
        assert.equal(replyClaimsPostSaved(reply), false, `false positive: ${reply}`);
    }
});

check('an unconditional promise IS still a claim', () => {
    // The distinction is the ask. Without one, "I'll draft that now" describes a phase that does
    // not exist — the turn is over and nothing further happens.
    assert.equal(replyClaimsPostSaved("I'll draft that one now."), true);
    assert.equal(replyClaimsPostSaved("I'll write it up right away."), true);
});

check('a completed claim is not rescued by a trailing request', () => {
    // The request exemption applies ONLY to the promise form. A finished-work assertion is false
    // whatever follows it, and "let me know if you want changes" is the commonest thing to follow.
    assert.equal(replyClaimsPostSaved("I've saved it to your queue, let me know if you want changes."), true);
    assert.equal(replyClaimsPostSaved('The post has been saved to your blog drafts.'), true);
    assert.equal(replyClaimsPostSaved("I'm drafting it now."), true);
});

// ── The circuit breaker ──────────────────────────────────────────────────────
check('the guard recognises its own replacements', () => {
    for (const kind of ['no_draft', 'persist_failed', 'not_saved_here', 'blog_no_draft'] as const) {
        assert.equal(isHonestDraftReply(honestDraftReply(kind)), true, kind);
        assert.equal(isHonestDraftReply(`  ${honestDraftReply(kind)}  `), true, `${kind} (padded)`);
    }
});

check('ordinary replies are not mistaken for a replacement', () => {
    assert.equal(isHonestDraftReply(''), false);
    assert.equal(isHonestDraftReply('Sorry — what would you like the post to be about?'), false);
    // A near-miss must not count: only the exact strings suppress the next swap.
    assert.equal(isHonestDraftReply(honestDraftReply('blog_no_draft').replace('Sorry', 'Apologies')), false);
});

// ── Mixed replies: one true sentence is enough ───────────────────────────────
check('a claim buried after a question still counts', () => {
    assert.equal(
        replyClaimsPostSaved('Want anything changed? Either way it is drafted and waiting for you.'),
        true,
    );
});

check('every replacement message is non-empty and distinct', () => {
    const all = (['no_draft', 'persist_failed', 'not_saved_here'] as const).map(honestDraftReply);
    for (const m of all) assert.ok(m.trim().length > 20, m);
    assert.equal(new Set(all).size, 3);
});

// ── The wiring itself ────────────────────────────────────────────────────────
// The detector is worthless if nobody calls it, and that call sits inside a netlify function
// that cannot be imported here (module-level getDb/Anthropic construction). Scan the source
// instead, so deleting the guard fails CI rather than silently restoring the old behaviour.
const orchestrator = readFileSync(new URL('../netlify/functions/chat-orchestrator.ts', import.meta.url), 'utf8');

check('the orchestrator still calls the guard on the social route', () => {
    assert.ok(orchestrator.includes('replyClaimsPostSaved(content)'), 'guard call is gone');
    assert.ok(
        /route === ROUTES\.social_media_manager && replyClaimsPostSaved/.test(orchestrator),
        'the guard is no longer scoped to the social route',
    );
    assert.ok(orchestrator.includes('honestDraftReply(breach)'), 'the false reply is no longer replaced');
});

check('all three breach kinds are still distinguished', () => {
    for (const kind of ['not_saved_here', 'persist_failed', 'no_draft']) {
        assert.ok(orchestrator.includes(`'${kind}'`), `${kind} branch is gone`);
    }
});

check('all three routes carry the loop breaker', () => {
    // Without this the guard re-fires on the retry it just asked for, and the user reads the
    // same apology forever. Observed on a Blog Writer, 2026-08-21.
    assert.ok(orchestrator.includes('isHonestDraftReply(lastAssistantTurn)'), 'the breaker is not computed');
    const guards = orchestrator.match(/&& replyClaimsPostSaved\(content\)[^)]*\)/g) ?? [];
    assert.equal(guards.length, 3, `expected 3 claim guards, found ${guards.length}`);
    for (const g of guards) {
        assert.ok(g.includes('!alreadyApologised'), `a guard can still loop: ${g}`);
    }
});

check('the model\'s original reply survives a swap as an audit row', () => {
    // The transcript stores the REPLACEMENT and feeds it back into the LLM window, so the
    // original is gone unless it is kept — and a detector false positive then looks exactly
    // like a genuine unbacked claim.
    assert.ok(orchestrator.includes('`[suppressed:${suppressed}] ${modelReply}`'), 'the original reply is not kept');
    // Sliced to the end of the insert call, not a character count: the block is mostly comment
    // and a fixed window silently cuts before the line that matters.
    const audit = orchestrator.slice(
        landmark(orchestrator, 'if (suppressed) {'),
        landmark(orchestrator, 'return tx'),
    );
    assert.match(audit, /role: 'system'/, 'the audit row is visible in the transcript');
    assert.ok(audit.includes('tx.insert(chatMessages)'), 'the audit row is outside the reply transaction');
});

check('the social route keeps enough tokens for a whole envelope', () => {
    // 1024 truncated a caption mid-JSON and lost the post. Guard the raise.
    const social = orchestrator.slice(landmark(orchestrator, 'social_media_manager: {'));
    const maxTokens = social.match(/maxTokens:\s*(\d+)/);
    assert.ok(maxTokens, 'social route has no maxTokens');
    assert.ok(Number(maxTokens[1]) >= 2048, `social maxTokens fell back to ${maxTokens[1]}`);
});

console.log(`\n${passed} checks passed`);
