// tests/mentor-data-inventory.test.ts
// What the Business Mentor may read (docs/business-mentor-plan.md §12.4), and its workspace snapshot.
//
// The inventory must list every table with an organisation column, every `never` must say why, and
// every `always` must really be read by the snapshot or by a block every chat gets — so the "What I can
// see" panel can't promise more (or less) than the code does.
//
// Run:  npx tsx tests/mentor-data-inventory.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MENTOR_DATA_INVENTORY } from '../src/config/mentor-data-inventory';
import { businessGaps, describeState, renderMentorSnapshot, startingPoint, teamState, type MentorSnapshotData } from '../src/utils/mentor-snapshot';

let passed = 0, total = 0;
function test(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}

const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
const schema = read('db/schema.ts');

// table name → drizzle export name, for every table with an organisation column.
const orgTables = new Map<string, string>();
const parts = schema.split(/export const (\w+) = pgTable\(\s*"([a-z_0-9]+)"/);
for (let i = 1; i < parts.length; i += 3) {
    const body = parts[i + 2].split('export const ')[0];
    if (/organisation_id|organization_id/.test(body)) orgTables.set(parts[i + 1], parts[i]);
}

// The code behind each `always`: the Mentor's own snapshot and the blocks every chat route gets.
const ALWAYS_READERS = [
    'src/utils/mentor-snapshot.ts',
    'src/utils/business-knowledge.ts',
    'src/utils/team-activity.ts',
    'src/utils/chat-plan-snapshot.ts',
    'src/utils/task-balance.ts',
    'src/utils/org-products.ts',
    'src/utils/mentor-proposals.ts',
    'src/utils/strategy-documents.ts',
    // Phase 3: its own reviews, commitments and track record (the snapshot reads them through these).
    'src/utils/mentor-review.ts',
    'src/utils/mentor-commitments.ts',
    'src/utils/mentor-outcomes.ts',
].filter((f) => { try { read(f); return true; } catch { return false; } }).map((f) => [f, read(f)] as const);

const base: MentorSnapshotData = {
    business: { description: 'Dog grooming in Leeds', industry: 'Pets', website: 'https://example.test' },
    products: [{ name: 'Full groom', hasPrice: true }], productCount: 1,
    offerKinds: ['services'], introOfferAnswered: true,
    team: [{ id: 2, name: 'Sam', role: 'Social Media Assistant', state: 'active' }],
    goals: [{ assistant: 'Sam', label: 'Followers', latest: null, target: 500, targetDate: new Date('2026-12-31'), status: 'at_risk' }],
    plan: { status: 'active', freeSlots: 10 },
};

console.log('mentor data inventory');

test('every table with an organisation column is classified', () => {
    const missing = [...orgTables.keys()].filter((t) => !MENTOR_DATA_INVENTORY[t]);
    assert.deepStrictEqual(missing, [], 'Classify these in src/config/mentor-data-inventory.ts');
});

test('the inventory names no table that does not exist', () => {
    const allTables = new Set([...schema.matchAll(/pgTable\(\s*"([a-z_0-9]+)"/g)].map((m) => m[1]));
    const stale = Object.keys(MENTOR_DATA_INVENTORY).filter((t) => !allTables.has(t));
    assert.deepStrictEqual(stale, []);
});

test('every entry says why', () => {
    const silent = Object.entries(MENTOR_DATA_INVENTORY).filter(([, e]) => e.reason.trim().length < 10).map(([t]) => t);
    assert.deepStrictEqual(silent, []);
});

test('every `always` table is really read by the snapshot or a block every chat gets', () => {
    const unread = Object.entries(MENTOR_DATA_INVENTORY)
        .filter(([, e]) => e.access === 'always')
        .map(([t]) => t)
        .filter((t) => {
            const varName = orgTables.get(t) ?? [...schema.matchAll(new RegExp(`export const (\\w+) = pgTable\\(\\s*"${t}"`, 'g'))][0]?.[1];
            return !varName || !ALWAYS_READERS.some(([, src]) => new RegExp(`\\b${varName}\\b`).test(src));
        });
    assert.deepStrictEqual(unread, [], 'Marked always but no reader found — mark on_request, or read it');
});

test('the snapshot reads only tables marked `always` (or the org, assistant catalogue and plan catalogue rows)', () => {
    const src = read('src/utils/mentor-snapshot.ts');
    const imported = (src.match(/import \{([^}]+)\} from '..\/..\/db\/schema'/)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const byVar = new Map([...schema.matchAll(/export const (\w+) = pgTable\(\s*"([a-z_0-9]+)"/g)].map((m) => [m[1], m[2]]));
    const notAllowed = imported.map((v) => byVar.get(v)!).filter((t) => t && !['organisations', 'master_assistants', 'master_plans'].includes(t) && MENTOR_DATA_INVENTORY[t]?.access !== 'always');
    assert.deepStrictEqual(notAllowed, []);
});

test('secrets, contacts\' details and other chats are never readable', () => {
    for (const t of ['vault_secrets', 'api_keys', 'system_connections', 'audience_contacts', 'lead_messages', 'login_events']) {
        assert.strictEqual(MENTOR_DATA_INVENTORY[t]?.access, 'never', t);
    }
    assert.match(MENTOR_DATA_INVENTORY.chat_sessions.reason, /never other assistants/);
});

test('team states say why an assistant is paused', () => {
    assert.strictEqual(teamState('working', 'complete'), 'active');
    assert.strictEqual(teamState('paused', 'complete'), 'paused_by_user');
    assert.strictEqual(teamState('system_paused', 'paused_quota'), 'paused_task_cap');
    assert.strictEqual(teamState('system_paused', 'paused_payment'), 'paused_payment');
    assert.strictEqual(teamState('paused', 'paused_limit'), 'paused_plan_limit');
    assert.strictEqual(teamState('ready_for_work', 'complete'), 'setting_up');
    assert.strictEqual(teamState('archived', 'complete'), 'archived');
});

test('starting point: established needs a description and a hired team (paused counts) or products', () => {
    assert.strictEqual(startingPoint(base), 'established');
    assert.strictEqual(startingPoint({ ...base, business: { ...base.business, description: '' } }), 'new');
    assert.strictEqual(startingPoint({ ...base, team: [], productCount: 0, products: [] }), 'new');
    assert.strictEqual(startingPoint({ ...base, team: [], productCount: 1 }), 'established');
    // A paused team still counts; an archived-only one doesn't.
    assert.strictEqual(startingPoint({ ...base, productCount: 0, products: [], team: [{ id: 3, name: 'Felix', role: 'Social Media Assistant', state: 'paused_payment' }] }), 'established');
    assert.strictEqual(startingPoint({ ...base, productCount: 0, products: [], team: [{ id: 3, name: 'Misty', role: 'Social Media Assistant', state: 'archived' }] }), 'new');
});

test('gaps come out in order, and a filled-in workspace has none', () => {
    assert.deepStrictEqual(businessGaps(base), []);
    const g = businessGaps({ ...base, business: { description: null, industry: null, website: null }, products: [], productCount: 0, offerKinds: null, introOfferAnswered: false });
    assert.match(g[0], /Business description is empty/);
    assert.match(g[1], /Products & Services is empty/);
    assert.strictEqual(g.length, 6);
    assert.match(businessGaps({ ...base, products: [{ name: 'X', hasPrice: false }] })[0], /No product or service has a price/);
});

test('the block never turns an unmeasured goal into 0, and says when it is the only assistant', () => {
    const block = renderMentorSnapshot(base);
    assert.match(block, /not measured yet \(unknown — never treat as 0\)/);
    assert.match(block, /Sam \(Social Media Assistant\): active/);
    const alone = renderMentorSnapshot({ ...base, team: [] });
    assert.match(alone, /You are the only assistant here\. Never propose changes to, or hand work to, an assistant/);
    const paused = renderMentorSnapshot({ ...base, team: [{ id: 2, name: 'Sam', role: 'Social Media Assistant', state: 'paused_task_cap' }] });
    assert.match(paused, /monthly task allowance ran out/);
    assert.match(paused, /None of them is active right now/);
});

test('a pause marker the live plan contradicts is called out of date, never a reason to buy', () => {
    // Staging 2026-10-25: Felix "paused for plan slots" on an active plan with 10 free slots.
    assert.match(describeState('paused_plan_limit', { status: 'active', freeSlots: 10 }), /looks out of date\. Never advise upgrading/);
    assert.match(describeState('paused_plan_limit', { status: 'active', freeSlots: 0 }), /fewer assistant slots than assistants/);
    assert.match(describeState('paused_plan_limit', { status: null, freeSlots: null }), /fewer assistant slots than assistants/);
    assert.match(describeState('paused_payment', { status: 'active', freeSlots: 10 }), /looks out of date\. Never tell them to fix billing/);
    assert.match(describeState('paused_payment', { status: 'past_due', freeSlots: 10 }), /My Account ▸ Billing & Subscription/);
});

test('the Mentor chat route reads the snapshot every turn', () => {
    const src = read('netlify/functions/chat-orchestrator.ts');
    const route = src.slice(src.indexOf('    business_mentor: {'), src.indexOf('    // Tier 1, Batch 1 — Lead Generator.'));
    assert.ok(route.length > 0 && route.includes('usesMentorSnapshot: true') && route.includes('rc.mentorSnapshot'));
    assert.match(src, /route\.usesMentorSnapshot\s*\n?\s*\? await buildMentorSnapshotParts\(db, orgId, userId, \{ withCustomers: asksAboutCustomers\(typed\) \}\)/);
});

test('provisioning is flag-gated, one per workspace, and never runs under impersonation', () => {
    const prov = read('src/utils/mentor-provision.ts');
    assert.match(prov, /isFeatureEnabled\(orgId, MENTOR_FLAG\)/);
    assert.match(prov, /const existing = await findMentor\(db, orgId\);\s*\n\s*if \(existing\) return/);
    assert.match(prov, /configuration: \{ type: MENTOR_ROLE_KEY/);
    assert.match(read('netlify/functions/get-assistants.ts'), /if \(!ctx\.impersonation\) await ensureMentor\(db, orgId, userId\);/);
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
