// tests/team-chat-replies.test.ts
// A note sent on the Team page gets a REAL reply: a chat turn on that note, in the assistant's newest
// conversation, written back under the note — with any card shown in place and working.
//
// WHY THIS EXISTS. Team Chat answered every note with a fixed "Noted — I will see this when we talk
// in chat", including "pause posting this week": it implied an instruction would be followed when
// nothing could follow it. These pin: the turn answers only this person's own unanswered note, by its
// stored words; it continues the newest conversation; the reply links to its chat message so the feed
// can show the card; cards on the feed are re-checked like a reopened chat's; and the feed mounts
// them through ChatSession so their buttons run the chat's own handlers.
//
// Run:  npx tsx tests/team-chat-replies.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { teamNoteForChatTurn } from '../src/utils/team-messages';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

function fakeDb(...answers: unknown[][]) {
    const queue = [...answers];
    return {
        select: () => {
            const rows = queue.shift() ?? [];
            const chain: any = { from: () => chain, where: () => chain, orderBy: () => chain, limit: () => Promise.resolve(rows) };
            return chain;
        },
    } as any;
}

async function main() {
    console.log('\nWhich note a turn may answer');

    await check('this person\'s unanswered note: its stored words and campaign come back', async () => {
        const note = await teamNoteForChatTurn(fakeDb([{ id: 7, body: 'Pause posting this week', campaignId: 3 }], [], [{ objective: 'Spring launch' }]),
            { orgId: 1, userId: 2, assistantId: 5, teamMessageId: 7 });
        assert.deepStrictEqual(note, { id: 7, body: 'Pause posting this week', campaignId: 3, campaignObjective: 'Spring launch' });
    });
    await check('someone else\'s note, or one already answered, gives nothing', async () => {
        assert.strictEqual(await teamNoteForChatTurn(fakeDb([]), { orgId: 1, userId: 2, assistantId: 5, teamMessageId: 7 }), null);
        assert.strictEqual(await teamNoteForChatTurn(fakeDb([{ id: 7, body: 'x', campaignId: null }], [{ id: 8 }]), { orgId: 1, userId: 2, assistantId: 5, teamMessageId: 7 }), null);
    });

    console.log('\nThe server');

    await check('sending with reply:\'model\' writes no fixed reply; other callers keep it', () => {
        const tm = read('src/utils/team-messages.ts');
        const send = tm.slice(tm.indexOf('export async function sendFromUser'), tm.indexOf('export async function teamNoteForChatTurn'));
        assert.ok(send.indexOf("if (args.reply === 'model') return { ok: true, id };") < send.indexOf('Noted —'));
        assert.ok(read('netlify/functions/team.ts').includes("reply: body.reply === 'model' ? 'model' : 'fixed'"));
    });
    await check('the orchestrator answers the stored note, in the newest conversation, and writes the reply back', () => {
        const o = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(o.includes('teamNote = await teamNoteForChatTurn(db, { orgId, userId, assistantId, teamMessageId: Number(body.teamMessageId) });'));
        assert.ok(o.includes("const typed = teamNote ? teamNote.body.trim() : (body.message || '').trim();"), 'the stored words, never the client\'s');
        assert.ok(/eq\(chatSessions\.status, 'active'\)\)\)\s*\.orderBy\(desc\(chatSessions\.updatedAt\), desc\(chatSessions\.id\)\)/.test(o));
        assert.ok(o.includes('body: content, chatSessionId: session.id, chatMessageId: assistantMessage.id,'));
    });
    await check('the feed carries each reply\'s card, re-checked like a reopened chat', () => {
        const tm = read('src/utils/team-messages.ts');
        assert.ok(tm.includes('.innerJoin(chatSessions, eq(chatSessions.id, chatMessages.chatSessionId))'));
        assert.ok(tm.includes('eq(chatSessions.organisationId, orgId)'), 'a link only resolves inside this workspace');
        assert.ok(read('netlify/functions/team.ts').includes('await refreshStoredCards(db, orgId, id,'));
    });

    console.log('\nThe page');

    await check('the feed sends, asks for the turn, and mounts cards through ChatSession', () => {
        const f = read('src/components/team-feed.js');
        assert.ok(f.includes("body: text, reply: 'model' })"));
        assert.ok(f.includes("body: JSON.stringify({ aiAssistantId: assistantId, teamMessageId })"));
        assert.ok(f.includes('container: el, cardOnly: true,'));
        assert.ok(f.includes('if (had && had.key === key) { slot.appendChild(had.el); return; }'), 'a poll never rebuilds a card mid-click');
        assert.ok(!f.includes('They see it when you next chat. For a rule'), 'the composer no longer promises a later read');
    });
    await check('card-only mode drops the composer, footer and bubble but keeps the handlers', () => {
        const c = read('src/components/chat-session.js');
        assert.ok(c.includes("container.innerHTML = cardOnly ? '<div data-chat-root><div data-chat-scroll></div></div>' :"));
        assert.ok(c.includes('if (!cardOnly) row.appendChild(bubble);'));
        assert.ok(c.includes('const readOnly = props.readOnly === true || cardOnly;'));
    });
    await check('the chat window reloads a conversation a Team reply landed in', () => {
        const m = read('src/components/assistant-chat-modal.js');
        assert.ok(m.includes("document.addEventListener('team:chatTurn'"));
        assert.ok(m.includes('loadConversation({ assistantId: state.assistantId, sessionId: sid });'));
    });

    console.log(`\n${passed}/${total} passed`);
    if (passed !== total) process.exitCode = 1;
}

main();
