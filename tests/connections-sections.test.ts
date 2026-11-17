// Connections PR 2 (owner, 2026-11-17): the Connections tab in collapsible sections by PURPOSE, each tool
// with its actions underneath, and "recipe" renamed to "action". Run: npx tsx tests/connections-sections.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f: string) => readFileSync(f, 'utf8');
const int = read('integrations.js');

// 1. The sections, in purpose order, with a short line and a "read more" paragraph each.
const sectionsSrc = int.slice(int.indexOf('const CONN_SECTIONS = ['), int.indexOf('// Card for a supported tool category that has no live connector yet.'));
for (const t of ['Social accounts', 'Send emails', 'Create tasks', 'Post to team chat', 'Save notes and documents', 'Update your CRM', 'Send to another app']) {
    assert.ok(sectionsSrc.includes(`title: '${t}'`), `section "${t}"`);
}
assert.ok(sectionsSrc.indexOf("cat: 'email'") < sectionsSrc.indexOf("cat: 'project_mgmt'") && sectionsSrc.indexOf("cat: 'project_mgmt'") < sectionsSrc.indexOf("cat: 'chat'"));
assert.match(sectionsSrc, /Choose ONE task tool — Jira or Asana/);
assert.match(sectionsSrc, /cat: 'generic', title: 'Send to another app'/, 'the webhook action has its own section, not "More tools"');

// 2. Run _connSections as written.
const ctx: Record<string, unknown> = {
    _esc: (v: unknown) => String(v ?? '').replace(/</g, '&lt;'),
    _rowPill: (label: string) => `<span>${label}</span>`,
};
vm.runInNewContext(`${sectionsSrc}; result = _connSections(rows, groups);`, Object.assign(ctx, {
    rows: [
        { cat: 'calendar', html: '<div>Calendar soon</div>', on: false, soon: true, title: 'Calendar' },
        { cat: 'email', html: '<div data-conn-row="gmail">Gmail</div>', on: true },
        { cat: 'email', html: '<div data-conn-row="outlook">Outlook</div>', on: false },
    ],
    groups: {
        email: { html: '<div data-tool-block="email">Follow-up action</div>', on: 1, connected: 0 },
        project_mgmt: { html: '<div data-tool-block="jira">Jira + actions</div>', on: 0, connected: 1 },
        chat: { html: '<div data-tool-block="slack">Slack</div>', on: 0, connected: 0 },
    },
}));
const html = String(ctx.result);
const order = [...html.matchAll(/data-conn-section="([a-z_]+)"/g)].map((m) => m[1]);
assert.deepEqual(order, ['email', 'project_mgmt', 'chat', 'calendar'], 'purpose order; "coming soon" only last');
const section = (cat: string) => html.slice(html.indexOf(`data-conn-section="${cat}"`), html.indexOf('</details>', html.indexOf(`data-conn-section="${cat}"`)));
assert.match(section('email'), /" open>/, 'something on → open');
assert.match(section('email'), /✓ 2 on/, 'Gmail connected + the follow-up action on');
assert.ok(section('email').indexOf('data-conn-row="gmail"') < section('email').indexOf('data-tool-block="email"'), 'the tools first, then the actions');
assert.match(section('project_mgmt'), /" open>/, 'connected → open');
assert.match(section('project_mgmt'), />Connected</);
assert.doesNotMatch(section('chat'), /" open>/, 'nothing set up → closed, to read before deciding');
assert.match(section('chat'), /Not set up/);
assert.match(section('calendar'), /Coming soon/);
assert.match(section('chat'), /Connect Slack and approved meeting summaries/, 'the read-more paragraph is inside');

// 3. The assistant panel draws sections (the standalone Integrations page keeps its tiles).
assert.ok(int.includes('const sectionsHtml = _connSections(rows, groups);'));
assert.ok(int.includes("if (_assistantScoped) {\n        const groups = window._syncedActionGroups || {};"));

// 4. Each tool, then its actions — drawn by assistant-integrations.js for the sections.
const ai = read('src/components/assistant-integrations.js');
assert.ok(ai.includes('function toolBlock(list)') && ai.includes('function actionRow(s, connected)') && ai.includes('function buildGroups(list)'));
assert.ok(ai.includes('">Actions</p>'), 'an "Actions" label under each tool');
assert.ok(ai.includes('window._syncedActionGroups = buildGroups(list);'));
assert.ok(ai.includes("if (!e.target.closest('[data-ai-actions]') && !(host() && host().contains(e.target))) return;"), 'buttons work inside the sections');
assert.ok(!ai.includes('function card(s)'), 'the old one-row list is gone');

// 5. "Recipe" → "action" in what people read.
for (const gone of ['Recipe enabled.', 'Enable recipe', 'Remove this recipe?', 'Couldn’t load synced actions.', 'no fields to map']) {
    assert.ok(!ai.includes(gone), `assistant tab still says "${gone}"`);
}
const hub = read('integrations.html');
assert.ok(hub.includes('font-extrabold text-gray-900">Actions</h2>') && !hub.includes('>Integration Scenarios</h2>'));
assert.ok(!hub.includes('Enable scenario') && !hub.includes('Remove this scenario?'));
const detail = read('assistant-detail.html');
assert.ok(detail.includes('<h3 class="text-lg font-bold text-gray-900">Connections</h3>') && !detail.includes('>Synced actions</h3>'));
assert.ok(read('input.css').includes('details[data-conn-section] > summary::-webkit-details-marker { display: none; }'));

console.log('connections-sections: all checks passed');
