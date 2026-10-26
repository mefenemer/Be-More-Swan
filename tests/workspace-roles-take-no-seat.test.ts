// tests/workspace-roles-take-no-seat.test.ts
// The Business Mentor is included on every plan and never takes a plan seat
// (docs/business-mentor-plan.md §2.3). The assistant limit is counted in several places, and one that
// forgets the exclusion either refuses a customer's hire ("you've used all your slots" when they've
// hired nothing) or, worse, pauses the Mentor on a downgrade (stripe-webhook.ts pauses the oldest).
//
// Run:  npx tsx tests/workspace-roles-take-no-seat.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { WORKSPACE_ROLE_KEYS, checkRoleSwap, isWorkspaceRole, takesASeat } from '../src/utils/assistant-capacity';

let passed = 0, total = 0;
async function test(name: string, fn: () => void | Promise<void>) {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}

const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

// Every place that counts or picks assistants against the plan's assistant limit.
const SEAT_COUNTS: Array<{ file: string; why: string }> = [
    { file: 'src/utils/assistant-capacity.ts', why: 'hire and resume gates (hire-assistant.ts, onboarding.ts, kickoff)' },
    { file: 'netlify/functions/check-capacity.ts', why: 'the client gate and the "N of M assistants" figure' },
    { file: 'netlify/functions/manage-assistant.ts', why: 'legacy resume gate' },
    { file: 'netlify/functions/stripe-webhook.ts', why: 'downgrade pauses the excess, oldest first' },
    { file: 'src/utils/plan-moves.ts', why: 'how many a bulk plan move will pause' },
    { file: 'src/utils/release-paused-limit.ts', why: 'how many paused assistants can come back' },
    { file: 'src/utils/beta-ending.ts', why: 'whether a beta workspace fits a paid plan' },
    { file: 'src/utils/mentor-snapshot.ts', why: 'free slots, to tell whether a "paused for plan slots" marker is out of date' },
];

// Files that list assistants by lifecycle state for reasons other than the plan limit.
const NOT_SEAT_COUNTS = new Set([
    'netlify/functions/assistant-command.ts', // command bar roster: every assistant, Mentor included
    'src/utils/site-audit-schedule.ts',       // which Mystery Shoppers are due an audit
]);

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(path.join(root, dir))) {
        const rel = path.join(dir, name);
        if (statSync(path.join(root, rel)).isDirectory()) walk(rel, out);
        else if (rel.endsWith('.ts')) out.push(rel);
    }
    return out;
}

(async () => {
    console.log('workspace roles take no seat');

    await test('the Business Mentor is the workspace role', () => {
        assert.deepStrictEqual([...WORKSPACE_ROLE_KEYS], ['business_mentor']);
        assert.strictEqual(isWorkspaceRole('business_mentor'), true);
        assert.strictEqual(isWorkspaceRole('social_media_manager'), false);
        assert.strictEqual(isWorkspaceRole(null), false);
        assert.strictEqual(isWorkspaceRole(''), false);
    });

    await test('takesASeat() excludes workspace roles by configuration.type, and keeps rows with no type', () => {
        const q = new PgDialect().sqlToQuery(takesASeat());
        assert.match(q.sql, /coalesce\("ai_assistants"\."configuration" ->> 'type', ''\) NOT IN \(\$1\)/);
        assert.deepStrictEqual(q.params, ['business_mentor']);
    });

    await test('bringing in the Mentor is never a role switch (decided before any database read)', async () => {
        // A null db throws on first use, so this proves the short-circuit.
        assert.strictEqual(await checkRoleSwap(null as any, 1, 1, 'business_mentor'), null);
    });

    for (const { file, why } of SEAT_COUNTS) {
        await test(`${file} counts with takesASeat() — ${why}`, () => {
            assert.ok(/takesASeat\(\)/.test(read(file)), `${file} counts assistants against the plan limit without takesASeat()`);
        });
    }

    await test('no other file counts assistants by seat-occupying state without being listed here', () => {
        const seatPattern = /'provisioning',\s*'ready_for_work',\s*'working'\]|SEAT_OCCUPYING_STATUSES\]/;
        const listed = new Set(SEAT_COUNTS.map((s) => s.file));
        const strays = [...walk('netlify/functions'), ...walk('src')]
            .filter((f) => !listed.has(f) && !NOT_SEAT_COUNTS.has(f))
            .filter((f) => seatPattern.test(read(f)));
        assert.deepStrictEqual(strays, [], `New seat count(s): add takesASeat() and list the file in SEAT_COUNTS, or add it to NOT_SEAT_COUNTS with a reason`);
    });

    console.log(`\n${passed}/${total} passed`);
    if (passed !== total) process.exit(1);
})();
