// Owner, 2026-11-17: "I do not want users to use bemoreswan email — if they do not connect Outlook or Gmail then
// they cannot email." The meeting follow-up action needs a connected mailbox to be switched on, the chat and
// the Inbox say when it won't send, and nothing a customer reads promises a Be More Swan address.
// Run: npx tsx tests/followup-mailbox-only.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NO_MAILBOX_SNAPSHOT_LINE, buildMeetingActionCard } from '../src/utils/chat-meeting-action';
import { RECIPE_DESCRIPTIONS } from '../src/config/recipe-settings';
import { MAILBOX_RECIPE_PROVIDER, NO_MAILBOX_MESSAGE } from '../src/utils/mailbox-connected';

const read = (f: string) => readFileSync(f, 'utf8');

// 1. The shared check: Gmail or Outlook, active only.
const mb = read('src/utils/mailbox-connected.ts');
assert.equal(MAILBOX_RECIPE_PROVIDER, 'email');
assert.match(NO_MAILBOX_MESSAGE, /^Connect Gmail or Outlook first/);
assert.ok(mb.includes('inArray(workspaceIntegrations.provider, [...MAILBOX_PROVIDERS])') && mb.includes("eq(workspaceIntegrations.status, 'active')"));

// 2. The server gate: list, save and switch-on.
const api = read('netlify/functions/integration-scenarios.ts');
assert.ok(!api.includes('CONNECTION_OPTIONAL_PROVIDERS'), 'no provider switches on without a connection any more');
assert.ok(api.includes('connection: scenario.providerKey === MAILBOX_RECIPE_PROVIDER ? mailbox :') && api.includes('needsMailbox: scenario.providerKey === MAILBOX_RECIPE_PROVIDER,'));
const save = api.slice(api.indexOf("resource === 'activate'"), api.indexOf("resource === 'toggle'"));
assert.ok(save.includes("if (!(await connectedMailbox(db, organisationId))) return json(409, { error: NO_MAILBOX_MESSAGE, code: 'no_mailbox' });"), 'save refuses with no mailbox');
const toggle = api.slice(api.indexOf("resource === 'toggle'"), api.indexOf("resource === 'deactivate'"));
assert.ok(toggle.includes("target?.providerKey === MAILBOX_RECIPE_PROVIDER && !(await connectedMailbox(db, organisationId))"), 'switch-on refuses with no mailbox');
assert.ok(toggle.indexOf('connectedMailbox') < toggle.indexOf('db.update(activeScenarios)'), 'checked BEFORE the switch is written');

// 3. The pages: Connect Gmail / Outlook in place of a switch; a refused switch says why and resets.
const tab = read('src/components/assistant-integrations.js');
assert.ok(!/connectionOptional/.test(tab) && !/connectionOptional/.test(read('integrations.html')) && !/connectionOptional/.test(read('src/components/assistant-data-hub.js')));
assert.ok(tab.includes("connectHref('gmail')") && tab.includes("connectHref('outlook')"));
assert.ok(tab.includes('On, but not sending — connect Gmail or Outlook above'), 'a follow-up left on after the mailbox went says it is not sending');
assert.ok(tab.includes("window.showToast(err.error || 'That couldn’t be changed. Please try again.', { tone: 'error' });"));
assert.ok(read('integrations.html').includes('Connect Gmail first') && read('integrations.html').includes('Connect Outlook first'));
// The data hub offers BOTH providers (one link that only went to Gmail stranded Outlook users).
assert.ok(read('src/components/assistant-data-hub.js').includes("${['gmail', 'outlook'].map((p) => `<a href=\"/api/oauth/${p}/connect"));
assert.ok(read('src/components/assistant-data-hub.js').includes("Connect ${p === 'gmail' ? 'Gmail' : 'Outlook'}</a>"));

// 4. The words: no Be More Swan address anywhere a customer reads.
assert.doesNotMatch(RECIPE_DESCRIPTIONS.email_meeting_followup, /Be More Swan/);
assert.match(RECIPE_DESCRIPTIONS.email_meeting_followup, /from your own Gmail or Outlook\. Connect one of them first/);
const sections = read('integrations.js');
assert.ok(sections.includes('Nothing is emailed until one of them is connected.') && !sections.includes('meeting follow-ups go from Be More Swan’s address'));
for (const f of ['assistants.js', 'src/config/recipe-settings.ts', 'integrations.js', 'src/components/disruptive-ui-registry.js', 'src/utils/meeting-followup-send.ts']) {
    assert.ok(!read(f).includes('from Be More Swan’s address because no inbox'), `${f} still describes the old fallback`);
}

// 5. Chat: the approve card and the prompt say the follow-up won't send.
const card = buildMeetingActionCard({ id: 7, title: 'Kick-off', approvalStatus: 'pending_approval', data: { attendees: [{ name: 'Ana', email: 'ana@x.com' }] } }, 3, { action: 'approve', recordId: 7 } as never);
assert.equal(card.noMailbox, undefined, 'the pure builder does not guess — the resolver checks the database');
const cma = read('src/utils/chat-meeting-action.ts');
assert.ok(cma.includes("if (card.action === 'approve' && !card.blocked) card.noMailbox = await followupBlockedByNoMailbox(db, organisationId, aiAssistantId);"));
assert.ok(cma.includes("if (ui.action === 'approve') return { ...m, uiElement: { ...ui, noMailbox: await followupBlockedByNoMailbox(db, organisationId, aiAssistantId) } };"), 'a stored card is brought up to date');
assert.match(NO_MAILBOX_SNAPSHOT_LINE, /approving a meeting now will NOT email the attendees/);
const reg = read('src/components/disruptive-ui-registry.js');
assert.ok(reg.includes('The follow-up email won’t be sent: no Gmail or Outlook is connected'));

console.log('followup-mailbox-only: all checks passed');
