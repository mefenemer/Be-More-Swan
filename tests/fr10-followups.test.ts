// tests/fr10-followups.test.ts
// Three things the FR#10 staging test turned up (2026-11-11):
//   1. A saved rule card read as unanswered to the Business Mentor ("you don't need to confirm the
//      earlier card" after it was saved): rule and goal cards now record what the user did on the
//      chat message (mentor:cardOutcome → mentor.ts card_outcome), and show it again on reload.
//   2. "Take Me There" left the newer chat window open over the page it went to.
//   3. "Not now" on one "Connect …?" pop-up opened the next straight away.
//
// Run:  npx tsx tests/fr10-followups.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

let passed = 0, total = 0;
function test(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

/** The source of one top-level-ish function, from its declaration to the matching closing brace. */
function fnSource(src: string, decl: string): string {
    const start = src.indexOf(decl);
    assert.ok(start >= 0, `${decl} not found`);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`${decl} never closes`);
}

const registry = read('src/components/disruptive-ui-registry.js');
const session = read('src/components/chat-session.js');

console.log('\n1. Rule and goal cards record their outcome');

test('the rule card sends applied, failed and not_now', () => {
    const body = fnSource(registry, 'function renderRuleProposalCard');
    for (const s of ["sendCardOutcome(el, 'applied', message)", "sendCardOutcome(el, 'failed', error)", "sendCardOutcome(el, 'not_now')"]) {
        assert.ok(body.includes(s), `renderRuleProposalCard is missing ${s}`);
    }
});

test('the goal card sends applied, failed and not_now', () => {
    const body = fnSource(registry, 'function renderGoalProposalCard');
    for (const s of ["sendCardOutcome(el, 'applied', message)", "sendCardOutcome(el, 'failed', error)", "sendCardOutcome(el, 'not_now')"]) {
        assert.ok(body.includes(s), `renderGoalProposalCard is missing ${s}`);
    }
});

test('sendCardOutcome dispatches the event chat-session.js saves', () => {
    assert.match(registry, /const sendCardOutcome = \(el, status, note\) => el\.dispatchEvent\(new CustomEvent\('mentor:cardOutcome', \{ bubbles: true/);
    assert.ok(session.includes("container.addEventListener('mentor:cardOutcome', onMentorCardOutcome)"));
});

test('a saved outcome on a rule or goal card removes its buttons on reload', () => {
    const body = fnSource(session, 'function showSavedCardOutcome');
    assert.ok(body.includes('[data-rp-status]') && body.includes('[data-gp-status]'), 'status lookup covers rule and goal cards');
    for (const b of ['[data-rp-go]', '[data-rp-cancel]', '[data-gp-go]', '[data-gp-cancel]']) assert.ok(body.includes(b), `${b} not removed`);
});

console.log('\n2. Take Me There closes either chat window');

test('closeChatWindows closes both the old and the new chat window', () => {
    const body = fnSource(registry, 'function closeChatWindows');
    assert.ok(body.includes('window.closeAssistantChatModal?.()') && body.includes('window.closeAssistantChat?.()'));
});

test('Take Me There and the hire list both use it', () => {
    const tmt = registry.slice(registry.indexOf("register('mentor_take_me_there'"), registry.indexOf("register('mentor_quiet_mode'"));
    assert.ok(tmt.includes('closeChatWindows();'), 'Take Me There');
    assert.ok(fnSource(registry, 'function openCatalogue').includes('closeChatWindows();'), 'hire list catalogue link');
});

test('the new chat window really exposes closeAssistantChat', () => {
    assert.ok(read('src/components/assistant-chat-modal.js').includes('window.closeAssistantChat = closeAssistantChat;'));
});

console.log('\n3. Connect pop-ups: Not now stops the rest');

function runQueue(labels: string[], clicks: Array<'cancel' | 'confirm'>) {
    const src = read('integrations.js');
    const code = `${fnSource(src, 'function _connectPromptKey')}\n${fnSource(src, 'function _queueConnectPermissionPrompts')}`;
    const shown: string[] = [];
    const store = new Map<string, string>();
    const ctx: Record<string, unknown> = {
        _selectedAssistantId: 17,
        _userConnections: [],
        _handleFor: () => '@handle',
        _serviceMatchesPlatform: () => false,
        sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } },
        window: {
            _intStartOAuth: () => {}, _intOpenModal: () => {},
            showConfirmModal: (msg: string, onConfirm: () => void, opts: { onCancel?: () => void }) => {
                shown.push(msg);
                const c = clicks.shift();
                if (c === 'cancel') opts.onCancel?.();
                else if (c === 'confirm') onConfirm();
            },
        },
    };
    vm.createContext(ctx);
    vm.runInContext(`${code}\n_queueConnectPermissionPrompts(${JSON.stringify(labels.map((l) => ({ id: l.toLowerCase(), label: l, oauthPlatform: true })))});`, ctx);
    return { shown, store };
}

test('Not now on the first pop-up does not open the next', () => {
    const { shown, store } = runQueue(['Instagram', 'LinkedIn', 'Facebook'], ['cancel']);
    assert.strictEqual(shown.length, 1, `showed ${shown.length} pop-ups`);
    assert.strictEqual(store.size, 3, 'every queued platform is marked asked for this session');
});

test('a second visit this session asks nothing', () => {
    const src = read('integrations.js');
    const code = `${fnSource(src, 'function _connectPromptKey')}\n${fnSource(src, 'function _queueConnectPermissionPrompts')}`;
    const store = new Map<string, string>();
    let shown = 0;
    const ctx: Record<string, unknown> = {
        _selectedAssistantId: 17, _userConnections: [], _handleFor: () => '@h', _serviceMatchesPlatform: () => false,
        sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } },
        window: { _intStartOAuth: () => {}, _intOpenModal: () => {}, showConfirmModal: (_m: string, _c: () => void, o: { onCancel?: () => void }) => { shown++; o.onCancel?.(); } },
    };
    vm.createContext(ctx);
    const call = `_queueConnectPermissionPrompts([{ id: 'instagram', label: 'Instagram' }, { id: 'linkedin', label: 'LinkedIn' }]);`;
    vm.runInContext(`${code}\n${call}\n${call}`, ctx);
    assert.strictEqual(shown, 1);
});

test('"an Instagram", "a LinkedIn"', () => {
    assert.match(runQueue(['Instagram'], ['cancel']).shown[0], /You added an Instagram handle/);
    assert.match(runQueue(['LinkedIn'], ['cancel']).shown[0], /You added a LinkedIn handle/);
});

console.log(`\n${passed}/${total} passed`);
