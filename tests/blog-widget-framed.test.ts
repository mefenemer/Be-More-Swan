// tests/blog-widget-framed.test.ts
// The blog widget inside a website builder's embed frame (Wix "Embed HTML" and friends).
//
// WHY THIS EXISTS (reported 2026-10-17): on Wix the blog showed "small posts in a small
// container". Wix never puts pasted code on the page itself; it wraps it in a fixed-size iframe,
// so the list AND every full article were read inside that box, at a phone-width layout. When
// framed, the widget now opens each post's full-page permalink (/b/:key/:slug) in a new tab.
//
// This runs the real widget.js in a vm against a minimal fake DOM, so it checks what a reader
// would actually get rather than the shape of the source.
//
// Run:  npx tsx tests/blog-widget-framed.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIDGET = readFileSync(join(root, 'widget.js'), 'utf8');

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const POSTS = [{ slug: 'hello-world', title: 'Hello', excerpt: 'First post' }];

/** Run widget.js once and return the list HTML it paints. */
async function renderList(opts: { framed: boolean; crossOriginTop?: boolean; postUrl?: string }): Promise<string> {
    let painted = '';
    const view: any = {
        className: '',
        set innerHTML(v: string) { painted = v; },
        get innerHTML() { return painted; },
        querySelectorAll: () => [],
        querySelector: () => null,
    };
    const shadow = { appendChild: () => {}, querySelector: () => null };
    const mount = { shadowRoot: null, attachShadow: () => shadow };
    const attrs: Record<string, string> = { 'data-bms-key': 'wgt_k', 'data-bms-mount': '#bms-blog' };
    if (opts.postUrl) attrs['data-bms-post-url'] = opts.postUrl;

    const win: any = {
        addEventListener: () => {},
        removeEventListener: () => {},
    };
    win.self = win;
    if (opts.crossOriginTop) {
        Object.defineProperty(win, 'top', { get() { throw new Error('SecurityError'); } });
    } else {
        win.top = opts.framed ? {} : win;
    }

    const context: any = {
        window: win,
        document: {
            currentScript: { src: 'https://bemoreswan.com/widget.js', getAttribute: (n: string) => attrs[n] ?? null },
            readyState: 'complete',
            querySelector: (sel: string) => (sel === '#bms-blog' ? mount : null),
            createElement: (tag: string) => (tag === 'div' ? view : { setAttribute: () => {}, appendChild: () => {} }),
            head: { appendChild: () => {} },
            addEventListener: () => {},
        },
        location: { hash: '' },
        localStorage: { getItem: () => null, setItem: () => {} },
        navigator: {},
        console: { error: () => {}, log: () => {} },
        URL, encodeURIComponent, decodeURIComponent, Date, Math, String, Array, JSON, Promise, isNaN,
        fetch: async (url: string) => ({
            ok: true,
            json: async () => (url.endsWith('/config') ? { theme: {}, badgeEnabled: true } : { posts: POSTS, nextCursor: null }),
        }),
    };
    vm.runInNewContext(WIDGET, context);
    for (let i = 0; i < 20 && !painted.includes('Hello'); i++) await new Promise(r => setTimeout(r, 0));
    assert.ok(painted.includes('Hello'), 'the widget never painted its list');
    return painted;
}

(async () => {
    console.log('\nOn the page itself, nothing changes');

    await check('top-level, no post-url: cards open in place (no link, no new tab)', async () => {
        const html = await renderList({ framed: false });
        assert.ok(html.includes('<div class="bms-card" data-slug="hello-world">'), html);
        assert.ok(!html.includes('target="_blank"'));
    });

    await check('top-level with a rooted post-url: same tab, the customer\'s own route', async () => {
        const html = await renderList({ framed: false, postUrl: '/blog/{slug}' });
        assert.ok(html.includes('<a class="bms-card" href="/blog/hello-world">'), html);
    });

    console.log('\nInside an embed frame (Wix)');

    await check('cards open the full-page permalink in a new tab', async () => {
        const html = await renderList({ framed: true });
        assert.ok(html.includes('href="https://bemoreswan.com/b/wgt_k/hello-world" target="_blank" rel="noopener"'), html);
    });

    await check('a cross-origin parent (window.top throws) still counts as framed', async () => {
        const html = await renderList({ framed: true, crossOriginTop: true });
        assert.ok(html.includes('/b/wgt_k/hello-world" target="_blank"'), html);
    });

    await check('a rooted post-url is not used inside a frame (it would resolve against Wix\'s sandbox domain)', async () => {
        const html = await renderList({ framed: true, postUrl: '/blog/{slug}' });
        assert.ok(!html.includes('href="/blog/hello-world"'), html);
        assert.ok(html.includes('/b/wgt_k/hello-world'), html);
    });

    await check('an absolute post-url is honoured inside a frame, in a new tab', async () => {
        const html = await renderList({ framed: true, postUrl: 'https://acme.com/blog/{slug}' });
        assert.ok(html.includes('href="https://acme.com/blog/hello-world" target="_blank" rel="noopener"'), html);
    });

    console.log('\nThe embed snippet');

    await check('the snippet the Blog Studio hands out includes its own mount <div>', async () => {
        const studio = readFileSync(join(root, 'src/components/blog-studio-modal.js'), 'utf8');
        assert.ok(/'<div id="bms-blog"><\/div>\\n'/.test(studio), 'the mount div must be part of the copied snippet');
        assert.ok(studio.includes('<strong>On Wix:</strong>'), 'the Wix note must be shown');
        const wix = studio.slice(studio.indexOf('<strong>On Wix:</strong>'), studio.indexOf('<strong>On Wix:</strong>') + 300);
        assert.ok(wix.includes('Blog page link'), 'the embed Wix note must send people to the Blog page link');
        assert.ok(!wix.includes('drag the box tall'), 'the old drag-the-box advice must be gone');
    });

    console.log(`\n${passed} passed`);
})();
