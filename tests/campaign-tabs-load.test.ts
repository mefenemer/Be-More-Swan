// tests/campaign-tabs-load.test.ts
// Found by testing on prod 2026-10-08, after the §9 release: things that rendered and were wrong.
//
//   1. The Campaign Assistant's Orders and Decisions tabs had NEVER loaded. assistant-records.ts
//      accepted only lead/enrichment/meeting/invoice/ticket and answered 400 to campaign_order and
//      campaign_decision — from the role's launch on 2026-08-06. The tabs rendered empty, so it read
//      as "nothing yet" for two months. The guard below is GENERIC: every record type any role's
//      dashboard asks for must be readable, so the next role cannot ship the same silent 400.
//   2. Because the Orders tab never loaded, its cells were never seen either: "Tasks" read a key the
//      mirror never wrote, and "Assigned to" showed a raw role key.
//   3. "Waiting on you — 0 pieces of work…": COUNT came back as the STRING "0", which is truthy.
//   4. The summary offered "reached 0 of 500 with 0 tasks" as a lesson worth keeping.
//
// Run:  npx tsx tests/campaign-tabs-load.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
function code(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

const records = code(read('netlify/functions/assistant-records.ts'));

/** The set literal a `const NAME = new Set([...])` declares, resolved one spread deep. */
function setFrom(src: string, name: string): Set<string> {
    const m = src.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`));
    assert.ok(m, `Could not find ${name} in assistant-records.ts.`);
    const out = new Set<string>();
    for (const part of m![1].split(',').map((x) => x.trim()).filter(Boolean)) {
        const spread = part.match(/^\.\.\.(\w+)$/);
        if (spread) setFrom(src, spread[1]).forEach((v) => out.add(v));
        else out.add(part.replace(/^['"]|['"]$/g, ''));
    }
    return out;
}

// The dashboard registry, evaluated (a plain browser IIFE) rather than regex-scraped.
const fakeWindow: { AssistantDashboardRegistry?: { REGISTRY: Record<string, Record<string, any>> } } = {};
new Function('window', read('src/components/assistant-dashboard-registry.js'))(fakeWindow);
const REGISTRY = fakeWindow.AssistantDashboardRegistry!.REGISTRY;

console.log('\n──── every tab a dashboard declares can actually load ────');

check('every record type any role\'s Data Hub or Review Queue asks for is readable', () => {
    const readable = setFrom(records, 'READ_RECORD_TYPES');
    const missing: string[] = [];
    for (const [role, cfg] of Object.entries(REGISTRY)) {
        for (const t of [cfg?.hubTab?.recordType, cfg?.reviewQueue?.kind === 'records' ? cfg.reviewQueue.recordType : null]) {
            if (typeof t === 'string' && !readable.has(t)) missing.push(`${role} → ${t}`);
        }
    }
    assert.deepStrictEqual(missing, [],
        `These tabs would 400 on every load and render empty: ${missing.join(', ')}. Add the type to READ_RECORD_TYPES.`);
});

check('the read path uses the READ set; imports still refuse the campaign mirrors', () => {
    assert.match(records, /if \(!READ_RECORD_TYPES\.has\(recordType\)\)/);
    const imports = setFrom(records, 'RECORD_TYPES');
    assert.ok(!imports.has('campaign_order') && !imports.has('campaign_decision'),
        'A CSV import of an order or decision would create a mirror with nothing real behind it.');
});

console.log('\n──── the Orders tab shows what the mirror writes ────');

check('every Orders column is a field the order mirror writes', () => {
    const cols: Array<{ key: string }> = REGISTRY.campaign_orchestrator.hubTab.columns;
    const mirror = code(read('src/utils/campaign-mirror.ts'));
    const data = mirror.slice(mirror.indexOf('const data = {'), mirror.indexOf('};', mirror.indexOf('const data = {')));
    const builtIn = new Set(['title', 'status', 'approvalStatus', 'updatedAt']);
    const unwritten = cols.map((c) => c.key).filter((k) => !builtIn.has(k) && !new RegExp(`\\b${k}:`).test(data));
    assert.deepStrictEqual(unwritten, [], `Orders columns the mirror never writes (they read "—"): ${unwritten.join(', ')}`);
});

check('"Assigned to" is a name, never a raw role key', () => {
    const mirror = code(read('src/utils/campaign-mirror.ts'));
    assert.match(mirror, /assignedTo: ASSIGNEE_NAMES\[input\.targetRoleLabel\] \?\? input\.targetRoleLabel/);
    for (const k of ['social_media_manager', 'blog_writer', 'lead_qualifier', 'newsletter_editor', 'human']) {
        assert.match(mirror, new RegExp(`${k}: '`), `No display name for ${k}.`);
    }
});

console.log('\n──── the row never claims work that is not there ────');

check('order counts are integers on the server and numbers on the client', () => {
    const api = code(read('netlify/functions/campaigns.ts'));
    assert.match(api, /inReview: sql<number>`\(COUNT\(\*\) FILTER \(WHERE \$\{campaignOrders\.status\} = 'in_review'\)\)::int`/,
        'COUNT is bigint — the driver returns it as a string, and "0" is truthy.');
    const tab = code(read('src/components/assistant-campaigns.js'));
    assert.match(tab, /inReview: Number\(raw\.inReview\) \|\| 0/);
});

check('a campaign that has done nothing offers no lesson about it', () => {
    const learning = code(read('src/utils/campaign-learning.ts'));
    assert.match(learning, /\(spend\.spentWork > 0 \|\| progress > 0\)/);
});

check('"1 task", not "1 tasks"', () => {
    const tab = code(read('src/components/assistant-campaigns.js'));
    assert.match(tab, /spec\.workItemsPerUnit === 1 \? 'task' : 'tasks'/);
});

console.log(`\n${passed} checks passed.`);
