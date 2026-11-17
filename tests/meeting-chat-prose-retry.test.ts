// Minute Taker run C (staging 2026-11-17): pasted meeting notes got "Here are the minutes for …" as plain text,
// no envelope, no minutes card — so no meeting was filed. The model copies the prose of its earlier replies.
// The Minute Taker always answers in JSON, so any prose or empty reply is asked again once.
// Run: npx tsx tests/meeting-chat-prose-retry.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSON_FORMAT_RETRY, strictJsonReplyIsProse } from '../src/utils/confirm-card-reply';

const verbatim = 'Here are the minutes for "Weekly ops sync — run C2". Vendor A was agreed for packaging, legal sign-off before the 30th is flagged as a risk, and there are four action items. Cara Singh has no email address on file, so she won\'t get the follow-up until one is added in the Inbox. Nothing has been sent; the minutes are waiting for your approval.';
assert.equal(strictJsonReplyIsProse(verbatim, { uiElement: null }), true, 'the staging reply');
assert.equal(strictJsonReplyIsProse('', { uiElement: null }), true, 'an empty reply');
assert.equal(strictJsonReplyIsProse('   \n', { uiElement: null }), true);
assert.equal(strictJsonReplyIsProse('{"reply":"Paste your notes.","uiElement":null}', { uiElement: null }), false, 'JSON with no card is a real answer');
assert.equal(strictJsonReplyIsProse('Sure — {"reply": broken', { uiElement: null }), false, 'a broken JSON attempt has its own fallback');
assert.equal(strictJsonReplyIsProse(verbatim, { uiElement: { type: 'x' } }), false, 'a card was recovered');
assert.match(JSON_FORMAT_RETRY, /^\[Format check from the system, not the user\]/);
assert.match(JSON_FORMAT_RETRY, /uiElement is the minutes card/);

const orch = readFileSync('netlify/functions/chat-orchestrator.ts', 'utf8');
assert.ok(orch.includes('const strictProse = route === ROUTES.meeting_note_taker && strictJsonReplyIsProse(raw, parsed);'));
assert.ok(orch.includes('(strictProse || proseReplyLostItsCard(raw, parsed))'));
assert.ok(orch.includes("content: strictProse ? JSON_FORMAT_RETRY : CARD_FORMAT_RETRY"));
assert.ok(orch.includes("content: raw.trim() || '(no reply)'"), 'an empty assistant turn is never sent to the API');
assert.ok(orch.includes('if (reparsed.uiElement || (strictProse && !raw.trim() && reparsed.content.trim())) { raw = again; parsed = reparsed; }'));
console.log('meeting-chat-prose-retry: all checks passed');
