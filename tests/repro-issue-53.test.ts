// tests/repro-issue-53.test.ts
// Issues #53 / #54 (prod, workspace 40, Business Mentor chat 2026-11-12): replies said "the card below" and no
// card came. The chat records show four "[card-dropped] … reply was prose, not JSON" rows. The safety net
// (chat-orchestrator: ask once more as JSON, issue #39) only ran when the first reply took under 10 s; the
// Mentor's replies took 12–16 s (17:35:41→17:35:57, 17:36:50→17:37:06, 17:43:26→17:43:38), so it never ran.
// Runs the REAL rule (cardRetryTimeoutMs) the orchestrator uses.
import assert from 'node:assert';
import { cardRetryTimeoutMs } from '../src/utils/confirm-card-reply';

// The Mentor's slow reply: the model took ~12 s, ~15 s into the 26 s request.
const mentor = cardRetryTimeoutMs({ requestElapsedMs: 15_000, replyElapsedMs: 12_000 });
assert.ok(mentor >= 4_000, `a 12 s Mentor reply still gets its card retry (got ${mentor} ms)`);
assert.ok(15_000 + mentor <= 24_000, 'and the retry still ends inside the 26 s request, with room to save');

// A fast reply keeps the full retry; a reply with no time left skips it rather than timing the request out.
assert.ok(cardRetryTimeoutMs({ requestElapsedMs: 8_000, replyElapsedMs: 6_000 }) >= 10_000);
assert.strictEqual(cardRetryTimeoutMs({ requestElapsedMs: 21_000, replyElapsedMs: 18_000 }), 0);
console.log('repro-issue-53: passed');
