// tests/outreach-connect-return.test.ts
// Connecting an inbox from inside "Approve & send email", and the way back afterwards.
//
// Two complaints, one seam.
//
//   1. (History — superseded 2026-10-22, see below.) The Lead Generator's Overview had no "Manage connections" button. The Connections tab was
//      reachable only from the Connections tab. The Overview card self-hides for roles with no
//      connectors, and that emptiness test counted platforms, sources and blog destinations —
//      written before outreach mailboxes existed and never taught about them. The Lead Generator's
//      ONLY connectors are Gmail and Outlook, so the card scored zero and vanished while the grid
//      behind the (now absent) button rendered both.
//
//   2. Approving a lead with no inbox offered to connect one, and then handed over a modal
//      containing a link, which opened a new tab, whose callback landed on the Connections tab.
//      Three surfaces and two more decisions between "Gmail" and having Gmail — and the user ended
//      up somewhere other than the lead they were part-way through sending.
//
// So the facts to pin are: the mailbox counts as a connector; picking a provider navigates STRAIGHT
// into the grant; and the callback comes back to the Approved column, resolving where-to-land from
// a table rather than echoing the unsigned `state` it was handed.
//
// Verified in a component harness against the shipped source (.claude/launch.json →
// component-harness-connections-card :4521 and component-harness-outreach-connect :4522), which is
// where the DOM behaviour was proven; this file is what keeps it from drifting back.
//
// Run:  npx tsx tests/outreach-connect-return.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const INT = read('integrations.js');
const SHELL = read('assistants.js');
const OAUTH = read('netlify/functions/oauth-integrations.ts');
const WORKSPACE = read('workspace.html');

console.log('\n──── every role reaches Connections the same way ────');

// Owner, 2026-10-22: no "Manage connections" button on the Overview, for any role. It used to sit
// in a hero strip on some roles and inside the Audience list on others, decided per role by
// _syncManageConnectionsPlacement — so two assistants showed it and the rest did not. Connections
// are managed in Assistant Profile ▸ Connections, which every role has. What these pin is that the
// one remaining route is always there (the Lead Generator once had none at all — see 1. above).

const DETAIL = read('assistant-detail.html');

check('there is no Manage connections button on the assistant page, and nothing that placed one', () => {
    assert.doesNotMatch(DETAIL, /Manage connections<\/button>/);
    assert.ok(!DETAIL.includes('id="connections-status-card"') && !DETAIL.includes('id="btn-audience-connections"'));
    assert.ok(!SHELL.includes('_syncManageConnectionsPlacement'), 'the placement logic is gone');
    assert.ok(!INT.includes('_renderConnectionsStatusCard'), 'and so is the strip renderer');
});

check('Assistant Profile has a Connections card, and no role hides it', () => {
    const home = DETAIL.slice(landmark(DETAIL, 'id="tab-profile-home"'), landmark(DETAIL, '/tab-profile-home'));
    assert.match(home, /data-tab="platforms" class="detail-tab-btn brief-card[^"]*"[\s\S]{0,400}Connections<\/p>/,
        'the profile index must offer Connections — it is now the only route there');
    assert.ok(!/\[data-tab="platforms"\][^\n]*classList\.add\('hidden'\)/.test(SHELL), 'no role may hide it');
});

check('help text points at Assistant Profile ▸ Connections, not a button that no longer exists', () => {
    const studio = read('src/components/blog-studio-modal.js');
    for (const [name, src] of [['assistants.js', SHELL], ['blog-studio-modal.js', studio]] as const) {
        assert.ok(!src.includes('Manage connections'), `${name} still names the removed button`);
    }
});

console.log('\n──── the Goal Progress actions are the same control ────');

// "Check again now" and "Manage goals" were underlined text links, which read as page chrome
// rather than as things the Goal Progress card can do. Both are now the same pill as
// "Adjust schedule", in the same top-right slot.

// The header now sits INSIDE the white panel (the actions belong to the card), so it runs from
// the panel to the body.
const GOALS_HDR = DETAIL.slice(
    landmark(DETAIL, 'id="goal-progress-panel"'),
    landmark(DETAIL, 'id="goal-progress-body"'),
);
const ADJUST = (() => {
    const from = DETAIL.slice(landmark(DETAIL, 'id="autopilot-adjust-btn"'));
    return /class="([^"]+)"/.exec(from.slice(0, landmark(from, '</button>')))?.[1] ?? '';
})();
const clsOf = (hay: string, marker: string) => {
    const from = hay.slice(landmark(hay, marker));
    return /class="([^"]+)"/.exec(from.slice(0, landmark(from, '</button>')))?.[1] ?? '';
};

check('both actions carry the Adjust schedule pill, not a text-link style', () => {
    for (const [name, marker] of [
        ['Check again now', 'id="btn-refresh-goals"'],
        ['Manage goals', "_openGoalsList()"],
    ] as const) {
        const cls = clsOf(GOALS_HDR, marker);
        assert.deepStrictEqual(
            cls.split(/\s+/).filter(c => c && c !== 'hidden').sort(),
            ADJUST.split(/\s+/).filter(Boolean).sort(),
            `${name} must be styled as the shared pill button`,
        );
        assert.doesNotMatch(cls, /underline/, `${name} is a button now, not a link`);
    }
});

check('the actions sit inside the Goal Progress panel, not above it', () => {
    assert.ok(GOALS_HDR.includes('Goal Progress</h3>'), 'the title is not inside the panel');
    assert.ok(GOALS_HDR.includes('id="btn-refresh-goals"'), 'Check again now is outside the card');
    assert.ok(GOALS_HDR.includes("_openGoalsList()"), 'Manage goals is outside the card');
});

check('they stay in the header\'s right-hand group', () => {
    assert.ok(
        landmark(GOALS_HDR, 'Goal Progress</h3>') < landmark(GOALS_HDR, 'id="btn-refresh-goals"'),
        'the actions follow the title, so justify-between puts them top-right',
    );
});

check('Check again now still has no display utility to beat its own `hidden`', () => {
    // ⚠️ _wireGoalRefreshButton reveals it with classList.toggle('hidden') alone. An inline-flex
    // here and it is visible-but-dead during the skeleton, on a detail page opened with no ?id,
    // and whenever the goals fetch fails — the silent no-op the hidden class exists to prevent.
    const cls = clsOf(GOALS_HDR, 'id="btn-refresh-goals"');
    assert.match(cls, /^hidden\b/, 'it must still ship hidden');
    assert.doesNotMatch(cls, /\b(inline-flex|inline-block|flex|block)\b/);
});

console.log('\n──── picking a provider starts the grant ────');

const OFFER = SHELL.slice(
    landmark(SHELL, 'async function _rqOfferOutreachConnect('),
    landmark(SHELL, 'async function _rqSendLeadOutreach('),
);

check('choosing Gmail or Outlook navigates, rather than drawing a link', () => {
    assert.match(OFFER, /window\.location\.assign\(_outreachConnectUrl\(p\.key, 'outreach'\)\)/,
        'selecting the provider must go straight into the consent screen');
    assert.doesNotMatch(OFFER, /target="_blank"/,
        'the second modal with a "Connect Google →" link is what this replaced — a new tab whose '
        + 'callback lands nowhere near the lead being sent');
});

check('the setup answer is saved BEFORE the redirect', () => {
    // send_outreach gates on the onboarding answer, not on the OAuth grant. Navigating first would
    // leave a user with a connected mailbox that still never sends, and no page left to explain it.
    assert.ok(
        landmark(OFFER, '_rqSetOutreachProvider(choice)') < landmark(OFFER, 'window.location.assign'),
        'set_outreach_provider must resolve before the tab leaves',
    );
});

check('it still reports "connecting", so the lead is not stamped as drafted', () => {
    // The navigation is asynchronous — script keeps running for a beat. Returning anything else
    // lets the caller stamp outreachDraftedAt on a lead that is about to be sent automatically.
    assert.match(OFFER, /return \{ connecting: true \};/);
});

check('an already-connected account does not take a pointless trip through OAuth', () => {
    const ready = OFFER.slice(landmark(OFFER, 'if (ready) {'), landmark(OFFER, 'const choice = await window.choiceModal'));
    assert.match(ready, /return \{ retry: true \}/, 'it retries the send in place');
    assert.doesNotMatch(ready, /location\.assign/, 'and never redirects');
});

console.log('\n──── the connect URL carries where to come back to ────');

const CONNECT_URL = SHELL.slice(
    landmark(SHELL, 'function _outreachConnectUrl(providerKey'),
    landmark(SHELL, 'async function _workspaceEmailAddress('),
);

check('returnTo is optional, so the Connections grid links are unchanged', () => {
    assert.match(CONNECT_URL, /if \(returnTo\) params\.set\('returnTo', returnTo\)/,
        'omitting it must keep the historic "back to Connections" behaviour');
});

check('the query string is built, not concatenated', () => {
    // ⚠️ A hardcoded '&' once produced '…/connect&assistantId=3', which the netlify rewrite never
    // matches. Adding a second param is exactly when that returns, so the separator is computed.
    assert.match(CONNECT_URL, /new URLSearchParams\(\)/);
    assert.match(CONNECT_URL, /\$\{qs \? `\?\$\{qs\}` : ''\}/);
});

console.log('\n──── the callback resolves the destination, never echoes it ────');

check('there is a table of return destinations, and outreach names the Approved column', () => {
    const table = OAUTH.slice(
        landmark(OAUTH, 'const RETURN_DESTINATIONS'),
        landmark(OAUTH, 'function buildState('),
    );
    assert.match(table, /outreach: \{ tab: 'review-queue', rqStatus: 'approved' \}/,
        'the lead being sent is in Approved by the time the grant completes');
});

check('an unknown returnTo is dropped at /connect', () => {
    const start = OAUTH.slice(
        landmark(OAUTH, 'const rawReturnTo'),
        landmark(OAUTH, 'const redirectUri = `${baseUrl}/api/oauth/${provider}/callback`;'),
    );
    // Two tables since 2026-08-31 — RETURN_DESTINATIONS for a tab inside an assistant,
    // STANDALONE_RETURNS for a page outside one. What must not change is the SHAPE: an unknown
    // token resolves to null and never reaches `state`. A bare `rawReturnTo` here would be a
    // pass-through, which is the thing this check exists to prevent.
    assert.match(start, /RETURN_DESTINATIONS\[rawReturnTo\]/, 'assistant tabs are still table-checked');
    assert.match(start, /STANDALONE_RETURNS\[rawReturnTo\]/, 'standalone pages are table-checked too');
    assert.match(start, /\?\s*rawReturnTo\s*:\s*null/, 'validate on the way in as well as the way out');
    assert.ok(!/returnTo\s*=\s*rawReturnTo\s*;/.test(start), 'never a straight pass-through');
});

check('the success redirect looks the tab up rather than interpolating state', () => {
    // ⚠️ `state` is base64 of client-supplied JSON with NO signature. Interpolating state.tab into
    // a Location header would let whoever holds the URL choose where the callback sends the browser.
    const ret = OAUTH.slice(
        landmark(OAUTH, 'const returnAssistantId = state.assistantId'),
        landmark(OAUTH, 'const blogProvider ='),
    );
    assert.match(ret, /RETURN_DESTINATIONS\[state\.returnTo\]/);
    assert.doesNotMatch(ret, /tab=\$\{state\./, 'nothing from state may reach the redirect verbatim');
    assert.match(ret, /&tab=\$\{dest\.tab\}/);
});

check('a declined consent comes back to the assistant, not to integrations.html', () => {
    // This became load-bearing the moment the outreach prompt started navigating THIS tab: pressing
    // Cancel on Google's screen used to dump a user who was approving a lead onto the workspace-wide
    // connectors page.
    const err = OAUTH.slice(
        landmark(OAUTH, "const oauthError = error === 'access_denied'"),
        landmark(OAUTH, 'if (!code || !rawState)'),
    );
    assert.match(err, /workspace\.html\?oauth_error=\$\{oauthError\}&platform=\$\{provider\}&assistantId=/);
    assert.match(err, /RETURN_DESTINATIONS\[failState\.returnTo\]/,
        'the failure path resolves through the same table as the success path');
    // A plain includes(): the thing being matched is itself a regex literal, and escaping one into
    // a pattern is how `^` quietly becomes an anchor and the assertion stops meaning anything.
    assert.ok(err.includes('/^\\d+$/.test(failState.assistantId)'),
        'and re-validates the id, because this branch runs before state is verified');
});

console.log('\n──── workspace.html lands on the column ────');

const SUCCESS = WORKSPACE.slice(
    landmark(WORKSPACE, 'function handleOAuthSuccess()'),
    landmark(WORKSPACE, 'function handleReconnectPrompt()'),
);

check('the tab and column are read, used, and stripped from the URL', () => {
    assert.match(SUCCESS, /const returnTab = qs\.get\('tab'\)/);
    assert.match(SUCCESS, /const returnRqStatus = qs\.get\('rqStatus'\)/);
    assert.match(SUCCESS, /url\.searchParams\.delete\('tab'\)/, 'or a reload repeats the routing');
    assert.match(SUCCESS, /url\.searchParams\.delete\('rqStatus'\)/);
    assert.match(SUCCESS, /window\._assistantDetailInitialTab = returnTab \|\| 'platforms'/,
        'no tab named = the Connections default the Connections grid relies on');
    assert.match(SUCCESS, /window\._assistantDetailInitialRqStatus = returnRqStatus/);
});

check('the toast names the button that actually sends', () => {
    // ⚠️ Connecting the mailbox does NOT send the email that started this — the lead was approved
    // before the prompt appeared. The modal that used to say "press Send email now when you come
    // back" is gone, so this toast is the only place that instruction survives.
    const toast = SUCCESS.slice(landmark(SUCCESS, 'msgEl.textContent'), landmark(SUCCESS, 'toast.classList.remove'));
    assert.match(toast, /Send email now/);
    assert.match(toast, /returnRqStatus === 'approved'/, 'and only on the column where that button exists');
});

check('a failed connect routes back the same way', () => {
    const FAIL = WORKSPACE.slice(
        landmark(WORKSPACE, 'function handleOAuthError()'),
        landmark(WORKSPACE, 'function handleOAuthSuccess()'),
    );
    assert.match(FAIL, /window\._assistantDetailInitialTab = returnTab \|\| 'platforms'/);
    assert.match(FAIL, /gmail: 'Gmail', outlook: 'Outlook'/,
        'cancelling the mailbox grant lands here, and "The platform" is a poor name for Google');
});

console.log('\n──── the review queue opens the requested column ────');

check('the deep-link column is validated and consumed once', () => {
    const TAB = SHELL.slice(
        landmark(SHELL, "if (name === 'review-queue') {"),
        landmark(SHELL, "if (name === 'datahub') {"),
    );
    assert.match(TAB, /const wantedCol = window\._assistantDetailInitialRqStatus;/);
    assert.match(TAB, /window\._assistantDetailInitialRqStatus = null;/,
        'consumed, or every later visit to the tab reopens Approved');
    assert.match(TAB, /_DETAIL_RQ_COLUMNS\[wantedCol\] \? wantedCol : 'review'/,
        '⚠️ detailRqOpenStatus RETURNS EARLY on an unknown key — an unvalidated column renders '
        + 'nothing at all rather than falling back');
});

console.log(`\n${passed} checks passed.\n`);
