// Run C (staging 2026-11-17): the chat's approve card said "including 4 action items for your task tracker" with
// no task tool switched on. It now names the tool that is on, or says the items stay in the Inbox.
// Run: npx tsx tests/meeting-approve-card-task-tool.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cma = readFileSync('src/utils/chat-meeting-action.ts', 'utf8');
assert.ok(cma.includes('export async function taskToolOn(db: Db, organisationId: number, aiAssistantId: number)'));
assert.ok(cma.includes('inArray(integrationScenarios.scenarioKey, [...TASK_TOOL_RECIPES]),') && cma.includes('eq(activeScenarios.isEnabled, true),'));
assert.ok(cma.includes("return row.key.startsWith('jira') ? 'Jira' : 'Asana';"));
assert.ok(cma.includes('card.taskTool = await taskToolOn(db, organisationId, aiAssistantId);'), 'set on a new approve card');
assert.ok(cma.includes('taskTool: await taskToolOn(db, organisationId, aiAssistantId) } };'), 'and on a stored one when it refreshes');

// Run the renderer's line as written, for each case.
const reg = readFileSync('src/components/disruptive-ui-registry.js', 'utf8');
const start = reg.indexOf('<p class="text-sm text-gray-700 mt-2">Approving sends it to the connections switched on for this assistant${');
const end = reg.indexOf("<p class=\"text-xs text-gray-600 mt-1\">No task tool is switched on", start);
assert.ok(start > 0 && end > start);
const line = reg.slice(start, reg.indexOf('</p>', start) + 4);
const esc = (v: string) => v;
const render = (ui: Record<string, unknown>) => new Function('ui', 'esc', `return \`${line}\`;`)(ui, esc) as string;
assert.match(render({ tasks: 4, taskTool: 'Asana' }), /including 4 action items for Asana\./);
assert.match(render({ tasks: 1, taskTool: 'Jira' }), /including 1 action item for Jira\./);
assert.doesNotMatch(render({ tasks: 4, taskTool: null }), /action item/, 'no task tool → no claim');
assert.match(render({ tasks: 4 }), /for your task tracker\./, 'a card made before this keeps its wording');
assert.ok(reg.includes("No task tool is switched on, so the ${esc(String(ui.tasks))} action item${Number(ui.tasks) === 1 ? ' stays' : 's stay'} in the Inbox."));
console.log('meeting-approve-card-task-tool: all checks passed');
