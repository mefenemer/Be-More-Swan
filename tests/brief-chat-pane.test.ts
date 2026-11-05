// tests/brief-chat-pane.test.ts — the Brand Designer's docked chat (owner 2026-11-05). The browser side is
// e2e/briefs-chat.spec.ts, with the model and every function stubbed, so what only the server does is here.
//
// Run:  npx tsx tests/brief-chat-pane.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { briefEditFromUiElement } from '../src/utils/chat-brief-edit';

const read = (f: string) => readFileSync(path.resolve(__dirname, '..', f), 'utf8');
let passed = 0;
const check = (n: string, fn: () => void) => { try { fn(); passed++; console.log(`  ✓ ${n}`); } catch (e) { console.log(`  ✗ ${n}\n    ${(e as Error).message}`); process.exitCode = 1; } };

const chat = read('netlify/functions/chat-orchestrator.ts');

check('the card is rebuilt: only what a brief\'s words are, nothing else the model might send', () => {
    assert.deepStrictEqual(
        briefEditFromUiElement({ type: 'visual_brief_edit', briefId: '#12', mood: ' Bright ', summary: ' Why ', sources: ['ai_image'], purpose: 'flyer', generate: true }),
        { type: 'visual_brief_edit', briefId: 12, summary: 'Why', mood: 'Bright' });
});

check('nothing to change, or no brief to change it on, is no card', () => {
    assert.strictEqual(briefEditFromUiElement({ type: 'visual_brief_edit', briefId: 12, mood: '  ' }), null);
    assert.strictEqual(briefEditFromUiElement({ type: 'visual_brief_edit', briefId: 0, mood: 'Bright' }), null);
    assert.strictEqual(briefEditFromUiElement({ type: 'visual_brief_proposal', briefId: 12, mood: 'Bright' }), null);
});

check('the card is only for this workspace\'s brief, and never a finished flyer or a cancelled one', () => {
    assert.ok(chat.includes('eq(visualBriefs.id, req.briefId), eq(visualBriefs.organisationId, orgId)'));
    assert.ok(chat.includes("brief.status !== 'cancelled' && !(isFlyer && brief.status === 'approved')"));
});

check('the words beside the card stay honest, and the model is told it only saves', () => {
    assert.ok(chat.includes('(!!briefEdit && uiElement === briefEdit)'), 'the reply can claim the change is made');
    assert.ok(chat.includes('It only saves the brief: nothing is made and nothing is spent'));
});

check('a chat card never spends: the click is `edit`, and only that', () => {
    const session = read('src/components/chat-session.js');
    const handler = session.slice(session.indexOf('async function onBriefEdit(e)'), session.indexOf('"Save these changes" on a campaign_edit_proposal'));
    assert.ok(handler.includes("action: 'edit'"));
    assert.ok(!handler.includes("'generate'"));
    assert.ok(session.includes("container.addEventListener('brief:edit', onBriefEdit);") && session.includes("container.removeEventListener('brief:edit', onBriefEdit);"));
});

console.log(`\n${passed}/5 passed`);
