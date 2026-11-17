// Meeting Note Taker real-account run (2026-11-17): Jira and Asana each filed one ticket then stopped, and
// Slack's real error was hidden, because an audit-log insert threw; and Slack posted to a #general that
// newer workspaces don't have. Run: npx tsx tests/handoff-logging-and-slack-channel.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { logApiCall } from '../src/utils/vault';
import { pickSlackChannel } from '../netlify/functions/sync-action';

const read = (f: string) => readFileSync(f, 'utf8');

(async () => {
    // 1. logApiCall never throws: a foreign-key miss is retried without the references; anything else is dropped.
    const inserts: Array<Record<string, unknown>> = [];
    const fkOnce = { insert: () => ({ values: async (row: Record<string, unknown>) => {
        inserts.push(row);
        if (inserts.length === 1) throw Object.assign(new Error('violates foreign key constraint'), { code: '23503' });
    } }) };
    await logApiCall(fkOnce as never, { userId: 59, integrationId: 10, endpoint: 'scenario/x', httpStatus: 502, activeScenarioId: 5 });
    assert.equal(inserts.length, 2, 'retried once');
    assert.equal(inserts[1].integrationId, null);
    assert.equal(inserts[1].endpoint, 'scenario/x', 'the line is kept');

    const down = { insert: () => ({ values: async () => { throw new Error('connection lost'); } }) };
    await logApiCall(down as never, { userId: 1, endpoint: 'e' }); // resolves, never rejects

    // 2. Nobody passes a workspace_integrations id into the system_connections-referencing column.
    const runner = read('netlify/functions/process-scenario-jobs.ts');
    const sync = read('netlify/functions/sync-action.ts');
    assert.ok(!runner.includes('integrationId: active.integrationId'), 'the recipe runner');
    assert.ok(!sync.includes('integrationId: token.integrationId'), 'the Jira/Asana ticket loop');

    // 3. Slack's default channel is the workspace's own (is_general), not a hard-coded #general.
    const channels = [
        { id: 'C1', name: 'random' },
        { id: 'C2', name: 'all-new-workspace', is_general: true },
        { id: 'C3', name: 'meeting-notes' },
    ];
    assert.equal(pickSlackChannel(channels, null), 'C2', 'a new workspace: #all-<name>');
    assert.equal(pickSlackChannel([{ id: 'G', name: 'general' }], null), 'G', 'an older workspace without the flag');
    assert.equal(pickSlackChannel(channels, 'meeting-notes'), 'C3', 'a named channel');
    assert.equal(pickSlackChannel(channels, 'nope'), null);
    assert.equal(pickSlackChannel(undefined, null), null);
    assert.ok(!sync.includes(": '#general';"), 'no hard-coded #general default');
    assert.ok(sync.includes('await resolveSlackChannelId(db, userId, accessToken, null)'));

    console.log('handoff-logging-and-slack-channel: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
