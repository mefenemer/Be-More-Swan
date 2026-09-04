// tests/blog-draft-is-async.test.ts
// Blog Studio's "Ask your assistant to draft" must not generate inside the request.
//
// The bug this exists for, reported on production 2026-09-04: the button hung on "Drafting…"
// forever and no post was ever written. generate-blog.ts called generateBlogBody() in-request — a
// 6,000-token model call plus KB retrieval, a blueprint compile and up to three stock-image lookups,
// thirty to sixty seconds of work — inside a synchronous Netlify function. Those are capped at ten
// seconds by default (netlify.toml sets no [functions] timeout) and at twenty-six even with a raise,
// so the invocation was killed every time and answered with a raw 502 carrying no JSON body.
//
// TWO faults, and the test covers both, because either one alone still produces a broken button:
//   1. the work did not fit in the budget, so it never completed;
//   2. the modal's api() called r.json() unconditionally, so a non-JSON 502 REJECTED the promise —
//      and runAiDraft was a bare .then() with no .catch, so nothing on screen ever changed.
// Fault 2 is why this went unnoticed: it turned every failure into a spinner instead of an error.
//
// These are source-shape checks. The properties are properties of how the code is WIRED — enqueues
// vs generates, polls vs awaits a body, resolves vs rejects — and a mocked run reproduces none of
// them, because under `netlify dev` the timeout that caused the incident is not enforced.
// Run:  npx tsx tests/blog-draft-is-async.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8');

const handler = read('netlify/functions/generate-blog.ts');
const worker = read('netlify/functions/process-blog-jobs.ts');
const modal = read('src/components/blog-studio-modal.js');
const toml = read('netlify.toml');
const trigger = read('src/utils/trigger-drain.ts');

console.log('\n──── the request enqueues, it does not generate ────');

check('generate-blog never calls the generator in-request', () => {
    // The whole incident in one assertion. Anything that awaits a draft inside a synchronous
    // function is back to being killed at ten seconds.
    //
    // Matched on the CALL and the IMPORT, never the bare name: this file's header explains what it
    // used to do and names generateBlogBody in prose, which a substring match reads as a dependency.
    assert.ok(!/generateBlogBody\(db/.test(handler),
        'generate-blog generates in-request again — it will be killed mid-draft and answer a raw 502');
    assert.ok(!/^import .*blog-generate/m.test(handler),
        'the handler still imports the generation core');
});

check('it enqueues a BLOG job the blog worker will claim', () => {
    const insert = handler.slice(landmark(handler, 'db.insert(contentGenerationJobs)'),
        landmark(handler, 'triggerBlogDrain('));
    assert.ok(/contentType: 'blog'/.test(insert),
        "the job defaults to content_type 'social', so the social drain claims it and the blog drain never sees it");
    assert.ok(/resultBlogPostId: post\.id/.test(insert),
        'the job does not name the post to draft into — the worker would ideate a topic and insert a SECOND post');
});

check('the answer is 202, not a body', () => {
    assert.ok(/statusCode: 202/.test(handler), 'the caller is still being made to wait for the work');
    assert.ok(/jobId/.test(handler), 'nothing is returned for the browser to poll');
});

check('the poke is awaited', () => {
    // An un-awaited dispatch is frozen with the lambda and never leaves the sandbox, which strands
    // the job until the ten-minute cron — indistinguishable from a hang. See trigger-drain.ts.
    assert.ok(/await triggerBlogDrain\(/.test(handler), 'the drain trigger is not awaited');
    assert.ok(/run-blog-jobs-background/.test(trigger),
        'triggerBlogDrain pokes the wrong worker — the content drain filters blog jobs out by content_type');
});

check('the background worker exists and is not on the synchronous budget', () => {
    const bg = read('netlify/functions/run-blog-jobs-background.ts');
    assert.ok(/drainBlogJobs\(\)/.test(bg), 'the background twin does not drain the blog queue');
    // The suffix is what buys the 15-minute budget. A netlify.toml entry cannot grant it: 26s is
    // the synchronous maximum, and a draft does not fit in 26s either.
    assert.ok(!/\[functions\.run-blog-jobs-background\]/.test(toml),
        'a timeout entry on a -background function is a sign someone believed it was synchronous');
});

console.log('\n──── the worker drafts into the post that already exists ────');

check('an interactive job skips ideation and inserts nothing', () => {
    const branch = worker.slice(landmark(worker, 'if (interactive) {'), landmark(worker, '} else {'));
    assert.ok(!/db\.insert\(blogPosts\)/.test(branch),
        'the interactive branch inserts a post — the author already has one open');
    assert.ok(!/ideateBlogTopic\(/.test(branch),
        'the interactive branch ideates a topic, discarding the one the author typed');
});

check("the author's post is never handed to the orphan cleanup", () => {
    // failJob() DELETES the post it is given. That is right for a half-built autopilot draft and
    // catastrophic for the post open in the editor, so createdPostId must stay null on that branch.
    const branch = worker.slice(landmark(worker, 'if (interactive) {'), landmark(worker, '} else {'));
    assert.ok(!/createdPostId = /.test(branch),
        'the interactive branch sets createdPostId — a failed attempt would delete the author’s post');
    assert.ok(/orphanPostId: createdPostId/.test(worker), 'the cleanup no longer reads createdPostId at all');
});

check('the discriminator is the column, not the trigger type', () => {
    // campaign-orders.ts enqueues blog jobs with trigger_type 'on_demand' and DOES want the
    // autopilot path, so keying the branch on trigger_type sends those down the wrong one.
    assert.ok(/const interactive = job\.result_blog_post_id != null;/.test(worker),
        'the interactive branch is keyed on something other than result_blog_post_id');
    assert.ok(/result_blog_post_id/.test(landmark(worker, 'FROM content_generation_jobs') >= 0
        ? worker.slice(landmark(worker, 'SELECT id, job_id'), landmark(worker, 'FROM content_generation_jobs'))
        : ''), 'the drain does not SELECT the column it branches on — it would read undefined');
});

check('a completed job is never re-queued by a failing follow-up', () => {
    // One content job wrote eight posts on prod (2026-09-03) this way. Here it would redraft the
    // article over the top of the one the author is reading.
    const tail = worker.slice(landmark(worker, "status: 'completed'"), worker.length);
    assert.ok(/jobCompleted = true;/.test(tail), 'nothing records that the job settled');
    assert.ok(/if \(jobCompleted\) \{[\s\S]{0,300}return;/.test(tail),
        'the catch re-queues a job whose post is already written');
});

console.log('\n──── the browser can always see what happened ────');

check('api() resolves on a non-JSON response instead of rejecting', () => {
    const api = modal.slice(landmark(modal, 'var api = function (path, opts)'),
        landmark(modal, 'var state = {'));
    // Two handlers on the JSON parse, and one on the fetch itself. Without them a 502 or a dropped
    // connection rejects into a bare .then() and the surface freezes on its last "…" message.
    assert.ok(/r\.json\(\)\.then\(function \(j\)[\s\S]*?, function \(\)/.test(api),
        'r.json() has no rejection handler — a non-JSON body still rejects the promise');
    assert.ok(/ok: false, body: \{ error/.test(api),
        'a failure does not arrive in the { ok, body.error } shape the call sites branch on');
});

check('the draft is polled, not awaited', () => {
    assert.ok(!/gen\.body\.bodyMarkdown/.test(modal),
        'the client still expects the body back from the POST — that response no longer carries one');
    assert.ok(/function pollAiDraft\(/.test(modal), 'nothing polls the job');
    assert.ok(/generate-blog\?jobId=/.test(modal), 'the poll does not read the job status endpoint');
});

check('every terminal state clears the spinner', () => {
    const poll = modal.slice(landmark(modal, 'function pollAiDraft('), landmark(modal, 'function applyAiDraft('));
    assert.ok(/status === 'failed'/.test(poll), 'a failed job polls forever — the original symptom, one layer down');
    assert.ok(/DRAFT_POLL_TIMEOUT_MS/.test(poll), 'nothing bounds the poll');
    // The failure path must both stop the poll and unlock the editor, or the author is left with a
    // dead page and no way back to their own draft.
    const failure = poll.slice(landmark(poll, "status === 'failed'"));
    assert.ok(/aiDraftJobId = null/.test(failure) && /aiDraftBusy\(false\)/.test(failure),
        'a failed draft leaves the editor locked');
});

check('the editor is locked while the worker writes into the post', () => {
    // MarkdownEditor autosaves 1.2s after any keystroke. Typing during a draft races the worker's
    // write to body_markdown: one of the two bodies wins and the other is lost silently.
    const busy = modal.slice(landmark(modal, 'function aiDraftBusy(busy)'), landmark(modal, 'function stopAiDraftPoll()'));
    assert.ok(/pointerEvents/.test(busy), 'the editor stays typable while the server is writing to it');
    assert.ok(/function stopAiDraftPoll\(\)/.test(modal), 'no way to abandon a poll when the post changes');
});

console.log(`\n${passed} checks passed.`);
