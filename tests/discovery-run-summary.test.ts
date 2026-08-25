// tests/discovery-run-summary.test.ts
// The completion notification has to say what the run actually did.
//
// ── What this fixes ──────────────────────────────────────────────────────────
// The notification said one thing: "found 14 companies". A paying customer read it, counted the
// addresses, and asked a human "does that seem right?" — the entire support problem in one
// sentence. Both of the facts that answer it were ALREADY computed slice by slice and persisted on
// discovery_jobs.cursor, and read by nothing:
//
//   stopReason — did we work the whole plan, or stop at a cap? Added after "a 175-lead sample of
//                ~4,500 schools presented itself as a finished search".
//   coverage   — searches run, results read, and how many were domains new to this campaign.
//
// ⚠️ THE DISTINCTION THIS DEFENDS: "complete" and "stopped at a cap" are different outcomes with
// opposite next actions. A run that ended on plan_complete has seen its market; one that ended on
// lead_cap has more to find and the fix is one click. The old copy said "Approve the ones worth
// pursuing" to both.
//
// Run:  npx tsx tests/discovery-run-summary.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    NAMED_TABS, STOP_REASONS, companiesPhrase, coverageSentence, isComplete, outcomeSentence,
    type RunStopReason,
} from '../src/config/discovery-run-summary';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const CAPS = { maxLeadsPerRun: 50, maxSearchCallsPerRun: 15, maxLeadsPerMonth: 500 };
/** Every branch the notification can take: each stop reason, plus the absent case, found and not. */
const ALL_ENDINGS: Array<RunStopReason | null | undefined> = [...STOP_REASONS, null, undefined];

console.log('\n──── capped is not complete ────');

check('only plan_complete (or an absent reason) counts as finished', () => {
    assert.ok(isComplete('plan_complete'));
    // Absent: runs predating the field. There is no honest way to claim a cap we have no record of.
    assert.ok(isComplete(null) && isComplete(undefined));
    for (const cap of ['lead_cap', 'search_cap', 'cost_cap', 'token_cap', 'month_cap'] as const) {
        assert.ok(!isComplete(cap), `${cap} must not read as a finished run`);
    }
});

check('a capped run tells the user it can be continued; a complete one does not', () => {
    // The behavioural difference the whole section exists for.
    const capped = outcomeSentence('lead_cap', 50, CAPS);
    assert.match(capped, /start it again/i, 'a capped run must tell the user it can carry on');
    assert.match(capped, /50 leads/, 'the cap must be quoted — "a limit" is not actionable');

    const complete = outcomeSentence('plan_complete', 14, CAPS);
    assert.doesNotMatch(complete, /start it again/i,
        'a finished run must not invite a pointless re-run — that is the "175-lead sample" bug in reverse');
});

check('each cap quotes its OWN number, never another cap’s', () => {
    // Quoting maxLeadsPerRun on a search_cap run would send the user to change the wrong setting.
    assert.match(outcomeSentence('search_cap', 30, CAPS), /15 searches/);
    assert.doesNotMatch(outcomeSentence('search_cap', 30, CAPS), /50 leads/);
    assert.match(outcomeSentence('month_cap', 30, CAPS), /500 leads/);
});

console.log('\n──── every branch is actionable ────');

check('every ending names a real tab', () => {
    // A notification arrives with none of the tab's explanatory copy around it, so it must name
    // the place the user can go. tests/signal-inbox.test.ts defended this on the template copy
    // until the call to action moved here.
    for (const ending of ALL_ENDINGS) {
        for (const found of [0, 1, 50]) {
            const s = outcomeSentence(ending, found, CAPS);
            assert.ok(NAMED_TABS.some((t) => s.includes(`${t} tab`)),
                `ending=${ending} found=${found} names no tab: "${s}"`);
        }
    }
});

check('the tab named is the RIGHT one for that outcome', () => {
    // ⚠️ Naming the wrong tab is worse than naming none — the user goes somewhere the thing they
    // were told about is not, and the notification has spent its one chance.
    //
    // A finished run: the leads exist and are read on ENRICHMENT.
    assert.match(outcomeSentence('plan_complete', 120, CAPS), /Enrichment tab/);
    // A capped or empty run: the next act is Start or Edit, both on SEARCHES.
    for (const cap of ['lead_cap', 'search_cap', 'cost_cap', 'token_cap'] as const) {
        assert.match(outcomeSentence(cap, 50, CAPS), /Searches tab/, `${cap} must send the user to Start search`);
    }
    assert.match(outcomeSentence('plan_complete', 0, CAPS), /Searches tab/, 'an empty run must send the user to Edit');
});

check('the finished-run sentence no longer contradicts the product', () => {
    // ⚠️ The copy this replaced said: "Approve the ones worth pursuing on the Searches tab and they
    // become leads." Three errors in nine words, and it is the one notification a user definitely
    // reads. Each is pinned because each reads as natural English and would come straight back.
    const s = outcomeSentence('plan_complete', 120, CAPS);

    //  1. leadGeneratorSurfaces() holds the assistant to: never tell a user their results are
    //     waiting to "become" leads. They ARE leads the moment they are scored, whatever they
    //     scored. The notification was contradicting the assistant that sent it.
    assert.doesNotMatch(s, /become leads/i, 'every scored company is already a lead');

    //  2. The button is "Move to Outreach". Saying "Approve" would have a user believe an email is
    //     on its way — approving is a separate act on the Outreach tab, and it sends.
    assert.doesNotMatch(s, /\bapprove\b/i, '"Approve" names a different act on a different tab, and it sends email');

    //  3. Leads are not on the Searches tab; its results view is read-only.
    assert.doesNotMatch(s, /Searches tab/, 'a finished run must not send the user to a read-only view');
});

check('the tabs it may name are the ones actually on screen', () => {
    // The labels come from the dashboard registry. Renaming a tab there without changing this
    // sends users to a tab that is not there — the same coupling tests/lead-prompt-surfaces.test.ts
    // defends for the assistant's own prompt.
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const registry = readFileSync(join(root, 'src/components/assistant-dashboard-registry.js'), 'utf8');
    for (const tab of NAMED_TABS) {
        assert.ok(registry.includes(`label: '${tab}'`),
            `no tab is labelled "${tab}" in the dashboard registry — the notification would send users nowhere`);
    }
});

check('every ending is a non-empty sentence', () => {
    for (const ending of ALL_ENDINGS) {
        for (const found of [0, 1, 50]) {
            const s = outcomeSentence(ending, found, CAPS);
            assert.ok(s.length > 20 && s.trim().endsWith('.'), `ending=${ending} found=${found}: "${s}"`);
        }
    }
});

check('a zero-result run gets an explanation, not silence', () => {
    // ⚠️ publishSignals used to `return` on leadsFound === 0, so the user who started the search
    // and waited was told NOTHING. Silence reads as "still running" or "broken".
    const nothingFound = outcomeSentence('plan_complete', 0, CAPS);
    assert.match(nothingFound, /too narrow|widen/i, 'a complete run that found nothing must say why and how to fix it');
    // The two sentences are rendered as one paragraph, so the outcome must not repeat what the
    // coverage sentence has just said.
    assert.doesNotMatch(nothingFound, /every search it planned/,
        'coverageSentence() already says the plan was worked — repeating it reads as padding');
    // And a run that found nothing because it stopped early must NOT blame the description.
    const stoppedEarly = outcomeSentence('lead_cap', 0, CAPS);
    assert.doesNotMatch(stoppedEarly, /too narrow/i,
        'a run that never finished its plan is not evidence the description is wrong');
    assert.match(stoppedEarly, /not a verdict/i);
});

console.log('\n──── the coverage sentence ────');

check('it reads the newness rate as advice, not as a percentage', () => {
    // The whole point is to hand the user the interpretation: it decides whether they re-run the
    // search or rewrite it. "38% newness" makes them do that work themselves.
    const fresh = coverageSentence({ queriesRun: 14, resolved: 120, inserted: 90 });
    assert.match(fresh, /more of this market left to find/);
    const saturated = coverageSentence({ queriesRun: 14, resolved: 120, inserted: 6 });
    assert.match(saturated, /close to exhausting its market/);
    assert.match(saturated, /widening the description/);
    // ⚠️ "sites", never "companies". This rate counts domains resolved, not leads qualified, and
    // beside "found no companies matching your criteria" the word "companies" read as a
    // contradiction — nothing matched, yet we had "already found" most of them.
    for (const s of [fresh, saturated]) {
        assert.doesNotMatch(s, /companies/,
            'the newness reading must not say "companies" — it collides with the lead count in the same paragraph');
    }
    // The middle band deliberately offers no reading — a hedge on every run is noise.
    const middling = coverageSentence({ queriesRun: 14, resolved: 120, inserted: 40 });
    assert.doesNotMatch(middling, /market/);
});

check('it says how much of the plan was worked', () => {
    assert.match(coverageSentence({ queriesRun: 9, resolved: 50, inserted: 30, remaining: 6 }),
        /9 searches of the 15 it planned/);
    assert.match(coverageSentence({ queriesRun: 14, resolved: 50, inserted: 30, remaining: 0 }),
        /all 14 searches it planned/);
    assert.match(coverageSentence({ queriesRun: 1, resolved: 4, inserted: 2 }), /all 1 search it planned/);
});

check('it says NOTHING rather than guessing when there is no record', () => {
    // Runs predating the coverage field. Inventing a confident sentence from absent data is the
    // exact failure this whole plan is about.
    assert.equal(coverageSentence(null), '');
    assert.equal(coverageSentence(undefined), '');
    assert.equal(coverageSentence({ queriesRun: 0, resolved: 0, inserted: 0 }), '');
    // Searches ran but nothing survived the filters: still worth saying, without a newness claim.
    const noResults = coverageSentence({ queriesRun: 5, resolved: 0, inserted: 0 });
    assert.match(noResults, /ran all 5 searches/);
    assert.doesNotMatch(noResults, /market/);
});

console.log('\n──── plurals ────');

check('the noun phrase is resolved at the call site, including zero', () => {
    // The merge engine has no plural rules; the old copy said "found 1 new signals".
    assert.equal(companiesPhrase(0), 'no companies');
    assert.equal(companiesPhrase(1), '1 company');
    assert.equal(companiesPhrase(14), '14 companies');
    assert.equal(companiesPhrase(-3), 'no companies', 'a negative count must not render as "-3 companies"');
});

console.log(`\n${passed} checks passed.`);
