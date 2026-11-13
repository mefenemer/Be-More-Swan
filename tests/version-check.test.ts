// tests/version-check.test.ts
// version-check.js tells a long-open workspace tab that a newer deploy is live, and reloads it on
// its own only when that cannot cost the user anything. These checks run the real script in a vm
// over a fake page and pin the rules:
//
//   - same deploy, local dev (commit null), or a failed request → nothing happens
//   - a different live commit → banner shown
//   - a VISIBLE tab is never reloaded on its own
//   - a hidden tab reloads, unless there is typed text, an open dialog, or a write in flight
//   - it never reloads twice for the same commit (no loop if the old page is served again)
//   - workspace.html loads it and sets window.BMS_VIEW_VERSION
//
// Run:  npx tsx tests/version-check.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(root, 'version-check.js'), 'utf8');
const WORKSPACE = readFileSync(join(root, 'workspace.html'), 'utf8');

const LOCAL = 'abcdef12';
const SAME = 'abcdef12' + '0'.repeat(32);
const NEWER = '1234567890abcdef1234567890abcdef12345678';

type Opts = { local?: string; live?: string | null; fail?: boolean; hidden?: boolean };

function load(opts: Opts = {}) {
    const listeners: Record<string, ((e: any) => void)[]> = {};
    const appended: any[] = [];
    const store = new Map<string, string>();
    let reloads = 0;
    let pendingWrite: (() => void) | null = null;

    function makeEl(tag: string): any {
        const el: any = {
            tagName: tag.toUpperCase(), style: {}, children: [] as any[], attrs: {} as Record<string, string>,
            id: '', textContent: '', isConnected: true, isContentEditable: false, value: '', type: 'text',
            classList: { contains: () => false },
            setAttribute(k: string, v: string) { this.attrs[k] = v; },
            append(...kids: any[]) { this.children.push(...kids); },
            addEventListener(t: string, fn: () => void) { this['on_' + t] = fn; },
            getClientRects: () => [1],
        };
        return el;
    }

    const page = { dialogs: [] as any[], openDialog: false };
    const document: any = {
        hidden: !!opts.hidden,
        body: { appendChild: (el: any) => appended.push(el) },
        addEventListener(t: string, fn: (e: any) => void) { (listeners[t] ||= []).push(fn); },
        createElement: makeEl,
        getElementById: (id: string) => appended.find(e => e.id === id) || null,
        querySelector: (sel: string) => (sel === 'dialog[open]' && page.openDialog ? {} : null),
        querySelectorAll: () => page.dialogs,
    };

    const fetchImpl = (input: any, init?: any) => {
        const url = String(input);
        if (url.includes('build-info')) {
            if (opts.fail) return Promise.reject(new Error('offline'));
            return Promise.resolve(new Response(JSON.stringify({ commit: opts.live === undefined ? NEWER : opts.live }), { status: 200 }));
        }
        if ((init?.method || 'GET') !== 'GET') return new Promise<Response>(res => { pendingWrite = () => res(new Response('{}')); });
        return Promise.resolve(new Response('{}'));
    };

    const window: any = {
        BMS_VIEW_VERSION: opts.local ?? LOCAL,
        fetch: fetchImpl,
        location: { reload: () => { reloads++; } },
        addEventListener(t: string, fn: (e: any) => void) { (listeners['win:' + t] ||= []).push(fn); },
    };
    const sessionStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
    };
    const sandbox: any = {
        window, document, sessionStorage, Date, Promise, String, Array, Set, Response,
        setInterval: () => 0, setTimeout: () => 0,
    };
    createContext(sandbox);
    runInContext(SRC, sandbox);

    return {
        window, document, page, store, appended, makeEl,
        vc: window.bmsVersionCheck,
        reloads: () => reloads,
        banner: () => appended.find(e => e.id === 'bms-version-banner'),
        fire: (t: string, e: any = {}) => (listeners[t] || []).forEach(fn => fn(e)),
        finishWrite: () => pendingWrite && pendingWrite(),
    };
}

const tick = () => new Promise(r => setTimeout(r, 0));

(async () => {
await check('same deploy → no banner, no reload', async () => {
    const t = load({ live: SAME, hidden: true });
    assert.strictEqual(await t.vc.check(true), null);
    assert.strictEqual(t.banner(), undefined);
    assert.strictEqual(t.reloads(), 0);
});

await check('local dev (build-info commit null) → nothing', async () => {
    const t = load({ live: null, hidden: true });
    assert.strictEqual(await t.vc.check(true), null);
    assert.strictEqual(t.banner(), undefined);
});

await check('failed request → nothing', async () => {
    const t = load({ fail: true, hidden: true });
    assert.strictEqual(await t.vc.check(true), null);
    assert.strictEqual(t.banner(), undefined);
});

await check('page version that is not a commit id → no request, nothing', async () => {
    const t = load({ local: 'dev', hidden: true });
    assert.strictEqual(await t.vc.check(true), null);
    assert.strictEqual(t.banner(), undefined);
});

await check('newer deploy, visible tab → banner shown, NOT reloaded', async () => {
    const t = load({ hidden: false });
    assert.strictEqual(await t.vc.check(true), NEWER);
    assert.ok(t.banner(), 'banner appended');
    assert.strictEqual(t.reloads(), 0);
});

await check('Refresh button reloads', async () => {
    const t = load({ hidden: false });
    await t.vc.check(true);
    const refresh = t.banner().children.find((c: any) => c.textContent === 'Refresh');
    refresh.on_click();
    assert.strictEqual(t.reloads(), 1);
});

await check('newer deploy, hidden tab, nothing unsaved → reloads on its own', async () => {
    const t = load({ hidden: true });
    await t.vc.check(true);
    assert.strictEqual(t.reloads(), 1);
});

await check('visible when found, reloads once the user switches away', async () => {
    const t = load({ hidden: false });
    await t.vc.check(true);
    assert.strictEqual(t.reloads(), 0);
    t.document.hidden = true;
    t.fire('visibilitychange');
    assert.strictEqual(t.reloads(), 1);
});

await check('typed-but-unsent text blocks the automatic reload; clearing it allows it', async () => {
    const t = load({ hidden: true });
    const box = t.makeEl('textarea');
    box.value = 'half-written post';
    t.fire('input', { target: box });
    await t.vc.check(true);
    assert.strictEqual(t.reloads(), 0, 'not reloaded while text is there');
    assert.ok(t.banner(), 'banner still shown');
    box.value = '';
    assert.strictEqual(t.vc.maybeAutoReload(), true);
    assert.strictEqual(t.reloads(), 1);
});

await check('a typed field that left the page no longer blocks', async () => {
    const t = load({ hidden: true });
    const box = t.makeEl('input');
    box.value = 'x';
    t.fire('input', { target: box });
    box.isConnected = false;
    await t.vc.check(true);
    assert.strictEqual(t.reloads(), 1);
});

await check('an open dialog blocks the automatic reload', async () => {
    const t = load({ hidden: true });
    t.page.openDialog = true;
    await t.vc.check(true);
    assert.strictEqual(t.reloads(), 0);
});

await check('a visible role-less full-screen overlay (the app\'s usual modal) blocks the automatic reload', async () => {
    const t = load({ hidden: true });
    const overlay = t.makeEl('div');
    overlay.id = 'plan-gate-modal';
    t.page.dialogs.push(overlay);
    await t.vc.check(true);
    assert.strictEqual(t.reloads(), 0);
    overlay.getClientRects = () => [];   // closed (display:none)
    assert.strictEqual(t.vc.maybeAutoReload(), true);
});

await check('the source treats .fixed.inset-0 overlays as dialogs', () => {
    assert.ok(SRC.includes(".fixed.inset-0'"), 'selector includes .fixed.inset-0');
});

await check('a write request in flight blocks the automatic reload until it finishes', async () => {
    const t = load({ hidden: true });
    t.window.fetch('/.netlify/functions/chat', { method: 'POST' });
    await t.vc.check(true);
    assert.strictEqual(t.reloads(), 0);
    t.finishWrite();
    await tick();
    assert.strictEqual(t.vc.maybeAutoReload(), true);
});

await check('never reloads twice for the same live commit (no loop)', async () => {
    const t = load({ hidden: true });
    t.store.set('bms.versionReloadedFor', NEWER);
    await t.vc.check(true);
    assert.strictEqual(t.reloads(), 0);
    assert.ok(t.banner(), 'banner offered instead');
});

await check('workspace.html loads version-check.js and exposes VIEW_VERSION to it', () => {
    assert.ok(WORKSPACE.includes('<script src="./version-check.js" defer></script>'));
    const at = WORKSPACE.indexOf("const VIEW_VERSION = '");
    assert.ok(at !== -1, 'VIEW_VERSION literal present');
    const after = WORKSPACE.slice(at, at + 400);
    assert.ok(after.includes('window.BMS_VIEW_VERSION = VIEW_VERSION;'), 'BMS_VIEW_VERSION set beside it');
});

// The standalone signed-in pages that carry the check (workspace.html is checked above).
const STANDALONE = ['admin.html', 'assistant-chat.html', 'onboarding.html', 'onboarding-social-media.html', 'assistant-setup.html'];
const STAMPER = readFileSync(join(root, 'scripts/stamp-view-version.mjs'), 'utf8');
for (const page of STANDALONE) {
    await check(`${page} loads version-check.js, exposes VIEW_VERSION, and the build stamps it`, () => {
        const html = readFileSync(join(root, page), 'utf8');
        assert.ok(html.includes('<script src="/version-check.js" defer></script>'));
        const at = html.indexOf("const VIEW_VERSION = '");
        assert.ok(at !== -1, 'VIEW_VERSION literal present (the stamp regex needs it)');
        assert.ok(html.slice(at, at + 200).includes('window.BMS_VIEW_VERSION = VIEW_VERSION;'));
        assert.ok(new RegExp(`const TARGETS = \\[[^\\]]*'${page.replace('.', '\\.')}'`).test(STAMPER), `${page} in stamp TARGETS`);
    });
}

console.log(`\n${passed} passed`);
})();
