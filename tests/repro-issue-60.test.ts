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
const seedJson = JSON.parse(readFileSync(join(root, 'seed/data/master_assistants.json'), 'utf8')) as Array<{ roleKey: string; isActive: boolean; comingSoon: boolean }>;
const inbox = seedJson.find((r) => r.roleKey === 'inbox_manager');
assert.strictEqual(inbox?.isActive, false, 'seed JSON: Inbox Assistant not active');
assert.strictEqual(inbox?.comingSoon, false, 'seed JSON: not "Coming soon" either');

// The seed catalog writes the RETIRED columns (columnsFor('retired') in assistant-go-live.ts), not a hidden/coming-soon mix.
const catalog = readFileSync(join(root, 'db/seed-catalog.ts'), 'utf8');
const entry = catalog.slice(catalog.indexOf("roleKey: 'inbox_manager'"), catalog.indexOf("roleKey: 'calendar_coordinator'"));
assert.ok(/comingSoon: false/.test(entry) && /isActive: false/.test(entry) && /lifecycleState: 'archived'/.test(entry), 'seed catalog: retired columns');
const status = readFileSync(join(root, 'src/utils/assistant-go-live.ts'), 'utf8');
assert.ok(status.includes("case 'retired':     return { isActive: false, comingSoon: false, lifecycleState: 'archived' };"), 'the same columns the Retired status writes');

// The live row is retired through Admin ▸ Assistants (the one status path, audit-logged) — no SQL in this change.
assert.ok(!require('node:fs').existsSync(join(root, 'db/z-retire-inbox-assistant.sql')), 'no hand SQL');

const listing = readFileSync(join(root, 'netlify/functions/master-assistants.ts'), 'utf8');
assert.ok(listing.includes('.where(eq(masterAssistants.isActive, true))'), 'the Hire catalogue lists active rows only');

console.log('repro-issue-60: the Inbox Assistant leaves the catalogue ✓');
