// Webhook test (staging 2026-11-18): the Note Taker's webhook sent a CRM-shaped body — the summary text, the title as
// "company", event "lead.status_changed", no action items, decisions, risks or attendees. It now sends one fixed
// meeting.approved event. Run: npx tsx tests/meeting-webhook-payload.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MEETING_WEBHOOK_RECIPE, buildMeetingWebhookPayload, buildWebhookPayload } from '../src/utils/scenario-engine';
import { RECIPE_DESCRIPTIONS } from '../src/config/recipe-settings';

const when = new Date('2026-11-18T09:30:00Z');
const subject = {
    recordType: 'meeting', recordId: 926, newStatus: 'MEETING_BOOKED',
    fields: {
        meetingTitle: 'Webhook test meeting', meetingSummary: '• Vendor A agreed.',
        decisionsMade: ['Go with vendor A'], identifiedRisks: ['Legal may be slow'],
        tasks: [{ description: 'Send the contract', assignee: 'Bo Chen', dueDate: 'Friday' }, { description: '  ' }],
        attendees: [{ name: 'Ana Lopez', email: 'ana@x.com' }, { name: 'Bo Chen', email: null }, { name: 'Cara', email: 'not-an-email' }],
        company: 'Webhook test meeting', contactEmail: undefined,
    },
};
const p = buildMeetingWebhookPayload(subject as never, when) as { event: string; meeting: Record<string, unknown> };
assert.equal(p.event, 'meeting.approved');
assert.deepEqual(p.meeting, {
    id: 926, title: 'Webhook test meeting', summary: '• Vendor A agreed.',
    decisions: ['Go with vendor A'], risks: ['Legal may be slow'],
    actionItems: [{ description: 'Send the contract', owner: 'Bo Chen', due: 'Friday' }],
    attendees: [{ name: 'Ana Lopez', email: 'ana@x.com' }, { name: 'Bo Chen', email: null }, { name: 'Cara', email: null }],
    meetingTime: null, meetingLink: null, approvedAt: '2026-11-18T09:30:00.000Z',
}, 'every part of the meeting, empty action items dropped, a bad address never sent');
// A meeting with nothing but a title still sends a complete shape.
const bare = buildMeetingWebhookPayload({ recordType: 'meeting', recordId: 1, fields: { meetingTitle: 'X', decisionsMade: 'One decision' } } as never, when) as { meeting: Record<string, unknown> };
assert.deepEqual(bare.meeting.decisions, ['One decision'], 'a single decision string becomes a list');
assert.deepEqual([bare.meeting.actionItems, bare.meeting.attendees, bare.meeting.risks], [[], [], []]);

// The lead webhook is unchanged.
assert.deepEqual(buildWebhookPayload({ recordType: 'lead', recordId: 5, newStatus: 'QUALIFIED', fields: { company: 'Acme' } } as never, { company: 'name' }),
    { event: 'lead.status_changed', status: 'QUALIFIED', recordType: 'lead', recordId: 5, data: { name: 'Acme' } });

// Wiring: the runner picks the meeting body for the meeting recipe only; the form has nothing to map; the copy says what is sent.
assert.equal(MEETING_WEBHOOK_RECIPE, 'universal_webhook_meeting');
const runner = readFileSync('netlify/functions/process-scenario-jobs.ts', 'utf8');
assert.ok(runner.includes('body: JSON.stringify(scenario.scenarioKey === MEETING_WEBHOOK_RECIPE\n                        ? buildMeetingWebhookPayload(subject, new Date())\n                        : buildWebhookPayload(subject, mappings)),'));
const api = readFileSync('netlify/functions/integration-scenarios.ts', 'utf8');
assert.ok(api.includes('...(scenario.scenarioKey === MEETING_WEBHOOK_RECIPE ? { fieldSchema: [] } : {}),'));
assert.match(RECIPE_DESCRIPTIONS.universal_webhook_meeting, /meeting\.approved/);
assert.match(RECIPE_DESCRIPTIONS.universal_webhook_meeting, /action item with its owner and due date, and the attendees/);
const sqlText = readFileSync('db/z-meeting-webhook-recipe.sql', 'utf8');
assert.match(sqlText, /SET title = 'Send Approved Meetings to a Webhook'[\s\S]*field_schema = '\[\]'::jsonb\s+WHERE scenario_key = 'universal_webhook_meeting'/);
console.log('meeting-webhook-payload: all checks passed');
