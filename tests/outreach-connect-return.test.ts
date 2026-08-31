// tests/outreach-connect-return.test.ts
// Connecting an inbox from inside "Approve & send email", and the way back afterwards.
//
// Two complaints, one seam.
//
//   1. The Lead Generator's Overview had no "Manage connections" button. The Connections tab was
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

console.log('\n──── the Overview keeps a route to Connections ────');

// The whole function, so "counts mailboxes" cannot be satisfied by the word appearing in some
// unrelated renderer further down the file.
const STATUS_CARD = INT.slice(
    landmark(INT, 'window._renderConnectionsStatusCard = function ('),
    landmark(INT, 'function _blogDestStatusRow('),
);

check('a mailbox-only role is not "nothing relevant"', () => {
    const gate = STATUS_CARD.slice(
        landmark(STATUS_CARD, 'const nothingRelevant'),
        landmark(STATUS_CARD, 'const keepForSocial'),
    );
    assert.match(gate, /!mailboxes\.length/,
        'the emptiness test must count outreach mailboxes, or the Lead Generator — whose only '
        + 'connectors ARE mailboxes — hides the card and loses its "Manage connections" button');
});

check('the mailboxes it counts are the ones the grid draws', () => {
    // Both must read the same array. A second, separately-fetched source would let the card and the
    // grid disagree about whether this role has connectors at all.
    assert.match(STATUS_CARD, /const mailboxes = _assistantScoped \? _mailboxProviders : \[\]/,
        'the card must read _mailboxProviders — the same array _loadConnections fills and the grid renders');
});

check('the card still hides for a role with genuinely nothing', () => {
    // The fix must not degrade into "always show". Roles whose integrations are Synced-action
    // recipes in the drawer have no connectors, and a button to an empty grid is worse than none.
    assert.match(STATUS_CARD, /if \(nothingRelevant && !keepForSocial\) \{[\s\S]{0,200}classList\.add\('hidden'\)/,
        'nothingRelevant must still hide the card');
});

check('the button lives in the card it re-reveals', () => {
    const DETAIL = read('assistant-detail.html');
    const card = DETAIL.slice(
        landmark(DETAIL, 'id="connections-status-card"'),
        landmark(DETAIL, 'id="detail-roi-strip"'),
    );
    assert.match(card, /Manage connections<\/button>/,
        'if the button ever moves out of #connections-status-card the gate above stops being the '
        + 'thing that decides whether it is on the page');
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
