// tests/repro-issue-51.test.ts
// Issue #51 (prod, Video Producer chat, 2026-11-12). The two card faults, in the shape of the replies in the
// chat record (neutral wording):
//  • 13:25:57 "Here's the card to confirm" over no card: no "points at a card" phrase matched, so neither the
//    missing-card note nor the ask-again-as-JSON retry ran (no [card-dropped] row either).
//  • 13:26:13 prose, then the card as a bare object, then a stray " /": splitProseAndCard refused anything after
//    the object, so the whole reply — JSON and all — was shown as text.
import assert from 'node:assert';
import { splitProseAndCard } from '../src/utils/model-json';
import { replyPointsAtCard } from '../src/utils/confirm-card-reply';

// Same shape as the prod reply (prose, then a bare card, then a stray " /"); the wording is neutral, not the customer's.
const shownAsText = 'Sorry about that. I\'ll send it again now. {"type":"mentor_support_request","summary":"A card did not appear.","destination":"issue","subject":"Card missing","description":"The reply said a card was there, but none was shown."} /';
const split = splitProseAndCard(shownAsText);
assert.ok(split, 'the card is drawn, not printed as text');
assert.strictEqual((split!.card as { type: string }).type, 'mentor_support_request');
assert.strictEqual(split!.prose, 'Sorry about that. I\'ll send it again now.');

const noCard = 'I can raise that for you. Here\'s the card to confirm; nothing is sent until you click it.';
assert.ok(replyPointsAtCard(noCard), '"Here\'s the card to confirm" is a claim of a card, so a missing one is caught');

// Still not a claim: an offer, and ordinary prose after a card.
assert.ok(!replyPointsAtCard('Tell me which one and I\'ll put it on a card for you.'));
assert.strictEqual(splitProseAndCard('Here it is {"type":"x"} and then more words afterwards.'), null);
console.log('repro-issue-51: passed');

// Faults 1 and 2 (the chat couldn't see a finished video's scenes, so it sent the customer to the tab): the snapshot
// now lists a READY video's scenes (with their own footage and its section) and the prompt says to offer the change.
import { readFileSync } from 'node:fs';
const vp = readFileSync('src/utils/video-producer.ts', 'utf8');
assert.ok(vp.includes("['planned', 'failed', 'ready', 'render_failed', 'rendering'].includes(r.status)"), 'READY videos list their scenes');
assert.ok(vp.includes('their video ${s.assetId}'), 'own-footage scenes name the video and section');
const orch = readFileSync('netlify/functions/chat-orchestrator.ts', 'utf8');
assert.ok(orch.includes("Never tell them to make the change on the \"Videos\" tab instead, and never say you can't change a finished video from this chat."));
const shared = readFileSync('src/constants/assistant-shared-prompts.ts', 'utf8');
assert.ok(shared.includes('never reuse an earlier report from this conversation'), 'a ticket is about what they ask now');
console.log('repro-issue-51 (prompt + snapshot): passed');
