// tests/repro-issue-69.test.ts
// Fix pipeline #69 (owner, 2026-11-16): the Note Taker's set-up step 5, "Where should action items go?", listed three
// tools (Notion, Jira, Asana); the owner wants two choices: "In Be More Swan" and "In an external system". Which external
// tool is the connection switched on in Connections, not a set-up answer.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { actionItemsStayInBeMoreSwan, buildMeetingMinutesPrompt, meetingDestinationLabel } from '../src/utils/meeting-minutes';

// The real form schema.
const src = readFileSync(join(__dirname, '..', 'src/public/assistant-onboarding-schemas.js'), 'utf8');
const ctx: any = { window: {}, console };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const schemas = ctx.window.AssistantOnboardingSchemas || ctx.window.ASSISTANT_ONBOARDING_SCHEMAS || ctx.window.onboardingSchemas;
const flat = JSON.stringify(schemas ?? {});
const m = /"key":"taskDestination".*?"options":(\[.*?\])/.exec(flat);
assert.ok(m, 'the taskDestination question is in the schema');
const options = JSON.parse(m![1]) as Array<{ value: string; label: string }>;
assert.deepStrictEqual(options.map((o) => [o.value, o.label]), [['be_more_swan', 'In Be More Swan'], ['external', 'In an external system']]);

// What the Note Taker is told.
assert.ok(actionItemsStayInBeMoreSwan('be_more_swan'));
assert.ok(!actionItemsStayInBeMoreSwan('external') && !actionItemsStayInBeMoreSwan('jira'), 'a named tool is external');
const inApp = buildMeetingMinutesPrompt({ meetingPlatform: 'zoom', taskDestination: 'be_more_swan', summaryFormat: 'executive_bullets', channelBlock: '' });
assert.ok(inApp.includes('action items stay in the Meeting Notes tab'), 'in Be More Swan: they stay in Meeting Notes');
const ext = buildMeetingMinutesPrompt({ meetingPlatform: 'zoom', taskDestination: 'external', summaryFormat: 'executive_bullets', channelBlock: '' });
assert.ok(ext.includes('your connected task tool') && ext.includes('Asana, Jira or Notion connection switched on'), 'external: the switched-on tool');

// Answers saved before this change still read sensibly.
assert.strictEqual(meetingDestinationLabel('jira'), 'Jira');
assert.strictEqual(meetingDestinationLabel('notion'), 'Notion');

console.log('repro-issue-69: two choices for where action items go ✓');
