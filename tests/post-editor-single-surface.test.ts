// tests/post-editor-single-surface.test.ts
// There is ONE post editor, it has ONE layout, and that layout leads with the content.
//
// Run:  npx tsx tests/post-editor-single-surface.test.ts
//
// Source-level, like tests/crosspost-grouping.test.ts, and for the same reason: every failure this
// guards against is a silent one. Nothing throws when a second editor exists, when a layout flag
// quietly defaults to the old layout, or when a borrowed control block loses the home it gets put
// back into — you just get the wrong screen, or a control that stops saving.
//
// Three decisions are pinned here:
//   1. The step rail is the ONLY layout. It shipped behind window.__bmsRail defaulting to OFF, so
//      the converged editor was built, committed, and invisible to everyone.
//   2. The steps run content first — write before targeting.
//   3. The Content Calendar opens the real editor. It used to carry a second, older post panel with
//      its own platform/format controls, so the same post offered different tools depending on
//      where it was clicked.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const workspace = read('workspace.html');
const calendarJs = read('calendar.js');
const calendarHtml = read('calendar.html');

console.log('\nPost editor — one surface, one layout\n');

// ── 1. One layout ───────────────────────────────────────────────────────────────────────────────
check('the layout flag and its switch are gone', () => {
    for (const token of ['__bmsRail', 'bms_rail', '_railOn', '_railSet', 'pce-layout-toggle', '_railToggleLayout']) {
        // Comments are allowed to mention the flag — that is the record of why it went.
        const live = workspace
            .split('\n')
            .filter(l => l.includes(token) && !/^\s*(\/\/|\*|<!--|\s*-->)/.test(l) && !l.trimStart().startsWith('//'))
            .filter(l => !l.includes('was flagged') && !l.includes('lived here'));
        assert.deepStrictEqual(live, [],
            `'${token}' is still live code — the step rail is the only layout, there is nothing to flag`);
    }
});

check('the collapsible panes are gone', () => {
    for (const token of ['_pceApplyPanes', '_pceTogglePane', '_pceShowLeftPane', '_pceCollapsed', 'pce-left-reopen', 'pce-right-reopen']) {
        const live = workspace
            .split('\n')
            .filter(l => l.includes(token) && !l.trimStart().startsWith('//'));
        assert.deepStrictEqual(live, [], `'${token}' survived the pane removal`);
    }
});

// The panes are gone, but the BLOCKS inside them are not: _railMount lends them to a step and
// _railRestoreAll puts them back before the rail's next innerHTML write. A block with no home is
// destroyed by that write, and #post-review-caption specifically is the field the save reads.
check('every block the rail borrows still has a home to be restored to', () => {
    // Blocks are resolved per post now (a still puts text+sound in Media, a video in step 3), so the
    // ids are inside blocks() bodies rather than static mount/also fields.
    const rail = workspace.slice(workspace.indexOf('const _RAIL = ['), workspace.indexOf('\n];', workspace.indexOf('const _RAIL = [')));
    const borrowed = [...new Set([...rail.matchAll(/'((?:pce|gp|post)-[a-z0-9-]+)'/g)].map(m => m[1]))];
    borrowed.push('post-review-changes');
    assert.ok(borrowed.length >= 7, `expected to find the rail's blocks, got ${JSON.stringify(borrowed)}`);
    for (const id of borrowed) {
        assert.ok(workspace.includes(`id="${id}"`),
            `the rail borrows #${id}, but no element with that id exists — _railRestoreAll would have nowhere to put it back`);
    }
});

check('the caption field the save reads from still exists, parked and hidden', () => {
    assert.match(workspace, /id="post-review-caption"/,
        'rqReviewSaveAmend saves from #post-review-caption — deleting it stops the editor saving captions');
    assert.match(workspace, /<aside id="post-review-inspector" class="hidden"/,
        'the parking container must be hidden in the markup, not shown as a pane');
    assert.match(workspace, /<aside id="pce-left" class="hidden"/,
        'the parking container must be hidden in the markup, not shown as a pane');
});

// ── 2. Content first ────────────────────────────────────────────────────────────────────────────
check('the rail steps run content first, with no Platforms step', () => {
    const block = workspace.slice(workspace.indexOf('const _RAIL = ['), workspace.indexOf('\n];', workspace.indexOf('const _RAIL = [')));
    const keys = [...block.matchAll(/key:\s*'(\w+)'/g)].map(m => m[1]);
    assert.deepStrictEqual(keys, ['write', 'media', 'imgtext', 'video', 'link', 'check', 'when'],
        'write → media → image overlays → video overlays → link → check → when');
    assert.ok(!keys.includes('setup'),
        'a post goes out on the connected accounts — openGeneratePostSheet seeds them, so there is nothing to choose');
});

check('a new post is seeded across every connected platform', () => {
    const fn = workspace.slice(workspace.indexOf('async function openGeneratePostSheet()'));
    const body = fn.slice(0, 2200);
    assert.match(body, /\.filter\(p => connected\.some\(c => c\.includes\(p\.id\)\)\)/,
        'seeding one platform is what made a Platforms step necessary');
    assert.match(body, /platforms, blank: true/, 'the whole set goes to create-manual-post');
    assert.ok(!/const first = /.test(body), 'the first-connected-only seed must be gone');
});

check('step 3 is video-only and says so, and stills keep their text and sound', () => {
    const block = workspace.slice(workspace.indexOf('const _RAIL = ['), workspace.indexOf('\n];', workspace.indexOf('const _RAIL = [')));
    assert.match(block, /key: 'video'[\s\S]*?enabled: \(post\) => _pcePostIsVideo\(post\)/,
        'timed text needs a duration, which a still cannot give it');
    // A still keeps BOTH: overlays in their own step, sound with the media it plays over.
    assert.match(block, /key: 'imgtext'[\s\S]*?enabled: \(post\) => !_pcePostIsVideo\(post\) && !!post\?\.thumbnailUrl/,
        'exactly one of the two overlay steps is ever enabled, and a card has sound even without overlays');
    // Sound left Media and rides with whichever overlay step the media type uses.
    const imgStep = block.slice(block.indexOf("key: 'imgtext'"), block.indexOf("key: 'video'"));
    assert.match(imgStep, /pce-insp-audio/, 'a photo with a voice note publishes as a video — sound goes with it');
    const mediaStep = block.slice(block.indexOf("key: 'media'"), block.indexOf("key: 'imgtext'"));
    assert.ok(!mediaStep.includes('pce-insp-audio'),
        'Media is about which picture — a voice note is not a picture');
    assert.match(block, /_pceLayers\.includes\('overlays'\)/,
        'a branded card has no overlay layer — reuse the existing capability gate rather than a second rule');
    // A disabled step must refuse to open, or it shows an empty panel.
    const toggle = workspace.slice(workspace.indexOf('function _railToggle(key)'));
    assert.match(toggle.slice(0, 700), /if \(step\?\.enabled && !step\.enabled\(post\)\) return;/,
        'an empty panel says the controls failed to draw, not that they belong elsewhere');
});

check('the format blocker survived the deleted step, somewhere always visible', () => {
    const body = workspace.slice(workspace.indexOf('id="post-review-media-alert"'), workspace.indexOf('id="post-review-tabs"'));
    assert.match(body, /id="pce-format-blocked"/,
        'it lived inside the Platforms step; with that gone it had to move or the only "cannot publish" warning would be invisible');
});

check('the header states no format until there is media to route', () => {
    const fn = workspace.slice(workspace.indexOf('function _rqReviewRenderTabs()'));
    const tabsBody = fn.slice(0, fn.indexOf('\n}\n'));
    assert.match(tabsBody, /route && p\.thumbnailUrl \?/,
        '"Instagram / no format" on a brand-new post reads as a fault, not as "add a picture"');
    // Comments stripped: the note recording why the link went naturally names it.
    const tabsCode = tabsBody.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n');
    assert.ok(!tabsCode.includes('Add a platform'),
        'the add-platform link pointed at a deleted step, which is why clicking it did nothing');
});

check('the modal owns the scroll while it is open', () => {
    const open = workspace.slice(workspace.indexOf("const modal = document.getElementById('post-review-modal');"));
    assert.match(open.slice(0, 900), /window\.ScrollLock\?\.lock\('post-review'\)/,
        'the page behind scrolled because this modal never took a lock');
    const close = workspace.slice(workspace.indexOf('function closePostReview()'));
    assert.match(close.slice(0, 400), /window\.ScrollLock\?\.release\('post-review'\)/,
        'a lock that is never released leaves the whole app unscrollable');
    assert.match(workspace, /style="overscroll-behavior:contain"/,
        'without this the gesture chains to the page once the panel scroller hits its end');
});

check('step 7 is the decision, with three ways to commit', () => {
    const at = workspace.indexOf('id="post-review-reschedule"');
    const panel = workspace.slice(at, workspace.indexOf('id="post-review-disclosure"', at));
    assert.match(panel, /onclick="rqReviewApprove\(\)"/, 'option 1: let the assistant pick the slot');
    assert.match(panel, /onclick="rqReviewScheduleMyself\(\)"/, 'option 2: a time you choose');
    assert.match(panel, /onclick="rqReviewPublishNow\(\)"/, 'option 3: now');
    // Choosing a time and approving must be ONE call, or a post can end up moved but unapproved.
    const fn = workspace.slice(workspace.indexOf('async function rqReviewScheduleMyself()'));
    assert.match(fn.slice(0, 2200), /_rqApproveTargets\(targets, 'reschedule', \{ rescheduleAt: when \}\)/,
        'setting the time and committing the post are one action');
    assert.match(workspace, /\.\.\.\(opts\.rescheduleAt \? \{ rescheduleAt: opts\.rescheduleAt \} : \{\}\)/,
        'approve-post needs the chosen time');
    assert.match(workspace, /const r = await _rqApproveOne\(p, action, opts\);/,
        'siblings share the slot — dropping opts would approve them at their old times');
    // The footer's Approve is gone entirely — two Approve buttons on screen at once was the bug.
    assert.ok(!workspace.includes('id="post-review-approve-btn"'),
        'approving lives in step 7; a footer Approve put the same question on screen twice');
    // Rejecting moved here too, so step 7 is the whole decision: three ways to yes, one to no.
    assert.match(panel, /id="post-review-when-reject-wrap"/,
        'a lone red button at the bottom of the footer read as the modal\'s parting question');
    // "Pick the time myself" must not occupy the panel until it is chosen.
    assert.match(panel, /id="post-review-when-mine" class="hidden/,
        'the date field, the words box and their button were most of the panel whether or not anyone wanted them');
});

check('there is exactly one rqReviewPublishNow, and it is the one with the gates', () => {
    const defs = [...workspace.matchAll(/async function rqReviewPublishNow\(/g)].length;
    assert.strictEqual(defs, 1,
        'two definitions meant the LATER one silently won — it published one platform, skipped the connection and media gates, and asked for no confirmation');
    const fn = workspace.slice(workspace.indexOf('async function rqReviewPublishNow()'));
    const body = fn.slice(0, 1800);
    assert.match(body, /rqEnsurePlatformConnection/, 'post-now skips the wait, not the checks');
    assert.match(body, /confirm\(/, 'the one irreversible action in the editor must confirm');
    assert.match(body, /_rqReviewTargets\(\)/, 'it must publish the whole group');
});

check('no step is auto-opened, so the order is an offer and not a wizard', () => {
    assert.match(workspace, /let _railOpen = null;/,
        'the rail must open with every step collapsed — the post is what you see first');
});

// ── 3. One surface ──────────────────────────────────────────────────────────────────────────────
check('the calendar opens the real editor', () => {
    // Anchor on the DEFINITION — the name also appears in every chip's onclick.
    const at = calendarJs.indexOf('window._calOpenPost = ');
    assert.ok(at > 0, 'could not find the _calOpenPost definition');
    assert.match(calendarJs.slice(at, at + 900), /window\.openPostReview\(postId\)/,
        'clicking a calendar chip must open the shared editor, not a panel of the calendar\'s own');
});

check('the calendar\'s own post panel is deleted', () => {
    for (const id of ['aura-panel', 'panel-logistics-platform', 'panel-logistics-format', 'panel-caption-edit', 'modal-reject-post', 'modal-approve-past']) {
        assert.ok(!calendarHtml.includes(`id="${id}"`),
            `#${id} is part of the calendar's old post editor — it was replaced by openPostReview`);
    }
    // The drag-to-another-day confirmation is the calendar's OWN gesture and stays.
    assert.ok(calendarHtml.includes('id="modal-reschedule"'),
        'dragging a chip to another day is the calendar\'s own gesture and keeps its confirmation');
});

check('nothing still calls the deleted panel actions', () => {
    const gone = ['_calClosePanel', '_calToggleEdit', '_calSaveEdits', '_calApprovePost', '_calOpenRejectPanel',
                  '_calCancelPost', '_calDetachAsset', '_calSubmitRejection', '_calNavPost', 'toggleQualityPanel'];
    for (const rel of ['calendar.js', 'calendar.html', 'workspace.html', 'assistant-detail.html']) {
        const src = read(rel);
        for (const name of gone) {
            assert.ok(!src.includes(name), `${rel} still references ${name}, which was deleted with the calendar panel`);
        }
    }
});

check('closing the editor refreshes the calendar', () => {
    const close = workspace.slice(workspace.indexOf('function closePostReview()'));
    assert.match(close.slice(0, 1600), /window\._calRefreshAfterEdit\?\.\(\)/,
        'the calendar\'s posts are stale once the editor has saved — closing it must ask for a reload');
    assert.match(calendarJs, /window\._calRefreshAfterEdit\s*=/,
        'calendar.js must expose the refresh hook closePostReview calls');
});

// ── 4. Drafting lives in the writing step, not the header ───────────────────────────────────────
check('both drafting buttons are in step 1, not the modal header', () => {
    const block = workspace.slice(workspace.indexOf('id="pce-write-block"'), workspace.indexOf('id="post-review-amend-all"'));
    assert.ok(block.includes('id="pce-ai-actions"'), 'the Draft-with-AI pair must live inside #pce-write-block');
    assert.ok(block.includes('_pceDraftWithAI()'), '"Draft it for me" must be in step 1');
    assert.ok(block.includes('_pceAskSwanCaption()'), '"Talk it through in chat" must be in step 1');

    // The header keeps only the title and the close button.
    const header = workspace.slice(workspace.indexOf('id="post-review-title"'), workspace.indexOf('<!-- Body: platform mock-up'));
    for (const gone of ['_pceDraftWithAI', '_pceAskSwanCaption', 'pce-ai-actions']) {
        assert.ok(!header.includes(gone), `${gone} is still in the modal header — it belongs to the writing step`);
    }
});

// ── 5. Dictation is reachable ───────────────────────────────────────────────────────────────────
// The mic that served the caption was #pce-caption-mic in the design pane. The converged layout
// never shows that pane, so dictating a post had quietly become impossible while the recogniser
// stayed wired up — a feature that fails by being invisible.
check('every text box the user writes into has a mic the layout actually shows', () => {
    const fields = workspace.slice(workspace.indexOf('const GP_VOICE_FIELDS = {'), workspace.indexOf('function gpStartVoice'));
    for (const id of ['pce-inline-caption', 'post-review-feedback']) {
        assert.ok(fields.includes(`'${id}'`), `${id} must be registered with the shared recogniser`);
    }
    // The canvas caption box is created in JS, so its mic and its stable id are created there too.
    const opener = workspace.slice(workspace.indexOf('function _pceOpenInlineCaption'));
    assert.match(opener.slice(0, 4000), /ta\.id = 'pce-inline-caption'/,
        'the inline caption box needs a stable id — gpStartVoice writes into an element by id');
    assert.match(opener.slice(0, 4000), /gpStartVoice\('pce-inline-caption'\)/,
        'the inline caption box needs a mic button');
    // Dictated text must reach the field the save reads from, exactly as typing does.
    assert.match(fields, /box\.value = ta\.value/,
        'dictation into the canvas caption must mirror into #post-review-caption or it is lost on blur');
    assert.ok(workspace.includes('id="pce-feedback-mic"'), 'the rewrite box needs a mic');
});

// ── 6. Format is reported, not chosen ───────────────────────────────────────────────────────────
check('the format picker is gone and the platform step is named for what it decides', () => {
    for (const id of ['pce-format-list', 'pce-format-for', 'pce-format-scope', 'pce-format-rules']) {
        assert.ok(!workspace.includes(`id="${id}"`), `#${id} is part of the format picker, which the engine replaces`);
    }
    // The blocker is NOT a picker — it says a derived format can never carry the attached media.
    assert.ok(workspace.includes('id="pce-format-blocked"'),
        'the "this format can never publish" warning must survive — it is the only pre-approval notice');
    // _pceChooseFormat still runs: the format/media agreement code moves the format to fit new media.
    assert.ok(workspace.includes('async function _pceChooseFormat('),
        '_pceChooseFormat is still called by the format-media agreement code');
});

// ── 7. The branded card is reachable from the Media step ────────────────────────────────────────
check('the Media step carries the style chooser and the whole media inspector', () => {
    const railBlocks = workspace.slice(workspace.indexOf('const _RAIL = ['), workspace.indexOf('\n];', workspace.indexOf('const _RAIL = [')));
    assert.match(railBlocks, /key: 'media'[\s\S]*?'pce-style-block', 'pce-insp-media'/,
        'the style chooser and what-is-attached belong together');
    assert.ok(workspace.includes('id="pce-style-block"'), 'the photo-vs-card chooser needs its own mountable block');
    assert.ok(workspace.includes('id="pce-insp-media"'), 'the media inspector needs an id for the rail to borrow it');
});

check('the card has one inversion control, not two', () => {
    // Light/Bold IS the inversion (resolveCardPalette swaps background and text between variants), so
    // a separate "Invert colours" button was a second control for a decision already made — and the
    // two could disagree about which way round the card was.
    assert.ok(!workspace.includes('id="pce-invert"'), 'the variant control already inverts');
    assert.ok(!/function _pceInvertCardColours\(\) \{/.test(workspace), 'and its handler went with it');
    assert.match(workspace, /data-variant="light"/, 'Light/Bold must still be there');
    assert.match(workspace, /data-variant="bold"/, 'Light/Bold must still be there');
});

// ── 8. The caption badges count characters and nothing else ─────────────────────────────────────
check('the caption length badges no longer carry media warnings', () => {
    const fn = workspace.slice(workspace.indexOf('function _pceRefreshCaptionMeta'));
    // Comments stripped: the note explaining why the warning went naturally quotes it.
    const body = fn.slice(0, fn.indexOf('\n}\n'))
        .split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n');
    for (const phrase of ['needs an image', 'needs a video']) {
        assert.ok(!body.includes(phrase),
            `"${phrase}" under the caption answers a question nobody asked while writing — the Media step and the approve gate own it`);
    }
    // The protection itself must still exist somewhere.
    assert.ok(workspace.includes('needs an image before this can publish'),
        'the approve-time media gate must survive the badge cleanup');
});

// ── 9. The platform preview picker is always on screen ──────────────────────────────────────────
check('the platform tab bar shows even for a single-platform post', () => {
    const fn = workspace.slice(workspace.indexOf('function _rqReviewRenderTabs()'));
    const body = fn.slice(0, 2500);
    assert.ok(!body.includes('group.length < 2) { host.classList.add'),
        'hiding the bar below two platforms left a new post with nothing naming the platform it is for');
    assert.match(body, /if \(!group\.length\)/, 'the bar hides only when there is no platform at all');
    assert.match(body, /Add a platform/, 'a single-platform post needs a route to a second one');
});

// ── 10. Length checks wait until there is something to check ────────────────────────────────────
check('the caption badges say nothing on an empty post, and step 6 carries the verdict', () => {
    const fn = workspace.slice(workspace.indexOf('function _pceRefreshCaptionMeta'));
    assert.match(fn.slice(0, 3000), /if \(!len\) \{ paint\(''\); return; \}/,
        '"Instagram · 0/2200" on a brand-new post is a limit check against no content');
    // The check itself must still happen — moved, not dropped.
    assert.ok(workspace.includes('function _pceOverLimitPlatforms('),
        'the over-limit check needs one shared implementation');
    const sub = workspace.slice(workspace.indexOf("case 'check': {"));
    assert.match(sub.slice(0, 900), /_pceOverLimitPlatforms\(post\)/,
        'step 6 is where the length verdict belongs');
    assert.match(sub.slice(0, 900), /Too long for/, 'step 6 must name the platforms it is too long for');
    // Both readers must count the same string, link paragraph included.
    const shared = workspace.slice(workspace.indexOf('function _pceOverLimitPlatforms('), workspace.indexOf('function _pceRefreshCaptionMeta'));
    assert.match(shared, /_pceLinkLine\(caption\)/,
        'the badges and step 6 must count the same text the publishers send, or they will disagree');
});

// ── 11. Dictation is a toggle that owns exactly one recogniser ───────────────────────────────────
// The bug: every click called SwanSpeech.start() and nothing was ever stopped. The browser allows
// one recogniser, so click → grant permission (ends that session) → click again raced a forgotten
// session, failed with 'aborted', and the only handling was to un-redden the button. Silent.
check('the mic toggles, tracks one session, and reports real failures', () => {
    const fn = workspace.slice(workspace.indexOf('let _gpVoice = null;'), workspace.indexOf('// ── Shared chip styling'));
    assert.match(fn, /if \(_gpVoice && _gpVoice\.targetId === targetId\) \{ gpStopVoice\(\); return; \}/,
        'a second click on the listening mic must STOP, not start a rival recogniser');
    assert.match(fn, /const handingOver = !!_gpVoice;\s*\n\s*gpStopVoice\(\);/,
        'starting must clear whatever session came before, so a stale one cannot hold the microphone');
    assert.match(fn, /_gpVoice = \{ handle, targetId, micId: cfg\.mic \}/,
        'the handle has to be kept or it can never be stopped');
    assert.match(fn, /if \(kind !== 'aborted' && kind !== 'start-failed'\) gpVoiceError/,
        "'aborted' is a stop, and SwanSpeech reports 'start-failed' from its own catch BEFORE returning null — reporting it here fired the error every time, including when the retry then worked");
    assert.ok(fn.includes('Microphone access is blocked'),
        'a denied microphone must say so — silence is what made this look broken');
    // stop() is async: starting in the same tick throws InvalidStateError, which surfaced as
    // "Dictation could not start" for nothing worse than moving between boxes.
    assert.match(fn, /if \(handingOver\) \{ setTimeout\(\(\) => _gpBeginVoice\(targetId, cfg\), 150\); return; \}/,
        'let the previous session land before opening a new recogniser');
    assert.match(fn, /if \(!isRetry\) \{ setTimeout\(\(\) => _gpBeginVoice\(targetId, cfg, true\), 300\); return; \}/,
        'the click straight after granting permission must succeed on the retry, not report a failure');

    // Dictation must not outlive the box it writes into.
    const commit = workspace.slice(workspace.indexOf('async function _pceCommitInlineCaption'));
    assert.match(commit.slice(0, 600), /gpStopVoice\(\)/,
        'the caption box is destroyed by the re-render; a live recogniser would write into a detached node');
    const close = workspace.slice(workspace.indexOf('function closePostReview()'));
    assert.match(close.slice(0, 400), /gpStopVoice\(\)/, 'a closed modal must not keep listening');
});

// ── 12. The orchestrator always answers in JSON ──────────────────────────────────────────────────
// A throw outside its single try/catch escaped to withLambda as a bare platform 502 with no body,
// which the chat UI can only report as "Something went wrong (HTTP 502)" — the exact symptom seen
// from "Talk it through in chat". Half the handler ran with no boundary at all.
check('chat-orchestrator has an error boundary around the whole handler', () => {
    const src = read('netlify/functions/chat-orchestrator.ts');
    assert.match(src, /export default withLambda\(async \(event\) => \{\s*try \{\s*return await handleChatTurn\(event\);/,
        'the whole turn needs a boundary, not just the LLM call');
    assert.match(src, /async function handleChatTurn\(/, 'the handler body must be callable from the wrapper');
    assert.match(src, /unhandled error before the LLM boundary/,
        'the outer catch must log, or the next raw 502 is just as undiagnosable');
});

// ── 13. Your own draft gets ways out that are not "publish" ──────────────────────────────────────
check('a post you are writing offers save-and-discard, not reject-and-rewrite', () => {
    assert.ok(workspace.includes('id="post-review-draft-actions"'),
        'save/discard is the one pair with no step of its own');
    for (const gone of ['post-review-reject-toggle', 'post-review-quick-links']) {
        assert.ok(!workspace.includes(`id="${gone}"`),
            `#${gone} duplicated a step: rejecting is in step 7, rewriting in step 1, timing in step 7`);
    }
    const sync = workspace.slice(
        workspace.indexOf("const isOwnDraft = post.status === 'draft';"),
        workspace.indexOf('// Per-post AI disclosure footer'));
    assert.match(sync, /draftActions\.classList\.toggle\('hidden', !isOwnDraft\)/,
        'save/discard belong to writing your own');
    assert.match(sync, /post-review-when-reject-wrap'\)\?\.classList\.toggle\('hidden', isOwnDraft\)/,
        'you do not reject your own writing — you throw it away');
    // Discard reuses the established soft-cancel, and covers the whole cross-post group.
    const discard = workspace.slice(workspace.indexOf('async function rqReviewDiscardDraft()'));
    assert.match(discard.slice(0, 1500), /method: 'DELETE'/, 'discard must actually retire the row');
    assert.match(discard.slice(0, 1500), /_rqReviewGroupIds/, 'every platform in the group is one post');
    // Save must flush a caption still open on the canvas — that box commits on blur, and a button is not a blur.
    const save = workspace.slice(workspace.indexOf('async function rqReviewSaveDraft()'));
    assert.match(save.slice(0, 700), /_pceCommitInlineCaption\(ta\)/,
        'closing from a button is not a blur, so an open caption would be lost');
});

// ── 14. The steps that act on a finished post wait for one ──────────────────────────────────────
check('Check & improve and Schedule & publish are gated on one readiness rule', () => {
    assert.ok(workspace.includes('function _pceNotReadyReason(post)'),
        'one rule, or the two steps will disagree about what "ready" means');
    const rail = workspace.slice(workspace.indexOf('const _RAIL = ['), workspace.indexOf('\n];', workspace.indexOf('const _RAIL = [')));
    for (const key of ['check', 'when']) {
        assert.match(rail, new RegExp(`key: '${key}'[\\s\\S]*?enabled: \\(post\\) => !_pceNotReadyReason\\(post\\)`),
            `step '${key}' acts on a finished post — a blank one would buy a critique of nothing, or schedule an empty page`);
    }
    // The rule must be the SAME two conditions the server enforces at approval.
    const fn = workspace.slice(workspace.indexOf('function _pceNotReadyReason(post)'));
    const body = fn.slice(0, 1400);
    assert.match(body, /Write a caption first/, 'no words, nothing to post');
    assert.match(body, /_rqPlatformBlockedReason\(t\)/,
        'reuse the existing publishability gate rather than inventing a second media rule');
    // Both subtitles must report the reason, or a disabled step says nothing.
    const sub = workspace.slice(workspace.indexOf("case 'check': {"));
    assert.match(sub.slice(0, 400), /const notReady = _pceNotReadyReason\(post\);/, 'step 5 must say what is missing');
    const subWhen = workspace.slice(workspace.indexOf("case 'when': {"));
    assert.match(subWhen.slice(0, 400), /const notReady = _pceNotReadyReason\(post\);/, 'step 7 must say what is missing');
});

// ── 15. Nothing claims a time has been chosen when it has not ───────────────────────────────────
check('a draft shows no scheduled time anywhere', () => {
    // The modal subtitle printed "<Assistant> · N platforms · planned for <date>".
    assert.ok(!workspace.includes('id="post-review-sub"'),
        'the platforms are on the tabs, and "planned for" printed a proposal as a decision');
    assert.ok(!workspace.includes("' · planned for '"), 'the subtitle builder went with it');
    // Step 7 shows a date only for a post whose schedule is actually live.
    const sub = workspace.slice(workspace.indexOf("case 'when': {"));
    assert.match(sub.slice(0, 900), /!window\.PlatformConstants\.isScheduleActive\(post\.status\)\) return 'Choose when to publish'/,
        "a draft's publish_date is a proposal — printing it made the step read as already settled");
});

// ── 16. Warnings wait until there is something to warn about ────────────────────────────────────
check('no platform is struck through before it has media to judge', () => {
    const fn = workspace.slice(workspace.indexOf('function _rqReviewRenderTabs()'));
    assert.match(fn.slice(0, 5000), /const blocked = !p\.thumbnailUrl \? null/,
        'a crossed-out platform on a post created seconds ago reads as "broken", not "add a picture"');
    // But the warning itself must survive — only Instagram (image) and YouTube (video) are mandatory.
    assert.ok(workspace.includes('only publishes video'), 'a photo on YouTube is still impossible');
    assert.ok(workspace.includes('needs an image before this can publish'), 'Instagram still needs one');
});

// ── 17. The platform allow-list is read, not retyped ────────────────────────────────────────────
// A hand-written set in check-capacity.ts omitted 'threads', so a connected Threads account was
// reported as not connected: missing from the tabs, skipped when a new post seeds its platforms, and
// refused by the approve-time gate.
check('connected platforms come from the catalogue', () => {
    const src = read('netlify/functions/check-capacity.ts');
    assert.match(src, /import \{ SOCIAL_PLATFORMS \} from '\.\.\/\.\.\/src\/config\/platform-formats'/,
        'the publishable platforms live in one place');
    assert.ok(!/new Set\(\['instagram', 'facebook', 'x', 'twitter'/.test(src),
        'the hand-written eight-name list is what dropped Threads');
    assert.match(src, /name === 'twitter' \? 'x' : name/,
        "legacy 'twitter' rows are the same account as 'x' — normalise rather than listing both");
    // Every catalogue platform must be reachable, Threads included.
    const cat = read('src/config/platform-formats.ts');
    for (const p of ['threads', 'youtube']) {
        assert.ok(cat.includes(`${p}:`), `${p} must be in the catalogue for the import to include it`);
    }
});

// ── 18. Dictation is offered where the caption is written ───────────────────────────────────────
check('the empty caption carries its own Dictate button', () => {
    assert.match(workspace, /data-caption-mic/,
        'dictation was only inside the editor, so it was invisible until you had started typing');
    const click = workspace.slice(workspace.indexOf('function _pceCanvasClick(ev)'));
    assert.match(click.slice(0, 1400), /if \(ev\.target\.closest\('\[data-caption-mic\]'\)\) \{[\s\S]*?_pceOpenInlineCaption\(\);[\s\S]*?gpStartVoice\('pce-inline-caption'\);/,
        'one click should open the box AND start listening');
});

// ── 19. A chat failure names itself ─────────────────────────────────────────────────────────────
check('the orchestrator reports a code the user can quote', () => {
    const src = read('netlify/functions/chat-orchestrator.ts');
    assert.match(src, /typeof e\?\.code === 'string'/,
        'a Postgres error code (42703, 42P01, 23502) identifies the fault and leaks no row data');
    assert.match(src, /const detail = typeof e\?\.message === 'string' \? e\.message\.slice\(0, 200\) : '';/,
        'the code alone reported "Error" for any plain throw — the message is what identifies it');
    assert.match(src, /Something went wrong starting that conversation: \$\{detail\}/,
        'the reader of this message is the person who can act on it');
});

// ── 20. The rewrite actions need something to rewrite ───────────────────────────────────────────
check('step 1\'s rewrite actions are disabled until there is a caption', () => {
    const block = workspace.slice(workspace.indexOf('id="pce-write-block"'), workspace.indexOf('id="pce-write-freetext"'));
    const tagged = (block.match(/data-rewrite-action/g) || []).length;
    assert.strictEqual(tagged, 3,
        '"Change the tone" / "Suggest hashtags" / "Fix grammar" each spend a generation asking the assistant to rewrite nothing');
    // "Shorten for X" is gone: the per-platform caption badges already count every platform's limit
    // live, and _pceOverLimitPlatforms blocks approval — a button duplicating that rule for ONE
    // platform, at the cost of a generation, was the worse half of the pair.
    assert.ok(!workspace.includes('Shorten for X'), 'length for X is enforced, not offered as a rewrite');
    assert.ok(workspace.includes('function _pceSyncRewriteActions()'), 'one place decides');
    // Must be kept honest both when the step opens and as the caption is typed.
    const render = workspace.slice(workspace.indexOf('function _railRender()'));
    assert.match(render.slice(0, 6000), /_pceSyncRewriteActions\(\)/, 'the step can be opened at any time');
    const meta = workspace.slice(workspace.indexOf('function _pceRefreshCaptionMeta()'));
    assert.match(meta.slice(0, 2500), /_pceSyncRewriteActions\(\)/, 'this already runs on every keystroke');
});

// ── 21. The caption offers the assistant where the words are ────────────────────────────────────
check('the written caption carries a swan Improve action', () => {
    assert.match(workspace, /data-caption-improve/, 'improving the words belongs on the words');
    const click = workspace.slice(workspace.indexOf('function _pceCanvasClick(ev)'));
    assert.match(click.slice(0, 1800), /data-caption-improve[\s\S]*?_railRewrite\(/,
        'route through the in-place rewrite so the better version lands in the post, not in a chat');
    // Only when there IS something to improve.
    assert.match(workspace, /const captionImprove = editableNow && !captionEmpty/,
        'on a blank caption the real offers are Dictate and step 1\'s "Draft it for me"');
});

// ── 22. The old layer list stays buried ─────────────────────────────────────────────────────────
check('nothing brings the pre-rail layer list back', () => {
    const fn = workspace.slice(workspace.indexOf('function _pceRenderLayers()'));
    const body = fn.slice(0, 1800);
    assert.ok(!/block\?\.classList\.toggle\('hidden', bare\)/.test(body),
        "toggle() REMOVED the class whenever the post had media, so the list reappeared under the caption");
    assert.match(body, /getElementById\('pce-layers-block'\)\?\.classList\.add\('hidden'\)/,
        'the rail is the layer list now');
    // And a render re-pins it, so whatever un-hides it next is corrected.
    const render = workspace.slice(workspace.indexOf('function _railRender()'));
    assert.match(render.slice(0, 7000), /Pinned shut on EVERY render/,
        '_railToggle re-renders without re-applying the layout — that is exactly when it came back');
});

// ── 23. A crop says what will happen, not what you must do ──────────────────────────────────────
check('an auto-cropped route explains itself', () => {
    const fn = workspace.slice(workspace.indexOf('function _rqReviewRenderTabs()'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.ok(!body.includes("'needs a crop'"),
        '"needs a crop" read as a job with no button to do it and no hint whether the assistant would');
    assert.match(body, /'auto-cropped'/, 'state the outcome');
    assert.match(body, /crops it to fit\. Swap the picture in Media if the framing matters/,
        'a crop route still PUBLISHES — only state "none" blocks — so say so');
});

// ── 24. Every media source has an explainer ─────────────────────────────────────────────────────
// The console said: [explainers] no glossary entry for "media-source-brand_card". A fourth source
// was added to the picker and the glossary was not, so its label had a dead tooltip.
check('every media source in the picker has a glossary entry', () => {
    const assistants = read('assistants.js');
    // Bounded to the object literal — the next const along is another META map, and reading into it
    // asserted a glossary entry for a goal status.
    const at = assistants.indexOf('const _MEDIA_SOURCE_META = {');
    const meta = assistants.slice(at, assistants.indexOf('\n};', at));
    const keys = [...meta.matchAll(/^\s{4}(\w+):\s*\{/gm)].map(m => m[1]);
    assert.ok(keys.length >= 4, `expected the media sources, got ${JSON.stringify(keys)}`);
    const explainers = read('explainers.js');
    for (const k of keys) {
        assert.ok(explainers.includes(`'media-source-${k}'`),
            `media source '${k}' is offered in the picker with no glossary entry — data-explain resolves to nothing`);
    }
});

// ── 25. Sourcing is a modal, opened from the picture ────────────────────────────────────────────
check('the media sourcing panel lives in its own modal', () => {
    assert.ok(workspace.includes('id="pce-media-modal"'), 'five source buttons were the bulk of the Media step');
    assert.ok(!workspace.includes('id="post-review-media-host"'),
        'the in-step host is gone — _pceOpenMediaPicker borrows #gp-ai-media into the modal instead');
    assert.ok(!/function _inspMountMediaPanel\(\) \{/.test(workspace),
        'its host no longer exists, so the function that filled it went too');
    // The empty frame must open the picker, not the OS file dialog: uploading is one of six answers.
    assert.match(workspace, /data-media-empty onclick="_pceOpenMediaPicker\(\)"/,
        'going straight to the file dialog answered "which picture" before it had been asked');
    // Borrow-and-return, or the next surface finds the panel parented into a hidden modal.
    const close = workspace.slice(workspace.indexOf('function _pceCloseMediaPicker()'));
    assert.match(close.slice(0, 700), /_rqRestoreMediaPanel\(\)/, 'the panel is shared with the generate-post sheet');
    // Its own scroll-lock key, or closing it would unlock the editor behind it.
    assert.match(workspace, /ScrollLock\?\.lock\('pce-media-modal'\)/, 'two overlays, two keys');
    // z-index must be inline: the compiled sheet has no z-[95].
    assert.match(workspace, /id="pce-media-modal"[^>]*style="z-index:95"/,
        'an uncompiled arbitrary z utility resolves to `auto`, which put this modal UNDER the editor');
    assert.ok(!workspace.includes('z-[95]"'), 'no uncompiled z utility in the class list');
});

check('a branded card is offered where you look for a picture, and only once', () => {
    assert.match(workspace, /_pceCreateBrandCardFromPicker/, 'no photo is a real answer to "which picture"');
    // R4: the standalone button duplicated the Post Style chooser directly above it.
    assert.ok(!workspace.includes('id="insp-make-card"'),
        'Post Style already offers Branded Card — the panel had two doors to one place');
    // Not on a video, and not while replacing an existing card.
    const open = workspace.slice(workspace.indexOf('function _pceOpenMediaPicker()'));
    assert.match(open.slice(0, 2200), /const cardable = !_pcePostIsVideo\(post\) && _pceSwapCardFor !== post\.id;/,
        'a card is a still, and offering another one mid-replacement is the opposite of the ask');
});

// ── 26. "Making the card…" has to finish ────────────────────────────────────────────────────────
check('the card paths refetch by the post\'s own status', () => {
    assert.ok(workspace.includes('async function _pceRefetchPostGroup(post)'), 'one helper, both callers');
    // The bug: `status=pending_approval` is an ASSISTANT draft's status. A post you made is 'draft',
    // so the refetch returned a list without it and the new card never reached the mock-up.
    const hardcoded = workspace.split('\n').filter(l =>
        l.includes("get-social-drafts?status=pending_approval") && !l.trimStart().startsWith('//'));
    assert.ok(hardcoded.length <= 2,
        `still ${hardcoded.length} hardcoded pending_approval refetches — a 'draft' post is invisible to them: ${hardcoded.map(l => l.trim().slice(0, 60)).join(' | ')}`);
    const fn = workspace.slice(workspace.indexOf('async function _pceCreateBrandCard()'));
    const body = fn.slice(0, 2500);
    assert.match(body, /await _pceRefetchPostGroup\(post\)/, 'the card is only visible once the group is refetched');
    assert.match(body, /say\(''\);/,
        '"Making the card…" was written to one element and the confirmation to another, so it never came down');
});

// ── 27. Step 1 stops narrating ───────────────────────────────────────────────────────────────────
check('step 1 does not explain itself', () => {
    assert.ok(!workspace.includes('Whatever comes back lands in the post itself'),
        'a caption under five buttons that already say what they do');
});

// ── 28. The card's wording is edited on the card ────────────────────────────────────────────────
check('the headline is placeable and editable on the canvas', () => {
    // Placeable: it joins the DRAG list but not the show/hide list — a card without words is not a card.
    assert.match(workspace, /const _PCE_PLACEABLE = \{ headline: 'Wording', wordmark:/,
        'two lists because the headline can be dragged but not hidden');
    const paint = workspace.slice(workspace.indexOf('function _pcePaintHandles()'));
    assert.match(paint.slice(0, 500), /Object\.entries\(_PCE_PLACEABLE\)/, 'handles come from the drag list');
    // Editable: double-click opens a box over the words, first click still drags.
    assert.ok(workspace.includes('function _pceOpenInlineHeadline()'), 'the words are edited where they are');
    const drag = workspace.slice(workspace.indexOf('function _pceDragStart(ev)'));
    assert.match(drag.slice(0, 900), /handle\.dataset\.key === 'headline' && ev\.detail >= 2/,
        'the first click must still be able to grab and move the words');
    // The textarea in the panel is gone, but its hidden field remains as the model _pceValues reads.
    assert.match(workspace, /<textarea id="pce-headline" rows="3" maxlength="120" class="hidden"/,
        'deleting the field outright would stop the card saving its wording');
    // Comments may name it — that record is why the field went. The LABEL must not exist.
    assert.ok(!/<label[^>]*for="pce-headline"/.test(workspace),
        'typing in a panel to change words that are on a picture somewhere else');
    // Client and server must agree on the default, or a card nobody dragged would move on first save.
    const brandCard = read('src/lib/brand-card.ts');
    assert.match(brandCard, /headline: \{ show: true, align: 'left', y: 0\.5 \}/, 'server default');
    assert.match(workspace, /headline: \{ show: true, align: 'left', y: 0\.5 \}/, 'client default');
});

// ── 29. The card saves itself ───────────────────────────────────────────────────────────────────
check('every card change commits without a Save button', () => {
    for (const gone of ['pce-save', 'pce-revert']) {
        assert.ok(!workspace.includes(`id="${gone}"`),
            'a card IS a rendered PNG — an unsaved edit meant the preview and the published image were different pictures');
    }
    assert.ok(workspace.includes('function _pceScheduleCardSave()'), 'one debounced save path');
    assert.ok(workspace.includes('async function _pceSaveCardNow()'), 'and one implementation');
    // Every control that changes stored state must schedule it: colours/font/variant, alignment,
    // drag-drop, show/hide, and the inline wording editor.
    const bind = workspace.slice(workspace.indexOf('(function _pceBind()'));
    assert.ok((bind.match(/_pceScheduleCardSave\(\)/g) || []).length >= 4,
        'a control that only previews leaves the card unsaved, which is the state this removes');
    const dragEnd = workspace.slice(workspace.indexOf('function _pceDragEnd('));
    assert.match(dragEnd.slice(0, 900), /_pceScheduleCardSave\(\)/, 'a dropped element is a change to the card');
    // "Reset to my brand style" is not an undo — it survives.
    assert.ok(workspace.includes('id="pce-resetkit"'), 'resetting to Brand Assets is a different starting point');
    // ...and it has to COMMIT like every other change. _pceRefreshPreview clears _pceState.resetKit,
    // so a reset that only previewed could never reach the server on any later save: the card on
    // screen would be the brand style and the card that published would be the old one.
    const reset = bind.slice(bind.indexOf("_pceEl('pce-resetkit')"));
    assert.match(reset.slice(0, 800), /_pceSaveCardNow\(\)/,
        'a reset that only previews is an unsaved edit, which is the state this whole change removes');
    assert.ok(!/Back to your brand style — save to keep it/.test(workspace),
        'the message must not ask for a Save button that no longer exists');
});

// ── 30. Font is a list, not a guessing game ─────────────────────────────────────────────────────
check('the font field is a picker', () => {
    assert.match(workspace, /<select id="pce-fontFamily"/,
        'loadWebFont silently falls back on an unknown family, so a typo produced the wrong typeface in silence');
    assert.ok(workspace.includes('const _PCE_FONTS = ['), 'a shortlist of families the renderer can fetch');
    assert.ok(workspace.includes('function _pceRenderFontOptions('),
        'a <select> drops a value it has no option for — a card already on an off-list family would be reset');
    assert.match(workspace, /<option value="">Your brand font<\/option>/,
        'the empty value must mean "whatever Brand Assets says"');
});

// ── 31. What left the Media step ────────────────────────────────────────────────────────────────
check('Media no longer carries the card wording, the swap-media block or Sound', () => {
    assert.ok(!workspace.includes('Whatever you attach replaces the card.'),
        'swapping a card for a picture is the media picker\'s job');
    // _pceSwapCardForMedia is still the mechanism — only the third door to it went.
    assert.ok(workspace.includes('function _pceSwapCardForMedia('), 'the mechanism survives');
    assert.ok(!workspace.includes('Card created — edit the wording below.'),
        'it pointed at a panel that no longer exists, and the card appearing IS the confirmation');
});

// ── 32. The handles do not print words on the card ──────────────────────────────────────────────
check('a drag handle is an outline, not a caption printed on the card', () => {
    const paint = workspace.slice(workspace.indexOf('function _pcePaintHandles() {'));
    const body = paint.slice(0, paint.indexOf('\n}\n'));
    // The chip read "Wording" / "Company name" / "Website" on every band, permanently. It looked
    // like part of the design — the card appeared to have the word "Website" printed on it.
    assert.ok(!/h\.innerHTML/.test(body),
        'a handle must draw no text of its own: the band sits over the words it moves, so it already says which it is');
    assert.ok(!/text-\[10px\][^`]*\$\{label\}/.test(body), 'and no chip markup may come back by another route');
    assert.match(body, /h\.title = label/,
        'the name is still reachable on hover for anyone who wants it');
    // The registry keeps the labels — the inspector and the title attribute both read them.
    assert.ok(workspace.includes("const _PCE_PLACEABLE = { headline: 'Wording'"),
        'the labels themselves are still the naming source, only the painted chip went');
});

// ── 33. Sound is a video layer ──────────────────────────────────────────────────────────────────
check('a still image is not offered Sound', () => {
    const sync = workspace.slice(workspace.indexOf('const audioCapable ='));
    const line = sync.slice(0, sync.indexOf('\n'));
    assert.match(line, /isVideo/,
        '"On the image" is about words placed on a still; a voice note is not something you place on a still');
    // A still that already HAS a clip must keep the panel, or the audio is stranded with no way to
    // remove it — and it would still publish the post as a video.
    assert.match(line, /_pceAudioClips\(post\)\.length > 0/,
        'hiding the panel on a still that already has a clip would strand the audio');
    // The step itself still mounts the block when the layer is present — that is the one seam.
    const rail = workspace.slice(workspace.indexOf("{ key: 'imgtext'"));
    assert.match(rail.slice(0, 400), /_pceLayers\.includes\('audio'\)/,
        'the step reads the layer list, so audioCapable is the single rule');
});

// ── 34. A dead voice module says so ─────────────────────────────────────────────────────────────
check('the mic button cannot fail silently', () => {
    const fn = workspace.slice(workspace.indexOf('function gpStartVoice('));
    const head = fn.slice(0, fn.indexOf('_gpBeginVoice(targetId, cfg);'));
    // Unguarded, this threw a TypeError inside an inline onclick — which the browser swallows, so
    // the mic became a button that does nothing at all: no toast, no alert, nothing to report.
    assert.match(head, /if \(!window\.SwanSpeech\) \{/,
        'a mic button that is silently dead is the hardest possible version of this bug to diagnose');
    assert.match(head, /console\.error\('\[voice\]/, 'and it must leave a trace that names the missing file');
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
