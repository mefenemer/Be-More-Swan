// tests/campaign-paid-ui.test.ts
// The paid surface as a user sees it — which for almost every workspace means the LOCKED state.
//
// That is the case this suite is arranged around, not an afterthought. plan §1.1 is explicit: the
// paid surface renders as a locked state that NAMES the blocker, never as a button that fails.
// `follower-counts-availability` is what the alternative costs — a control that rendered, promised,
// and could never return a value.
//
// The second theme is the approve control. It is the only button in this product that starts real
// spending, and the figure it shows must be the figure it sends: `approve_launch` refuses a
// mismatch, so a display that drifts from the payload turns a working guard into a dead end.
//
// Run:  npx tsx tests/campaign-paid-ui.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import { AD_NETWORK_LABELS } from '../src/config/ad-networks';
import { networkAvailability } from '../src/utils/ad-networks/registry';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const ui = read('src/components/assistant-campaigns.js');
const api = read('netlify/functions/campaigns.ts');
const locked = ui.slice(landmark(ui, 'function paidLockedHtml()'), landmark(ui, 'function variantRow('));

console.log('\n──── the locked state, which is what almost everyone sees ────');

check('the three blockers are kept separate, because they unblock differently', () => {
    // Plan does not include it → a commercial conversation.
    // No reachable network      → we are waiting on LinkedIn.
    // Not connected / no account→ the user can fix it right now.
    // One boolean would send two of those three people to the wrong place.
    assert.match(locked, /if \(!p\.featureEnabled\)/);
    assert.match(locked, /if \(!p\.anyNetwork\)/);
    assert.match(locked, /if \(!p\.adsReady\)/);
});

check('each network names ITS OWN blocker, not a shared sentence', () => {
    assert.match(locked, /esc\(n\.blocker \|\| 'not available'\)/);
    // And the server really does supply one per network.
    for (const row of networkAvailability()) {
        assert.ok(row.blocker && row.blocker.length > 30, `${row.network} has no real blocker sentence`);
    }
});

check('network names come from a LABEL, never from CSS capitalize', () => {
    // ⚠️ `capitalize` renders "linkedin" as "Linkedin", which is the wrong name for the company —
    // on the one screen whose entire job is explaining why we cannot use them yet.
    assert.equal(AD_NETWORK_LABELS.linkedin, 'LinkedIn');
    assert.match(locked, /esc\(n\.label \|\| n\.network\)/);
    assert.ok(!/capitalize/.test(locked), 'the network name is being title-cased by CSS');
    assert.ok(networkAvailability().every((r) => r.label), 'the server does not send a label');
});

check('the actionable blocker offers a way to act', () => {
    // The one a user can fix. A sentence with no route is a dead end.
    assert.match(locked, /esc\(p\.adsReason \|\| ''\)/);
    assert.match(locked, /href="\/integrations\.html"/);
});

check('no "coming soon" anywhere on the locked surface', () => {
    // A date we cannot keep is worse than an honest blocker.
    // ⚠️ Comments stripped first: the phrase appears in the comment explaining WHY it is banned,
    // and a naive scan reports the explanation as the violation — whose obvious "fix" is deleting
    // the reasoning. Fourth time this shape has bitten in this build.
    assert.ok(!/coming soon/i.test(code(locked)));
});

console.log('\n──── the approve control ────');

const panel = ui.slice(landmark(ui, 'function paidPanel('), landmark(ui, '── Tab badge'));

check('the figure shown is the figure sent', () => {
    // ⚠️ approve_launch 409s on a mismatch. If the display and the payload could drift, the guard
    // that makes "a human, with the number in front of them" true becomes a dead end instead.
    assert.match(panel, /£\$\{esc\(budget\.toFixed\(2\)\)\} a day/);
    assert.match(panel, /data-cmp-budget="\$\{esc\(String\(budget\)\)\}"/);
    const handler = ui.slice(landmark(ui, "const budget = Number(approveBtn.dataset.cmpBudget)"));
    assert.match(handler, /confirmDailyBudgetGbp: budget/);
});

check('the confirm dialog states the amount and that charging starts', () => {
    // ⚠️ The end landmark is searched FROM the start index. Without that, `if (!ok) return;`
    // matches the stop_all handler earlier in the file, start > end, and slice() returns an EMPTY
    // STRING — so every assertion below would fail against perfectly correct code.
    const confirmAt = landmark(ui, 'const ok = window.confirm(\n      `Start spending');
    const confirm = ui.slice(confirmAt, landmark(ui, 'if (!ok) return;', confirmAt));
    assert.match(confirm, /£\$\{budget\.toFixed\(2\)\} a day/);
    assert.match(confirm, /LinkedIn begins charging/);
    // And a way back, or it is a one-way door.
    assert.match(confirm, /pause them from this page/);
});

check('approve appears only while something is actually staged', () => {
    assert.match(panel, /const awaiting = \(st\.variants \|\| \[\]\)\.some\(\(v\) => v\.status === 'staged'\)/);
    assert.match(panel, /\$\{awaiting \? `/);
});

check('a rejected approval RELOADS, so the user sees the real number', () => {
    // A 409 means the budget changed since this page was drawn. Leaving the stale figure on screen
    // would let them re-approve the number they already had refused.
    const branch = ui.slice(landmark(ui, "sayPaid(id, err.message || 'That did not work.'"), landmark(ui, '/** Status line inside one'));
    assert.match(branch, /await load\(\);/);
});

console.log('\n──── staging says what it does and does not do ────');

check('the form states that nothing is spent at staging', () => {
    assert.match(panel, /created on LinkedIn <span class="font-bold">paused<\/span>/);
    assert.match(panel, /nothing is spent until you approve them/);
});

check('the staging button is NOT styled like the money button', () => {
    // Staging is neutral; approving is the committing act. Two identical buttons would make the
    // difference invisible at a glance.
    assert.match(panel, /data-cmp-stage="[^"]*"\s*\n\s*class="mt-3 px-3 py-1\.5 bg-white border/);
    assert.match(panel, /data-cmp-approve="[^"]*"[^>]*\n\s*class="mt-3 px-4 py-2 bg-emerald-600/);
});

check('a failed stage does NOT re-render, so three written ads survive', () => {
    // render() rewrites the tab's innerHTML. The same rule the tracked-link form follows, and it
    // matters more here because there is more to lose.
    const branch = ui.slice(landmark(ui, "sayPaid(id, err.message || 'LinkedIn would not accept that.'"), landmark(ui, 'stageBtn.disabled = false;'));
    assert.ok(!/render\(\)/.test(branch));
});

console.log('\n──── an ad that stopped says why ────');

check('the pause reason is rendered, from the GENERATED vocabulary', () => {
    // ⚠️ An ad that stopped without saying why is the assistant making a decision the user cannot
    // argue with. And the labels are generated, never hand-copied.
    assert.match(ui, /window\.CampaignConstants\?\.pauseReasonLabel/);
    assert.match(ui, /\$\{why \? `<p[^`]*Stopped:<\/span> \$\{esc\(why\)\}/);
    const gen = read('src/generated/platform-constants.js');
    assert.match(gen, /pauseReasonLabel: function/);
    assert.match(gen, /creative_fatigue/);
});

check('"waiting for you" is distinct from "paused"', () => {
    // staged = never launched; paused = ran and stopped. Collapsing them would let a Resume button
    // restart something nobody ever approved.
    // ⚠️ Sliced from variantRow, NOT paidPanel — the chips are defined in the former, which sits
    // ABOVE the latter in the file, so the panel slice never contained them.
    const row = ui.slice(landmark(ui, 'function variantRow('), landmark(ui, 'function paidPanel('));
    assert.match(row, /label: 'Waiting for you'/);
    assert.match(row, /label: 'Paused'/);
});

console.log('\n──── the health banner ────');

const banner = ui.slice(landmark(ui, 'function optimiserHealthHtml()'), landmark(ui, '── The paid surface'));

check('it renders only when the server says actionable', () => {
    assert.match(banner, /if \(!h \|\| !h\.actionable\) return '';/);
});

check('unsupervised spend reads differently from merely late', () => {
    // At 'late' the campaigns are already halting themselves — the customer is protected. Identical
    // tone for both would waste the alarm.
    assert.match(banner, /const severe = h\.state === 'down' \|\| h\.state === 'never_run'/);
    assert.match(banner, /not being supervised/);
    assert.match(banner, /behind on checking/);
});

console.log('\n──── the server tells the client what it may offer ────');

check('list returns the paid block with all three facts', () => {
    const list = api.slice(landmark(api, "if (action === 'list')"), landmark(api, "if (action === 'create')"));
    assert.match(list, /featureEnabled,/);
    assert.match(list, /networks: networkAvailability\(\)/);
    assert.match(list, /adsReason:/);
});

check('readiness is only computed when the feature is on', () => {
    // No point asking about an ads connection for a workspace that cannot have one.
    assert.match(code(api), /const adsReadiness = featureEnabled\s*\n\s*\? assessAdsReadiness/);
});

check('the client treats a null paid block as "offer nothing"', () => {
    assert.match(code(ui), /if \(!p\) return '';/);
});

console.log(`\n${passed} checks passed.\n`);
