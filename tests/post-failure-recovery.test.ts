// tests/post-failure-recovery.test.ts
// Locks the failure classification, and the properties that stop the "Needs attention" column
// becoming a dead end again. No network or DB.
// Run:  npx tsx tests/post-failure-recovery.test.ts
//
// The bug these guard against: a post that failed to publish landed in the Review page's
// Needs-attention column, and that was the end of it. The card said "Failed to publish", opening it
// showed the post with no reason and no controls, and the only recovery path in the entire product
// was a banner in the Data Hub's Content Library. The rules below are what make the column
// actionable — and the classification is the part most likely to rot as platforms change their
// error text, so it is pinned to real messages the publishers actually store.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { diagnosePostFailure, type FailureKind } from '../src/utils/post-failure-diagnosis';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }

const ws = () => readFileSync(path.join(import.meta.dirname, '..', 'workspace.html'), 'utf8');

function kindOf(reason: unknown, platform = 'Instagram'): FailureKind {
    return diagnosePostFailure(reason as Parameters<typeof diagnosePostFailure>[0], platform).kind;
}

check('a dead connection is never reported as retryable', () => {
    // The one classification that must not be wrong in the optimistic direction: offering "Publish
    // again now" as the lead action on an expired token sends the user round a loop that fails
    // instantly, every time, and burns an attempt budget doing it.
    for (const reason of [
        { httpStatus: 401, errorMessage: 'Unauthorized', isRetryable: false },
        { httpStatus: 400, errorCode: 190, errorMessage: 'Error validating access token: Session has expired', isRetryable: false },
        { httpStatus: 400, errorCode: 200, errorMessage: '(#200) Permissions error', isRetryable: false },
        { httpStatus: 403, errorMessage: 'Forbidden', isRetryable: false },
        'The connection was revoked',
    ]) {
        const d = diagnosePostFailure(reason as never, 'LinkedIn');
        assert.equal(d.kind, 'connection', `expected a connection failure for ${JSON.stringify(reason)}`);
        assert.equal(d.retryable, false, 'a broken connection must never lead with a retry');
        assert.equal(d.needsReconnect, true, 'and it must offer the reconnect button');
        assert.match(d.remedy, /LinkedIn/, 'the remedy names the platform — a workspace has several');
    }
});

check('a suspension is classified before the generic 403 swallows it', () => {
    // Ordering matters: both arrive as a 403-ish refusal, but reconnecting cannot lift a suspension,
    // so offering "Reconnect" as the fix would be advice that cannot work.
    const d = diagnosePostFailure({ httpStatus: 403, errorCode: 368, errorMessage: 'Your account has been restricted', isRetryable: false }, 'Instagram');
    assert.equal(d.kind, 'account');
    assert.equal(d.needsReconnect, false);
});

check('media and content failures are not retryable — they need the post changed', () => {
    assert.equal(kindOf({ httpStatus: null, errorMessage: 'This post has media attached but it could not be loaded, so it was not published. Re-attach the media and try again.', isRetryable: true }), 'media');
    assert.equal(kindOf({ httpStatus: 400, errorSubcode: 352, errorMessage: 'Format unsupported' }), 'media');
    assert.equal(kindOf({ httpStatus: 400, errorMessage: 'Unsupported aspect ratio' }), 'media');
    assert.equal(kindOf({ httpStatus: 400, errorSubcode: 2207026, errorMessage: 'content policy' }), 'content');

    // The publisher stored isRetryable:true on the unresolvable-media path (it is retryable in the
    // sense that the row can be re-queued) — but retrying without re-attaching the media publishes
    // nothing, so the diagnosis must override the publisher's flag here.
    const gone = diagnosePostFailure({ httpStatus: null, errorMessage: 'This post has media attached but it could not be loaded, so it was not published.', isRetryable: true }, 'Facebook');
    assert.equal(gone.retryable, false, 'missing media is not fixed by trying again');
});

check('throttles and platform outages ARE retryable', () => {
    assert.equal(kindOf({ httpStatus: 429, errorMessage: 'Too Many Requests' }), 'rate_limit');
    assert.equal(kindOf({ httpStatus: 400, errorCode: 4, errorMessage: 'Application request limit reached' }), 'rate_limit');
    assert.equal(kindOf({ httpStatus: 503, errorMessage: 'Service Unavailable' }), 'platform');
    assert.equal(kindOf({ httpStatus: null, errorMessage: 'Video processing timed out after 120s', isRetryable: true }), 'platform');
    for (const r of [{ httpStatus: 429, errorMessage: 'rate limit' }, { httpStatus: 500, errorMessage: 'boom' }]) {
        assert.equal(diagnosePostFailure(r as never, 'X').retryable, true);
    }
});

check('a bare string and a null both produce something actionable', () => {
    // Rows predating the jsonb shape hold a plain string, and the video-upload timeout path can
    // leave the column null. Neither may render an empty red box with no way out.
    const legacy = diagnosePostFailure('LinkedIn rejected the request', 'LinkedIn');
    assert.ok(legacy.title && legacy.remedy, 'a legacy string still gets a title and a remedy');
    assert.equal(legacy.raw, 'LinkedIn rejected the request', 'and the original text survives verbatim');

    const nothing = diagnosePostFailure(null, 'Threads');
    assert.equal(nothing.raw, null);
    assert.ok(/no reason was recorded/i.test(nothing.title), 'say the reason is missing rather than invent one');
    assert.equal(nothing.retryable, true, 'with nothing to go on, let the user try');
});

check('every diagnosis carries a remedy — a cause with no next step is a nag', () => {
    const samples: unknown[] = [
        null, '', 'weird', { httpStatus: 418, errorMessage: "I'm a teapot" },
        { httpStatus: 401, errorMessage: 'nope' }, { httpStatus: 429, errorMessage: 'slow down' },
        { httpStatus: 400, errorMessage: 'aspect ratio' }, { httpStatus: 500, errorMessage: '' },
    ];
    for (const s of samples) {
        const d = diagnosePostFailure(s as never, 'Instagram');
        assert.ok(d.title.trim().length > 0, `no title for ${JSON.stringify(s)}`);
        assert.ok(d.remedy.trim().length > 0, `no remedy for ${JSON.stringify(s)}`);
    }
});

check('the recovery panel offers every way out, whatever the diagnosis', () => {
    // The classification is a heuristic over other people's error strings and it WILL be wrong
    // sometimes. When it is, the user must still be able to reach the action they needed — so the
    // buttons are unconditional and only their emphasis is derived. Reconnect is the single
    // exception: it is shown when the diagnosis asks for it, because sending someone to re-authorise
    // a connection that is perfectly healthy is its own dead end.
    const src = ws();
    const panel = src.slice(landmark(src, 'function _rqFailureRecoveryHtml('), landmark(src, 'function _rqAfterFailureAction('));
    assert.ok(panel.length > 0, 'the panel builder must exist');
    for (const action of ['rqFailedRetry(', 'rqFailedFix(', 'rqFailedRetryAt(', 'rqFailedReject(']) {
        assert.ok(panel.includes(action), `${action} must be reachable from the panel`);
        // …and not behind a conditional on the diagnosis.
        assert.ok(!new RegExp(`\\?[^\`]{0,80}${action.replace('(', '\\(')}`).test(panel),
            `${action} must not be gated on the failure kind`);
    }
    assert.ok(/f\.needsReconnect \? `<button onclick="rqFailedReconnect/.test(panel),
        'reconnect is the one action that IS conditional');
});

check('the panel never puts the platform’s own error text into an onclick', () => {
    // Remote content, and it routinely contains quotes and parentheses — "(#100) Invalid parameter".
    // Interpolated into an attribute it breaks the handler at best. It is rendered as escaped text.
    const src = ws();
    const panel = src.slice(landmark(src, 'function _rqFailureRecoveryHtml('), landmark(src, 'function _rqAfterFailureAction('));
    const onclicks = panel.match(/onclick="[^"]*"/g) || [];
    for (const o of onclicks) {
        assert.ok(!/f\.(raw|title|remedy)|failureMessage/.test(o), `error text leaked into a handler: ${o}`);
    }
    assert.ok(panel.includes('_rqEsc(f.raw)'), 'the raw message is escaped where it IS shown');
});

check('the Content Library banner explains the failure the same way Review does', () => {
    // Two surfaces, one failed post. The Data Hub used to render only the platform's raw sentence
    // ("(#352) Format unsupported") while Review showed the classified cause — the same post
    // explained two different ways depending on which tab you were standing in. Both now read the
    // `failure` object get-social-drafts attaches, and the raw text is demoted to a details element.
    const hub = readFileSync(path.join(import.meta.dirname, '..', 'src/components/assistant-data-hub.js'), 'utf8');
    const banner = hub.slice(landmark(hub, 'function failureBanner('), landmark(hub, 'function libraryDetail('));
    assert.ok(banner.length > 0, 'the banner builder must exist');
    assert.match(banner, /p\.failure\b/, 'the banner must read the server-side diagnosis');
    assert.match(banner, /esc\(f\.title\)/, 'it leads with the classified cause');
    assert.match(banner, /esc\(f\.remedy\)/, 'and with what to do about it');
    assert.match(banner, /<details[\s\S]*esc\(f\.raw\)/, "the platform's own words go behind a details element");
    // failureMessage stays as the fallback: an older cached payload has no `failure` and must not
    // render an empty red box.
    assert.match(banner, /p\.failureMessage/, 'the raw message is still honoured for back-compat');
    // …and the same three ways out, including the one that was missing entirely.
    assert.match(banner, /mode: 'edit'|\{ mode \}/, "'Fix the post' must reach retry-failed-post's edit mode");
    for (const hook of ['data-retry-now', 'data-retry-edit', 'data-retry-schedule']) {
        assert.ok(banner.includes(hook), `${hook} must be offered`);
    }
});

check('a failed post can be opened from a cold cache', () => {
    // Everything above is unreachable if the modal will not open. openPostReview probes a list of
    // statuses when the cache is empty, and 'failed' was absent from it — so a deep link from a
    // notification produced "That post couldn't be opened" and nothing else.
    const src = ws();
    const probe = src.slice(landmark(src, 'for (const status of (known ?'), landmark(src, 'for (const status of (known ?') + 200);
    assert.match(probe, /'failed'/, "the cold-cache probe must ask for 'failed'");
});

check("'Fix the post' returns it to an editable status", () => {
    // 'failed' is deliberately absent from MEDIA_EDITABLE_STATUSES and from _pceIsEditablePost, so
    // every editing control is off while a post sits in it. Recovery therefore cannot mean "edit in
    // place" — it has to move the post back to a status the editor accepts, and pending_approval is
    // the one the Review column reads.
    const fn = readFileSync(path.join(import.meta.dirname, '..', 'netlify/functions/retry-failed-post.ts'), 'utf8');
    assert.match(fn, /mode === 'edit' \? 'pending_approval' : 'scheduled'/);
    assert.ok(!/mode === 'edit' \? 'draft'/.test(fn), "'draft' is read by no Review Queue column");

    // …and the retry path must still refuse anything that is not actually failed, or this endpoint
    // becomes a way to re-queue a published post.
    assert.match(fn, /post\.status !== 'failed'/);

    // The edit path must not stamp publish_date: the post is about to be rewritten, and moving it to
    // now() would hand it back with an already-past slot.
    assert.match(fn, /\.\.\.\(mode === 'edit' \? \{\} : \{ publishDate \}\)/);
});

check('the Needs-attention badge is counted before the column is opened', () => {
    // It was declared in review-queue.html from the day the column shipped and nothing ever wrote to
    // it, so a workspace with three failed posts looked exactly like one with none.
    const src = ws();
    assert.match(src, /status=failed&limit=1&offset=0/, 'the poll must count failed posts');
    assert.match(src, /function _rqSetAttentionBadge/);
    assert.ok(readFileSync(path.join(import.meta.dirname, '..', 'review-queue.html'), 'utf8')
        .includes('rq-col-count-attention'), 'the element the badge writes to must still exist');
});

check('workspace.html still parses', () => {
    // This caught a real break while the panel was being written: an HTML comment INSIDE the
    // panel's template literal quoted two class names in backticks, which closed the template and
    // made the whole 500k-character script block a syntax error — every function in the workspace,
    // not just this one. A markup-heavy template literal is exactly where that is easy to do and
    // invisible on review, so the parse is asserted rather than assumed.
    const src = ws();
    const blocks = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(blocks.length >= 4, 'expected several inline script blocks');
    for (const [i, code] of blocks.entries()) {
        if (!code.trim()) continue;
        assert.doesNotThrow(() => new Function(code), `workspace.html script block ${i} does not parse`);
    }
});

console.log(`\n${passed} passed, 0 failed\n`);
