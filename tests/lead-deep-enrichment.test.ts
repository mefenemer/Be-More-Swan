// tests/lead-deep-enrichment.test.ts
// Deep enrichment: researching a lead and re-scoring it on what turns up.
//
// WHY THIS EXISTS. This is the first thing in the product that lets a model change a stored
// judgement about a real company, and then shows that judgement to a user as fact. Three ways it
// can go wrong, all silent, none caught by types:
//
//   1. FABRICATION. Asked for the leadership of a company whose team page it could not read, a
//      model will produce a plausible managing director. That name would be shown as fact and fed
//      to the outreach drafter, which would then address a real business by a person who does not
//      work there. §2 holds the guard that stops it.
//   2. UNGROUNDED CLAIMS. A signal summary with no source link is an assertion the user cannot
//      check. Every claim on that panel has to be one click from the page it came from. §3.
//   3. UNATTENDED SPEND. The cadence sweep calls two paid APIs per lead with nobody watching. It
//      is the only cron in this repo that spends money, and §5 is what keeps it off by default and
//      away from leads where the spend is a foregone conclusion.
//
// Also guarded here: the retention clock is NOT disturbed by enrichment (§6). That coupling is
// easy to miss and would be catastrophic in a quiet way — a nightly sweep that touched updated_at
// would keep every lead alive forever and the 30-day countdown would never reach zero on anything.
//
// Run:  npx tsx tests/lead-deep-enrichment.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { landmark } from './landmark';
import { nameAppearsInSources, hasIntelWorthScoring, LEAD_INTEL_SEARCHES } from '../src/lib/lead-intel';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** Blank comments, preserving length, so prose about a rule cannot satisfy a scan for the rule. */
function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

const INTEL = read('src/lib/lead-intel.ts');
const INTEL_CODE = stripComments(INTEL);
const SCORING = read('src/lib/discovery-scoring.ts');
const ENRICH = read('src/utils/lead-enrichment.ts');
const ENRICH_CODE = stripComments(ENRICH);
const SWEEP = read('netlify/functions/lead-enrichment-sweep.ts');
const SWEEP_CODE = stripComments(SWEEP);
const LEADGEN = read('netlify/functions/lead-generation.ts');
const HUB = read('src/components/assistant-data-hub.js');
// ⚠️ Scanned separately from HUB. The bulk-control check below looks for phrases that this file's
// own comments legitimately contain — the comment above the Research button EXPLAINS why a
// "research all" button must not exist, and matching that text passed a test that was supposed to
// prove the button was absent. Same lesson lead-prompt-surfaces.test.ts records.
const HUB_CODE = stripComments(HUB);
const SEARCH = read('src/lib/discovery-search.ts');
const TOML = read('netlify.toml');

const RESCORE = SCORING.slice(
    landmark(SCORING, 'export async function rescoreWithIntel'),
    SCORING.length,
);
const DEEP = ENRICH.slice(
    landmark(ENRICH, 'export async function deepEnrichLead'),
    landmark(ENRICH, 'async function stampIntel'),
);

console.log('\n──── 1. gathering is deterministic; only interpretation uses a model ────');

check('the evidence gatherer never calls a model', () => {
    // The split is what makes the fabrication guard possible at all: because the source text
    // travels with the evidence, the persist step can check a claimed name against it. Mixing the
    // two halves would leave nothing to check against.
    assert.ok(!/anthropic|Anthropic|messages\.create/.test(INTEL_CODE),
        'src/lib/lead-intel.ts now calls a model. Gathering must stay extraction-only — the '
        + 'verification in lead-enrichment.ts depends on the source text being collected '
        + 'independently of whatever interprets it.');
});

check('every fetch goes through the SSRF-guarded fetcher', () => {
    // These domains come from search results, i.e. attacker-influenceable input.
    assert.match(INTEL_CODE, /safeFetchText/, 'the gatherer no longer uses safeFetchText');
    assert.ok(!/\bawait fetch\(|[^.]\bfetch\(`https/.test(INTEL_CODE),
        'the gatherer makes a bare fetch() to a lead-supplied domain — every hop must be re-validated');
});

check('signal queries are date-restricted, and the restriction reaches the provider', () => {
    // A funding round from 2019 is history, not a buying signal. Feeding it to the re-scorer as
    // though it were news is how a lead gets promoted for nothing.
    assert.match(INTEL_CODE, /recency: 'year'/, 'the signal queries are no longer date-restricted');
    assert.match(SEARCH, /qdr:y/, 'the search provider drops the date restriction on the floor');
    assert.match(SEARCH, /tbs \? \{ tbs \} : \{\}/, 'tbs is not passed through to the provider');
});

check('the per-lead search budget is respected as it is spent', () => {
    const fn = INTEL_CODE.slice(landmark(INTEL_CODE, 'export async function gatherLeadIntel'), INTEL_CODE.length);
    assert.match(fn, /if \(searchCallsMade >= budget\) break/,
        'the budget is no longer checked between queries');
    assert.ok(!/Promise\.all\(SIGNAL_QUERIES|SIGNAL_QUERIES\.map/.test(fn),
        'the signal queries run concurrently — a Promise.all has already bought all four by the '
        + 'time the first returns, so the budget would be advisory rather than a cap');
    // A failed query must still count against the budget, or a provider erroring on every call
    // turns the cap into an infinite loop of retries.
    assert.match(fn, /catch \{[\s\S]{0,200}searchCallsMade\+\+/,
        'a failed query does not count against the budget');
});

check('the budget cannot be raised above the module ceiling by a caller', () => {
    const fn = INTEL_CODE.slice(landmark(INTEL_CODE, 'export async function gatherLeadIntel'), INTEL_CODE.length);
    assert.match(fn, /Math\.min\(opts\.maxSearches \?\? LEAD_INTEL_SEARCHES, LEAD_INTEL_SEARCHES\)/,
        'a caller can now ask for more searches than the module ceiling allows');
    assert.ok(LEAD_INTEL_SEARCHES > 0 && LEAD_INTEL_SEARCHES <= 6,
        'the per-lead search ceiling has moved outside a sane range');
});

console.log('\n──── 2. the fabrication guard ────');

check('a name that is not in the source text is rejected', () => {
    const sources = [{ url: 'https://example.com/about', text: 'Our team. Priya  Raghunathan is the Managing Director. Tom Beckett runs the workshop.' }];
    assert.strictEqual(nameAppearsInSources('Priya Raghunathan', sources), true,
        'a real name split across whitespace in the source must still match');
    assert.strictEqual(nameAppearsInSources('tom beckett', sources), true, 'matching must be case-insensitive');
    assert.strictEqual(nameAppearsInSources('James Fitzgerald', sources), false,
        'THE GUARD: an invented name must be rejected');
    assert.strictEqual(nameAppearsInSources('', sources), false, 'an empty name must never pass');
    assert.strictEqual(nameAppearsInSources('Jo', sources), false,
        'a one- or two-character needle matches half the web — it must not pass');
    assert.strictEqual(nameAppearsInSources('Priya Raghunathan', []), false,
        'with no sources reada nothing can be verified, so nothing may pass');
});

check('the guard is actually applied on the persist path', () => {
    // nameAppearsInSources being correct is worth nothing if deepEnrichLead does not call it.
    assert.match(ENRICH_CODE, /function verifyPeople/, 'verifyPeople is gone');
    assert.match(ENRICH_CODE, /nameAppearsInSources\(p\.name, sources\)/, 'verifyPeople no longer verifies');
    assert.match(DEEP, /verifyPeople\(rescored\.people, intel\.peopleSources\)/,
        'deepEnrichLead persists the model\'s people list WITHOUT verifying it against the pages read');
    // The verified list, not the raw one, is what gets written.
    const written = DEEP.slice(landmark(DEEP, 'people,'), DEEP.length);
    assert.ok(!/rescored\.people/.test(written.slice(0, 400)),
        'the unverified list is what reaches the record');
});

check('the prompt forbids inventing people, and says so in the hard terms', () => {
    assert.match(RESCORE, /appears, spelled exactly that way/,
        'the prompt no longer requires names to appear verbatim in the supplied text');
    assert.match(RESCORE, /Never invent an email address/,
        'the prompt must forbid inventing an address for a named person — that is the step that '
        + 'turns a fabricated name into a real email to a real company');
    assert.match(RESCORE, /return an empty list/,
        'the prompt must make "nobody was named" an acceptable answer, or the model will supply one');
});

console.log('\n──── 3. no claim without its source ────');

check('signals are filtered to evidence URLs we actually supplied', () => {
    assert.match(RESCORE, /const allowedUrls = new Set\(intel\.evidence\.map\(\(e\) => e\.url\)\)/,
        'the allow-list of evidence urls is gone');
    assert.match(RESCORE, /allowedUrls\.has\(s\.url\)/,
        'a signal pointing at an invented url would now be kept and shown as fact');
});

check('an unparseable direction defaults to neutral, never positive', () => {
    // These chips read as "reasons to chase this lead". A garbled direction must not become one.
    assert.match(RESCORE, /s\.direction === 'positive' \|\| s\.direction === 'negative' \? s\.direction : 'neutral'/,
        'the direction fallback has changed — anything but neutral biases the panel towards chasing');
});

check('the panel refuses to draw a signal with no link', () => {
    const fn = HUB.slice(landmark(HUB, 'function intelBanner'), landmark(HUB, '\n  }', landmark(HUB, 'function intelBanner')));
    assert.match(fn, /\.filter\(\(s\) => s && s\.summary && s\.url\)/,
        'the renderer no longer requires a source url — this is the last of three gates');
    assert.match(fn, />source/, 'the source link is gone from the signal row');
    assert.match(fn, /nothing here contacts them/i,
        'the people list must say plainly that nothing in this product contacts them — we hold no '
        + 'address for these individuals and there is no channel that could');
});

check('"we looked and found nothing" is rendered as a result, not as absence', () => {
    // The same distinction enrichAttemptedAt draws on the Contact column: a lead nobody has
    // researched and one there is genuinely nothing to say about must not look identical.
    const fn = HUB.slice(landmark(HUB, 'function intelBanner'), landmark(HUB, '\n  }', landmark(HUB, 'function intelBanner')));
    assert.match(fn, /nothing published about this company/,
        'a researched-but-barren lead now renders nothing, which is indistinguishable from never researched');
});

console.log('\n──── 4. a re-score cannot quietly undo a decision ────');

check('do-not-contact is carried forward, never re-asked', () => {
    // A model re-reading cheerful press about a company we have flagged as a competitor or an
    // opt-out must not be able to talk itself into clearing that flag.
    assert.match(RESCORE, /doNotContact: current\.doNotContact/,
        'the re-score takes doNotContact from the MODEL. The only path out of that verdict is the '
        + 'audited override_do_not_contact action.');
    assert.match(RESCORE, /doNotContactReason: current\.doNotContactReason/, 'the reason is re-asked too');
});

check('the prospect-type clamp is carried forward, not re-rolled', () => {
    assert.match(RESCORE, /prospectType: current\.prospectType \?\? null/,
        'a re-score re-rolls the prospect-type gate, which would let a lead escape a disqualification '
        + 'it already earned');
});

check('a failed re-score leaves the lead exactly as it was', () => {
    // EMPTY_RESCORE is declared ABOVE rescoreWithIntel, so this reads the whole module rather than
    // the RESCORE span.
    assert.match(SCORING, /const EMPTY_RESCORE: RescoreResult = \{\s*\n?\s*card: null/,
        'the failure path no longer returns a null card');
    assert.match(DEEP, /if \(!rescored\.card\)/, 'deepEnrichLead does not check for a failed re-score');
    // The important half: on that path it must not write a score.
    const failPath = DEEP.slice(landmark(DEEP, 'if (!rescored.card)'), landmark(DEEP, 'const people ='));
    assert.ok(!/score:/.test(failPath),
        'a failed re-score writes a score anyway — a guess that looks exactly as authoritative as a judgement');
});

check('the record merge preserves everything the pass has no business rewriting', () => {
    // `data` also carries the contact address, emailKind provenance, the retention stamp and the
    // deal outcome.
    assert.match(DEEP, /COALESCE\(\$\{assistantRecords\.data\}, '\{\}'::jsonb\) \|\|/,
        'the deep pass replaces `data` wholesale instead of merging into it');
    assert.match(DEEP, /\.\.\.\(next\.outreachDraft \? \{ outreachDraft: next\.outreachDraft \} : \{\}\)/,
        'a cold re-score returns a null draft, and nulling it would destroy a draft the user may '
        + 'have edited by hand');
});

check('a rating change is emitted as lead_scored, not a new event type', () => {
    // The vocabulary is CHECK-constrained in db/revenue-events.sql and applied BY HAND, so a new
    // value would be code ahead of schema on whichever environment had not been migrated.
    assert.match(DEEP, /recordEvent\(db, 'lead_scored'/, 'the re-score no longer emits lead_scored');
    assert.match(DEEP, /rescore: true/, 'nothing distinguishes a re-score from an original score');
    assert.match(DEEP, /previousScore: current\.score/, 'the movement is not recorded, so it cannot be aggregated');
    const vocab = read('src/config/revenue-events.ts');
    assert.ok(!/lead_rescored|lead_researched/.test(vocab),
        'a new event type was added to the vocabulary — db/revenue-events.sql is a MANUAL apply, so '
        + 'this would fail a CHECK constraint on any environment that has not been migrated');
});

console.log('\n──── 5. the sweep spends money, so it is caged ────');

check('it is OFF by default', () => {
    assert.match(SWEEP_CODE, /LEAD_ENRICH_SWEEP_ENABLED \?\? 'false'/,
        'the only cron in this repo that bills a third party now defaults to ON');
    assert.match(SWEEP_CODE, /if \(!ENABLED\)/, 'the enabled check is gone');
});

check('it does nothing when there is no search provider', () => {
    // Otherwise every lead costs a model call over an empty evidence set — paying to be told
    // nothing changed.
    assert.match(SWEEP_CODE, /if \(!isSearchConfigured\(\)\)/,
        'a run with no search provider would still make one model call per lead');
});

check('it skips leads where the spend is a foregone conclusion', () => {
    const fn = SWEEP_CODE.slice(landmark(SWEEP_CODE, 'async function collectCandidates'), landmark(SWEEP_CODE, 'function onboardingOf'));
    assert.match(fn, /doNotContact' IS DISTINCT FROM 'true'/, 'do-not-contact leads are re-researched');
    assert.match(fn, /'dealOutcome' IS NULL/, 'leads with a recorded outcome are re-researched — the deal is over');
    assert.match(fn, /isNotNull\(discoveredLeads\.domain\)/, 'leads with no website are researched anyway');
    assert.match(fn, /eq\(aiAssistants\.isActive, true\)/, 'deactivated assistants still cost their owner money');
    assert.match(fn, /archivedAt\} IS NULL/,
        'an archived assistant sits in its 14-day reinstate window still flagged active — isActive '
        + 'alone keeps billing for a workspace the user has closed');
    assert.match(fn, /isRetentionDeleted/,
        'retention-deleted leads are re-researched nightly, which is money spent on a graveyard');
});

check('the retention exclusion reuses the shared predicate rather than a second jsonb path', () => {
    assert.ok(!/retention,deletedAt/.test(SWEEP_CODE),
        'the sweep hand-copies the retention path into SQL. src/config/lead-retention.ts exists so '
        + 'there is one definition; a second one drifts.');
});

check('leads are processed one at a time, and one failure costs only itself', () => {
    assert.ok(!/Promise\.all\(candidates|candidates\.map\(async/.test(SWEEP_CODE),
        'the sweep fans out concurrently — four searches and a model call across 25 leads at once '
        + 'is a burst against two rate-limited third parties');
    // The window is generous because SWEEP_CODE has its comments blanked to spaces, not removed —
    // the explanatory block between the catch and the log survives as whitespace.
    assert.match(SWEEP_CODE, /catch \(err\)[\s\S]{0,800}console\.error\(`\[lead-enrich-sweep\] lead/,
        'one lead\'s failure now takes the rest of the run with it');
});

check('the run is scheduled, capped, and its cost is logged', () => {
    assert.match(TOML, /\[functions\.lead-enrichment-sweep\]/, 'the sweep is not scheduled');
    assert.match(SWEEP_CODE, /LEAD_ENRICH_SWEEP_MAX_LEADS/, 'there is no per-run lead cap');
    assert.match(SWEEP_CODE, /costGbp: Math\.round/,
        'the audit row no longer records what the run cost — the one number an operator needs');
    assert.match(SWEEP_CODE, /hitCap: candidates\.length === MAX_LEADS/,
        'nothing says whether the run was capped, so a permanent backlog would be invisible');
});

check('it runs AFTER the retention sweep', () => {
    // A lead being moved out of Outreach tonight should be moved first, not researched at cost and
    // then dropped an hour later.
    const at = (fn: string) => {
        const block = TOML.slice(TOML.indexOf(`[functions.${fn}]`));
        const m = block.match(/schedule = "(\d+) (\d+)/);
        return m ? Number(m[2]) * 60 + Number(m[1]) : -1;
    };
    const retention = at('lead-retention-sweep');
    const enrichment = at('lead-enrichment-sweep');
    assert.ok(retention > 0 && enrichment > 0, 'one of the two sweeps has no readable schedule');
    assert.ok(enrichment > retention,
        `the enrichment sweep (${enrichment} min) runs before the retention sweep (${retention} min) — `
        + 'leads would be researched at cost and then moved to Deleted an hour later');
});

console.log('\n──── 6. enrichment must not disturb the retention clock ────');

check('stamping intel does NOT touch updated_at', () => {
    // updated_at IS the 30-day retention clock (src/config/lead-retention.ts). A nightly sweep that
    // bumped it would keep every lead alive forever: the countdown would never reach zero on any
    // lead the cadence had looked at, which is every lead.
    const fn = ENRICH.slice(landmark(ENRICH, 'async function stampIntel'), ENRICH.length);
    assert.ok(!/updatedAt/.test(fn),
        'stampIntel writes updated_at. That column is the retention clock, so the nightly enrichment '
        + 'cadence would silently make every lead immortal and the 30-day sweep would collect nothing.');
});

check('a real re-score DOES touch updated_at', () => {
    // The other direction: a lead whose rating just changed has genuinely been worked, and its
    // clock should restart. The distinction is deliberate, so both halves are pinned.
    assert.match(DEEP, /updatedAt: new Date\(\)/,
        'a lead that was actually re-scored no longer restarts its retention clock');
});

console.log('\n──── 7. the on-demand button ────');

check('there is no bulk "research everything" control', () => {
    // One click costing a few hundred searches is exactly the shape of spend that needs a human
    // deciding per lead.
    assert.ok(!/data-hub-bulkenrich|bulkEnrich|Research all/i.test(HUB_CODE),
        'a bulk research control was added. Every press spends real money per lead; the batched '
        + 'path is the nightly cadence, which has an operator cap and a kill switch.');
});

check('the button reports what actually happened, not a generic success', () => {
    const fn = HUB.slice(landmark(HUB, "key: 'enrich',"), landmark(HUB, "buttons.push({ label: 'Edit'"));
    assert.match(fn, /data\.message/,
        'the button shows its own success text — only the server knows whether the rating moved');
    assert.match(fn, /state\.pendingFocusId = record\.id/,
        'the refresh collapses the panel the user is reading, so the whole visible result of the '
        + 'press would be a row quietly changing colour somewhere in a list');
    assert.match(fn, /pendingFocusTone = 'neutral'/,
        'the re-opened row flashes the RED failure ring on what is a success');
});

check('the API refuses a lead with no website rather than pretending to research it', () => {
    const action = LEADGEN.slice(
        landmark(LEADGEN, "if (action === 'enrich_lead')"),
        landmark(LEADGEN, "if (action === 'set_outcome')"),
    );
    assert.match(action, /No website is recorded for this company/,
        'a lead with no domain is accepted and silently researches nothing');
    assert.match(action, /link\?\.domain \|\| site/,
        'the domain must fall back to the record itself, or imported and hand-added leads are unreachable');
});

console.log('\n──── 8. the pass is skipped when there is nothing to interpret ────');

check('no evidence means no model call', () => {
    assert.strictEqual(hasIntelWorthScoring({
        gatheredAt: '', evidence: [], peopleSources: [],
        fingerprint: { platforms: [], hasCareersPage: false, pagesRead: [] },
        searchCallsMade: 0, costGbp: 0,
    }), false, 'an empty gather must not be sent to the model');
    assert.strictEqual(hasIntelWorthScoring({
        gatheredAt: '', evidence: [], peopleSources: [],
        fingerprint: { platforms: [], hasCareersPage: true, pagesRead: [] },
        searchCallsMade: 0, costGbp: 0,
    }), true, 'a careers page is a growth proxy and is worth interpreting');
    assert.match(DEEP, /if \(!hasIntelWorthScoring\(intel\)\)/,
        'deepEnrichLead pays for a model call over an empty evidence set');
});

check('a barren lead is stamped, so the cadence does not pay for it again nightly', () => {
    const barren = DEEP.slice(landmark(DEEP, 'if (!hasIntelWorthScoring(intel))'), landmark(DEEP, 'const rescored ='));
    assert.match(barren, /stampIntel/,
        'a lead with nothing to find is not stamped, so the nightly sweep would re-buy the same four '
        + 'searches against the same silent company for the life of the account');
});

console.log(`\n${passed} checks passed.\n`);
