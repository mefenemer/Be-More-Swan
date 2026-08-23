// tests/deliverability.test.ts
// "Will this arrive?" — answered only where we actually know something.
//
// ⚠️ THE FAILURE MODE OF EVERY DELIVERABILITY FEATURE IS FALSE PRECISION. A spam score out of ten
// implies a model of the receiving filter, and nobody outside Google has one: Gmail is not
// SpamAssassin, it is not public, and it weighs sender reputation far above anything visible in the
// message. A number would be ACTED ON — somebody would rewrite working copy to move it — which
// makes inventing one worse than saying nothing.
//
// So this file mostly guards absences: no score, no trigger-word folklore, no rate quoted from a
// sample too small to mean anything, and no "you have no DMARC" when what happened was that our
// lookup failed.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import {
    BOUNCE_RATE_WARN, COMPLAINT_RATE_LIMIT, COMPLAINT_RATE_TARGET, MIN_SAMPLE_FOR_RATES,
    contentFindings, listHealthFindings, severityRank, warmupFinding, warmupLimitFor,
} from '../src/utils/deliverability';
import { dmarcAdvice } from '../src/utils/dmarc-check';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
        process.exitCode = 1;
    }
}

const MOD = read('src/utils/deliverability.ts');
// ⚠️ The structural findings MOVED here (plain .js, UMD-ish) so the browser recomputes them live
// with the same code the server runs. The "no score" reasoning moved with them.
const FINDINGS = read('src/public/newsletter-findings.js');
const DMARC = read('src/utils/dmarc-check.ts');
const DOMAIN_FN = read('netlify/functions/newsletter-sending-domain.ts');
const ISSUES = read('netlify/functions/newsletter-issues.ts');
const UI = read('newsletter.js');

const codes = (fs: { code: string }[]) => fs.map((f) => f.code);

console.log('\nDeliverability\n');

// ── 1. No score, anywhere ───────────────────────────────────────────────────

check('nothing produces a score, and the reason is written down', () => {
    assert.match(MOD, /THERE IS NO SPAM SCORE HERE, AND THERE MUST NOT BE ONE/);
    assert.match(FINDINGS, /THERE IS NO SPAM SCORE HERE AND THERE MUST NEVER BE ONE/);
    for (const f of contentFindings({ subject: 'HELLO!!!', text: 'hi', html: '' })) {
        assert.ok(!('score' in f), 'a finding must not carry a number');
    }
    // The panel neither shows a score nor mentions one — see the next check for why the
    // explanatory footnote was removed as well.
    assert.ok(!/\bscore\b/i.test(UI.slice(landmark(UI, 'function paintDeliverability'), landmark(UI, 'function renderLinks'))),
        'the panel must not present one either');
});

check('the reason there is no number lives in the code, not under every warning', () => {
    // ⚠️ THE FOOTNOTE WAS REMOVED ON PURPOSE. The panel used to end every list of findings with
    // "these are specific things we can see, not a spam score — there is no number here because
    // nobody can honestly give you one". True, and an answer to a question the reader had not
    // asked: somebody looking at "your subject line is all capitals" wants to fix the subject line.
    // The reasoning belongs where it stops a developer adding a score, which is the module.
    const fn = UI.slice(landmark(UI, 'function paintDeliverability'), landmark(UI, 'function renderLinks'));
    assert.ok(!/nobody can honestly give you one/.test(fn),
        'the explanatory footnote must not be shown to the user');
    assert.match(fn, /NO FOOTNOTE UNDER THE LIST, and do not reinstate one/,
        'and whoever reads this next must find out why it is not there');
    // The reasoning itself, in the module that would have to change for a score to exist.
    assert.match(FINDINGS, /nobody outside Google has one/);
});

check('there is no trigger-word list', () => {
    // "Free", "act now" and the rest are folklore from filters retired a decade ago. A warning
    // about the word "free" makes a tenant rewrite a good offer for no benefit.
    assert.match(FINDINGS, /NO TRIGGER-WORD LIST/);
    const findings = contentFindings({
        subject: 'Free money, act now, click here, guaranteed winner',
        text: 'x '.repeat(60),
        html: '<p>hello</p>',
    });
    assert.deepStrictEqual(codes(findings), [], 'ordinary marketing words must produce nothing');
});

// ── 2. Rates are quoted, not invented ───────────────────────────────────────

check('the thresholds are the published ones, and attributed', () => {
    assert.strictEqual(COMPLAINT_RATE_LIMIT, 0.003);
    assert.strictEqual(COMPLAINT_RATE_TARGET, 0.001);
    assert.match(MOD, /thresholds Gmail and Yahoo PUBLISHED/);
    const over = listHealthFindings({ delivered: 10000, bounced: 0, complained: 40 });
    assert.match(over[0].message, /Gmail's published limit/);
});

check('a sample too small to mean anything says so instead of showing a rate', () => {
    // ⚠️ Two bounces out of thirty is 6.7%, which reads as a crisis and is two bounces.
    const small = listHealthFindings({ delivered: 28, bounced: 2, complained: 0 });
    assert.deepStrictEqual(codes(small), ['too_few_to_judge']);
    assert.ok(!/%/.test(small[0].message), 'and it must not quote a percentage at all');
    assert.ok(MIN_SAMPLE_FOR_RATES >= 100);
});

check('over the limit is a blocker; over the target is a warning', () => {
    const limit = listHealthFindings({ delivered: 10000, bounced: 0, complained: 40 });
    assert.strictEqual(limit[0].severity, 'blocker');
    const target = listHealthFindings({ delivered: 10000, bounced: 0, complained: 15 });
    assert.strictEqual(target[0].severity, 'warning');
    assert.match(target[0].message, /under their 0\.3% limit but above/);
});

check('bounces are graded, and the advice differs', () => {
    assert.deepStrictEqual(codes(listHealthFindings({ delivered: 9400, bounced: 600, complained: 0 })), ['bounces_severe']);
    assert.deepStrictEqual(codes(listHealthFindings({ delivered: 9700, bounced: 300, complained: 0 })), ['bounces_high']);
    assert.ok(BOUNCE_RATE_WARN < 0.05);
});

check('a healthy list is told it is healthy, with the numbers', () => {
    const ok = listHealthFindings({ delivered: 5000, bounced: 20, complained: 2 });
    assert.deepStrictEqual(codes(ok), ['healthy']);
    assert.match(ok[0].message, /0\.04% marked as spam/);
});

check('rates come from the send LEDGER, not the denormalised counters', () => {
    // A counter can drift, and this is a number a tenant would act on by deleting part of a list.
    const fn = DOMAIN_FN.slice(landmark(DOMAIN_FN, "action === 'health'"), landmark(DOMAIN_FN, 'const dmarc ='));
    assert.match(fn, /from\(newsletterSends\)/);
    assert.match(fn, /Counted from the LEDGER/);
});

// ── 3. Warm-up is advice, and behaves like advice ───────────────────────────

check('a new domain has a low ceiling that rises on its own', () => {
    const now = new Date('2026-08-20T00:00:00Z');
    const today = warmupLimitFor(new Date('2026-08-20T00:00:00Z'), now);
    const week = warmupLimitFor(new Date('2026-08-13T00:00:00Z'), now);
    assert.ok(today !== null && week !== null && week > today, 'it must grow with age');
    // And it stops being stated at all once the domain is established.
    assert.strictEqual(warmupLimitFor(new Date('2026-06-01T00:00:00Z'), now), null);
});

check('nothing enforces it — it is a finding, not a refusal', () => {
    assert.match(MOD, /GUIDANCE, NOT A RULE, and nothing enforces it/);
    const f = warmupFinding({ verifiedAt: new Date(), recipientCount: 8000 });
    assert.strictEqual(f!.severity, 'warning', 'never a blocker');
    assert.match(f!.message, /safer maximum for today/);
    assert.match(f!.message, /protects the domain your ordinary email uses/);
});

check('a send inside the ceiling says nothing at all', () => {
    assert.strictEqual(warmupFinding({ verifiedAt: new Date(), recipientCount: 50 }), null);
    assert.strictEqual(warmupFinding({ verifiedAt: new Date('2020-01-01'), recipientCount: 500000 }), null,
        'an established domain has no ceiling worth stating');
});

check('warm-up only applies to a verified domain', () => {
    // A mailbox send is capped at a small list anyway and has no reputation of its own.
    // ⚠️ The end landmark is searched FROM the start one. Unanchored it took the FIRST
    // `return json(200, {` in the file, which stopped being the one that closes this block the day
    // an earlier branch was added to the same handler (the calendar feed) — and a slice whose end
    // precedes its start is '', so every assertion below passed vacuously... except that
    // assert.match on '' fails loudly. It failed the right way here; the same shape silently
    // reports "N checks passed" when the assertions are negative ones.
    const start = landmark(ISSUES, 'const [verifiedDomain]');
    const fn = ISSUES.slice(start, landmark(ISSUES, 'return json(200, {', start));
    assert.match(fn, /status, 'verified'/);
    assert.match(fn, /verifiedDomain\s*\n?\s*\? warmupFinding|verifiedDomain$/m);
});

// ── 4. Message findings ─────────────────────────────────────────────────────

check('a shouting subject and repeated punctuation are named', () => {
    assert.ok(codes(contentFindings({ subject: 'LAST CHANCE TODAY', text: 'x '.repeat(60), html: '' })).includes('subject_shouting'));
    assert.ok(codes(contentFindings({ subject: 'Last chance!!!', text: 'x '.repeat(60), html: '' })).includes('subject_punctuation'));
    // A normal subject is left alone.
    assert.deepStrictEqual(codes(contentFindings({ subject: 'Our September opening hours', text: 'x '.repeat(60), html: '' })), []);
});

check('an all-but-empty email is flagged, and says why it matters to a reader', () => {
    const f = contentFindings({ subject: 'Hello', text: 'Hi there', html: '<img><img><img>' });
    const thin = f.find((x) => x.code === 'thin_text');
    assert.ok(thin);
    assert.match(thin!.message, /blocks images/);
});

check('findings are ordered worst-first', () => {
    const f = [
        { code: 'a', severity: 'note' as const, message: '' },
        { code: 'b', severity: 'blocker' as const, message: '' },
        { code: 'c', severity: 'warning' as const, message: '' },
    ].sort((x, y) => severityRank(x) - severityRank(y));
    assert.deepStrictEqual(codes(f), ['b', 'c', 'a']);
    assert.match(ISSUES, /severityRank\(a\) - severityRank\(b\)/);
});

check('the report is shown while it can still be acted on', () => {
    // On a sent issue it is a post-mortem; on a draft it is a decision.
    const fn = UI.slice(landmark(UI, 'function renderDeliverability'), landmark(UI, 'function renderLinks'));
    assert.match(fn, /\['sending', 'sent'\]\.includes\(issue\.status\)/);
    assert.match(fn, /if \(!list \|\| !list\.length\)/, 'and nothing to say shows nothing');
});

check('the structural findings are recomputed as the author types', () => {
    // ⚠️ THE BUG THIS CLOSES: "there are only 0 words of text" arrived with the issue and never
    // moved again, so it sat under a finished draft until somebody reloaded the page — a warning
    // that was wrong about the very thing the author was looking at.
    assert.match(UI, /function recomputeFindings/);
    assert.match(UI, /\['nl-subject', 'nl-body'\]\.forEach[\s\S]{0,220}recomputeFindings\(\)/,
        'the subject and the body both drive it');
    // ⚠️ And so does the design canvas, or a designed issue reports the word count it had on load.
    assert.match(UI, /onChange: \(\) => \{[\s\S]{0,400}recomputeFindings\(\);/);
    // ⚠️ And it recomputes with the SAME module the server runs, not a hand-written copy.
    assert.match(UI, /window\.NewsletterFindings\.contentFindings/);
    assert.match(read('src/utils/deliverability.ts'), /from '\.\.\/public\/newsletter-findings\.js'/);
    assert.match(read('workspace.html'), /src\/public\/newsletter-findings\.js/, 'and the browser loads that exact file');
});

check('the warm-up warning survives a keystroke', () => {
    // It depends on the audience size and the age of the sending domain, which the browser cannot
    // recompute. Dropping it on the first keystroke would make a real warning vanish exactly when
    // somebody started working — so the structural codes are named and everything else is kept.
    assert.match(UI, /STRUCTURAL_CODES/);
    assert.match(UI, /serverOnlyFindings = list\.filter/);
    assert.ok(!/warmup_exceeded/.test(UI), 'by listing what IS structural, not what is not');
});

// ── 5. DMARC ────────────────────────────────────────────────────────────────

check('a failed lookup is never reported as a missing record', () => {
    // ⚠️ "You have no DMARC" when the truth is "our DNS call timed out" sends somebody to edit
    // their DNS for no reason.
    const err = dmarcAdvice({ found: false, policy: null, record: null, error: 'boom' });
    assert.strictEqual(err.severity, 'note');
    assert.match(err.message, /our lookup failing, not a problem with your domain/);
});

check('a missing record is a warning with the exact record to add', () => {
    const none = dmarcAdvice({ found: false, policy: null, record: null });
    assert.strictEqual(none.severity, 'warning');
    assert.match(none.message, /v=DMARC1; p=none/);
    assert.match(none.message, /Gmail and Yahoo require bulk senders/);
});

check('p=none is acknowledged as sufficient, with the next step', () => {
    const advice = dmarcAdvice({ found: true, policy: 'none', record: 'v=DMARC1; p=none' });
    assert.strictEqual(advice.severity, 'note');
    assert.match(advice.message, /satisfies the bulk sender requirements/);
    assert.match(advice.message, /p=quarantine/);
});

check('the lookup walks up to the root domain', () => {
    // A record on acme.com covers mail.acme.com; reporting "none" for the subdomain would send a
    // tenant to add something they do not need.
    assert.match(DMARC, /Checked on the ROOT domain, not the sending subdomain/);
    assert.match(DMARC, /candidates\.push\(parent\)/);
});

check('a DNS answer of "nothing here" keeps walking; a real failure stops', () => {
    assert.match(DMARC, /ENOTFOUND' \|\| code === 'ENODATA'/);
    assert.match(DMARC, /must not be shown as "you have no DMARC"/);
});

check('the health report is readable by any role in the org', () => {
    // The person who acts on "2.1% bounced" is often the one writing the issues, not the owner.
    assert.match(DOMAIN_FN, /readable by ANY role in the org/);
    const fn = DOMAIN_FN.slice(landmark(DOMAIN_FN, "action === 'health'"), landmark(DOMAIN_FN, 'const [domain]'));
    assert.ok(!/roles: ROLES/.test(fn));
});

console.log(`\n${passed} checks passed.`);
