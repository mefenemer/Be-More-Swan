// tests/push-notifications.test.ts
// Web Push as the third notification channel.
//
// The failure modes here are all silent, and all of them look to a user like "the feature is
// broken" rather than like an error:
//   • a category with no push rule → `cat.push.locked` on undefined → 500 on a valid write
//   • a locked push category → an OS alert the user cannot silence → they revoke the browser
//     permission wholesale and lose every alert, including the ones we locked ON to guarantee
//   • the service worker anywhere but the site root → registers fine, receives nothing
//   • push gated behind the wrong channel's preference → alerts for categories they muted
//
// So these are invariants, not behaviour walkthroughs.

import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    PREF_CATEGORIES, pushRule, buildDefaults, isPushEnabled, isPushEnabledFor,
    CHANNEL_AVAILABILITY,
} from '../src/utils/notification-prefs';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// ── 1. The rule model ────────────────────────────────────────────────────────

check('every category resolves to a defined push rule', () => {
    // PrefCategory.push is optional, so a category that forgot it must still resolve — the
    // endpoint reads pushRule(cat).locked on every GET and would 500 on undefined.
    for (const cat of PREF_CATEGORIES) {
        const rule = pushRule(cat);
        assert.equal(typeof rule.locked, 'boolean', `${cat.key} has no usable push rule`);
        assert.equal(typeof rule.default, 'boolean', `${cat.key} has no usable push default`);
    }
});

check('NO push category is locked', () => {
    // A lock-screen alert the user cannot turn off is how an app gets its notification permission
    // revoked at the OS level — which silently loses them the very alerts locking was meant to
    // guarantee. inApp/email lock the essentials precisely because those channels are passive.
    const locked = PREF_CATEGORIES.filter(c => pushRule(c).locked).map(c => c.key);
    assert.deepEqual(locked, [], `these push categories are locked and must not be: ${locked.join(', ')}`);
});

check('push defaults are no louder than in-app', () => {
    // A bell that lists everything is useful; a phone that buzzes for everything gets muted. Any
    // category defaulting ON for push while OFF in-app is a mistake in the noisy direction.
    const louder = PREF_CATEGORIES
        .filter(c => pushRule(c).default && !c.inApp.default)
        .map(c => c.key);
    assert.deepEqual(louder, [], `push defaults ON but in-app defaults OFF for: ${louder.join(', ')}`);
});

check('at least one category defaults ON, and most default OFF', () => {
    const on = PREF_CATEGORIES.filter(c => pushRule(c).default);
    assert.ok(on.length > 0, 'a channel where nothing defaults on would never be noticed');
    assert.ok(on.length < PREF_CATEGORIES.length / 2,
        `${on.length}/${PREF_CATEGORIES.length} default ON — too noisy; push should be selective`);
});

check('buildDefaults covers push without throwing', () => {
    const d = buildDefaults('push');
    assert.equal(Object.keys(d).length, PREF_CATEGORIES.length);
    for (const cat of PREF_CATEGORIES) {
        assert.equal(d[cat.key], pushRule(cat).default, `${cat.key} default mismatch`);
    }
});

// ── 2. Gating reads the PUSH preference, not another channel's ───────────────

check('a stored push preference wins over the default', () => {
    const cat = PREF_CATEGORIES.find(c => pushRule(c).default) !== undefined
        ? PREF_CATEGORIES.find(c => pushRule(c).default)!
        : PREF_CATEGORIES[0];
    const type = cat.types[0];
    assert.equal(isPushEnabled(null, type), pushRule(cat).default, 'no stored value ⇒ the default');
    assert.equal(isPushEnabled({ [cat.key]: false }, type), false, 'a stored false must mute it');
    assert.equal(isPushEnabled({ [cat.key]: true }, type), true, 'a stored true must enable it');
});

check('a user can mute EVERY push category', () => {
    // The direct consequence of nothing being locked. If any type survives a full opt-out, the
    // "you can always turn it off" promise is false.
    const allOff = Object.fromEntries(PREF_CATEGORIES.map(c => [c.key, false]));
    const stillOn = PREF_CATEGORIES
        .flatMap(c => c.types)
        .filter(t => isPushEnabled(allOff, t));
    assert.deepEqual(stillOn, [], `these types push even when everything is muted: ${stillOn.slice(0, 5).join(', ')}`);
});

check('a per-assistant override beats the workspace push preference', () => {
    const cat = PREF_CATEGORIES.find(c => c.scope === 'assistant');
    assert.ok(cat, 'expected at least one assistant-scope category');
    const type = cat!.types[0];
    const workspaceOff = { [cat!.key]: false };
    const overrides = { '7': { [cat!.key]: { push: true } } };
    assert.equal(isPushEnabledFor(workspaceOff, overrides, 7, type), true,
        'an assistant override must win');
    assert.equal(isPushEnabledFor(workspaceOff, overrides, 9, type), false,
        'and must apply only to the assistant it was set on');
});

check('push is an available channel', () => {
    assert.equal(CHANNEL_AVAILABILITY.push, true,
        'push is gated per-user by OS permission, not by plan — unlike sms/whatsapp');
});

// ── 3. The delivery path ─────────────────────────────────────────────────────

check('notify.ts fans out to push from the single write path', () => {
    // 106 call sites write notifications. If push were gated at the call sites instead, it would
    // drift immediately — the whole point of notify.ts being the ONE path.
    const src = read('src/utils/notify.ts');
    assert.match(src, /deliverPush\(/, 'createNotification must reach the push channel');
    const fanOut = src.slice(landmark(src, 'export async function createNotifications('));
    assert.match(fanOut.slice(0, 2000), /deliverPush\(/, 'the fan-out must push too, not just the single insert');
    assert.match(src, /isPushEnabledFor\(/, 'push must be gated on the PUSH preference');
});

check('a push failure cannot fail the notification that triggered it', () => {
    const src = read('src/utils/notify.ts');
    assert.match(src, /void deliverPush\(/,
        'deliverPush must not be awaited into the return value — the in-app row is the source of truth');
});

check('web-push retires dead subscriptions but not transient failures', () => {
    const src = read('src/utils/web-push.ts');
    assert.match(src, /status === 404 \|\| status === 410/,
        'only 404/410 mean the subscription is permanently gone');
    assert.match(src, /MAX_FAILURES/,
        'a repeatedly-failing endpoint must eventually be retired so the fan-out stays bounded');
    assert.match(src, /isPushConfigured\(\)/,
        'an environment with no VAPID keys must skip push, not error per notification');
});

// ── 4. The PWA half ──────────────────────────────────────────────────────────

check('the service worker is at the site ROOT', () => {
    // Scope is capped by the worker's own directory. Anywhere else and it registers happily,
    // controls nothing, and never receives a push.
    assert.ok(existsSync(join(root, 'sw.js')),
        'sw.js must be at the repo root — a nested path silently narrows its scope');
    const client = read('push-client.js');
    assert.match(client, /var SW_URL = '\/sw\.js'/);
    assert.match(client, /scope: '\/'/);
});

check('the app manifest is installable, and is not the favicon icon set', () => {
    // favicon/manifest.json has icons and nothing else — no start_url, no display — so a browser
    // will not offer to install it, and without installation iOS never delivers a push.
    const m = JSON.parse(read('manifest.webmanifest'));
    assert.ok(m.start_url, 'start_url is required for installability');
    assert.equal(m.display, 'standalone');
    assert.ok(Array.isArray(m.icons) && m.icons.length > 0);
    for (const icon of m.icons) {
        const rel = String(icon.src).replace(/^\//, '');
        assert.ok(existsSync(join(root, rel)), `manifest icon ${icon.src} does not exist in the repo`);
    }
});

check('the service worker only references icons that exist', () => {
    const src = read('sw.js');
    for (const m of src.matchAll(/['"](\/favicon\/[^'"]+)['"]/g)) {
        const rel = m[1].replace(/^\//, '');
        assert.ok(existsSync(join(root, rel)), `sw.js references ${m[1]}, which is not in the repo`);
    }
});

check('workspace.html loads the app manifest and the push client', () => {
    const html = read('workspace.html');
    assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/,
        'the workspace must point at the APP manifest, not favicon/manifest.json');
    assert.match(html, /src="\/push-client\.js"/);
});

check('the iOS-in-Safari case gets its own message, not "unsupported"', () => {
    // iOS DOES support Web Push — from a Home Screen install only. Telling an iPhone user their
    // browser cannot do it is both wrong and unactionable.
    const client = read('push-client.js');
    assert.match(client, /ios_needs_install/);
    const html = read('workspace.html');
    assert.match(html, /ios_needs_install:/, 'the settings card must render copy for that reason');
    assert.match(html, /Add to Home Screen/i);
});

check('enable() runs inside the click handler', () => {
    // Browsers reject a permission prompt not triggered by a user gesture, and some permanently
    // deny a site that asks unprompted.
    const html = read('workspace.html');
    // Scoped to _renderPushCard first: `btn.onclick = async () => {` appears in several unrelated
    // features earlier in the file, and an unscoped landmark lands on the workspace-access button
    // and reports a false red about push.
    const card = html.slice(landmark(html, 'async function _renderPushCard()'));
    const at = landmark(card, 'showBtn(\'Enable\');');
    assert.match(card.slice(at, at + 500), /SwanPush\.enable\(\)/,
        'the Enable button must call enable() directly in its click handler');
});

console.log(`\n${passed} checks passed\n`);
