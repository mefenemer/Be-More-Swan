// tests/strategy-proposals.test.ts
// Phase 5a of docs/lead-generator-revenue-engine-plan.md §7 — the Strategy Agent's proposal store.
//
// Two invariants, neither enforceable by the type system:
//
//   1. THE VOCABULARIES ARE CLOSED AND IDENTICAL in all THREE places they are declared
//      (src/config/strategy-proposals.ts, db/schema.ts check(), db/strategy-proposals.sql). A value
//      added in one place only becomes a constraint violation inside a module that swallows errors
//      — i.e. invisible. Same discipline as tests/revenue-ledger.test.ts, for the same reason.
//
//   2. THE CHANGE ENVELOPE HOLDS. `targetField` is a key lookup against a frozen map, never a free
//      string from the model, and the "never" list (deal guardrails, autonomy, suppression, spend)
//      must not be reachable through it. A prompt instruction not to touch guardrails is a
//      suggestion; this test is what makes it a rule.
//
// No database: pure-function and cross-file-consistency checks, so this runs in CI with no
// connection string, matching every other file in tests/ except rls-enforcement.
// Run:  npx tsx tests/strategy-proposals.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import {
    PROPOSAL_SOURCES, PROPOSAL_STATUSES, REJECT_REASONS, REJECT_REASON_LABELS,
    REJECT_REASON_EFFECTS, REJECT_REASONS_FED_TO_MODEL, STRATEGY_TUNABLE_FIELDS,
    STRATEGY_FORBIDDEN_FIELDS, STRATEGY_AGENT_FEATURE, STRATEGY_AGENT_ASSISTANT_KEY,
    MIN_SAMPLE, PROPOSAL_EXPIRY_DAYS,
    isProposalSource, isProposalStatus, isRejectReason, isStrategyAgentEnabledForAssistant,
    isValidValueFor, tunableField,
} from '../src/config/strategy-proposals';

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
/**
 * The SQL that defines this table's constraints — the original file plus every later migration that
 * widens one of them, in apply order.
 *
 * ⚠️ A superseding migration is a SEPARATE FILE on purpose. db-migrate.mjs tracks each db/*.sql by
 * content hash, so editing an already-applied file reports DRIFTED against both live databases
 * rather than being a tidy-up. Constraint history therefore accumulates across files, and anything
 * reading "the constraint" has to read the last definition, not the first.
 */
const SQL_FILES = [
    'db/strategy-proposals.sql',
    'db/strategy-proposal-source-lead-rejection.sql',
] as const;
const sqlText = SQL_FILES.map((f) => readFileSync(join(root, f), 'utf8')).join('\n');
const schemaText = readFileSync(join(root, 'db/schema.ts'), 'utf8');

/**
 * Blank out comments, preserving length and newlines so offsets stay exact.
 *
 * The source scans below assert on what the code DOES. Both of these modules explain their design
 * in prose — including naming the very things they must not call, so the next reader knows the
 * omission was a decision rather than an oversight. Scanning raw text turns those explanations into
 * failures and creates pressure to delete the most valuable comments in the file.
 */
function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** Code only — see stripComments. */
const sourceOf = (rel: string) => stripComments(readFileSync(join(root, rel), 'utf8'));

/** The schema.ts block for strategyProposals only, so a match cannot come from another table. */
const schemaBlock = (() => {
    const start = schemaText.indexOf('export const strategyProposals');
    assert.ok(start !== -1, 'strategyProposals is missing from db/schema.ts');
    const end = schemaText.indexOf('\nexport const ', start + 1);
    return schemaText.slice(start, end === -1 ? undefined : end);
})();

// ── 1. Vocabulary integrity ──────────────────────────────────────────────────

check('every REJECT_REASON has a label and a stated effect', () => {
    // The effect is what makes choosing a reason something other than arbitrary — the UI shows it.
    for (const r of REJECT_REASONS) {
        assert.ok(REJECT_REASON_LABELS[r], `no label for ${r}`);
        assert.ok(REJECT_REASON_EFFECTS[r], `no effect for ${r}`);
    }
    assert.equal(Object.keys(REJECT_REASON_LABELS).length, REJECT_REASONS.length, 'a label exists for a reason that does not');
    assert.equal(Object.keys(REJECT_REASON_EFFECTS).length, REJECT_REASONS.length, 'an effect exists for a reason that does not');
});

check('the vocabularies contain no duplicates', () => {
    for (const [name, list] of [
        ['REJECT_REASONS', REJECT_REASONS],
        ['PROPOSAL_SOURCES', PROPOSAL_SOURCES],
        ['PROPOSAL_STATUSES', PROPOSAL_STATUSES],
    ] as const) {
        assert.equal(new Set(list).size, list.length, `${name} has a duplicate`);
    }
});

check('`other` is excluded from the rejections fed back to the model', () => {
    // Its note is unstructured text, and one org's idiosyncratic phrasing in a prompt is poison
    // rather than signal (§7.1). It is still stored and still shown to humans.
    assert.ok(!REJECT_REASONS_FED_TO_MODEL.includes('other' as never), '`other` must never reach the prompt');
    assert.equal(REJECT_REASONS_FED_TO_MODEL.length, REJECT_REASONS.length - 1);
});

check('guards reject unknown values rather than passing them through', () => {
    assert.equal(isRejectReason('off_brand'), true);
    assert.equal(isRejectReason('vibes'), false);
    assert.equal(isRejectReason(null), false);
    assert.equal(isProposalSource('edit_pattern'), true);
    assert.equal(isProposalSource('win-loss'), false, 'a near-miss spelling must not pass');
    assert.equal(isProposalStatus('pending'), true);
    assert.equal(isProposalStatus('Pending'), false, 'the CHECK is case-sensitive; so is this');
});

// ── 2. Three-way sync: config ↔ SQL ↔ schema.ts ──────────────────────────────

check('every REJECT_REASON appears in the SQL CHECK and in schema.ts', () => {
    for (const r of REJECT_REASONS) {
        assert.ok(sqlText.includes(`'${r}'`), `${r} missing from db/strategy-proposals.sql`);
        assert.ok(schemaBlock.includes(`'${r}'`), `${r} missing from db/schema.ts`);
    }
});

check('every PROPOSAL_SOURCE appears in the SQL CHECK and in schema.ts', () => {
    // 'human' in particular: §5.4 routes a human "save as default" through the SAME apply path, so
    // the constraint has to permit it from the start rather than being migrated later.
    for (const s of PROPOSAL_SOURCES) {
        assert.ok(sqlText.includes(`'${s}'`), `${s} missing from db/strategy-proposals.sql`);
        assert.ok(schemaBlock.includes(`'${s}'`), `${s} missing from db/schema.ts`);
    }
});

check('every PROPOSAL_STATUS appears in the SQL CHECK and in schema.ts', () => {
    for (const s of PROPOSAL_STATUSES) {
        assert.ok(sqlText.includes(`'${s}'`), `${s} missing from db/strategy-proposals.sql`);
        assert.ok(schemaBlock.includes(`'${s}'`), `${s} missing from db/schema.ts`);
    }
});

check('the SQL CHECKs contain nothing the config does not', () => {
    // The reverse direction. A value in the constraint but not the config is a value the writer can
    // never produce and no reader knows how to label — dead, and misleading to the next reader.
    // The LAST definition wins: a widening migration supersedes the original, and asserting against
    // the first would test a constraint no live database still has.
    const constraintValues = (constraint: string): string[] => {
        const all = [...sqlText.matchAll(new RegExp(`${constraint}[\\s\\S]*?CHECK\\s*\\(([\\s\\S]*?)\\);`, 'g'))];
        const m = all[all.length - 1];
        if (!m) return [];
        return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    };
    for (const [constraint, allowed] of [
        ['strategy_proposals_status_check', PROPOSAL_STATUSES],
        ['strategy_proposals_source_check', PROPOSAL_SOURCES],
        ['strategy_proposals_reject_reason_check', REJECT_REASONS],
    ] as const) {
        const found = constraintValues(constraint);
        assert.ok(found.length > 0, `could not parse ${constraint} out of the SQL`);
        for (const v of found) {
            assert.ok((allowed as readonly string[]).includes(v), `${constraint} permits "${v}", which the config does not define`);
        }
    }
});

check('the partial unique index is declared in BOTH the SQL and schema.ts', () => {
    // ⚠️ Load-bearing: without it a confident field accumulates a pending proposal every week, each
    // with a previousValue snapshotted against a different world, and applying the oldest LAST
    // silently reverts the others. Declared in schema.ts too, or drizzle-kit push drops it.
    assert.ok(sqlText.includes('strategy_proposals_pending_field_uidx'), 'missing from the SQL');
    assert.ok(sqlText.includes("WHERE status = 'pending'"), 'the SQL index is not partial');
    assert.ok(schemaBlock.includes('strategy_proposals_pending_field_uidx'), 'missing from schema.ts');
    assert.ok(schemaBlock.includes("status = 'pending'"), 'the schema.ts index is not partial');
});

check('every CHECK in the SQL is mirrored in schema.ts', () => {
    // Otherwise a later `drizzle-kit push` silently reverts the constraint the migration added.
    const inSql = [...sqlText.matchAll(/CONSTRAINT (strategy_proposals_\w+_check)/g)].map((m) => m[1]);
    assert.ok(inSql.length >= 5, `expected ≥5 named constraints, parsed ${inSql.length}`);
    for (const name of new Set(inSql)) {
        assert.ok(schemaBlock.includes(name), `${name} is in the SQL but not in db/schema.ts`);
    }
});

check('the migration is idempotent (guarded DDL throughout)', () => {
    assert.ok(sqlText.includes('CREATE TABLE IF NOT EXISTS strategy_proposals'), 'table creation is not guarded');
    // Constraints must be added under an existence guard, not by CREATE TABLE alone: re-running
    // against an existing table would otherwise skip a constraint that is genuinely missing.
    assert.ok(/pg_constraint WHERE conname = 'strategy_proposals_status_check'/.test(sqlText), 'constraints are not guarded');
    for (const m of sqlText.matchAll(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/g)) {
        assert.fail(`unguarded index creation at offset ${m.index}`);
    }
});

// ── 3. The change envelope (§7.3, §5.1) ──────────────────────────────────────

check('the allow-list and the never-list are disjoint', () => {
    for (const forbidden of Object.keys(STRATEGY_FORBIDDEN_FIELDS)) {
        assert.ok(
            !Object.prototype.hasOwnProperty.call(STRATEGY_TUNABLE_FIELDS, forbidden),
            `${forbidden} is on BOTH lists — an agent must never widen its own financial or safety envelope`,
        );
    }
});

check('the never-list names deal_guardrails even though the table does not exist yet', () => {
    // §5.1: an allow-list protects by omission, which is a protection nobody can see. This entry is
    // what a reviewer of the Phase 4 PR will actually find when they add the guardrails table.
    assert.ok(STRATEGY_FORBIDDEN_FIELDS.deal_guardrails, 'Phase 4 could ship a table the agent is silently permitted to write');
    for (const key of ['autonomy_level', 'suppression_list', 'spend_guardrails']) {
        assert.ok(STRATEGY_FORBIDDEN_FIELDS[key], `${key} must be named explicitly`);
    }
});

check('tunableField rejects anything not on the allow-list — reject, never clamp', () => {
    assert.ok(tunableField('outreach_playbook'), 'a legitimate field must resolve');
    for (const bad of Object.keys(STRATEGY_FORBIDDEN_FIELDS)) {
        assert.equal(tunableField(bad), null, `${bad} must not resolve`);
    }
    assert.equal(tunableField('anything_else'), null);
    assert.equal(tunableField(''), null);
    assert.equal(tunableField(null), null);
    assert.equal(tunableField(42), null);
});

check('tunableField cannot be tricked through the prototype chain', () => {
    // A plain `MAP[field]` lookup returns Object.prototype members for these, so a model emitting
    // "constructor" would resolve to a function and sail past a truthiness check.
    for (const proto of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
        assert.equal(tunableField(proto), null, `${proto} must not resolve to a field`);
    }
});

check('every tunable field declares a coherent target', () => {
    for (const [key, f] of Object.entries(STRATEGY_TUNABLE_FIELDS)) {
        assert.ok(f.label, `${key} has no label`);
        assert.ok(f.description, `${key} has no description — the review screen shows it under the diff`);
        assert.ok(['onboarding', 'campaign'].includes(f.store), `${key} has an unknown store "${f.store}"`);
        assert.ok(['text', 'json'].includes(f.valueType), `${key} has an unknown valueType "${f.valueType}"`);
        assert.ok(f.key, `${key} has no target key`);
    }
});

check('the campaign store only targets columns that exist on discovery_campaigns', () => {
    // The apply path writes these by name; a typo here is a runtime failure on a user's click.
    for (const [key, f] of Object.entries(STRATEGY_TUNABLE_FIELDS)) {
        if (f.store !== 'campaign') continue;
        assert.ok(
            new RegExp(`\\b${f.key}\\s*:`).test(schemaText.slice(landmark(schemaText, 'export const discoveryCampaigns'))),
            `${key} targets discoveryCampaigns.${f.key}, which is not a column`,
        );
    }
});

check('value shapes are validated, so a text field never gets an object', () => {
    const text = STRATEGY_TUNABLE_FIELDS.outreach_playbook;
    const json = STRATEGY_TUNABLE_FIELDS.target_persona;

    assert.equal(isValidValueFor(text, 'Lead with the operational pain.'), true);
    assert.equal(isValidValueFor(text, ''), false, 'an empty string is not a strategy');
    assert.equal(isValidValueFor(text, '   '), false, 'whitespace is not a strategy either');
    assert.equal(isValidValueFor(text, { a: 1 }), false, 'an object here writes "[object Object]" into the brief');
    assert.equal(isValidValueFor(text, null), false);

    assert.equal(isValidValueFor(json, { industries: ['manufacturing'] }), true);
    assert.equal(isValidValueFor(json, ['a', 'b']), true, 'an array is a legitimate json value');
    assert.equal(isValidValueFor(json, 'a string'), false);
    assert.equal(isValidValueFor(json, null), false, 'null is indistinguishable from "unset" downstream');
});

// ── 4. Thresholds and gating ─────────────────────────────────────────────────

check('MIN_SAMPLE is held at the epic figure rather than lowered to make the tab look alive', () => {
    // A wrong pivot from n=8 is worse than no pivot: acting on a step function produces
    // oscillation, not learning. Small orgs are served by the edit-pattern proposer instead.
    assert.equal(MIN_SAMPLE, 20);
});

check('the expiry window leaves previousValue current enough to be restorable', () => {
    assert.ok(PROPOSAL_EXPIRY_DAYS >= 7, 'shorter than a holiday silently loses proposals');
    assert.ok(PROPOSAL_EXPIRY_DAYS <= 30, 'a month-old previousValue is too stale to restore safely');
});

check('the gate is its own feature key, NOT the autonomous tier', () => {
    // §7.1: "the difference is blast radius". tierAllows('autonomous') admits the goal optimizer,
    // which rewrites brand voice for an org's OWN content; this redirects cold outreach at real
    // strangers. Reusing one gate collapses that distinction, and does it silently — nobody
    // re-reads a tier check when adding a feature to it.
    assert.equal(STRATEGY_AGENT_FEATURE, 'strategy_agent');

    const apiText = sourceOf('netlify/functions/strategy-proposals.ts');
    assert.ok(apiText.includes('hasFeatureByOrg'), 'the API must check the plan feature');
    assert.ok(!/tierAllows\s*\(\s*['"]autonomous/.test(apiText), 'the API must not fall back to the autonomous tier gate');
});

check('nothing seeds the feature on, so every environment starts closed', () => {
    // hasFeatureByOrg treats a missing key as false, which is the whole reason "default off" needs
    // no data change. A seed row would quietly undo that.
    for (const rel of ['db/seed.ts', 'db/seed-catalog.ts']) {
        let text = '';
        try { text = readFileSync(join(root, rel), 'utf8'); } catch { continue; }
        assert.ok(!text.includes(STRATEGY_AGENT_FEATURE), `${rel} seeds ${STRATEGY_AGENT_FEATURE} — it must stay off by default`);
    }
});

// ── 5. The writer is the only writer ─────────────────────────────────────────

check('the API delegates every mutation to the single writer', () => {
    // §5.4: a human "save as default" and an agent pivot must share one apply path, one audit row
    // and one rollback. An inline db.update here would be the second mechanism.
    const apiText = sourceOf('netlify/functions/strategy-proposals.ts');
    for (const fn of ['applyStrategyChange', 'rejectProposal', 'rollbackProposal']) {
        assert.ok(apiText.includes(fn), `the API does not use ${fn}`);
    }
    assert.ok(!/db\s*\.\s*update\s*\(/.test(apiText), 'the API writes directly instead of going through the writer');
    assert.ok(!/db\s*\.\s*delete\s*\(/.test(apiText), 'nothing in this flow deletes');
    assert.ok(!/db\s*\.\s*insert\s*\(/.test(apiText), 'the API inserts directly instead of going through the writer');
});

check('the writer never sends anything', () => {
    // Untrusted third-party text reaches this feature's prompts (§5.2), and unlike memory-query
    // this module writes. The guarantee comes from the shape of what it can do: no sends, no tools,
    // no writes outside strategy_proposals and the fields the envelope names.
    const writerText = sourceOf('src/utils/strategy-proposals.ts');
    for (const forbidden of ['sendGmailMessage', 'sendOutlookMessage', 'sendEmail', 'fetch(']) {
        assert.ok(!writerText.includes(forbidden), `the writer must not reference ${forbidden}`);
    }
});

check('the writer only ever writes tables the envelope names', () => {
    const writerText = sourceOf('src/utils/strategy-proposals.ts');
    const written = new Set([...writerText.matchAll(/db\s*\.\s*(?:update|insert|delete)\s*\(\s*(\w+)/g)].map((m) => m[1]));
    // templateFeedback / leadRejectFeedback: only ever the `applied_*` flag, marking the evidence
    // that funded an applied proposal as spent so the same edits (or the same rejections) cannot
    // fund the identical suggestion next week.
    const allowed = new Set([
        'strategyProposals', 'aiAssistants', 'discoveryCampaigns', 'auditLogs',
        'templateFeedback', 'leadRejectFeedback',
    ]);
    for (const t of written) {
        assert.ok(allowed.has(t), `the writer touches ${t}, which is outside the change envelope`);
    }
    assert.ok(written.has('strategyProposals'), 'the scan found no writes at all — it is not testing anything');
});

// ── The per-assistant consent switch ─────────────────────────────────────────
//
// Two gates in series, with OPPOSITE defaults, and the defaults are the whole design:
// the plan feature is off until somebody grants it (commercial), the per-assistant switch is on
// unless somebody revokes it (operational). Invert either one and the pair stops working — two
// default-off gates give "I enabled it and nothing happened", two default-on gates give a feature
// nobody sold running against a customer's outbound.

check('the per-assistant switch defaults ON, and only an explicit false switches it off', () => {
    // Absence means on. This is what makes the toggle need no backfill: every assistant that
    // predates it, and every assistant created without the key, keeps behaving as it did.
    assert.equal(isStrategyAgentEnabledForAssistant(undefined), true);
    assert.equal(isStrategyAgentEnabledForAssistant(null), true);
    assert.equal(isStrategyAgentEnabledForAssistant({}), true);
    assert.equal(isStrategyAgentEnabledForAssistant({ [STRATEGY_AGENT_ASSISTANT_KEY]: true }), true);
    assert.equal(isStrategyAgentEnabledForAssistant({ [STRATEGY_AGENT_ASSISTANT_KEY]: false }), false);

    // onboarding_context is nullable and holds whatever onboarding last wrote — a non-object must
    // not throw, and must not read as "off" either.
    for (const junk of ['false', 0, [], 'nonsense']) {
        assert.equal(isStrategyAgentEnabledForAssistant(junk), true, `${JSON.stringify(junk)} must read as on`);
    }
    // Falsy-but-not-false values are NOT an opt-out: only `false` is, so a half-written context
    // cannot silently disable the agent.
    assert.equal(isStrategyAgentEnabledForAssistant({ [STRATEGY_AGENT_ASSISTANT_KEY]: 0 }), true);
    assert.equal(isStrategyAgentEnabledForAssistant({ [STRATEGY_AGENT_ASSISTANT_KEY]: null }), true);
});

check('the consent key cannot be reached through the prototype chain', () => {
    // `{}` inherits toString; a key lookup that walked the chain would read a function as "not
    // false" here, but the same laxity is what lets a crafted context answer for a missing key.
    assert.equal(isStrategyAgentEnabledForAssistant(Object.create({ [STRATEGY_AGENT_ASSISTANT_KEY]: false })), true);
});

check('consent and entitlement are two different keys', () => {
    // ⚠️ Sharing a key would collapse the distinction: the user's operational switch would be
    // writing the workspace's commercial entitlement, from a page they control.
    assert.notEqual(STRATEGY_AGENT_ASSISTANT_KEY, STRATEGY_AGENT_FEATURE);
    assert.ok(!STRATEGY_AGENT_ASSISTANT_KEY.includes(STRATEGY_AGENT_FEATURE),
        'the consent key contains the feature key — a source scan for one would match the other');
});

check('the consent switch never gates reading or deciding an existing proposal', () => {
    // It stops PRODUCTION only. Gating the API on it too would strand a pending proposal behind a
    // toggle: invisible, un-appliable, and un-declinable until the user guessed why.
    const apiText = sourceOf('netlify/functions/strategy-proposals.ts');
    assert.ok(apiText.includes('isStrategyAgentEnabledForAssistant'),
        'the API does not read the consent switch at all, so it cannot report it');
    assert.ok(/assistantPaused/.test(apiText), 'the API must report the paused state to the tab');
    // The refusal path and the gated-list path must both key off the PLAN feature alone.
    assert.ok(/if \(!enabled && action !== 'list'\)/.test(apiText),
        'the 403 refusal is no longer keyed off the plan feature alone');
    assert.ok(!/assistantPaused[\s\S]{0,80}return json\(403/.test(apiText),
        'the consent switch is refusing decisions — pending proposals would be stranded');
});

check('the consent switch is stored where the blueprint already lives', () => {
    // onboarding_context, not a new column: the worker already loads it for the field it is
    // rewriting, so the gate costs no extra query in either pass.
    const workerText = sourceOf('netlify/functions/autonomous-strategy-agent.ts');
    const reads = [...workerText.matchAll(/isStrategyAgentEnabledForAssistant\(([^)]*)\)/g)].map((m) => m[1].trim());
    assert.equal(reads.length, 2, `expected the gate in both passes, found ${reads.length}`);
    for (const arg of reads) {
        assert.equal(arg, 'assistant.onboardingContext',
            'the gate is reading something other than the assistant it is about to rewrite');
    }
});

console.log(`\n${passed} checks passed.`);
