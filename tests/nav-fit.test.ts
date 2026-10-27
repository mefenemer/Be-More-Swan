// tests/nav-fit.test.ts
// The public nav (2026-10-27): it ran off the page from 1024px up to ~1060px in English and ~1460px
// in Spanish, and nine pages never loaded mobileMenu.js, so their hamburger did nothing.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const PAGES = ['about', 'assistant-chat', 'assistant-role-detail', 'assistant-setup', 'assistant', 'assistants', 'beta', 'blog',
    'check-email', 'connections', 'contact', 'dashboard', 'data-deletion', 'dpa', 'faq', 'how-it-works', 'index', 'integrations',
    'invite', 'logout', 'partner-terms', 'partners', 'powered-by', 'pricing', 'privacy', 'referral', 'register', 'report-site',
    'terms_of_service', 'trust', 'waitlist'];

check('every page that injects the nav loads mobileMenu.js', () => {
    for (const p of PAGES) {
        const html = read(`${p}.html`);
        if (!html.includes('components/nav.html')) continue;
        assert.match(html, /<script src="(\.\/|\/)mobileMenu\.js"/, `${p}.html has a dead hamburger`);
    }
});

check('the hamburger toggles from one document listener, not a per-page setup call', () => {
    const js = read('mobileMenu.js');
    assert.ok(js.includes("e.target.closest('#mobile-menu-button')"));
    assert.ok(!/menuButton\.onclick/.test(js), 'an onclick as well would toggle twice');
    assert.match(js, /function setupMobileMenu\(\)/, 'pages still call it');
});

check('the nav is measured, and the compact class shows the hamburger at any width', () => {
    const js = read('mobileMenu.js');
    assert.ok(js.includes("root.classList.toggle(COMPACT, needed > row.clientWidth);"));
    const nav = read('components/nav.html');
    assert.ok(nav.includes('html.bms-nav-compact .bms-nav-desktop { display: none !important; }'));
    assert.ok(nav.includes('html.bms-nav-compact .bms-nav-burger { display: flex !important; }'));
    assert.ok(nav.includes('html:not(.bms-nav-compact) #mobile-menu { display: none !important; }'), 'the open menu would be hidden in compact mode');
});

console.log(`\n${passed} checks passed`);
