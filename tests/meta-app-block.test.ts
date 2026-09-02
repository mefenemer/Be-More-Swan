// tests/meta-app-block.test.ts
//
// The 2026-09-02 Meta outage, in miniature.
//
// Every Meta connection in the product began failing at once with
// `{"errorCode": 200, "httpStatus": 400, "errorMessage": "API access blocked."}` — four
// connections, two organisations, both platforms, four DIFFERENT vault keys, two of which had not
// been touched since August. Nothing tenant-specific produces that shape; Meta was refusing the app.
//
// The product handled it in the two worst ways available:
//
//   • PERMANENT. `isRetryable(400, 200)` is false, so every post that came due during the outage
//     was marked 'failed' on attempt 1 and never retried. A platform outage was eating the
//     customer's content calendar, and nothing would have republished when the block lifted.
//   • "RECONNECT". Code 200 is in post-failure-diagnosis's AUTH_CODES, so each of those posts told
//     its owner their connection had expired. Reconnecting cannot succeed while the app is blocked
//     — Meta refuses the OAuth dialog before consent — and a reconnect rebinds whichever Page Meta
//     returns first, so the advice was both useless and hazardous.
//
// These pin the containment: hold the post, and stop giving advice that cannot work.
//
// NOT COVERED: the DB side of handlePublishFailure in either publisher (no live database here).
//
// Run:  npx tsx tests/meta-app-block.test.ts

import assert from 'node:assert';
import { isMetaAppBlocked, APP_BLOCK_HOLD_MS } from '../src/utils/meta-app-block';
import { diagnosePostFailure } from '../src/utils/post-failure-diagnosis';
import { isRetryable } from '../netlify/functions/publish-instagram';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

/** The exact blob both publishers stored during the outage, copied from prod. */
const OUTAGE = { errorCode: 200, httpStatus: 400, isRetryable: false, errorMessage: 'API access blocked.', errorSubcode: null };

check('recognises the outage signature', () => {
    assert.equal(isMetaAppBlocked('API access blocked.'), true);
});

check('is case-insensitive and tolerates Meta prefixing a code', () => {
    assert.equal(isMetaAppBlocked('(#200) api access blocked'), true);
});

check('does NOT claim a genuine per-connection permission loss', () => {
    // Same code 200, different cause. This one really is actionable, and holding it for ever would
    // be worse than failing it — which is why the test is on the message, not the code.
    assert.equal(isMetaAppBlocked('(#200) Requires pages_manage_posts permission'), false);
    assert.equal(isMetaAppBlocked('Error validating access token'), false);
});

check('treats an absent message as not-blocked', () => {
    assert.equal(isMetaAppBlocked(null), false);
    assert.equal(isMetaAppBlocked(undefined), false);
    assert.equal(isMetaAppBlocked(''), false);
});

check('holds for an hour — only Meta clears this, so a fast retry is just noise', () => {
    assert.equal(APP_BLOCK_HOLD_MS, 3_600_000);
});

check('the diagnosis stops telling the customer to reconnect', () => {
    const d = diagnosePostFailure(OUTAGE, 'Instagram');
    assert.equal(d.needsReconnect, false, 'reconnecting cannot clear an app block');
    assert.equal(d.kind, 'platform');
    assert.equal(d.retryable, true);
    assert.ok(!/expired/i.test(d.title), `title still blames the connection: ${d.title}`);
});

check('the diagnosis keeps Meta’s own words for support', () => {
    assert.equal(diagnosePostFailure(OUTAGE, 'Instagram').raw, 'API access blocked.');
});

check('a REAL expired token still routes to reconnect', () => {
    const d = diagnosePostFailure(
        { errorCode: 190, httpStatus: 400, isRetryable: false, errorMessage: 'Error validating access token: Session has expired' },
        'Instagram',
    );
    assert.equal(d.kind, 'connection');
    assert.equal(d.needsReconnect, true);
});

check('a genuine lost permission is still a connection problem, not a platform one', () => {
    // The branch above must not swallow code 200 wholesale — that is the mirror of the bug it fixes.
    const d = diagnosePostFailure(
        { errorCode: 200, httpStatus: 400, isRetryable: false, errorMessage: '(#200) Requires pages_manage_posts permission' },
        'Facebook',
    );
    assert.equal(d.kind, 'connection');
    assert.equal(d.needsReconnect, true);
});

check('the retry classification is deliberately UNCHANGED', () => {
    // The hold is what protects the post. Making code 200 retryable would instead give a genuine
    // permission loss three pointless attempts before failing it anyway.
    assert.equal(isRetryable(400, 200), false);
});

console.log(`\n${passed} passed\n`);
