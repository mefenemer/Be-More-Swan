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
    const mounts = [...workspace.matchAll(/mount:\s*'([a-z0-9-]+)'/g)].map(m => m[1]);
    const also   = [...workspace.matchAll(/also:\s*'([a-z0-9-]+)'/g)].map(m => m[1]);
    const borrowed = [...mounts, ...also, 'post-review-changes'];
    assert.ok(borrowed.length >= 8, `expected to find the rail's mounts, got ${JSON.stringify(borrowed)}`);
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
check('the rail steps run content first', () => {
    const block = workspace.slice(workspace.indexOf('const _RAIL = ['), workspace.indexOf('];', workspace.indexOf('const _RAIL = [')));
    const keys = [...block.matchAll(/key:\s*'(\w+)'/g)].map(m => m[1]);
    assert.deepStrictEqual(keys, ['write', 'media', 'text', 'link', 'setup', 'check', 'when'],
        'the editor opens on the work, not on the targeting form — writing comes before platforms & format');
    assert.ok(keys.indexOf('write') < keys.indexOf('setup'),
        '"Write" must come before "Platforms & format"');
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
    assert.match(workspace, /\{ key: 'setup', title: 'Platforms',/,
        'the step decides platforms; format is derived');
    // The blocker is NOT a picker — it says a derived format can never carry the attached media.
    assert.ok(workspace.includes('id="pce-format-blocked"'),
        'the "this format can never publish" warning must survive — it is the only pre-approval notice');
    // _pceChooseFormat still runs: the format/media agreement code moves the format to fit new media.
    assert.ok(workspace.includes('async function _pceChooseFormat('),
        '_pceChooseFormat is still called by the format-media agreement code');
});

// ── 7. The branded card is reachable from the Media step ────────────────────────────────────────
check('the Media step carries the style chooser and the whole media inspector', () => {
    assert.match(workspace, /\{ key: 'media', title: 'Media',\s+mount: 'pce-style-block', also: 'pce-insp-media' \}/,
        'mounting #gp-ai-media alone left "Make a branded card" and every card control off screen');
    assert.ok(workspace.includes('id="pce-style-block"'), 'the photo-vs-card chooser needs its own mountable block');
    assert.ok(workspace.includes('id="pce-insp-media"'), 'the media inspector needs an id for the rail to borrow it');
    const render = workspace.slice(workspace.indexOf('function _railRender()'));
    assert.match(render.slice(0, 3000), /if \(step\.key === 'media'\) _inspMountMediaPanel\(\)/,
        'the sourcing panel must nest into #post-review-media-host inside the borrowed inspector');
});

check('a branded card can be inverted', () => {
    assert.ok(workspace.includes('id="pce-invert"'), 'the card needs an invert control');
    const fn = workspace.slice(workspace.indexOf('function _pceInvertCardColours()'));
    const body = fn.slice(0, 900);
    assert.match(body, /bg\.value = text\.value/, 'invert must swap background and text');
    assert.match(body, /_pceRefreshPreview\(\)/,
        'invert must re-render through the ordinary preview path, so Undo and Save need no special case');
    assert.match(body, /if \(!_pceState\.kitSeeded\) return;/,
        '_pceValues drops colours while unseeded, so an invert before the kit lands would be discarded');
    assert.ok(!body.includes('primaryColor'),
        'the accent is not part of the foreground/background pair — swapping it looks like a different brand');
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
    assert.match(fn, /gpStopVoice\(\);\n\n    const micBtn/,
        'starting must clear whatever session came before, so a stale one cannot hold the microphone');
    assert.match(fn, /_gpVoice = \{ handle, targetId, micId: cfg\.mic \}/,
        'the handle has to be kept or it can never be stopped');
    assert.match(fn, /if \(kind !== 'aborted'\) gpVoiceError/,
        "'aborted' is what a stop looks like — reporting it would cry wolf on every hand-over");
    assert.ok(fn.includes('Microphone access is blocked'),
        'a denied microphone must say so — silence is what made this look broken');

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
    for (const id of ['post-review-reject-toggle', 'post-review-quick-links', 'post-review-draft-actions']) {
        assert.ok(workspace.includes(`id="${id}"`), `#${id} is needed to switch the footer by authorship`);
    }
    const sync = workspace.slice(workspace.indexOf("const isOwnDraft = post.status === 'draft';"));
    assert.match(sync.slice(0, 900), /post-review-reject-toggle'\)\?\.classList\.toggle\('hidden', isOwnDraft\)/,
        'you do not reject your own blank page');
    assert.match(sync.slice(0, 900), /\['post-review-quick-links', !isOwnDraft\]/,
        'the rewrite and re-time links belong to reviewing someone else\'s draft');
    assert.match(sync.slice(0, 900), /\['post-review-draft-actions', isOwnDraft\]/,
        'save/discard belong to writing your own');
    // Discard reuses the established soft-cancel, and covers the whole cross-post group.
    const discard = workspace.slice(workspace.indexOf('async function rqReviewDiscardDraft()'));
    assert.match(discard.slice(0, 1500), /method: 'DELETE'/, 'discard must actually retire the row');
    assert.match(discard.slice(0, 1500), /_rqReviewGroupIds/, 'every platform in the group is one post');
    // Save must flush a caption still open on the canvas — that box commits on blur, and a button is not a blur.
    const save = workspace.slice(workspace.indexOf('async function rqReviewSaveDraft()'));
    assert.match(save.slice(0, 700), /_pceCommitInlineCaption\(ta\)/,
        'closing from a button is not a blur, so an open caption would be lost');
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
