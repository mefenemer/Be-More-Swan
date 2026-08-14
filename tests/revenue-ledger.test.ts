// tests/revenue-ledger.test.ts
// Phase 0 of docs/lead-generator-revenue-engine-plan.md — the revenue ledger.
//
// The ledger's whole value is that the Phase 5 Strategy Agent can AGGREGATE it, and that only
// holds if two invariants are true:
//   1. the vocabularies are genuinely closed and identical in all THREE places they are declared
//      (src/config/revenue-events.ts, db/schema.ts, db/revenue-events.sql);
//   2. `outcome` is non-NULL on exactly the terminal events — the partial index and every win-rate
//      figure depend on it.
// Neither is enforceable by the type system across a TS/SQL boundary, so it is enforced here.
//
// No database: these are pure-function and cross-file-consistency checks, so this runs in CI
// with no connection string (matching every other file in tests/ except rls-enforcement).
// Run:  npx tsx tests/revenue-ledger.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    EVENT_TYPES, TERMINAL_EVENT_TYPES, LOSS_REASONS, ACTORS, OUTCOMES, OUTCOME_FOR_EVENT,
    isEventType, isTerminal, isLossReason, isActor, isOutcome,
} from '../src/config/revenue-events';
import { recordEvent, cycleDaysBetween } from '../src/utils/revenue-ledger';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): void | Promise<void> {
    try {
        const r = fn();
        if (r instanceof Promise) {
            return r.then(
                () => { passed++; console.log(`  ✓ ${name}`); },
                (err: Error) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; },
            );
        }
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sqlText = readFileSync(join(root, 'db/revenue-events.sql'), 'utf8');
const schemaText = readFileSync(join(root, 'db/schema.ts'), 'utf8');

// ── 1. Vocabulary integrity ──────────────────────────────────────────────────

check('every terminal event is also a member of EVENT_TYPES', () => {
    for (const t of TERMINAL_EVENT_TYPES) {
        assert.ok((EVENT_TYPES as readonly string[]).includes(t), `${t} missing from EVENT_TYPES`);
    }
});

check('OUTCOME_FOR_EVENT covers every terminal event and nothing else', () => {
    assert.deepEqual(
        Object.keys(OUTCOME_FOR_EVENT).sort(),
        [...TERMINAL_EVENT_TYPES].sort(),
        'OUTCOME_FOR_EVENT keys must be exactly the terminal events',
    );
    for (const [evt, outcome] of Object.entries(OUTCOME_FOR_EVENT)) {
        assert.ok((OUTCOMES as readonly string[]).includes(outcome), `${evt} maps to unknown outcome ${outcome}`);
    }
});

check('event types are unique (a duplicate would double-count every aggregate)', () => {
    assert.equal(new Set(EVENT_TYPES).size, EVENT_TYPES.length);
    assert.equal(new Set(LOSS_REASONS).size, LOSS_REASONS.length);
});

check('isTerminal is true for exactly the three terminal events', () => {
    for (const t of EVENT_TYPES) {
        const expected = (TERMINAL_EVENT_TYPES as readonly string[]).includes(t);
        assert.equal(isTerminal(t), expected, `isTerminal('${t}') should be ${expected}`);
    }
});

check('guards reject unknown values rather than passing them through', () => {
    assert.equal(isEventType('deal_maybe'), false);
    assert.equal(isEventType(''), false);
    assert.equal(isEventType(null), false);
    assert.equal(isLossReason('too_expensive'), false, "'too_expensive' is not the key — it is 'price'");
    assert.equal(isActor('robot'), false);
    assert.equal(isOutcome('pending'), false);
    assert.equal(isTerminal('lead_scored'), false);
});

// ── 2. The three declarations agree ──────────────────────────────────────────
// This is the test that earns its keep. A value added to the TS config but not to the SQL CHECK
// produces a constraint violation at runtime — inside a module that deliberately swallows errors,
// so the only symptom is silently missing analytics.

check('every LOSS_REASON appears in the SQL CHECK constraint', () => {
    const m = sqlText.match(/revenue_events_loss_reason_check[\s\S]*?CHECK \(loss_reason IS NULL OR loss_reason IN \(([\s\S]*?)\)\)/);
    assert.ok(m, 'could not locate the loss_reason CHECK in db/revenue-events.sql');
    const inSql = new Set([...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
    for (const r of LOSS_REASONS) {
        assert.ok(inSql.has(r), `LOSS_REASONS has '${r}' but the SQL CHECK does not — inserts using it will be rejected`);
    }
    assert.equal(inSql.size, LOSS_REASONS.length, 'SQL CHECK lists a loss reason that LOSS_REASONS does not');
});

check('every ACTOR appears in the SQL CHECK constraint', () => {
    const m = sqlText.match(/CHECK \(actor IN \(([^)]*)\)\)/);
    assert.ok(m, 'could not locate the actor CHECK in db/revenue-events.sql');
    const inSql = new Set([...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
    assert.deepEqual([...inSql].sort(), [...ACTORS].sort());
});

check('every OUTCOME appears in the SQL CHECK constraint', () => {
    const m = sqlText.match(/CHECK \(outcome IS NULL OR outcome IN \(([^)]*)\)\)/);
    assert.ok(m, 'could not locate the outcome CHECK in db/revenue-events.sql');
    const inSql = new Set([...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
    assert.deepEqual([...inSql].sort(), [...OUTCOMES].sort());
});

check('db/schema.ts check() constraints match the SQL (drizzle-kit push must not revert the DDL)', () => {
    const block = schemaText.slice(landmark(schemaText, 'export const revenueEvents'));
    for (const a of ACTORS) {
        assert.ok(block.includes(`'${a}'`), `schema.ts actor check is missing '${a}'`);
    }
    for (const o of OUTCOMES) {
        assert.ok(block.includes(`'${o}'`), `schema.ts outcome check is missing '${o}'`);
    }
    for (const r of LOSS_REASONS) {
        assert.ok(block.includes(`'${r}'`), `schema.ts loss_reason check is missing '${r}'`);
    }
});

check('the partial outcome index is declared in BOTH schema.ts and the SQL', () => {
    assert.ok(/revenue_events_outcome_idx[\s\S]*?WHERE outcome IS NOT NULL/.test(sqlText),
        'SQL is missing the partial predicate — the index would cover every row and lose its point');
    const block = schemaText.slice(landmark(schemaText, 'export const revenueEvents'));
    assert.ok(block.includes('revenue_events_outcome_idx') && block.includes('outcome IS NOT NULL'),
        'schema.ts is missing the partial predicate on revenue_events_outcome_idx');
});

check('the migration is idempotent (guarded DDL + guarded backfill)', () => {
    assert.ok(sqlText.includes('CREATE TABLE IF NOT EXISTS revenue_events'), 'table create is not guarded');
    const creates = [...sqlText.matchAll(/CREATE INDEX/g)].length;
    const guarded = [...sqlText.matchAll(/CREATE INDEX IF NOT EXISTS/g)].length;
    assert.equal(creates, guarded, 'every CREATE INDEX must be IF NOT EXISTS');
    const inserts = [...sqlText.matchAll(/INSERT INTO revenue_events/g)].length;
    const guards = [...sqlText.matchAll(/WHERE NOT EXISTS|AND NOT EXISTS/g)].length;
    assert.ok(inserts > 0, 'expected backfill INSERTs');
    assert.ok(guards >= inserts, `every backfill INSERT needs a NOT EXISTS guard (${inserts} inserts, ${guards} guards)`);
});

// ── 3. recordEvent behaviour ─────────────────────────────────────────────────
// A fake inserter captures what WOULD be written, so the invariants are checked without a DB.
// tsx compiles this file to CJS, where top-level await is unavailable — hence the async main().

type Captured = Record<string, any>;
function fakeDb(onInsert?: (v: Captured) => void) {
    return {
        insert: () => ({
            values: (v: Captured) => {
                onInsert?.(v);
                return { returning: async () => [{ id: 1 }] } as any;
            },
        }),
    } as any;
}

async function main() {
await check('derives outcome from the event type, never from the caller', async () => {
    let captured: Captured = {};
    await recordEvent(fakeDb((v) => { captured = v; }), 'deal_won', {
        organisationId: 1, lossReason: 'price', valueGbp: 1234.5, cycleDays: 12,
    });
    assert.equal(captured.outcome, 'won');
    assert.equal(captured.lossReason, 'price');
    assert.equal(captured.valueGbp, '1234.50', 'decimal must be a fixed-2 string for postgres-js');
    assert.equal(captured.cycleDays, 12);
});

await check('non-terminal events never carry outcome fields', async () => {
    let captured: Captured = {};
    await recordEvent(fakeDb((v) => { captured = v; }), 'outreach_sent', {
        organisationId: 1, lossReason: 'price', valueGbp: 99, cycleDays: 5,
    });
    assert.equal(captured.outcome, null, 'a non-terminal event must not set outcome');
    assert.equal(captured.lossReason, null, 'loss reason on a non-terminal event would corrupt "top loss reason"');
    assert.equal(captured.valueGbp, null);
    assert.equal(captured.cycleDays, null);
});

await check('an unknown event type is refused, not written', async () => {
    let wrote = false;
    const id = await recordEvent(fakeDb(() => { wrote = true; }), 'deal_probably', { organisationId: 1 });
    assert.equal(wrote, false, 'a typo\'d event must not reach the table');
    assert.equal(id, null);
});

await check('an unknown loss reason keeps the event but drops the reason', async () => {
    let captured: Captured = {};
    await recordEvent(fakeDb((v) => { captured = v; }), 'deal_lost', { organisationId: 1, lossReason: 'vibes' as any });
    assert.equal(captured.outcome, 'lost', 'the outcome still counts');
    assert.equal(captured.lossReason, null, 'but an invented key must not be stored');
});

await check('a missing organisationId is refused (a row with no tenant is unusable)', async () => {
    let wrote = false;
    const id = await recordEvent(fakeDb(() => { wrote = true; }), 'lead_scored', { organisationId: undefined as any });
    assert.equal(wrote, false);
    assert.equal(id, null);
});

await check('actor defaults to system and an invalid actor falls back rather than throwing', async () => {
    let captured: Captured = {};
    await recordEvent(fakeDb((v) => { captured = v; }), 'lead_scored', { organisationId: 1 });
    assert.equal(captured.actor, 'system');
    await recordEvent(fakeDb((v) => { captured = v; }), 'lead_scored', { organisationId: 1, actor: 'robot' as any });
    assert.equal(captured.actor, 'system', 'an invalid actor must not reach the CHECK constraint');
});

await check('NEVER THROWS — a failing insert resolves to null instead of breaking its caller', async () => {
    const exploding = {
        insert: () => ({ values: () => { throw new Error('relation "revenue_events" does not exist'); } }),
    } as any;
    const id = await recordEvent(exploding, 'lead_scored', { organisationId: 1 });
    assert.equal(id, null, 'a ledger failure must be swallowed — it is an observer, not a participant');
});

await check('NEVER THROWS — a rejected promise is swallowed too', async () => {
    const rejecting = {
        insert: () => ({ values: () => ({ returning: async () => { throw new Error('connection terminated'); } }) }),
    } as any;
    const id = await recordEvent(rejecting, 'deal_won', { organisationId: 1 });
    assert.equal(id, null);
});

await check('payload defaults to an object so the NOT NULL column is always satisfied', async () => {
    let captured: Captured = {};
    await recordEvent(fakeDb((v) => { captured = v; }), 'lead_scored', { organisationId: 1 });
    assert.deepEqual(captured.payload, {});
});

await check('occurredAt is only set when supplied, so the DB default applies otherwise', async () => {
    let captured: Captured = {};
    await recordEvent(fakeDb((v) => { captured = v; }), 'lead_scored', { organisationId: 1 });
    assert.equal('occurredAt' in captured, false, 'omitting the key lets DEFAULT now() win');
    const when = new Date('2026-01-01T00:00:00Z');
    await recordEvent(fakeDb((v) => { captured = v; }), 'lead_scored', { organisationId: 1, occurredAt: when });
    assert.equal(captured.occurredAt, when, 'a backfill must be able to state the real moment');
});

// ── 4. cycleDaysBetween ──────────────────────────────────────────────────────

check('cycleDaysBetween floors to whole days and never goes negative', () => {
    assert.equal(cycleDaysBetween('2026-01-01T00:00:00Z', '2026-01-11T00:00:00Z'), 10);
    assert.equal(cycleDaysBetween('2026-01-01T00:00:00Z', '2026-01-01T23:59:00Z'), 0);
    assert.equal(cycleDaysBetween('2026-01-11T00:00:00Z', '2026-01-01T00:00:00Z'), 0, 'clock skew must not produce a negative cycle');
    assert.equal(cycleDaysBetween('nonsense', '2026-01-01T00:00:00Z'), 0, 'an unparseable date must not yield NaN');
});

console.log(`\n${passed} checks passed.`);
}

void main();
