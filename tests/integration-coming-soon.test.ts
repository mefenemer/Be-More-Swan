// tests/integration-coming-soon.test.ts
// "Connects with" entries ending "(coming soon)" render as a muted Coming soon chip (2026-10-10):
// the Marketing Campaign Orchestrator announces Meta / Google / LinkedIn ads before any connector
// exists, without its card reading as something a customer can connect today.
//
// Run:  npx tsx tests/integration-coming-soon.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { ROLE_CONNECTIONS } from '../src/utils/connection-map';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const sandbox: { window: any } = { window: {} };
vm.runInNewContext(read('src/public/assistant-content.js'), sandbox);
const AC = sandbox.window.AssistantContent;

check('a "(coming soon)" entry renders muted, labelled Coming soon, without the suffix or the green dot', () => {
    const html = AC.integrationChip('Meta Ads (coming soon)');
    assert.ok(/Meta Ads<span[^>]*>Coming soon<\/span>/.test(html), html);
    assert.ok(!/\(coming soon\)/i.test(html) && !/bg-emerald-500/.test(html));
    assert.ok(AC.isComingSoonIntegration('LinkedIn Ads [Coming Soon]'));
});
check('an ordinary entry is unchanged, and every entry is escaped', () => {
    assert.ok(/bg-emerald-500[\s\S]*Canva/.test(AC.integrationChip('Canva')));
    assert.ok(AC.integrationChip('<img src=x>').includes('&lt;img src=x&gt;'));
});
check('the card, the detail modal and the role page all use the one renderer', () => {
    for (const f of ['assistants.html', 'assistant-role-detail.html', 'src/components/assistant-detail-modal.js']) {
        assert.ok(/AssistantContent\.integrationChip\(app\)/.test(read(f)), f);
    }
});
check('nothing is connectable yet: the orchestrator\'s connection policy stays empty', () => {
    assert.deepStrictEqual(ROLE_CONNECTIONS.campaign_orchestrator, []);
});
check('the data migration only fills an EMPTY list, so an admin edit is never overwritten', () => {
    const sql = read('db/z-campaign-paid-ads-coming-soon.sql');
    assert.ok(/WHERE role_key = 'campaign_orchestrator'\s+AND \(integrations IS NULL OR integrations = '\[\]'::jsonb\)/.test(sql));
    for (const n of ['Meta Ads (coming soon)', 'Google Ads (coming soon)', 'LinkedIn Ads (coming soon)']) assert.ok(sql.includes(n), n);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — with FAILURES above' : ''}`);
