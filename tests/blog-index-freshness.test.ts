// tests/blog-index-freshness.test.ts
// Two failures of the same thing — the crawler-visible post index baked into blog.html.
//
//   1. It FLASHED. The list lives inside #bms-blog and was hidden only once widget.js attached a
//      shadow root, which is two network round trips away (a preflight fetch, then the script).
//      Until then every visitor to /blog saw raw headlines, excerpts and ISO dates with no styling.
//
//   2. It went STALE. It is a snapshot taken at deploy time, and posts publish on a */5 cron with
//      no deploy near them. On 2026-09-09 the baked list held four posts while the live endpoint
//      served five — a drift nothing surfaces, because the page looks perfectly healthy while
//      describing an older site.
//
// Run:  npx tsx tests/blog-index-freshness.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const blog = readFileSync(join(root, 'blog.html'), 'utf8');
const widget = readFileSync(join(root, 'widget.js'), 'utf8');

// ── the flash ───────────────────────────────────────────────────────────────
console.log('\nThe crawler list must never get a frame\n');

check('⚠️ the shadow root is attached inline, not by widget.js', () => {
    // The whole fix. Anything that waits for a fetch or a script is two round trips too late.
    const inline = blog.slice(landmark(blog, '<div id="bms-blog"></div>'), landmark(blog, 'id="bms-blog-setup"'));
    assert.match(inline, /attachShadow\(\{ mode: 'open' \}\)/, 'blog.html must attach the root itself');
    assert.ok(
        landmark(blog, 'attachShadow') < landmark(blog, 'function mountWidgetScript'),
        'it must run before anything that mounts the widget',
    );
});

check('⚠️ it sits immediately after the mount element and blocks the parser', () => {
    // A deferred/async script, or one moved further down the page, reopens exactly the window
    // this closes: the light DOM children paint before the root goes up.
    // ⚠️ Slice from AFTER the mount element, not from it: the mount is itself a <div>, so a slice
    // that includes it matches the "nothing renderable in between" regex against the very element
    // the check is anchored on.
    const MOUNT = '<div id="bms-blog"></div>';
    const after = blog.slice(landmark(blog, MOUNT) + MOUNT.length);
    const tag = after.slice(0, landmark(after, 'attachShadow'));
    assert.ok(!/<script[^>]*\b(defer|async)\b/.test(tag), 'the inline script must not be deferred or async');
    assert.ok(!/<script[^>]*\bsrc=/.test(tag), 'and must not be an external script — that is a round trip');
    // Nothing renderable may come between the mount and the script.
    assert.ok(!/<(section|div|p|h[1-6])\b/.test(tag), `markup between the mount and the guard: ${tag.slice(0, 120)}`);
});

check('⚠️ the list is NOT hidden with CSS', () => {
    // display:none would work visually and quietly destroy the point: search engines discount
    // hidden text, and this markup exists so crawlers can find the post pages at all.
    const inline = blog.slice(landmark(blog, '<div id="bms-blog"></div>'), landmark(blog, 'id="bms-blog-setup"'));
    assert.ok(!/#blog-static[^{]*\{[^}]*display\s*:\s*none/.test(blog), 'blog-static must never be display:none');
    assert.ok(!/visibility\s*:\s*hidden/.test(inline), 'nor visibility:hidden');
});

check('the placeholder is inert to assistive tech', () => {
    const inline = blog.slice(landmark(blog, '<div id="bms-blog"></div>'), landmark(blog, 'id="bms-blog-setup"'));
    assert.match(inline, /data-bms-placeholder/, 'the placeholder needs the marker widget.js clears it by');
    assert.match(inline, /aria-hidden="true"/, 'decorative loading bars must not be announced');
    assert.match(inline, /prefers-reduced-motion/, 'a pulsing animation needs a reduced-motion opt-out');
});

check('⚠️ widget.js REUSES an existing root instead of attaching a second', () => {
    // attachShadow on an element that already has a root throws NotSupportedError — which would
    // take the entire widget down on the one page that got the fix.
    assert.match(widget, /mountEl\.shadowRoot\s*\n?\s*\|\|\s*\(mountEl\.attachShadow/,
        'must prefer an existing shadowRoot');
    assert.ok(!/var shadow = mountEl\.attachShadow \? mountEl\.attachShadow/.test(widget),
        'the unconditional attach must be gone');
});

check('⚠️ the placeholder carries its own <style> inside it', () => {
    // widget.js removes the placeholder by its marker. A sibling <style> would survive that and
    // leave dead rules in the shadow root of every visit — observed, then fixed, on 2026-09-09.
    const inline = blog.slice(landmark(blog, '<div id="bms-blog"></div>'), landmark(blog, 'id="bms-blog-setup"'));
    // ⚠️ Anchored on the EMITTED string (`+ '<style>'`), not on a bare `<style>`: the prose comment
    // above this markup contains the tag name too, and matching that made the check compare the
    // placeholder against a code comment.
    const at = (needle: string) => landmark(inline, needle);
    assert.ok(
        at('data-bms-placeholder') < at("+ '<style>'"),
        'the <style> must be emitted AFTER the placeholder element opens, i.e. nested inside it',
    );
    assert.ok(
        at("+ '</style>'") < at("'<i></i>"),
        'and close before the bars, so the whole placeholder is one removable element',
    );
});

check('widget.js clears the placeholder, and only the placeholder', () => {
    // Scoped to our own marker: a customer page may have its own shadow content, and wiping the
    // root wholesale would delete it.
    assert.match(widget, /querySelector\('\[data-bms-placeholder\]'\)/);
    assert.ok(!/shadow\.innerHTML\s*=/.test(widget), 'must not clear the whole shadow root');
});

check('⚠️ a widget.js that never loads still shows the links', () => {
    // There is no detachShadow. Without a recovery path the section would be permanently blank —
    // worse than the unstyled list this page used to show.
    const fn = blog.slice(landmark(blog, 'function mountWidgetScript'), landmark(blog, 'function mountBlogWidget'));
    // ⚠️ Anchored on the assignment, not the bare name: /s\.onerror/ also matches
    // `s.onerror_disabled`, so renaming the handler out of existence would pass.
    assert.match(fn, /s\.onerror = function \(\) \{/, 'the injected script needs an error path');
    assert.match(fn, /insertBefore\(stat, mount\.nextSibling\)/, 'it must move the list into the light DOM');
    assert.match(fn, /else showSetupPanel\(\)/, 'and fall back when there is no baked list to move');
});

// ── the staleness ───────────────────────────────────────────────────────────
console.log('\nA publish must not leave the index describing an older site\n');

const rebuild = readFileSync(join(root, 'src/utils/seo-rebuild.ts'), 'utf8');

check('the not-configured outcome is distinguishable from a send', () => {
    // That it actually WARNS is asserted for real in the runtime section below. A source scan for
    // `console.warn(` is not enough — `void 0 && console.warn(...)` still contains the string.
    assert.match(rebuild, /not-configured/, 'a missing hook must be distinguishable from a successful send');
});

check('a rebuild never breaks a publish', () => {
    // The post is live either way; only the crawler index lags. Throwing here would turn a
    // cosmetic lag into a failed publish.
    assert.match(rebuild, /try \{/, 'the fetch must be guarded');
    assert.ok(!/throw /.test(rebuild), 'requestSeoRebuild must never throw');
});

check('⚠️ the scheduled publisher rebuilds ONCE per tick, not once per post', () => {
    // Several posts can come due together; a build each just queues builds that supersede one
    // another. Gated on something actually having been published.
    const cron = readFileSync(join(root, 'netlify/functions/publish-blog-posts.ts'), 'utf8');
    assert.match(cron, /if \(published > 0\) await requestSeoRebuild\(/);
    assert.equal((cron.match(/requestSeoRebuild\(/g) || []).length, 1, 'exactly one call site in the loop file');
    // Inside the per-post loop it would fire per post.
    const loop = cron.slice(landmark(cron, 'for (const { id } of due)'), landmark(cron, 'if (published > 0)'));
    assert.ok(!/requestSeoRebuild/.test(loop), 'the trigger must sit AFTER the loop, not inside it');
});

check('⚠️ every path that changes what is baked triggers a rebuild', () => {
    // Unpublish matters as much as publish, and cuts the other way: leave it and the index keeps
    // advertising a post whose page now 404s.
    for (const f of ['publish-blog.ts', 'publish-blog-posts.ts', 'unpublish-blog.ts']) {
        const src = readFileSync(join(root, 'netlify/functions', f), 'utf8');
        assert.match(src, /await requestSeoRebuild\(/, `${f} must request a rebuild`);
    }
});

check('⚠️ the hook call is AWAITED — a Lambda freezes on return', () => {
    // An un-awaited fetch is cancelled in flight and the rebuild silently never happens.
    for (const f of ['publish-blog.ts', 'publish-blog-posts.ts', 'unpublish-blog.ts']) {
        const src = readFileSync(join(root, 'netlify/functions', f), 'utf8');
        assert.ok(!/void requestSeoRebuild/.test(src), `${f} must not fire-and-forget`);
        assert.match(src, /await requestSeoRebuild/, `${f} must await`);
    }
});

// ⚠️ Wrapped, not run inline: tsx compiles this file to CJS, where a top-level `await` is a
// transform error that takes the WHOLE suite down rather than just these two checks.
async function runtimeChecks(): Promise<void> {
    // ── behaviour, executed ─────────────────────────────────────────────────────
    console.log('\nrequestSeoRebuild, run for real\n');

    await checkAsync('an unset hook reports not-configured and calls nothing', async () => {
        const { requestSeoRebuild } = await import('../src/utils/seo-rebuild');
        const saved = process.env.NETLIFY_PROD_BUILD_HOOK;
        delete process.env.NETLIFY_PROD_BUILD_HOOK;
        const realFetch = globalThis.fetch;
        const realWarn = console.warn;
        let called = false;
        const warnings: string[] = [];
        globalThis.fetch = (async () => { called = true; return new Response('', { status: 200 }); }) as typeof fetch;
        console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
        try {
            assert.equal(await requestSeoRebuild('test'), 'not-configured');
            assert.equal(called, false, 'no request may be made without a hook');
            // ⚠️ The point of this whole branch. NETLIFY_PROD_BUILD_HOOK is NOT set on production,
            // so this is the live path — and a no-op that says nothing is a control that looks
            // present and guards nothing. Assert the warning fires and names the variable.
            assert.equal(warnings.length, 1, `expected exactly one warning, got ${warnings.length}`);
            assert.match(warnings[0], /NETLIFY_PROD_BUILD_HOOK/, 'the warning must name the missing variable');
            assert.match(warnings[0], /stale/i, 'and say what goes wrong as a result');
        } finally {
            globalThis.fetch = realFetch;
            console.warn = realWarn;
            if (saved !== undefined) process.env.NETLIFY_PROD_BUILD_HOOK = saved;
        }
    });

    await checkAsync('a configured hook is POSTed, and a failure is swallowed', async () => {
        const { requestSeoRebuild } = await import('../src/utils/seo-rebuild');
        const saved = process.env.NETLIFY_PROD_BUILD_HOOK;
        process.env.NETLIFY_PROD_BUILD_HOOK = 'https://hook.test/build';
        const realFetch = globalThis.fetch;
        const calls: Array<{ url: string; method?: string }> = [];
        try {
            globalThis.fetch = (async (u: string, o: RequestInit) => {
                calls.push({ url: String(u), method: o?.method });
                return new Response('', { status: 200 });
            }) as unknown as typeof fetch;
            assert.equal(await requestSeoRebuild('published'), 'sent');
            assert.deepEqual(calls, [{ url: 'https://hook.test/build', method: 'POST' }]);

            globalThis.fetch = (async () => new Response('', { status: 500 })) as typeof fetch;
            assert.equal(await requestSeoRebuild('published'), 'failed', 'a bad status is reported, not thrown');

            globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
            assert.equal(await requestSeoRebuild('published'), 'failed', 'an unreachable hook must not throw');
        } finally {
            globalThis.fetch = realFetch;
            if (saved === undefined) delete process.env.NETLIFY_PROD_BUILD_HOOK;
            else process.env.NETLIFY_PROD_BUILD_HOOK = saved;
        }
    });
}

void runtimeChecks()
    .catch((err) => { console.error(`  ✗ the runtime checks could not run\n    ${err}`); process.exitCode = 1; })
    .then(() => { console.log(`\n${passed} checks passed.`); });
