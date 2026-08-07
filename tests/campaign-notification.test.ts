// tests/campaign-notification.test.ts
// The alert that tells a user their campaign is waiting on them.
//
// Phase 1 shipped this feature with NO notification at all, and the reason it could not simply be
// added later without care is the same reason it is worth a test file: createNotification() with an
// unknown template key logs and returns false. It is a silent no-op that looks completely wired
// from the call site. Every check here exists because its failure mode is silence rather than an
// error — a wrong merge path renders a hole in the sentence, a wrong type files the card under the
// wrong tab, and a missing preference entry hides the toggle. None of them throw.
//
// No database: pure catalog/config assertions plus source-consistency checks.
// Run:  npx tsx tests/campaign-notification.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTIFICATION_DEFAULTS } from '../src/utils/notification-templates-catalog';
import { PREF_CATEGORIES, categoryForType } from '../src/utils/notification-prefs';
import { DECISION_TTL_DAYS } from '../src/config/campaign-vocab';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const KEY = 'campaign_decision_pending';
const agentSrc = read('netlify/functions/autonomous-campaign-agent.ts');
const tpl = NOTIFICATION_DEFAULTS.find((t) => t.templateKey === KEY);

console.log('\n──── the template exists, so the call is not a silent no-op ────');

check('the template is in the catalog', () => {
    // An unknown key logs and returns false. The call site would look correct for ever.
    assert.ok(tpl, `${KEY} is missing from the catalog — createNotification would no-op`);
});

check('every variable the copy uses is declared', () => {
    // Undeclared variables make the admin's "Insert variable" list lie and defeat save-time
    // validation, which is what stops an admin editing in a path the call site never supplies.
    const used = [...`${tpl!.title} ${tpl!.message}`.matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1]);
    const declared = new Set(tpl!.variables.map((v) => v.key));
    assert.ok(used.length > 0, 'the copy interpolates nothing — did the message lose its variables?');
    for (const u of used) assert.ok(declared.has(u), `{{${u}}} is used but not declared`);
});

check('the call site supplies exactly the paths the copy interpolates', () => {
    // The merge-var trap: renderMergeVars resolves a missing path to '' rather than to a literal
    // {{tag}}, so a drifted variable renders "Felix has  waiting on you" and nothing anywhere
    // fails. The catalog and the call site have to be checked against each OTHER, not just
    // internally — which is what the check above cannot do.
    const used = [...`${tpl!.title} ${tpl!.message}`.matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1]);
    const callIdx = agentSrc.indexOf(`createNotification(db, '${KEY}'`);
    assert.ok(callIdx !== -1, 'the agent does not send this notification');
    // The context object runs to the end of the call; take a generous window and look for each
    // path's leaf under its parent object.
    const callBody = agentSrc.slice(callIdx, callIdx + 1400);
    for (const path of used) {
        const [parent, leaf] = path.split('.');
        assert.ok(callBody.includes(`${parent}: {`), `the call site passes no "${parent}" context`);
        assert.ok(new RegExp(`\\b${leaf}\\s*:`).test(callBody), `the call site never sets ${path}`);
    }
});

console.log('\n──── it lands in the right place in the UI ────');

check('it is a suggested action, not informational', () => {
    // An uncategorised type falls back to 'informational', which files "your campaign needs a
    // decision" under Updates instead of Action required.
    const actions = read('src/utils/notification-actions.ts');
    assert.match(actions, new RegExp(`${KEY}: 'suggested_action'`), 'not routed to suggested_action');
});

check('it is dismissible — never a pinned banner', () => {
    // critical_action is undismissible. Nothing is broken here: a lapsed decision costs nothing and
    // the agent re-proposes while the evidence still holds.
    const actions = read('src/utils/notification-actions.ts');
    assert.ok(!new RegExp(`${KEY}: 'critical_action'`).test(actions), 'a suggestion became an unkillable banner');
});

check('the card deep-links to the Decisions tab, not the dashboard', () => {
    // Without an explicit CTA the generic action fallback drops the user on the dashboard to go and
    // find it — for a card that can expire in two days that is most of the way to not notifying
    // them at all.
    const js = read('notifications.js');
    const idx = js.indexOf(`notif.type === '${KEY}'`);
    assert.ok(idx !== -1, 'no CTA is registered for this type');
    const branch = js.slice(idx, idx + 400);
    assert.ok(branch.includes("'review-queue'"), 'the CTA does not open the Review Queue tab');
    assert.ok(branch.includes('routeToAssistantDetail'), 'the CTA does not route to the assistant');
});

check('the call site passes the assistantId the deep link reads', () => {
    // Two different code paths: the denormalised column drives the actor avatar, metadata drives
    // the CTA. Passing only one leaves either an anonymous card or a dead button.
    const callIdx = agentSrc.indexOf(`createNotification(db, '${KEY}'`);
    const callBody = agentSrc.slice(callIdx, callIdx + 1400);
    assert.match(callBody, /assistantId: notice\.assistantId/, 'no denormalised assistant link (actor identity)');
    assert.match(callBody, /metadata: \{ assistantId: notice\.assistantId \}/, 'no metadata.assistantId (deep link)');
});

console.log('\n──── the user can find and change the setting ────');

check('it is governed by Approvals, not the General fallback', () => {
    // Unmapped types fall back to product_updates, so muting product news would silently stop
    // approval requests — and the toggle would sit where nobody looks for it.
    const cat = categoryForType(KEY);
    assert.equal(cat.key, 'approvals', `governed by "${cat.key}" instead of approvals`);
});

check('Approvals is assistant-scoped and on by default', () => {
    // A decision is the assistant's work waiting on the user, so the toggle belongs per-assistant.
    const cat = PREF_CATEGORIES.find((c) => c.key === 'approvals')!;
    assert.equal(cat.scope, 'assistant');
    assert.ok(cat.inApp, 'approvals is off by default in-app');
});

console.log('\n──── one alert per org per run ────');

check('the notification is sent from a per-org loop, not per decision', () => {
    // Three campaigns filing on the same morning is one alert. Otherwise the feature becomes the
    // noise it exists to cut through.
    assert.ok(agentSrc.includes('noticesByOrg'), 'notifications are not collapsed per org');
    const loopIdx = agentSrc.indexOf('for (const [organisationId, notice] of noticesByOrg)');
    // The CALL, not the import — a bare indexOf('createNotification') matches the import line at
    // the top of the file and would pass no matter where the call actually sits. Positional
    // anchors over a whole file have quietly measured the wrong function here before.
    const notifyIdx = agentSrc.indexOf(`createNotification(db, '${KEY}'`);
    assert.ok(loopIdx !== -1, 'no per-org fan-in loop');
    assert.ok(notifyIdx !== -1, 'the notification is never sent');
    assert.ok(notifyIdx > loopIdx, 'the notification is sent from inside the per-campaign loop');
});

check('the fan-in runs after every campaign has been considered', () => {
    // Sent mid-loop, an org running three campaigns would be told about the first and then again
    // about the second.
    const campaignLoop = agentSrc.indexOf('for (const campaign of live)');
    const fanIn = agentSrc.indexOf('for (const [organisationId, notice] of noticesByOrg)');
    assert.ok(campaignLoop !== -1 && fanIn > campaignLoop, 'the fan-in is not after the campaign loop');
});

check('a notification failure cannot fail the run or be blamed on a campaign', () => {
    const fanIn = agentSrc.slice(agentSrc.indexOf('for (const [organisationId, notice] of noticesByOrg)'));
    assert.ok(fanIn.includes('try {') && fanIn.includes('catch'), 'the notify loop is unguarded');
});

console.log('\n──── the alert still describes something inert ────');

check('the copy says nothing has happened yet', () => {
    // The entire safety story of this feature is that a decision changes nothing until a human
    // approves it. An alert reading like a completed action would undo that in one sentence.
    assert.match(tpl!.message, /Nothing moves until you approve it\./,
        'the copy no longer states that the decision is inert');
});

check('the copy quotes no money', () => {
    // Phase 1 campaigns spend capacity, never money. A pound sign on a card is a price.
    assert.ok(!/[£$]/.test(`${tpl!.title} ${tpl!.message}`), 'a currency symbol reached the notification');
    for (const v of tpl!.variables) assert.ok(!/[£$]/.test(v.sample), `the ${v.key} sample quotes money`);
});

check('the decisions it announces really can expire unseen', () => {
    // The justification for notifying at all. If every kind lived for months the Review Queue badge
    // would genuinely have been enough.
    const shortest = Math.min(...Object.values(DECISION_TTL_DAYS));
    assert.ok(shortest <= 3, `the shortest decision TTL is ${shortest} days — re-check whether this alert is needed`);
});

console.log(`\n${passed} checks passed.\n`);
