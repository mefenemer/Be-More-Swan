// Connections PR 1 (owner, 2026-11-17, from the Meeting Note Taker real-account run): recipe settings are
// pickers filled from the connected tool, the Jira issue type is fixed and said in words, keys are upper
// case, only one task tool can be on, and the picker opens right after connecting.
// Run: npx tsx tests/connections-pickers.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    RECIPE_DESCRIPTIONS, RECIPE_SETTINGS, TASK_TOOL_RECIPES, cleanRecipeSettings, needsRecipeSettings, normaliseJiraKey,
} from '../src/config/recipe-settings';
import { pickJiraIssueType } from '../src/utils/pm-tickets';
import { sortSlackChannels } from '../src/utils/slack-channels';

const read = (f: string) => readFileSync(f, 'utf8');

// 1. The settings each recipe really needs — and nothing else.
assert.deepEqual(RECIPE_SETTINGS.jira_create_tasks.map((d) => [d.key, d.picker, d.required]), [['projectKey', 'jira_projects', true]], 'no issue type to edit');
assert.deepEqual(RECIPE_SETTINGS.asana_create_tasks.map((d) => [d.key, d.picker, d.required]), [['asanaProjectGid', 'asana_projects', true]]);
assert.deepEqual(RECIPE_SETTINGS.slack_meeting_summary.map((d) => [d.key, d.picker, d.required]), [['channel', 'slack_channels', false]], 'a channel, not a summary/time/tasks mapping');
assert.match(RECIPE_DESCRIPTIONS.jira_create_tasks, /Jira task \(issue type: Task\)/, 'the fixed issue type is said in the description');
assert.deepEqual([...TASK_TOOL_RECIPES], ['jira_create_tasks', 'asana_create_tasks']);

// 2. Saving keeps only those keys, upper-cases a Jira key, and refuses a missing required one.
assert.deepEqual(cleanRecipeSettings('jira_create_tasks', { projectKey: ' Scrum ', projectKeyLabel: 'Be More Swan (SCRUM)', issueType: 'Bug', junk: 'x' }),
    { ok: true, mappings: { projectKey: 'SCRUM', projectKeyLabel: 'Be More Swan (SCRUM)' } });
assert.equal(normaliseJiraKey('ntt'), 'NTT');
const bad = cleanRecipeSettings('jira_create_tasks', { projectKey: 'my project' });
assert.ok(!bad.ok && /isn’t a Jira project key/.test(bad.error));
const none = cleanRecipeSettings('asana_create_tasks', {});
assert.ok(!none.ok && /Choose the Asana project first/.test(none.error));
assert.deepEqual(cleanRecipeSettings('slack_meeting_summary', { tasks: 'Do task 1', meetingTime: '09:00', meetingSummary: 'Test Meeting' }), { ok: true, mappings: {} }, 'the old Slack mapping values are dropped; no channel = main channel');
assert.deepEqual(cleanRecipeSettings('slack_meeting_summary', { channel: 'C123', channelLabel: '#meeting-notes' }), { ok: true, mappings: { channel: 'C123', channelLabel: '#meeting-notes' } });
assert.equal(needsRecipeSettings('jira_create_tasks', {}), true);
assert.equal(needsRecipeSettings('jira_create_tasks', { projectKey: 'SCRUM' }), false);
assert.equal(needsRecipeSettings('slack_meeting_summary', {}), false, 'Slack works on the main channel without a choice');
assert.equal(needsRecipeSettings('email_meeting_followup', {}), false);

// 3. The issue type: Task when there is one, else the project's standard type — never a failed run.
assert.equal(pickJiraIssueType([{ name: 'Epic' }, { name: 'Task' }, { name: 'Subtask', subtask: true }]), 'Task');
assert.equal(pickJiraIssueType([{ name: 'Epic', hierarchyLevel: 1 }, { name: 'Story' }, { name: 'Bug' }]), 'Story');
assert.equal(pickJiraIssueType([]), 'Task');
const pm = read('src/utils/pm-tickets.ts');
assert.ok(pm.includes('const projectKey = project.projectKey.trim().toUpperCase();'), 'a key saved before this is upper-cased when sent');
assert.ok(pm.includes("project.issueType?.trim() || await jiraIssueTypeFor(accessToken, cloudId, projectKey)"));

// 4. Slack's picker: the main channel first.
assert.deepEqual(sortSlackChannels([{ id: 'C1', name: 'random' }, { id: 'C2', name: 'all-new-workspace', is_general: true }, { id: 'C3', name: 'meeting-notes' }]).map((c) => c.value), ['C2', 'C3', 'C1']);

// 5. The server: settings + wording on the list, an options endpoint, cleaning on save, one task tool.
const api = read('netlify/functions/integration-scenarios.ts');
assert.ok(api.includes("settings: RECIPE_SETTINGS[scenario.scenarioKey] ?? null,") && api.includes('description: RECIPE_DESCRIPTIONS[scenario.scenarioKey] ?? scenario.description,'));
assert.ok(api.includes("resource === 'options'") && api.includes('listJiraProjects(') && api.includes('listAsanaProjects(') && api.includes('listSlackChannels('));
assert.ok(api.includes('const cleaned = cleanRecipeSettings(scenario.scenarioKey, fieldMappings);'));
assert.ok(api.includes('await switchOffOtherTaskTools(db, organisationId, assistantId, scenario.id)'), 'switching one on (save)');
assert.ok(api.includes('switchedOff = await switchOffOtherTaskTools(db, organisationId, row.assistantId, row.scenarioId);'), 'switching one on (toggle)');
// …and the runner, for an assistant that already has both on.
const runner = read('netlify/functions/process-scenario-jobs.ts');
assert.ok(runner.includes('const taskTools = matches.filter((m) => TASK_TOOL_RECIPES.includes(m.scenario.scenarioKey));'));

// 6. The page: one shared picker form on both settings forms; opens itself after connecting.
const form = read('src/components/recipe-settings-form.js');
assert.ok(form.includes("const OPTIONS_API = '/api/integrations/options';") && form.includes('window.RecipeSettingsForm = { render, collect };'));
assert.ok(form.includes("fieldMappings[d.key] = d.picker === 'jira_projects' ? value.toUpperCase() : value;"));
const tab = read('src/components/assistant-integrations.js');
assert.ok(tab.includes('window.RecipeSettingsForm.render(') && tab.includes('window.RecipeSettingsForm.collect('));
assert.ok(tab.includes('function openPendingSetup()') && tab.includes('openPendingSetup();'));
assert.ok(tab.includes("'Tasks now go to ' + s.providerName"));
const hub = read('integrations.html');
assert.ok(hub.includes('window.RecipeSettingsForm.render(') && hub.includes('<script src="/src/components/recipe-settings-form.js"></script>'));
const ws = read('workspace.html');
assert.ok(ws.includes('if (!returnTab) window._pendingRecipeSetup = platform;'));
assert.ok(ws.indexOf('recipe-settings-form.js') < ws.indexOf('assistant-integrations.js"></script>'), 'loaded before the tab that uses it');

console.log('connections-pickers: all checks passed');
