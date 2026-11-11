// tests/fix-pipeline-2026-11-11.test.ts
// Fix pipeline #33/#36/#37/#38 (prod, org 40, 2026-11-10).
//   #33/#36 — "No card came with this reply" was added to replies that OFFERED a card, not ones that
//             claimed one. The replies below are the real ones from prod.
//   #37     — "Something else" after editing an outreach email gave no way to say what.
//   #38     — an edited email on page 5 of the review list jumped to page 1 after it was regenerated.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DROPPED_CARD_TAG, droppedCardRecord, missingCardReply, NO_CARD_NOTE, replyPointsAtCard } from '../src/utils/confirm-card-reply';
import { EDIT_NOTE_MAX } from '../src/config/template-feedback';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8');

console.log('An offer of a card is not a missing card (#33, #36)');
check('the prod offers get no note', () => {
    for (const reply of [
        'You can change either under Assistant Settings ▸ When and how I work, or just tell me what you\'d like and I\'ll put a card here for you to confirm.',
        'To read one exactly as it will go, open it on the Outreach tab, or tell me which one (for example #2897 East Hartford Public Library) and I\'ll put it on a card that shows every word. Nothing is sent unless you press the button.',
        'If you\'d like to see exactly how an email ends now, tell me which one and I’ll put it on a card that shows every word.',
        'I can put a card here whenever you’re ready.',
    ]) {
        assert.strictEqual(replyPointsAtCard(reply), false, reply);
        assert.strictEqual(missingCardReply(reply, false), reply);
    }
});
check('the prod claims still get the note', () => {
    for (const reply of [
        'I\'ve put a rule on the card below so articles always use that address for your blog.',
        'The card below will leave /blog out of the site pages your assistants read, so it won\'t be linked again.',
        'I can\'t see #118\'s text from here, so the card below asks for a revision that makes the first two paragraphs connect.',
        'Approve the card below and I’ll do the rest.',
        'I\'ll explain. The card below changes your schedule.',
    ]) {
        assert.strictEqual(missingCardReply(reply, false), `${reply}\n\n${NO_CARD_NOTE}`, reply);
    }
});
check('one claim beside an offer still counts as a claim', () => {
    const reply = 'Tell me which and I\'ll put it on a card that shows every word. Meanwhile the card below rewrites #2897.';
    assert.strictEqual(replyPointsAtCard(reply), true);
});

console.log('"Something else" can say what (#37)');
const page = read('assistants.js');
const strip = page.slice(page.indexOf('function _rqShowEditReasonStrip()'), page.indexOf('// ── Why was this lead rejected?'));
check('picking it opens a box instead of saving', () => {
    assert.ok(strip.includes('data-edit-reason-note'), 'textarea');
    assert.ok(/if \(reason === 'other'\) \{\s*otherBox\.classList\.remove\('hidden'\);/.test(strip), 'opens the box');
    assert.ok(strip.includes("save('other', noteEl.value.trim())"), 'Save sends the words');
    assert.ok(strip.includes('...(note ? { editNote: note } : {})'), 'sent only when typed');
});
check('the server keeps the note for "other" only, capped, and the column exists', () => {
    const fn = read('netlify/functions/lead-generation.ts');
    assert.ok(fn.includes("const editNote = editReason === 'other' ? (str(body.editNote, EDIT_NOTE_MAX) ?? '').trim() : '';"));
    assert.ok(fn.includes('editNote: editNote || null,'));
    assert.ok(read('db/schema.ts').includes('editNote: text("edit_note"),'));
    assert.ok(read('db/z-template-feedback-edit-note.sql').includes('ADD COLUMN IF NOT EXISTS edit_note text'));
    assert.ok(EDIT_NOTE_MAX > 0 && EDIT_NOTE_MAX <= 1000);
    assert.ok(read('src/generated/platform-constants.js').includes(`editNoteMax: ${EDIT_NOTE_MAX}`), 'regenerate constants');
});
check('the writer only sends the column when a note was typed (safe before the SQL runs)', () => {
    assert.ok(read('src/utils/template-feedback.ts').includes('...(editNote ? { editNote } : {}),'));
});

console.log('The review list keeps its order after an edit (#38)');
check('deliverable=1 is ordered by created_at, not updated_at', () => {
    const src = read('netlify/functions/assistant-records.ts');
    assert.ok(src.includes('? [desc(assistantRecords.createdAt), desc(assistantRecords.id)]'));
    assert.ok(src.includes('.orderBy(...(deliverableOnly'));
});

console.log('A lost card is kept for diagnosis (#33)');
check('a refused card keeps its type and body', () => {
    const r = droppedCardRecord({ route: 'blog_writer', roleKey: 'blog_writer', sentUiElement: { type: 'site_directory', action: 'exclude', path: '/blog' }, raw: '{"reply":"The card below…"}' });
    assert.ok(r.content.startsWith(`${DROPPED_CARD_TAG} blog_writer / blog_writer: sent site_directory`));
    assert.strictEqual(r.uiElementJson.sentType, 'site_directory');
    assert.ok(String(r.uiElementJson.sentCard).includes('"/blog"'));
    assert.strictEqual(r.uiElementJson.replyWasJson, true);
});
check('no card, and prose instead of JSON, say which', () => {
    assert.ok(droppedCardRecord({ route: 'r', roleKey: null, sentUiElement: null, raw: '{"reply":"x"}' }).content.endsWith('no card in the reply'));
    assert.ok(droppedCardRecord({ route: 'r', roleKey: null, sentUiElement: undefined, raw: 'The card below.' }).content.endsWith('reply was prose, not JSON'));
});
check('capped so one turn cannot write a huge row', () => {
    const r = droppedCardRecord({ route: 'r', roleKey: 'x', sentUiElement: { type: 't', big: 'a'.repeat(20000) }, raw: 'b'.repeat(20000) });
    assert.ok(String(r.uiElementJson.sentCard).length <= 4000);
    assert.ok(String(r.uiElementJson.rawEnd).length <= 1500);
});
check('the orchestrator stores it as a hidden system row in the reply transaction', () => {
    const src = read('netlify/functions/chat-orchestrator.ts');
    const at = src.indexOf("droppedCard = droppedCardRecord({");
    assert.ok(at > 0 && at < src.indexOf('const [assistantMessage] = await db.transaction('));
    assert.ok(src.includes("await tx.insert(chatMessages).values({ chatSessionId: session.id, role: 'system', content: droppedCard.content, uiElementJson: droppedCard.uiElementJson });"));
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
