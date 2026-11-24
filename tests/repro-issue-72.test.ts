// tests/repro-issue-72.test.ts
// Fix pipeline #72 (owner, 2026-11-17): "In Note Taker, if I connect and enable Gmail, I should not be able to connect
// to Outlook as well. This should be disabled and vice versa." Every sender tries Gmail first (mailbox-connected.ts,
// meeting-followup-send.ts), so a second mailbox never sends anything. No workspace on prod had both (2026-11-24).
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const root = join(__dirname, '..');
const js = readFileSync(join(root, 'integrations.js'), 'utf8');
function slice(startMarker: string): string {
    const start = js.indexOf(startMarker);
    assert.ok(start !== -1, startMarker);
    let i = js.indexOf('{', start), depth = 0;
    for (; i < js.length; i++) { if (js[i] === '{') depth++; else if (js[i] === '}' && --depth === 0) break; }
    return js.slice(start, i + 1) + (startMarker.startsWith('const') ? ';' : '');
}

function card(provider: string, providers: Array<{ provider: string; connected: boolean }>, scoped: boolean): string {
    const ctx: any = {
        _mailboxProviders: providers, _assistantScoped: scoped, _ROW_BTN: 'row-btn',
        _withAssistantId: (u: string) => `${u}?assistantId=1`,
        _esc: (s: unknown) => String(s ?? ''),
        _rowPill: (t: string) => `<pill>${t}</pill>`,
        _connRow: (o: any) => `<row sub="${o.sub}">${o.control}</row>`,
    };
    vm.createContext(ctx);
    vm.runInContext(`${slice('const MAILBOX_CATALOG = {')}\n${slice('function _mailboxCard(m) {')}\nthis.__card = _mailboxCard;`, ctx);
    return ctx.__card(providers.find((p) => p.provider === provider));
}

const gmailOn = [{ provider: 'gmail', connected: true }, { provider: 'outlook', connected: false }];
for (const scoped of [true, false]) {
    const outlook = card('outlook', gmailOn, scoped);
    assert.ok(!outlook.includes('/api/oauth/outlook/connect'), `${scoped ? 'assistant' : 'workspace'} view: no Outlook connect link while Gmail is connected`);
    assert.ok(outlook.includes('One mailbox at a time') && outlook.includes('disconnect Gmail'), 'says why, and what to do');
}
// Vice versa.
const outlookOn = [{ provider: 'gmail', connected: false }, { provider: 'outlook', connected: true }];
assert.ok(!card('gmail', outlookOn, true).includes('/api/oauth/gmail/connect'), 'no Gmail connect while Outlook is connected');
// Neither connected: both can be connected.
const none = [{ provider: 'gmail', connected: false }, { provider: 'outlook', connected: false }];
assert.ok(card('gmail', none, true).includes('/api/oauth/gmail/connect') && card('outlook', none, true).includes('/api/oauth/outlook/connect'));

// The server refuses it too, whatever page the connect came from.
const oauth = readFileSync(join(root, 'netlify/functions/oauth-integrations.ts'), 'utf8');
assert.ok(oauth.includes("if (provider === 'gmail' || provider === 'outlook') {"), 'connect checks the other mailbox');
assert.ok(oauth.includes('oauth_error=mailbox_already_connected'), 'and refuses with its own error');
assert.ok(readFileSync(join(root, 'workspace.html'), 'utf8').includes('mailbox_already_connected:'), 'which the page explains');

console.log('repro-issue-72: one mailbox at a time ✓');
