// tests/page-width.test.ts
// One page width across the workspace (owner, 2026-10-23): every routed page's outer wrapper is
// `.page-wide` — 1360px, centred, 16px sides on a phone and 24px from sm up — the same box as Blog
// Studio's full page. Before this there were eight widths (672px to 1600px) and three paddings.
//
// Deliberate exceptions: Getting Started and Assistant Setup stay narrow (step-by-step), and the
// Calendar, Review and the post editor stay full width. Forms keep a reading width INSIDE the page.
// No network.
//
// Run:  npx tsx tests/page-width.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const WIDE = [
    'assistants-directory.html', 'orchestrations-content.html', 'assistant-detail.html',
    'assistant-catalogue.html', 'assets.html', 'notifications.html', 'user-settings.html', 'billing.html',
    'help-content.html', 'my-content.html', 'audience.html', 'orders.html', 'newsletter.html',
    'referral-content.html', 'partner-content.html',
];

/** The first element in the file (comments and <style> blocks skipped) — the page's outer wrapper. */
function outerWrapper(html: string): string {
    const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
    const m = body.match(/<(div|header|section)\b[^>]*>/);
    return m ? m[0] : '';
}

check('the class is 1360px with 16px / 24px sides, in input.css AND the compiled style.css', () => {
    for (const f of ['input.css', 'style.css']) {
        const css = read(f);
        assert.ok(css.includes('.page-wide { width: 100%; max-width: 1360px; margin-left: auto; margin-right: auto; padding-left: 1rem; padding-right: 1rem; }'), `${f}: .page-wide rule`);
        assert.ok(css.includes('@media (min-width: 640px) { .page-wide { padding-left: 1.5rem; padding-right: 1.5rem; } }'), `${f}: sm padding`);
    }
});

check('Blog Studio\'s full page is the same 1360px', () => {
    assert.ok(read('src/components/blog-studio-modal.js').includes('#bms-blog-backdrop.bs-page .bms-blog-panel{max-width:1360px;'));
});

for (const f of WIDE) {
    check(`${f} opens on .page-wide, with no width or side padding of its own`, () => {
        const w = outerWrapper(read(f));
        assert.ok(/class="[^"]*\bpage-wide\b/.test(w), `outer wrapper is ${w}`);
        assert.ok(!/\bmax-w-|\bpx-\d|\bsm:px-|\blg:px-|max-width/.test(w), `it must not set its own width or sides: ${w}`);
    });
}

check('dashboard-content.html: its header and body are both .page-wide', () => {
    const html = read('dashboard-content.html');
    assert.ok(html.includes('<header class="page-wide py-10">'));
    assert.ok(html.includes('<div class="page-wide pb-20">'));
    assert.ok(!/max-w-7xl/.test(html), 'no 1280px wrapper left');
});

check('Email Studio no longer widens itself to 1600px', () => {
    assert.ok(!read('newsletter.html').includes('#nl-page { max-width'));
});

check('pages embedded in another page drop the class, not a stale max-w-*', () => {
    assert.ok(read('user-settings.html').includes("wrapper.classList.remove('page-wide', 'py-10', 'pb-20');"));
    assert.ok(read('src/components/assistant-my-content.js').includes("page.classList.remove('py-10', 'page-wide');"));
});

check('forms keep a reading width inside the wider page', () => {
    const settings = read('user-settings.html');
    for (const p of ['profile', 'sounds', 'agreements', 'agency', 'business']) {
        assert.match(settings, new RegExp(`class="settings-tab-panel[^"]*max-w-4xl" data-panel="${p}"`), `My Account ▸ ${p}`);
    }
    const assets = read('assets.html');
    for (const p of ['profile', 'hours', 'bookings', 'legal', 'team']) {
        assert.match(assets, new RegExp(`class="bizinfo-tab-panel[^"]*max-w-4xl" data-panel="${p}"`), `Business Information ▸ ${p}`);
    }
});

check('the narrow and full-width exceptions are untouched', () => {
    assert.ok(outerWrapper(read('getting-started.html')).includes('max-w-2xl'));
    assert.ok(outerWrapper(read('assistant-setup-checklist.html')).includes('max-w-2xl'));
    assert.ok(!outerWrapper(read('calendar.html')).includes('page-wide'));
    assert.ok(!outerWrapper(read('review-queue.html')).includes('page-wide'));
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — SOME FAILED' : ''}`);
