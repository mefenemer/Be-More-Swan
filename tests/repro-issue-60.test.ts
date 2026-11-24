// tests/repro-issue-60.test.ts
// Fix pipeline #60 (owner, 2026-11-15): "The Email Assistant I believe has superseded the Inbox Assistant. Therefore we
// should remove references to the Inbox Assistant." Confirmed: the owner named the new role the Email Assistant
// (email_assistant, docs/email-assistant-plan.md), and the Inbox Assistant (inbox_manager) was only a "Coming soon" card
// in the Hire catalogue (prod master_assistants id 1, 0 hired). The catalogue (master-assistants.ts) lists rows with
// is_active = true, so the retirement is that flag; the seeds say the same so a fresh database agrees.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const seedJson = JSON.parse(readFileSync(join(root, 'seed/data/master_assistants.json'), 'utf8')) as Array<{ roleKey: string; isActive: boolean }>;
assert.strictEqual(seedJson.find((r) => r.roleKey === 'inbox_manager')?.isActive, false, 'seed JSON: Inbox Assistant inactive');

const catalog = readFileSync(join(root, 'db/seed-catalog.ts'), 'utf8');
const entry = catalog.slice(catalog.indexOf("roleKey: 'inbox_manager'"), catalog.indexOf("roleKey: 'calendar_coordinator'"));
assert.ok(/isActive: false/.test(entry), 'seed catalog: Inbox Assistant inactive');

const sql = readFileSync(join(root, 'db/z-retire-inbox-assistant.sql'), 'utf8');
assert.ok(/UPDATE master_assistants\s+SET is_active = false/.test(sql), 'the SQL switches the live row off');
assert.ok(/WHERE role_key = 'inbox_manager'/.test(sql), 'only that row');
assert.ok(/NOT EXISTS \(SELECT 1 FROM ai_assistants/.test(sql), 'never one somebody has hired');
assert.ok(!/DELETE|DROP|TRUNCATE/i.test(sql.replace(/--.*$/gm, '')), 'nothing deleted');

const listing = readFileSync(join(root, 'netlify/functions/master-assistants.ts'), 'utf8');
assert.ok(listing.includes('.where(eq(masterAssistants.isActive, true))'), 'the Hire catalogue lists active rows only');

console.log('repro-issue-60: the Inbox Assistant leaves the catalogue ✓');
