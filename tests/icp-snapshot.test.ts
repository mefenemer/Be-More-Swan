// tests/icp-snapshot.test.ts
// The ICP half of the revenue ledger's attribution key (§7.2, docs/strategy-agent-plan.md §0.2).
//
// Two things are being defended here, and only the second is about this module's logic:
//
//   1. THE EMIT SITES. `icp_snapshot` and `blueprint_version` can only be captured at write time —
//      an event written without them is permanently unattributable, and the Strategy Agent's
//      segments simply do not contain it. Nothing in the type system requires a recordEvent()
//      caller to pass either one: RecordEventInput marks both optional, because a genuinely
//      unresolvable ref is a legitimate outcome. That optionality is exactly how nine of twelve
//      call sites came to omit icpSnapshot silently. So the guarantee has to be a source scan.
//
//   2. THE PRECEDENCE. Campaign snapshot before onboarding, always. Attributing a deal won today
//      to today's onboarding credits the current targeting for a lead the previous targeting
//      found — the correlating-noise failure the attribution key exists to prevent.
//
// No database: pure-function and source-consistency checks, so this runs in CI with no connection
// string, matching every other file in tests/ except rls-enforcement.
// Run:  npx tsx tests/icp-snapshot.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getIcpSnapshot, makeIcpSnapshotCache, icpFromOnboarding } from '../src/utils/icp-snapshot';
import { icpBlock } from '../src/config/icp-profile';
import { discoveredLeads, aiAssistants } from '../db/schema';
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

// ── 1. Every emit site carries the attribution key ───────────────────────────

/** Every .ts file under the given dirs, recursively, excluding tests/. */
function sourceFiles(dirs: string[]): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === 'tests') continue;
                walk(p);
            } else if (entry.name.endsWith('.ts')) {
                out.push(p);
            }
        }
    };
    for (const d of dirs) walk(join(root, d));
    return out;
}

/**
 * Blank out comments, preserving length and newlines so offsets and line numbers stay exact.
 *
 * Necessary because several of these modules explain the ledger contract in their header comments
 * and name `recordEvent()` while doing so — a scan that counts those reports violations in files
 * that emit nothing.
 */
function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** The balanced-paren text of the call starting at `from` (the index of its opening paren). */
function balancedCall(text: string, from: number): string {
    let depth = 0;
    for (let i = from; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')') { depth--; if (depth === 0) return text.slice(from, i + 1); }
    }
    return text.slice(from);
}

/**
 * Does this call-site text supply `field`, directly or via a spread of a local object that does?
 *
 * The spread case is not a technicality — the discovery worker builds one `ledgerBase` and spreads
 * it into both of its emits, which is the right shape (it guarantees the two events agree) and
 * would read as a violation to a naive substring check.
 */
function suppliesField(callText: string, fileText: string, field: string): boolean {
    // `field:`, `field,` and `field }` — the shorthand form is the common one where the value was
    // resolved into a same-named local above the call, which is most of these sites.
    const supplied = new RegExp(`\\b${field}\\s*[:,}]`);
    if (supplied.test(callText)) return true;
    for (const m of callText.matchAll(/\.\.\.(\w+)/g)) {
        const declIdx = fileText.search(new RegExp(`const\\s+${m[1]}\\s*=\\s*\\{`));
        if (declIdx === -1) continue;
        const braceStart = landmark(fileText, '{', declIdx);
        let depth = 0;
        for (let i = braceStart; i < fileText.length; i++) {
            if (fileText[i] === '{') depth++;
            else if (fileText[i] === '}') {
                depth--;
                if (depth === 0) {
                    if (supplied.test(fileText.slice(braceStart, i + 1))) return true;
                    break;
                }
            }
        }
    }
    return false;
}

interface EmitSite { file: string; line: number; text: string; fileText: string; }

const emitSites: EmitSite[] = [];
for (const file of sourceFiles(['netlify', 'src'])) {
    // The ledger's own module defines and wraps recordEvent; it is not a call site.
    if (relative(root, file) === 'src/utils/revenue-ledger.ts') continue;
    const fileText = stripComments(readFileSync(file, 'utf8'));
    for (const m of fileText.matchAll(/\brecordEvent(?:Async)?\(/g)) {
        const open = m.index! + m[0].length - 1;
        emitSites.push({
            file: relative(root, file),
            line: fileText.slice(0, m.index).split('\n').length,
            text: balancedCall(fileText, open),
            fileText,
        });
    }
}

check('the scan actually found the emit sites (a broken scan must fail, not silently pass)', () => {
    // Guards against the regex or the walk quietly matching nothing, which would make every
    // assertion below vacuously true — the failure mode that makes source-scanning tests useless.
    assert.ok(emitSites.length >= 12, `expected ≥12 recordEvent call sites, found ${emitSites.length}`);
});

check('every recordEvent call site supplies icpSnapshot', () => {
    const missing = emitSites
        .filter((s) => !suppliesField(s.text, s.fileText, 'icpSnapshot'))
        .map((s) => `${s.file}:${s.line}`);
    assert.deepEqual(missing, [], `these emit sites write permanently unattributable rows:\n    ${missing.join('\n    ')}`);
});

check('every recordEvent call site supplies blueprintVersion', () => {
    const missing = emitSites
        .filter((s) => !suppliesField(s.text, s.fileText, 'blueprintVersion'))
        .map((s) => `${s.file}:${s.line}`);
    assert.deepEqual(missing, [], `these emit sites write permanently unattributable rows:\n    ${missing.join('\n    ')}`);
});

check('the ICP snapshot shape is defined once, not re-inlined at a call site', () => {
    // The shape drifted before: src/utils/discovery.ts had three fields, lead-generation.ts had two
    // (no salesTone). Two events about the same org then carried snapshots that do not GROUP BY
    // together, and a segment that splits on the mere presence of a key is not a segment.
    const offenders: string[] = [];
    for (const file of sourceFiles(['netlify', 'src'])) {
        const rel = relative(root, file);
        if (rel === 'src/utils/icp-snapshot.ts') continue;
        const text = stripComments(readFileSync(file, 'utf8'));
        // Anchored to the start of a line so this matches a PROPERTY KEY only. Unanchored it also
        // hits the ternary in the discovery worker (`… ? campaign.icpSnapshot : {}`), which reads
        // the snapshot rather than inventing one.
        for (const m of text.matchAll(/^[ \t]*icpSnapshot\s*:\s*\{/gm)) {
            offenders.push(`${rel}:${text.slice(0, m.index).split('\n').length}`);
        }
    }
    assert.deepEqual(offenders, [], `build the snapshot with icpFromOnboarding() instead:\n    ${offenders.join('\n    ')}`);
});

// ── 2. icpFromOnboarding ─────────────────────────────────────────────────────

check('icpFromOnboarding always returns every key, so snapshots GROUP BY together', () => {
    const empty = icpFromOnboarding(undefined);
    assert.deepEqual(Object.keys(empty).sort(), ['excludeProfile', 'minHeadcount', 'salesTone', 'targetIndustries']);
    assert.equal(empty.targetIndustries, null);
    assert.equal(empty.minHeadcount, null);
    assert.equal(empty.salesTone, 'professional', 'the tone default must be stable, not absent');
    // Null, not ''. An unanswered exclusion list and an explicitly emptied one are different facts,
    // and only the first should read as "never asked" when this snapshot is looked at later.
    assert.equal(empty.excludeProfile, null);
});

check('icpFromOnboarding tolerates junk rather than throwing', () => {
    for (const junk of [null, undefined, 'a string', 42, [1, 2, 3]]) {
        const r = icpFromOnboarding(junk);
        assert.equal(r.targetIndustries, null, `failed on ${JSON.stringify(junk)}`);
        assert.equal(r.salesTone, 'professional');
    }
});

check('icpFromOnboarding reads real answers through', () => {
    const r = icpFromOnboarding({
        targetIndustries: ['manufacturing'], minHeadcount: 50, salesTone: 'direct',
        excludeProfile: 'other manufacturers, industrial recruiters',
    });
    assert.deepEqual(r, {
        targetIndustries: ['manufacturing'], minHeadcount: 50, salesTone: 'direct',
        excludeProfile: 'other manufacturers, industrial recruiters',
    });
});

// ── 2b. icpBlock — the rendered profile ──────────────────────────────────────
// The shape (above) is an attribution key; this is the prompt text built from it. They were
// separate concerns living in four files, which is how the wording drifted.

check('icpBlock states every criterion, so an unanswered one reads as neutral not absent', () => {
    const block = icpBlock(icpFromOnboarding(undefined));
    assert.match(block, /Target industries: not specified/);
    assert.match(block, /Minimum company headcount: not specified/);
    assert.match(block, /Sales tone: professional/);
});

check('icpBlock omits the exclusion line entirely when nothing is excluded', () => {
    // Not "- NOT customers: none". An empty list stated as a criterion invites the model to fill it,
    // and every assistant hired before the field existed would get that line.
    for (const blank of [undefined, null, '', '   ']) {
        const block = icpBlock({ excludeProfile: blank });
        assert.ok(!/NOT customers/.test(block), `rendered an empty exclusion line for ${JSON.stringify(blank)}`);
    }
});

check('icpBlock renders the exclusion list when it is answered', () => {
    const block = icpBlock(icpFromOnboarding({ excludeProfile: 'marketing agencies, recruiters' }));
    assert.match(block, /NOT customers .* marketing agencies, recruiters/);
});

check('the ICP prompt block is defined once, not re-inlined at a call site', () => {
    // The guard that would have caught the original drift: discovery-scoring.ts said "treat as
    // neutral", lead-generation.ts said "treat industry as neutral", and chat-orchestrator.ts had a
    // third copy inline in a template literal. Three surfaces scoring the same company from three
    // different prompts is not a difference any user could attribute to its real cause.
    const offenders: string[] = [];
    for (const file of sourceFiles(['netlify', 'src'])) {
        const rel = relative(root, file);
        if (rel === 'src/config/icp-profile.ts') continue;
        const text = stripComments(readFileSync(file, 'utf8'));
        if (/-\s*Target industries:/.test(text) || /Scoring bands: 70-100/.test(text)) {
            offenders.push(rel);
        }
    }
    assert.deepEqual(offenders, [], `import icpBlock()/SCORING_BANDS from src/config/icp-profile.ts instead:\n    ${offenders.join('\n    ')}`);
});

// ── 3. The resolver ──────────────────────────────────────────────────────────
// tsx compiles this file to CJS, where top-level await is unavailable — hence the async main().

type Rows = Record<string, unknown>[];

/**
 * A drizzle-shaped fake. Both campaign paths select FROM discovered_leads (one joins via the lead
 * id, the other via the record id), so each test supplies at most one of those refs and the result
 * is unambiguous.
 */
function fakeDb(opts: { leads?: Rows; assistants?: Rows; throwOn?: 'leads' | 'assistants' }) {
    let table: 'leads' | 'assistants' | '' = '';
    const chain: any = {
        from: (t: unknown) => { table = t === discoveredLeads ? 'leads' : t === aiAssistants ? 'assistants' : ''; return chain; },
        innerJoin: () => chain,
        where: () => chain,
        limit: async () => {
            if (opts.throwOn === table) throw new Error('simulated db failure');
            return table === 'leads' ? (opts.leads ?? []) : (opts.assistants ?? []);
        },
    };
    return { select: () => chain } as any;
}

const CAMPAIGN_ICP = { targetIndustries: ['hospitality'], minHeadcount: 10, salesTone: 'warm' };

async function main() {

await check('a lead resolves to its CAMPAIGN snapshot, not current onboarding', async () => {
    const db = fakeDb({
        leads: [{ icpSnapshot: CAMPAIGN_ICP }],
        assistants: [{ onboardingContext: { targetIndustries: ['something else'] } }],
    });
    const got = await getIcpSnapshot(db, { discoveredLeadId: 7, aiAssistantId: 3 });
    assert.deepEqual(got, CAMPAIGN_ICP, 'the ICP live when the lead was FOUND is the attribution key');
});

await check('a mirrored record resolves via record → lead → campaign', async () => {
    const db = fakeDb({ leads: [{ icpSnapshot: CAMPAIGN_ICP }] });
    const got = await getIcpSnapshot(db, { assistantRecordId: 42, aiAssistantId: 3 });
    assert.deepEqual(got, CAMPAIGN_ICP);
});

await check('a manually added lead falls back to onboarding rather than returning null', async () => {
    const db = fakeDb({ leads: [], assistants: [{ onboardingContext: { targetIndustries: ['retail'], minHeadcount: 5 } }] });
    const got = await getIcpSnapshot(db, { assistantRecordId: 42, aiAssistantId: 3 });
    assert.deepEqual(got, { targetIndustries: ['retail'], minHeadcount: 5, salesTone: 'professional', excludeProfile: null },
        'a weaker attribution is still an attribution');
});

await check('an empty campaign snapshot falls through to onboarding', async () => {
    // A campaign predating the icp_snapshot column has {} or null; treating that as a real
    // snapshot would create an empty-ICP segment that every such lead falls into.
    for (const emptyish of [{}, null, 'nonsense', []]) {
        const db = fakeDb({ leads: [{ icpSnapshot: emptyish }], assistants: [{ onboardingContext: { minHeadcount: 9 } }] });
        const got = await getIcpSnapshot(db, { discoveredLeadId: 7, aiAssistantId: 3 });
        assert.equal((got as Record<string, unknown>).minHeadcount, 9, `failed for ${JSON.stringify(emptyish)}`);
    }
});

await check('NEVER THROWS — a failing campaign lookup still tries onboarding', async () => {
    const db = fakeDb({ throwOn: 'leads', assistants: [{ onboardingContext: { minHeadcount: 12 } }] });
    const got = await getIcpSnapshot(db, { discoveredLeadId: 7, aiAssistantId: 3 });
    assert.equal((got as Record<string, unknown>).minHeadcount, 12);
});

await check('NEVER THROWS — a failing onboarding lookup resolves to null', async () => {
    const db = fakeDb({ throwOn: 'assistants' });
    assert.equal(await getIcpSnapshot(db, { aiAssistantId: 3 }), null);
});

await check('an unresolvable ref is null, not a throw and not an empty object', async () => {
    const db = fakeDb({});
    assert.equal(await getIcpSnapshot(db, {}), null);
    assert.equal(await getIcpSnapshot(db, { discoveredLeadId: null, aiAssistantId: null }), null);
    assert.equal(await getIcpSnapshot(db, { aiAssistantId: 1.5 }), null, 'a non-integer id must not reach the query');
});

await check('a missing assistant row is null rather than a default-shaped snapshot', async () => {
    // Inventing {targetIndustries: null, salesTone: 'professional'} for an assistant that does not
    // exist would put a phantom segment in the aggregate.
    assert.equal(await getIcpSnapshot(fakeDb({ assistants: [] }), { aiAssistantId: 3 }), null);
});

await check('the cache separates lead / record / assistant key spaces', async () => {
    // Id 5 can be a lead, a record and an assistant at once, and the three are not interchangeable.
    let calls = 0;
    const db = fakeDb({ leads: [{ icpSnapshot: CAMPAIGN_ICP }], assistants: [{ onboardingContext: { minHeadcount: 99 } }] });
    const inner = db.select;
    db.select = (...a: unknown[]) => { calls++; return inner.apply(db, a as []); };

    const cached = makeIcpSnapshotCache(db);
    const byLead = await cached({ discoveredLeadId: 5 });
    const byAssistant = await cached({ aiAssistantId: 5 });
    assert.deepEqual(byLead, CAMPAIGN_ICP);
    assert.equal((byAssistant as Record<string, unknown>).minHeadcount, 99, 'assistant 5 must not read lead 5\'s cache entry');
    assert.equal(calls, 2);

    await cached({ discoveredLeadId: 5 });
    await cached({ aiAssistantId: 5 });
    assert.equal(calls, 2, 'a repeat ref must be served from cache');
});

await check('the cache memoises nulls too', async () => {
    let calls = 0;
    const db = fakeDb({ assistants: [] });
    const inner = db.select;
    db.select = (...a: unknown[]) => { calls++; return inner.apply(db, a as []); };
    const cached = makeIcpSnapshotCache(db);
    assert.equal(await cached({ aiAssistantId: 8 }), null);
    assert.equal(await cached({ aiAssistantId: 8 }), null);
    assert.equal(calls, 1, 'an unresolvable ref should cost one query per run, not one per lead');
});

console.log(`\n${passed} checks passed.`);
}

void main();
