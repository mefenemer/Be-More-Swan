// tests/lead-rating-help.test.ts
// What "hot", "warm" and "cold" mean — one definition, three audiences.
//
// The bands steer the SCORING PROMPT (three of them: discovery, chat, lead-generation), and since
// the rating chips explain themselves on hover they are now also shown to USERS. That is four
// places one set of numbers has to agree. It has already drifted once — the comment on
// SCORING_BANDS records three prompt copies disagreeing, which read as an inconsistent model rather
// than a bug — so this file pins the single source and the generated browser mirror to it.
//
// Run:  npx tsx tests/lead-rating-help.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RATING_BANDS, SCORING_BANDS } from '../src/config/icp-profile';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/** Load the generated browser mirror the way a page does, and hand back window.LeadRating. */
function loadLeadRating(): {
    bands: { rating: string; min: number; max: number; meaning: string }[];
    bandFor: (score: unknown) => { rating: string } | null;
    help: (rating: string) => string;
} {
    const win: Record<string, unknown> = {};
    new Function('window', read('src/generated/platform-constants.js'))(win);
    const lr = win.LeadRating;
    assert.ok(lr, 'window.LeadRating is missing from the generated constants — run npm run gen:constants');
    return lr as ReturnType<typeof loadLeadRating>;
}

const LeadRating = loadLeadRating();

console.log('\n──── the prompt string did not change when it became derived ────');

check('SCORING_BANDS still renders exactly what the models were trained against', () => {
    // Byte-identical, deliberately. This string is pasted into three system prompts; rewording it
    // silently re-scores every lead discovered from here on, which is not a refactor.
    assert.strictEqual(
        SCORING_BANDS,
        'Scoring bands: 70-100 = "hot" (strong profile fit + buying intent), 40-69 = "warm" '
        + '(partial fit or unclear intent), 0-39 = "cold" (poor fit or no intent).',
    );
});

check('the bands partition 0-100 with no gap and no overlap', () => {
    const sorted = [...RATING_BANDS].sort((a, b) => a.min - b.min);
    assert.strictEqual(sorted[0].min, 0, 'the lowest band must start at 0');
    assert.strictEqual(sorted[sorted.length - 1].max, 100, 'the highest band must end at 100');
    for (let i = 1; i < sorted.length; i++) {
        assert.strictEqual(sorted[i].min, sorted[i - 1].max + 1,
            `a score between ${sorted[i - 1].max} and ${sorted[i].min} belongs to no band`);
    }
});

console.log('\n──── the browser mirror agrees with the rubric ────');

check('the generated mirror carries the same bands, in the same order', () => {
    assert.deepStrictEqual(LeadRating.bands.map((b) => b.rating), RATING_BANDS.map((b) => b.rating));
    for (const band of RATING_BANDS) {
        const mirrored = LeadRating.bands.find((b) => b.rating === band.rating);
        assert.ok(mirrored, `${band.rating} is missing from the mirror`);
        assert.strictEqual(mirrored!.min, band.min, `${band.rating} min drifted`);
        assert.strictEqual(mirrored!.max, band.max, `${band.rating} max drifted`);
    }
});

check('help() quotes the real thresholds, for every band', () => {
    for (const band of RATING_BANDS) {
        const help = LeadRating.help(band.rating);
        assert.ok(help.includes(String(band.min)) && help.includes(String(band.max)),
            `the ${band.rating} tooltip does not state its own ${band.min}-${band.max} range`);
        // The tooltip has to say what it was scored AGAINST. "Hot: 70-100" alone invites the reader
        // to assume some absolute quality bar rather than their own profile.
        assert.match(help, /ideal customer profile/,
            `the ${band.rating} tooltip must say the score is against the user's own profile`);
    }
});

check('an unknown rating produces no tooltip rather than a guess', () => {
    // Callers put this straight into a title attribute. An invented sentence about a rating we do
    // not have is worse than silence.
    assert.strictEqual(LeadRating.help('lukewarm'), '');
    assert.strictEqual(LeadRating.help(''), '');
});

check('bandFor maps a raw score to the band that produced the chip', () => {
    assert.strictEqual(LeadRating.bandFor(100)!.rating, 'hot');
    assert.strictEqual(LeadRating.bandFor(70)!.rating, 'hot');
    assert.strictEqual(LeadRating.bandFor(69)!.rating, 'warm');
    assert.strictEqual(LeadRating.bandFor(40)!.rating, 'warm');
    assert.strictEqual(LeadRating.bandFor(39)!.rating, 'cold');
    assert.strictEqual(LeadRating.bandFor(0)!.rating, 'cold');
    assert.strictEqual(LeadRating.bandFor(null), null);
    assert.strictEqual(LeadRating.bandFor('nope'), null);
});

console.log('\n──── the UI reads the mirror, never its own copy ────');

for (const file of ['src/components/assistant-signal-inbox.js', 'src/components/assistant-data-hub.js']) {
    check(`${file.split('/').pop()} takes its tooltip from window.LeadRating`, () => {
        const src = read(file);
        assert.ok(/window\.LeadRating/.test(src), 'the tooltip must come from the generated mirror');
        // The failure mode this guards: someone "helpfully" inlines the numbers so the tooltip works
        // without the constants script, and the fifth copy starts drifting the moment a band moves.
        assert.ok(!/70-100|70–100|0-39|0–39/.test(src),
            'a hardcoded band has appeared in the UI — read it from window.LeadRating instead');
    });
}

console.log(`\n${passed} checks passed.`);
