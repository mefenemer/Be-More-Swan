// tests/push-notifications.test.ts
// Web Push as a third delivery channel: the preference model, the fan-out, and the PWA plumbing.
//
// Almost every failure mode here is SILENT. A push that is not sent looks exactly like a push the
// user did not want; a service worker at the wrong path registers cleanly and then never receives
// anything; a locked push category is invisible until someone's phone buzzes at 3am and they
// revoke the permission for good. So these lean on the invariants rather than on delivery.

import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    PREF_CATEGORIES, buildDefaults, pushRule, isPushEnabled, isPushEnabledFor, CHANNEL_AVAILABILITY,
} from '../src/utils/notification-prefs';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// ── 1. The preference model ──────────────────────────────────────────────────

check('every category declares a push rule, so none silently defaults', () => {
    // pushRule() falls back to OFF for an undeclared category, which is the safe direction — but
    // the fallback is a safety net, not the design. A new category should make a deliberate choice.
    const undeclared = PREF_CATEGORIES.filter(c => !c.push).map(c => c.key);
    assert.deepEqual(undeclared, [], `these categories have no push rule and will silently never push:\n    ${undeclared.join('\n    ')}`);
});

check('NO push category is locked', () => {
    // A lock-screen alert the user cannot turn off is how an app gets its notification permission
    // revoked wholesale — which loses them the very alerts a lock was meant to guarantee. inApp
    // and email lock the essential rows because those channels are passive; push is not.
    const locked = PREF_CATEGORIES.filter(c => pushRule(c).locked).map(c => c.key);
    assert.deepEqual(locked, [], `push must never be locked, but these are:\n    ${locked.join('\n    ')}`);
});

check('push defaults are TIGHTER than in-app', () => {
    // A bell that lists everything is useful; a phone that buzzes for everything gets muted, and a
    // muted app delivers nothing at all. If push ever defaults ON at least as widely as in-app,
    // that reasoning has been lost.
    const pushOn = PREF_CATEGORIES.filter(c => pushRule(c).default).length;
    const inAppOn = PREF_CATEGORIES.filter(c => c.inApp.default).length;
    assert.ok(pushOn < inAppOn,
        `push defaults ON for ${pushOn}/${PREF_CATEGORIES.length} categories vs in-app's ${inAppOn} — push should be the quieter channel`);
});

check('a locked in-app category is still user-silenceable on push', () => {
    // The specific consequence of the rule above, stated as behaviour: account_security is
    // LOCKED_ON for in-app and email, and must STILL be turn-off-able on push.
    const security = PREF_CATEGORIES.find(c => c.key === 'account_security')!;
    assert.equal(security.inApp.locked, true, 'precondition: account_security is locked in-app');
    assert.equal(isPushEnabled({ account_security: false }, 'security'), false,
        'a user must be able to stop security alerts buzzing their phone, even though the in-app row is locked');
});

check('buildDefaults understands the push channel', () => {
    const d = buildDefaults('push');
    assert.equal(Object.keys(d).length, PREF_CATEGORIES.length, 'every category needs a default');
    const security = PREF_CATEGORIES.find(c => c.key === 'account_security')!;
    assert.equal(d.account_security, pushRule(security).default);
});

check('an unset preference falls back to the category default, not to undefined', () => {
    // The commonest real state: a user who has never opened the settings page.
    for (const cat of PREF_CATEGORIES) {
        const type = cat.types[0];
        if (!type) continue;
        assert.equal(isPushEnabled(null, type), pushRule(cat).default,
            `${cat.key}: an unset push preference must resolve to its declared default`);
    }
});

check('per-assistant push overrides resolve, and workspace prefs win when absent', () => {
    const approvals = PREF_CATEGORIES.find(c => c.key === 'approvals')!;
    const type = approvals.types[0];
    assert.equal(approvals.scope, 'assistant', 'precondition: approvals is assistant-scoped');

    const overrides = { '7': { approvals: { push: false } } };
    assert.equal(isPushEnabledFor({ approvals: true }, overrides, 7, type), false, 'the override must win');
    assert.equal(isPushEnabledFor({ approvals: true }, overrides, 9, type), true, 'a different assistant is unaffected');
    assert.equal(isPushEnabledFor({ approvals: true }, null, 7, type), true, 'no override ⇒ the workspace preference');
});

check('push is advertised as an available channel', () => {
    assert.equal(CHANNEL_AVAILABILITY.push, true, 'the UI renders the column from this');
});

// ── 2. The fan-out ───────────────────────────────────────────────────────────

check('notify.ts pushes from BOTH write paths, not just the single-recipient one', () => {
    // 106 call sites go through this module precisely so a channel is added once. A fan-out that
    // wrote rows but skipped push would silently halve the feature.
    const src = read('src/utils/notify.ts');
    const single = src.slice(landmark(src, 'export async function createNotification('));
    assert.match(single.slice(0, 1400), /deliverPush\(/, 'createNotification must deliver push');
    const fanout = src.slice(landmark(src, 'export async function createNotifications('));
    assert.match(fanout.slice(0, 1400), /deliverPush\(/, 'createNotifications must deliver push too');
});

check('push delivery never blocks or fails the notification that triggered it', () => {
    const src = read('src/utils/notify.ts');
    const fn = src.slice(landmark(src, 'async function deliverPush('));
    const body = fn.slice(0, landmark(fn, '\n}\n'));
    assert.match(body, /catch/, 'deliverPush must swallow its own failures');
    // The in-app row is the source of truth. If push threw into the caller, a delivered
    // notification would be reported as a failure.
    assert.match(src, /void deliverPush\(/, 'the call must not be awaited into the return value');
});

check('an environment with no VAPID keys skips push entirely', () => {
    // This is what lets the whole feature deploy dark and be switched on by setting env vars —
    // and it must be the FIRST thing deliverPush checks, or every notification pays a query.
    const src = read('src/utils/notify.ts');
    const fn = src.slice(landmark(src, 'async function deliverPush('));
    const guard = fn.indexOf('isPushConfigured()');
    const query = fn.indexOf('.select(');
    assert.ok(guard !== -1 && guard < query, 'isPushConfigured() must gate before any DB work');
});

check('markup is stripped before it reaches an OS notification', () => {
    // Template copy may contain the inline markup admins are allowed to use; the in-app feed
    // sanitises it, but an OS notification is plain text and would show the tags literally.
    const src = read('src/utils/notify.ts');
    assert.match(src, /function stripMarkup\(/);
    const fn = src.slice(landmark(src, 'async function deliverPush('));
    assert.match(fn.slice(0, 3000), /stripMarkup\(row\.title\)/, 'the title must be stripped');
});

// ── 3. Dead-subscription pruning ─────────────────────────────────────────────

check('404/410 retires a subscription; other errors only count a failure', () => {
    // Without this the fan-out grows unbounded: every notification pays an HTTP request per
    // permanently-dead endpoint, forever. But retiring on a transient 500 would unsubscribe a
    // whole user base during one bad afternoon at a push provider.
    const src = read('src/utils/web-push.ts');
    assert.match(src, /status === 404 \|\| status === 410/, 'dead endpoints must be detected by status');
    assert.match(src, /expiredAt: new Date\(\)/, 'and retired');
    assert.match(src, /failureCount: nextCount/, 'transient failures must only increment a counter');
});

// ── 4. The PWA plumbing ──────────────────────────────────────────────────────

check('the service worker is at the site ROOT', () => {
    // A worker's scope is capped by its own URL's directory. At /assets/sw.js it would register
    // without complaint and then never receive a push for any real page.
    assert.ok(existsSync(join(root, 'sw.js')), 'sw.js must live at the repo root, which is the published root');
    assert.match(read('push-client.js'), /var SW_URL = '\/sw\.js'/);
});

check('the app manifest is installable — favicon/manifest.json is not', () => {
    const m = JSON.parse(read('manifest.webmanifest'));
    // iOS only delivers Web Push to a Home-Screen-installed PWA, and it will not offer to install
    // one without these. favicon/manifest.json is an icon set with none of them.
    for (const k of ['name', 'start_url', 'scope', 'display', 'icons']) {
        assert.ok(m[k], `manifest is missing ${k}, which browsers require to offer installation`);
    }
    assert.equal(m.display, 'standalone');
    assert.ok(m.icons.some((i: any) => i.sizes === '512x512'), 'a 512px icon is required for installation');

    const ws = read('workspace.html');
    assert.match(ws, /rel="manifest" href="\/manifest\.webmanifest"/,
        'workspace.html must link the APP manifest, not the icon-only favicon one');
});

check('every manifest icon actually exists', () => {
    // A missing icon makes a browser silently refuse to offer installation — and on iOS, no
    // installation means no push at all.
    const m = JSON.parse(read('manifest.webmanifest'));
    const missing = m.icons.map((i: any) => i.src).filter((src: string) => !existsSync(join(root, src.replace(/^\//, ''))));
    assert.deepEqual([...new Set(missing)], [], `manifest references icons that are not in the repo:\n    ${missing.join('\n    ')}`);
});

check('the worker always shows a notification for a push it receives', () => {
    // Browsers may revoke push permission from a site whose worker wakes on a push and shows
    // nothing. That is unrecoverable from inside the page, so a malformed payload must still
    // produce something.
    const src = read('sw.js');
    assert.match(src, /showNotification/);
    const handler = src.slice(landmark(src, "addEventListener('push'"));
    assert.match(handler.slice(0, 1600), /catch/, 'payload parsing must be defensive');
    assert.match(handler.slice(0, 1600), /data\.body \|\|/, 'and fall back to default copy');
});

check('the worker handles subscription rotation', () => {
    // A browser can silently replace a subscription. Unhandled, every subsequent send 410s, the
    // row is retired, and the user stops receiving alerts with no error anywhere.
    assert.match(read('sw.js'), /pushsubscriptionchange/);
    // The backstop for a session that was not open when it rotated.
    assert.match(read('push-client.js'), /async function init\(/);
});

check('iOS-in-Safari is reported as its own case, not as "unsupported"', () => {
    // iOS DOES support Web Push — but only for a Home-Screen PWA. Telling an iPhone user their
    // browser cannot do it is both unhelpful and, once they install it, wrong.
    const src = read('push-client.js');
    assert.match(src, /ios_needs_install/);
    assert.match(src, /isStandalone/);
    assert.match(read('workspace.html'), /ios_needs_install:/,
        'the settings UI must render copy for that case');
});

check('permission is requested inside the click handler', () => {
    // Browsers reject a permission prompt that was not triggered by a user gesture, and some
    // permanently deny a site for asking unprompted.
    // Anchored on the CALL and looking backwards, rather than forwards from an `onclick` marker:
    // `btn.onclick = async () => {` is not unique even within _renderPushCard (the disable button
    // uses it too), so a forward slice from the first hit checks the wrong handler.
    const ws = read('workspace.html');
    const at = landmark(ws, 'window.SwanPush.enable()');
    const before = ws.slice(Math.max(0, at - 300), at);
    assert.match(before, /onclick\s*=\s*async/,
        'enable() must be called from inside a click handler, not on load');
});

console.log(`\n${passed} checks passed\n`);
