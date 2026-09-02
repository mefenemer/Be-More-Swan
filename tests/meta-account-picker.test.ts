// tests/meta-account-picker.test.ts
// DEFECT 3 of the 2026-09-01 Meta incident: a workspace never got to say WHICH account it was
// connecting. meta-oauth.ts took `pageList.find(p => p.instagram_business_account?.id)` for
// Instagram and `?? pageList[0]` for Facebook — the first Page /me/accounts happened to return.
//
// A user who admins several Pages was therefore bound to an arbitrary one, and a reconnect could
// silently REBIND the workspace to a different account: org 37 went from bemoreswan to
// love.cat.studio in six seconds. Publishing then failed with Meta's
// "(#10) Application does not have permission for this action", which reads as an App Review
// problem and sends you to the Meta dashboard rather than to this code.
//
// The fix is an explicit picker: when a login reaches more than one account the token is parked in
// the vault, the user chooses, and the already-connected account is pre-selected so a routine
// reconnect defaults to staying put. Defects 1 and 2 (the shared vault key and the unordered
// limit(1)) are covered by tests/connection-selection.test.ts.
//
// Run:  npx tsx tests/meta-account-picker.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { landmark } from './landmark';
import {
    accountsFor, renderAccountPicker, pendingRefKey,
    signPickerHandle, parsePickerHandle, type IgPage,
} from '../src/utils/meta-accounts';

let passed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const metaOauth = read('../netlify/functions/meta-oauth.ts');

// The shape /me/accounts returns for a user who administers two Pages, each with its own Instagram
// business account — the exact situation that broke org 37.
const TWO_ACCOUNTS: IgPage[] = [
    { id: '1001', name: 'love.cat.studio', instagram_business_account: { id: '17841467511229378', username: 'love.cat.studio' } },
    { id: '1002', name: 'Be More Swan', instagram_business_account: { id: '17841414318461950', username: 'bemoreswan' } },
];

console.log('\nMeta account picker\n');

// ── 1. Both accounts are offered, not just the first ─────────────────────────────────────────

test('two Instagram accounts in one login are BOTH offered', () => {
    const accounts = accountsFor('instagram', TWO_ACCOUNTS);
    assert.strictEqual(accounts.length, 2, 'the old code took find() and threw the second away');
    assert.deepStrictEqual(
        accounts.map(a => a.externalUserId).sort(),
        ['17841414318461950', '17841467511229378'],
        'the connection is keyed on the IG business account id, not the Page id',
    );
    // The Page each account hangs off has to travel with it: publishing derives a Page token.
    assert.strictEqual(accounts.find(a => a.igUsername === 'bemoreswan')!.fbPageId, '1002');
});

test('a Page with no linked Instagram is not an Instagram candidate', () => {
    const accounts = accountsFor('instagram', [
        { id: '2001', name: 'A Page with no Instagram' },
        ...TWO_ACCOUNTS,
    ]);
    assert.strictEqual(accounts.length, 2);
    assert.ok(!accounts.some(a => a.fbPageId === '2001'), 'only a Business/Creator link can be connected');
});

test('every Page is a Facebook candidate, linked ones first', () => {
    const accounts = accountsFor('facebook', [
        { id: '2001', name: 'No Instagram here' },
        ...TWO_ACCOUNTS,
    ]);
    assert.strictEqual(accounts.length, 3, 'Facebook needs only a Page');
    assert.deepStrictEqual(accounts.map(a => a.externalUserId), ['1001', '1002', '2001']);
    assert.ok(
        accounts[0].igUsername,
        'Pages carrying an Instagram account come first, so Facebook and Instagram default to one Page',
    );
});

test('one Instagram account reachable through two Pages is offered ONCE', () => {
    // Otherwise the picker asks the user to choose between two identical rows.
    const shared = { id: '17841414318461950', username: 'bemoreswan' };
    const accounts = accountsFor('instagram', [
        { id: '1002', name: 'Be More Swan', instagram_business_account: shared },
        { id: '1003', name: 'Be More Swan (old)', instagram_business_account: shared },
    ]);
    assert.strictEqual(accounts.length, 1);
});

test('the ordering is stable, so the same login always renders the same list', () => {
    const once = accountsFor('instagram', TWO_ACCOUNTS).map(a => a.externalUserId);
    const twice = accountsFor('instagram', TWO_ACCOUNTS).map(a => a.externalUserId);
    assert.deepStrictEqual(once, twice);
});

// ── 2. The handle that carries the parked choice ─────────────────────────────────────────────
// It is the only thing standing between a browser and a vaulted long-lived token, so a forged or
// edited one must never resolve to a vault key.

const SECRET = 'test-jwt-secret';
const NONCE = 'a'.repeat(64);

test('a handle round-trips to the org, user and nonce that signed it', () => {
    const handle = signPickerHandle(SECRET, 37, 42, NONCE);
    assert.deepStrictEqual(parsePickerHandle(SECRET, handle), { organisationId: 37, userId: 42, nonce: NONCE });
});

test('an edited handle is rejected', () => {
    const handle = signPickerHandle(SECRET, 37, 42, NONCE);
    // Repointing the org at someone else's vault prefix must not verify.
    const forged = handle.replace(/^37\./, '38.');
    assert.strictEqual(parsePickerHandle(SECRET, forged), null);
    assert.strictEqual(parsePickerHandle(SECRET, handle.slice(0, -1) + '0'), null, 'a tampered MAC must fail');
    assert.strictEqual(parsePickerHandle('another-secret', handle), null, 'and it must be OUR signature');
});

test('a malformed handle is rejected without reaching the vault', () => {
    for (const bad of [undefined, null, '', 'nope', '37.42.' + NONCE, `37.42.${'z'.repeat(64)}.mac`, `37.42.${NONCE}.${NONCE}.extra`]) {
        assert.strictEqual(parsePickerHandle(SECRET, bad as string | undefined), null, `accepted ${String(bad)}`);
    }
});

test('the parked token lives inside its own org prefix', () => {
    const key = pendingRefKey(37, 42, NONCE);
    assert.ok(key.startsWith('aura/org-37/'), 'org-wide revocation sweeps by that prefix');
    assert.notStrictEqual(key, pendingRefKey(37, 43, NONCE), 'two users choosing at once must not collide');
    assert.notStrictEqual(key, pendingRefKey(38, 42, NONCE));
});

// ── 3. What the user actually sees ───────────────────────────────────────────────────────────

const renderTwo = (connectedIds: string[] = []) => renderAccountPicker({
    handle: signPickerHandle(SECRET, 37, 42, NONCE),
    platform: 'instagram',
    accounts: accountsFor('instagram', TWO_ACCOUNTS),
    connectedIds,
    cancelUrl: '/workspace.html?meta_error=picker_cancelled&platform=instagram',
});

test('both accounts are rendered, each as its own radio', () => {
    const html = renderTwo();
    assert.ok(html.includes('@bemoreswan') && html.includes('@love.cat.studio'));
    assert.strictEqual((html.match(/type="radio"/g) ?? []).length, 2);
    assert.ok(html.includes('value="17841414318461950"'), 'the radio carries the account id the row is keyed on');
});

test('the account already connected is badged and PRE-SELECTED', () => {
    // The reconnect case. bemoreswan is second in Meta's list, so a default of "first" is exactly
    // the bug: the picker must default to where the workspace already is.
    const html = renderTwo(['17841414318461950']);
    const bemoreswanInput = html.match(/<input[^>]*value="17841414318461950"[^>]*>/)![0];
    const otherInput = html.match(/<input[^>]*value="17841467511229378"[^>]*>/)![0];
    assert.ok(bemoreswanInput.includes(' checked'), 'the connected account must be the default');
    assert.ok(!otherInput.includes(' checked'), 'and it must be the ONLY default');
    assert.ok(html.includes('Currently connected'), 'the user has to be able to see which one is live');
});

test('with nothing connected yet the first account is selected, and exactly one is', () => {
    const html = renderTwo();
    assert.strictEqual((html.match(/ checked/g) ?? []).length, 1);
});

test('a hostile Page name cannot inject markup', () => {
    const html = renderAccountPicker({
        handle: signPickerHandle(SECRET, 37, 42, NONCE),
        platform: 'facebook',
        accounts: accountsFor('facebook', [
            { id: '1', name: '<img src=x onerror="alert(1)">' },
            { id: '2', name: 'Ordinary Page' },
        ]),
        connectedIds: [],
        cancelUrl: '/workspace.html',
    });
    assert.ok(!html.includes('<img src=x'), 'Page names come from Meta — they are not trusted');
    assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
});

test('the picker posts back to select and needs no script or external asset', () => {
    const html = renderTwo();
    assert.match(html, /method="POST" action="\/\.netlify\/functions\/meta-oauth\?action=select"/);
    assert.ok(html.includes('name="h"'), 'the handle must ride back with the choice');
    assert.ok(!/<script/i.test(html), 'a blocked script would leave the user with a dead form');
    assert.ok(!/https?:\/\//.test(html.replace(/https?:\/\/[^"']*w3\.org[^"']*/g, '')), 'no off-site asset');
});

// ── 4. The flow around it ────────────────────────────────────────────────────────────────────
// Source scans: these guard the wiring, which is what regressed the last time.

test('meta-oauth no longer picks an account by array position', () => {
    assert.ok(
        !/pageList\.find\(p => p\.instagram_business_account\?\.id\)/.test(metaOauth),
        'the "first Page with an Instagram" pick is the defect itself',
    );
    assert.ok(!/\?\? pageList\[0\]/.test(metaOauth), 'and so is the Facebook fallback to pageList[0]');
    assert.match(metaOauth, /accountsFor\(platform, pageList\)/, 'candidates must come from the shared resolver');
});

test('a single reachable account still connects in one hop', () => {
    // The picker must not tax the common case with an extra click.
    const at = landmark(metaOauth, 'if (accounts.length === 1)');
    assert.match(metaOauth.slice(at, at + 300), /finaliseConnection\(/);
});

test('more than one account parks the token instead of writing a connection', () => {
    const at = landmark(metaOauth, 'const pendingOwner =');
    const parkBlock = metaOauth.slice(at, landmark(metaOauth, "action=choose", at));
    assert.match(parkBlock, /storeSecret\(db, pendingRefKey\(/, 'the token belongs in the vault, never in a URL');
    assert.ok(
        !/db\.insert\(systemConnections\)|db\.update\(systemConnections\)/.test(parkBlock),
        'an abandoned picker must leave the existing connection exactly as it was',
    );
});

test('select trusts the parked list, not the form', () => {
    const at = landmark(metaOauth, "if (action === 'select')");
    const select = metaOauth.slice(at);
    assert.match(
        select,
        /pending\.accounts\.find\(a => a\.externalUserId === form\.get\('account'\)\)/,
        'the posted id may only SELECT from the accounts this login actually reached',
    );
    assert.match(select, /requireTenant\(event, db\)/, 'the write step must insist on a session');
    assert.match(select, /ctx\.organisationId !== pending\.organisationId/, 'and on the right workspace');
    assert.match(select, /deleteSecret\(db, pendingRefKey\(/, 'a parked choice is single-use');
});

test('an expired choice is treated as absent and its token deleted', () => {
    const at = landmark(metaOauth, 'async function readPending');
    const fn = metaOauth.slice(at, at + 700);
    assert.match(fn, /PENDING_TTL_MS/, 'a parked token must not stay usable indefinitely');
    assert.match(fn, /deleteSecret\(db, key\)/, 'and must not linger in the vault once it expires');
});

test('the picker errors are all handled in the workspace toast', () => {
    const workspace = read('../workspace.html');
    const codes = [...metaOauth.matchAll(/metaErrUrl\('([a-z_]+)'/g)].map(m => m[1]);
    assert.ok(codes.includes('picker_expired') && codes.includes('picker_invalid'), 'expected the picker codes');
    for (const code of new Set(codes)) {
        assert.ok(
            new RegExp(`\\b${code}:`).test(workspace),
            `${code} has no message in workspace.html — the user gets the generic "connection failed"`,
        );
    }
});

console.log(`\n${passed} passed\n`);
