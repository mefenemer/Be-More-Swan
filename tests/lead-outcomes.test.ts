// tests/lead-outcomes.test.ts
// Phase 4.5 (outcome capture) + the blueprint-version attribution key.
// Design: docs/strategy-agent-plan.md §0.1, §0.2, §2.
//
// Two things are guarded here, and both fail SILENTLY in production if they break:
//
//   1. `blueprintVersion` at every recordEvent() call site. It is half the Strategy Agent's
//      attribution key and it CANNOT BE BACKFILLED — nothing can recover which blueprint was live
//      when a past event was written. A new emit site that forgets it does not error; it quietly
//      writes rows the analyser has to discard. So this file parses the emit sites and asserts the
//      field is present, which is the only place that omission can be caught.
//
//   2. The outcome vocabularies. `lossReason` is stored on ANY terminal event by recordEvent(),
//      so a won deal carrying one would be counted by every "why are we losing?" aggregate, and
//      recordEvent() swallows its errors — meaning a bad value is invisible rather than loud.
//
// No database: pure-function and source-consistency checks, like tests/revenue-ledger.test.ts.
// Run:  npx tsx tests/lead-outcomes.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    OUTCOMES, LOSS_REASONS, OUTCOME_FOR_EVENT, TERMINAL_EVENT_TYPES,
    LOSS_REASON_LABELS, OUTCOME_LABELS, EVENT_FOR_OUTCOME, OUTCOMES_REQUIRING_LOSS_REASON,
} from '../src/config/revenue-events';

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
const read = (p: string) => readFileSync(join(root, p), 'utf8');

// ── 1. Outcome vocabulary integrity ──────────────────────────────────────────

check('OUTCOME_LABELS covers exactly the outcomes', () => {
    assert.deepEqual(Object.keys(OUTCOME_LABELS).sort(), [...OUTCOMES].sort());
    for (const [k, v] of Object.entries(OUTCOME_LABELS)) {
        assert.ok(v && v.trim(), `${k} has an empty label`);
    }
});

check('LOSS_REASON_LABELS covers exactly the loss reasons', () => {
    assert.deepEqual(
        Object.keys(LOSS_REASON_LABELS).sort(),
        [...LOSS_REASONS].sort(),
        'a loss reason without a label renders as a raw enum key to the user',
    );
    for (const [k, v] of Object.entries(LOSS_REASON_LABELS)) {
        assert.ok(v && v.trim(), `${k} has an empty label`);
    }
});

check('EVENT_FOR_OUTCOME is the exact inverse of OUTCOME_FOR_EVENT', () => {
    assert.deepEqual(Object.keys(EVENT_FOR_OUTCOME).sort(), [...OUTCOMES].sort());
    for (const [outcome, event] of Object.entries(EVENT_FOR_OUTCOME)) {
        assert.ok(
            (TERMINAL_EVENT_TYPES as readonly string[]).includes(event),
            `${outcome} maps to ${event}, which is not a terminal event`,
        );
        assert.equal(
            OUTCOME_FOR_EVENT[event], outcome,
            `round trip broken: ${outcome} → ${event} → ${OUTCOME_FOR_EVENT[event]}`,
        );
    }
});

check('a won deal never requires — or accepts — a loss reason', () => {
    assert.ok(
        !OUTCOMES_REQUIRING_LOSS_REASON.includes('won'),
        'recordEvent stores lossReason on ANY terminal event, so a won deal carrying one '
        + 'would be counted by every loss-reason aggregate',
    );
    for (const o of OUTCOMES_REQUIRING_LOSS_REASON) {
        assert.ok((OUTCOMES as readonly string[]).includes(o), `${o} is not an outcome`);
    }
    assert.deepEqual([...OUTCOMES_REQUIRING_LOSS_REASON].sort(), ['disqualified', 'lost']);
});

// ── 2. The generated client mirror ───────────────────────────────────────────
// tests/client-constants-fresh.test.ts already asserts the file matches the generator. This asserts
// the generator actually EMITS the outcome vocabulary — a fresh file that is missing it would pass
// that test and still leave the Data Hub unable to render the control.

check('the generated client constants carry the outcome vocabulary', () => {
    const generated = read('src/generated/platform-constants.js');
    assert.ok(generated.includes('window.RevenueConstants'), 'RevenueConstants missing from the generated mirror');
    for (const r of LOSS_REASONS) {
        assert.ok(generated.includes(`"${r}"`), `loss reason ${r} missing from the client mirror`);
    }
    for (const o of OUTCOMES) {
        assert.ok(generated.includes(`"${o}"`), `outcome ${o} missing from the client mirror`);
    }
});

// ── 3. blueprintVersion at every emit site ───────────────────────────────────
// The regression this exists for: someone adds a new recordEvent() call and omits
// blueprintVersion. Nothing breaks, no test fails, and the rows are permanently unattributable.

/** Files that call recordEvent(), and how many calls each should contain. */
const EMIT_SITES: Record<string, number> = {
    'src/utils/outreach-sequences.ts': 3,
    'netlify/functions/process-sequence-sends.ts': 1,
    'netlify/functions/inbound-email.ts': 2,
    'netlify/functions/assistant-records.ts': 1,
    'netlify/functions/signal-inbox.ts': 1,
    'netlify/functions/lead-generation.ts': 4,      // score / dnc-override / outreach / set_outcome
    'netlify/functions/process-discovery-jobs.ts': 3,
};

/**
 * Extract each `recordEvent(...)` argument object as raw source, by walking braces from the call.
 * A regex cannot do this — the payloads contain nested objects and template strings.
 */
function recordEventCalls(src: string): string[] {
    const out: string[] = [];
    const marker = 'recordEvent(';
    let i = 0;
    while ((i = src.indexOf(marker, i)) !== -1) {
        // Skip the import, the definition and prose references ("recordEvent() is the only writer").
        const lineStart = src.lastIndexOf('\n', i) + 1;
        const line = src.slice(lineStart, src.indexOf('\n', i));
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) { i += marker.length; continue; }

        let depth = 0, end = -1;
        for (let j = i + marker.length; j < src.length; j++) {
            const c = src[j];
            if (c === '(') depth++;
            else if (c === ')') { if (depth === 0) { end = j; break; } depth--; }
        }
        if (end === -1) break;
        out.push(src.slice(i, end));
        i = end;
    }
    return out;
}

for (const [file, expected] of Object.entries(EMIT_SITES)) {
    check(`${file} — all ${expected} recordEvent call(s) carry blueprintVersion`, () => {
        const src = read(file);
        const calls = recordEventCalls(src);
        assert.equal(
            calls.length, expected,
            `expected ${expected} recordEvent call(s), found ${calls.length}. If you added one, add `
            + 'blueprintVersion to it and update EMIT_SITES here.',
        );
        calls.forEach((call, n) => {
            // `ledgerBase` is a shared literal spread into several calls — accept the spread and
            // check the base separately below.
            const viaSpread = /\.\.\.ledgerBase/.test(call);
            assert.ok(
                viaSpread || /blueprintVersion/.test(call),
                `recordEvent call #${n + 1} in ${file} has no blueprintVersion. It is the Strategy `
                + 'Agent\'s attribution key and CANNOT be backfilled — an event written without it '
                + 'is permanently unattributable.',
            );
        });
        if (/\.\.\.ledgerBase/.test(src)) {
            const base = src.slice(src.indexOf('const ledgerBase'));
            assert.ok(
                /blueprintVersion/.test(base.slice(0, base.indexOf('};'))),
                'ledgerBase is spread into recordEvent calls but does not set blueprintVersion',
            );
        }
    });
}

check('the blueprint-version lookup is never memoised at module scope', () => {
    const src = read('src/utils/blueprint-version.ts');
    // The cache must be created inside the factory. A `const cache = new Map()` at module level
    // would survive in a warm Lambda and keep stamping a version a recompile has already replaced —
    // silently corrupting the attribution this module exists to provide.
    const beforeFactory = src.slice(0, src.indexOf('export function makeBlueprintVersionCache'));
    assert.ok(
        !/^\s*const\s+\w+\s*=\s*new Map/m.test(beforeFactory),
        'a module-level Map here outlives the request and would serve stale blueprint versions',
    );
});

// ── 4. set_outcome guards ────────────────────────────────────────────────────
// Source assertions rather than a live handler call: the action needs a tenant context and a DB.
// These pin the rules whose violation is silent — see the header.

check('set_outcome refuses a value on anything but a win', () => {
    const src = read('netlify/functions/lead-generation.ts');
    const action = src.slice(src.indexOf("if (action === 'set_outcome')"));
    assert.ok(
        /outcome !== 'won'[\s\S]{0,200}A deal value can only be recorded on a won deal/.test(action),
        'a value on a lost deal would mix revenue earned with revenue missed in one aggregate',
    );
});

check('set_outcome requires an explicit confirmation before overwriting an outcome', () => {
    const src = read('netlify/functions/lead-generation.ts');
    const action = src.slice(src.indexOf("if (action === 'set_outcome')"));
    assert.ok(
        /confirmChange !== true/.test(action) && /409/.test(action),
        'the ledger is append-only, so a mis-click would leave one lead counted as both won and lost',
    );
    assert.ok(
        /supersedes/.test(action),
        'a corrective terminal event must be identifiable — readers take the LATEST per record',
    );
});

check('recording an outcome halts any running cadence', () => {
    const src = read('netlify/functions/lead-generation.ts');
    const action = src.slice(src.indexOf("if (action === 'set_outcome')"));
    assert.ok(
        /haltEnrolmentsForRecord\(/.test(action),
        'a decided deal that keeps receiving "just following up!" is the most visible failure here',
    );
    const seq = read('src/utils/outreach-sequences.ts');
    const fn = seq.slice(seq.indexOf('export async function haltEnrolmentsForRecord'));
    assert.ok(
        /haltEnrolment\(db, r, 'manual'/.test(fn.slice(0, fn.indexOf('\n}'))),
        'must route through haltEnrolment — it is what clears next_send_at, and a row whose state '
        + 'changed but whose timestamp did not is still claimable by the worker',
    );
});

console.log(`\n${passed} checks passed.`);
