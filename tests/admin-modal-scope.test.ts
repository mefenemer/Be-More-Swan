// tests/admin-modal-scope.test.ts
// admin.html is one document holding ~35 `.admin-view` sections. adminNav() shows one by putting
// `hidden` (display:none) on all the others — and a display:none ancestor hides its whole subtree
// no matter what the descendant's own classes say. So a dialog that lives inside a view section
// can only ever be opened while that view is the active one.
//
// Six dialogs had drifted into the wrong section. #billing-override-modal, #ai-credits-modal,
// #bulk-publish-modal, #version-modal and #lifecycle-modal all sat inside #view-audit-log while
// being opened from Users and Catalogue; #swan-read-panel sat inside #view-swan-queue while the
// Front Page view opened it too. Every one of those buttons was silently dead in production —
// the handler ran, `classList.remove('hidden')` landed on the right element, and nothing
// appeared. Nothing threw, so no console error pointed at it.
//
// The rule these checks lock: an overlay may only live inside a view section if that view is the
// ONLY place it opens from. Everything else belongs at body level.
// Run:  npx tsx tests/admin-modal-scope.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'admin.html'), 'utf8');
const $ = cheerio.load(html);

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// Overlays that are legitimately view-local: each is opened from exactly one view, and that is the
// view it sits in. Adding an id here is a claim that NOTHING outside that view opens it — if that
// stops being true the dialog goes dead in the same silent way, so move it to body level instead.
const VIEW_LOCAL: Record<string, string> = {
    'user-detail-panel':      'view-users',
    'ticket-detail-panel':    'view-tickets',
    'ir-detail-panel':        'view-issue-reports',
    'audit-diff-modal':       'view-audit-log',
    'modal-log-incident':     'view-breach-response',
    'modal-ico-notification': 'view-breach-response',
};

/** Every full-viewport overlay carrying an id — the shape every dialog in this page uses. */
function overlays(): { id: string; owner: string | null }[] {
    return $('[id]')
        .toArray()
        .filter((el) => {
            const cls = ($(el).attr('class') || '').split(/\s+/);
            return cls.includes('fixed') && cls.includes('inset-0');
        })
        .map((el) => ({
            id: $(el).attr('id') as string,
            owner: $(el).parents('.admin-view').first().attr('id') ?? null,
        }));
}

check('the page still looks the way these checks assume', () => {
    assert.ok($('.admin-view').length > 20, `expected many .admin-view sections, found ${$('.admin-view').length}`);
    assert.ok(overlays().length >= 12, `expected at least 12 overlays with ids, found ${overlays().length}`);
});

check('no dialog is trapped inside a view section it is not opened from', () => {
    const trapped = overlays()
        .filter((o) => o.owner !== null && VIEW_LOCAL[o.id] !== o.owner)
        .map((o) => `#${o.id} sits inside #${o.owner}`);
    assert.deepEqual(
        trapped, [],
        `these dialogs cannot open unless their host view happens to be active:\n      ${trapped.join('\n      ')}\n` +
        '    Move them to body level (see the "Cross-view modals" block near the end of the layout),\n' +
        '    or add them to VIEW_LOCAL if they really are opened from that one view only.',
    );
});

check('the VIEW_LOCAL allow-list has not gone stale', () => {
    for (const [id, view] of Object.entries(VIEW_LOCAL)) {
        assert.equal($(`[id="${id}"]`).length, 1, `VIEW_LOCAL names #${id}, which is not in admin.html exactly once`);
        assert.equal(
            $(`#${id}`).parents('.admin-view').first().attr('id'), view,
            `VIEW_LOCAL says #${id} lives in #${view}; it does not. Fix the entry or move the dialog.`,
        );
    }
});

check('the six dialogs that were dead in production are at body level', () => {
    const regressed = [
        'billing-override-modal', 'ai-credits-modal', 'bulk-publish-modal',
        'version-modal', 'lifecycle-modal', 'swan-read-panel',
    ];
    for (const id of regressed) {
        assert.equal($(`[id="${id}"]`).length, 1, `#${id} should appear exactly once in admin.html`);
        const owner = $(`#${id}`).parents('.admin-view').first().attr('id');
        assert.equal(owner, undefined, `#${id} is back inside #${owner} — the Override Subscription bug is back`);
    }
});

// The reveal is `classList.remove('hidden')`, so `.hidden` has to beat the element's own display
// utility in the compiled stylesheet. Tailwind emits them in source order and the build regenerates
// style.css on every deploy, so this ordering is worth pinning rather than assuming.
check('.hidden still wins over .flex in the compiled stylesheet', () => {
    const css = readFileSync(join(root, 'style.css'), 'utf8');
    const flex = css.indexOf('.flex {');
    const hidden = css.indexOf('.hidden {');
    assert.ok(flex !== -1 && hidden !== -1, 'could not find the .flex / .hidden utilities in style.css');
    assert.ok(
        hidden > flex,
        '.hidden is declared BEFORE .flex, so a modal carrying both classes would render while hidden',
    );
});

console.log(`\n${passed} checks passed.`);
