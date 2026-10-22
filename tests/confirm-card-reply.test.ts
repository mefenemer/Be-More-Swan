// tests/confirm-card-reply.test.ts
// The words beside a confirm card never say the change happened (src/utils/confirm-card-reply.ts).
//
// WHY THIS EXISTS. On the first live staging turns (2026-10-22) the model wrote "Schedule updated…",
// "I'll write like that" and — over a card the server had refused — "I'll stop drafting for Facebook
// from now on", despite every card's prompt forbidding it. These are those replies, verbatim.
//
// Run:  npx tsx tests/confirm-card-reply.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { confirmCardReply, replyClaimsChange } from '../src/utils/confirm-card-reply';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const ROOT = path.resolve(import.meta.dirname, '..');
const live = { blocked: null };

check('the three staging replies are caught', () => {
    for (const r of [
        'Schedule updated to Tuesdays and Thursdays at 08:00 — ready to confirm.',
        'Got it — I’ll write like that: short, punchy, no fluff. One clear idea per post.',
        'I\'ll stop drafting for Facebook from now on — just confirming that switch for you.',
    ]) assert.ok(replyClaimsChange(r), r);
});

check('a reply that only offers the card is kept', () => {
    for (const r of ['Goal card is ready to confirm.', 'Here’s the change for you to confirm below.', 'Confirm below and new drafts will follow the new days.']) {
        assert.strictEqual(confirmCardReply(r, live), r, r);
    }
});

check('a claiming reply over a live card becomes a neutral one', () => {
    assert.strictEqual(confirmCardReply('Schedule updated to Tuesdays.', live), 'Here it is — nothing changes until you confirm on the card below.');
});

check('a refused card’s reply says it was refused, whatever the model wrote', () => {
    const out = confirmCardReply('I\'ll stop drafting for Facebook from now on.', { blocked: 'Facebook isn’t connected.' });
    assert.ok(out.includes('can’t do that') && out.includes('Nothing has changed'), out);
});

check('a settled card, or no card, leaves the words alone', () => {
    assert.strictEqual(confirmCardReply('Updated earlier.', { settled: true, blocked: 'Already done' }), 'Updated earlier.');
    assert.strictEqual(confirmCardReply('Updated.', null), 'Updated.');
});

check('the orchestrator applies it to profile and review cards', () => {
    const src = readFileSync(path.join(ROOT, 'netlify/functions/chat-orchestrator.ts'), 'utf8');
    assert.ok(src.includes('if (uiElement && (uiElement === profileCard || uiElement === reviewsCard)) {'));
    assert.ok(src.includes('content = confirmCardReply(content, uiElement as'));
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
