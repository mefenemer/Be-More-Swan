// tests/site-audit.test.ts
// The Mystery Shopper's page reader (src/utils/site-extract.ts) and score (src/utils/site-score.ts).
// docs/mystery-shopper-plan.md §3.1, §4.3.
//
// Run:  npx tsx tests/site-audit.test.ts
//
// What matters most here, in order:
//  1. The score is DETERMINISTIC. Same page + same answers → same number, in any answer order, every
//     time. A weekly score that wobbles with nothing changed is the failure this design exists to stop.
//  2. Nothing the model quotes reaches the user unless it is on the page (grounding).
//  3. The content hash ignores what a buyer doesn't notice (footer year, testimonial order) and
//     catches what they do (headline, price) — an unchanged hash is what makes a weekly run free.
//  4. A JavaScript-only page is reported as unreadable, never scored as a bad page.
// Fixtures in tests/fixtures/site-pages/ are hand-written in the markup shape of each site builder
// (Squarespace, Wix, WordPress/Elementor+Yoast, Webflow, a Vite SPA shell, hand-coded HTML). Pure
// functions only; no network.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    extractSitePage, classifyCta, siteContentHash, diffSitePages, describeChanges,
    pickSecondaryPages, type SitePage,
} from '../src/utils/site-extract';
import { parseRobots, robotsAllowsPath, CRAWLERS } from '../src/lib/robots';
import {
    scoreAudit, scoreTaster, sanitiseRubricAnswers, groundFixes, isGrounded, rubricFor, RUBRIC,
    DETERMINISTIC_CHECKS, plainLocation, type RubricAnswer, type Lens,
} from '../src/utils/site-score';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const FIXTURES = join(__dirname, 'fixtures', 'site-pages');
const html = (name: string) => readFileSync(join(FIXTURES, `${name}.html`), 'utf8');
const URLS = {
    'squarespace-weak': 'https://northgate-consulting.example/',
    'wix-local': 'https://fastfix.example/',
    'wordpress-strong': 'https://ledgerly.example/',
    'webflow-saas': 'https://rotaly.example/',
    'spa-shell': 'https://acme.example/',
    'bare-html': 'http://hilltopkennels.example/',
} as const;
type Fixture = keyof typeof URLS;
const page = (name: Fixture, mutate?: (h: string) => string): SitePage =>
    extractSitePage(mutate ? mutate(html(name)) : html(name), URLS[name]);

const weak = page('squarespace-weak');
const wix = page('wix-local');
const strong = page('wordpress-strong');
const webflow = page('webflow-saas');
const spa = page('spa-shell');
const bare = page('bare-html');

/** Every rubric question for a lens answered the GOOD way, evidence-free. */
const allGood = (lens: Lens): RubricAnswer[] => rubricFor(lens).map((q) => ({ id: q.id, yes: q.goodAnswer, evidence: '' }));
const allBad = (lens: Lens): RubricAnswer[] => rubricFor(lens).map((q) => ({ id: q.id, yes: !q.goodAnswer, evidence: '' }));

console.log('\nExtraction — per builder');

check('Squarespace: weak hero read as written, passive CTAs found in the hero', () => {
    assert.deepStrictEqual(weak.hero.h1, ["Empowering Tomorrow's Digital Synergy Today"]);
    assert.strictEqual(weak.hero.subheadline, 'We help companies grow through tailored strategies and holistic workflows.');
    assert.deepStrictEqual(weak.hero.primaryCtas.map((c) => c.text), ['Learn More', 'Contact Us']);
    assert.strictEqual(weak.seo.description, null);
    assert.deepStrictEqual(weak.seo.schemaTypes, []);
    assert.strictEqual(weak.thin, false);
});

check('Squarespace: a quote and its attribution are ONE snippet, with a space between them', () => {
    assert.ok(weak.structure.proofSnippets.includes('"Great team to work with!" J. Smith'), JSON.stringify(weak.structure.proofSnippets));
    assert.ok(!weak.structure.proofSnippets.includes('"Great team to work with!"'), 'the bare blockquote is contained in the snippet and must be dropped');
});

check('Wix: tel: button is a CTA; trade-specific schema type (Plumber) is read', () => {
    assert.deepStrictEqual(wix.hero.primaryCtas.map((c) => c.text), ['Call 0113 000 0000', 'Book a visit']);
    assert.strictEqual(wix.hero.primaryCtas[0].href, 'tel:01130000000');
    assert.ok(wix.seo.schemaTypes.includes('Plumber'));
});

check('Wix: a slider of testimonials splits into one snippet each', () => {
    assert.strictEqual(wix.structure.proofSnippets.filter((p) => p.startsWith('"')).length, 2, JSON.stringify(wix.structure.proofSnippets));
});

check('Wix: the footer "Contact" button is not a hero CTA', () => {
    assert.ok(!wix.hero.primaryCtas.some((c) => c.text === 'Contact'));
});

check('WordPress: Yoast @graph types, schema FAQ and <details> FAQ all read', () => {
    for (const t of ['Organization', 'ProfessionalService', 'FAQPage']) assert.ok(strong.seo.schemaTypes.includes(t), t);
    assert.ok(strong.structure.faqQuestions.includes('What if we have more than 50 staff?'));
    assert.strictEqual(strong.structure.faqQuestions.length, 3, 'schema and on-page copies of the same question are one question');
});

check('WordPress: prices found; a testimonial mentioning £4,200 is NOT a price', () => {
    assert.ok(strong.structure.pricingSignals.some((p) => p.startsWith('£249/month')));
    assert.ok(!strong.structure.pricingSignals.some((p) => p.includes('£4,200')), JSON.stringify(strong.structure.pricingSignals));
});

check('Webflow: price and "Cancel anytime" in bare <div>s are still found', () => {
    assert.ok(webflow.structure.pricingSignals.includes('£19/month'), JSON.stringify(webflow.structure.pricingSignals));
    assert.ok(webflow.structure.pricingSignals.some((p) => /cancel anytime/i.test(p)));
});

check('Webflow: an image with no alt attribute is counted; alt="" would not be', () => {
    assert.strictEqual(webflow.structure.imageCount, 3);
    assert.strictEqual(webflow.structure.imagesMissingAlt, 1);
    const decorative = extractSitePage('<body><h1>Hello there all</h1><img src="a.png" alt=""><img src="b.png"></body>', 'https://x.example/');
    assert.strictEqual(decorative.structure.imagesMissingAlt, 1, 'alt="" marks a decorative image — that is correct, not missing');
});

check('SPA shell: no words, marked thin', () => {
    assert.strictEqual(spa.wordCount, 0);
    assert.strictEqual(spa.thin, true);
    assert.strictEqual(spa.seo.title, 'Acme Studio');
});

check('Bare HTML: http, no viewport, no lang, no CTA — all read as absent', () => {
    assert.strictEqual(bare.https, false);
    assert.strictEqual(bare.seo.hasViewport, false);
    assert.strictEqual(bare.seo.lang, null);
    assert.deepStrictEqual(bare.hero.primaryCtas, []);
    assert.strictEqual(bare.structure.imagesMissingAlt, 3);
});

check('Menus are left out of the body excerpt', () => {
    assert.ok(!/Log in/.test(webflow.bodyExcerpt), webflow.bodyExcerpt.slice(0, 200));
});

check('The body excerpt is capped', () => {
    const long = extractSitePage(`<html><body><h1>Hi there friend</h1>${'<p>word </p>'.repeat(3000)}</body></html>`, 'https://x.example/');
    assert.ok(long.bodyExcerpt.length <= 3500);
});

check('Secondary pages for a competitor: pricing first, then how-it-works; same host only', () => {
    assert.deepStrictEqual(pickSecondaryPages(strong), ['https://ledgerly.example/pricing/', 'https://ledgerly.example/how-it-works/']);
    const offsite = extractSitePage('<body><h1>Hello world here</h1><a href="https://g2.example/pricing">Pricing</a></body>', 'https://x.example/');
    assert.deepStrictEqual(pickSecondaryPages(offsite), []);
});

console.log('\nCTA classification');

check('passive vs outcome vs other', () => {
    const cases: Array<[string, string]> = [
        ['Learn More', 'passive'], ['Contact Us', 'passive'], ['Submit', 'passive'], ['Get in touch', 'passive'],
        ['Read more →', 'passive'], ['Book a 15-minute call', 'outcome'], ['Start your free 14-day trial', 'outcome'],
        ['See pricing', 'outcome'], ['Call 0113 000 0000', 'outcome'], ['Get my free quote', 'outcome'], ['Our story', 'other'],
    ];
    for (const [text, want] of cases) assert.strictEqual(classifyCta(text), want, text);
});

console.log('\nChange detection');

check('the same page read twice hashes the same', () => {
    assert.strictEqual(siteContentHash(page('wordpress-strong')), siteContentHash(strong));
});

check('a footer year change is NOT a change', () => {
    const later = page('wordpress-strong', (h) => h.replace('© 2026', '© 2027'));
    assert.strictEqual(siteContentHash(later), siteContentHash(strong));
});

check('reordering testimonials is NOT a change', () => {
    const swapped = page('wix-local', (h) => h.replace('Priya, Headingley', '@@P@@').replace('Mark, Roundhay', 'Priya, Headingley').replace('@@P@@', 'Mark, Roundhay')
        .replace('"Turned up in 40 minutes on a Sunday and fixed the leak for the price quoted."', '@@Q@@')
        .replace('"Honest, tidy and cheaper than the last firm."', '"Turned up in 40 minutes on a Sunday and fixed the leak for the price quoted."')
        .replace('@@Q@@', '"Honest, tidy and cheaper than the last firm."'));
    assert.strictEqual(siteContentHash(swapped), siteContentHash(wix));
});

check('a headline change IS a change, and the diff says what moved', () => {
    const next = page('squarespace-weak', (h) => h
        .replace("Empowering Tomorrow's Digital Synergy Today", 'Operations consulting for 10–50 person firms')
        .replace('<h2>Why Choose Us</h2>', '<h2>Why Choose Us</h2><p>Fixed fee from £1,500 per project.</p>'));
    assert.notStrictEqual(siteContentHash(next), siteContentHash(weak));
    const lines = describeChanges(diffSitePages(weak, next));
    assert.ok(lines.includes(`Headline changed from "Empowering Tomorrow's Digital Synergy Today" to "Operations consulting for 10–50 person firms"`), lines.join('\n'));
    assert.ok(lines.includes('Pricing added: "Fixed fee from £1,500 per project."'), lines.join('\n'));
});

check('no diff between identical reads', () => {
    assert.deepStrictEqual(diffSitePages(strong, page('wordpress-strong')), []);
});

console.log('\nrobots.txt (shared parser, src/lib/robots.ts)');

check('the Mystery Shopper obeys a group naming it, and is not bound by the lead crawler\'s group', () => {
    const robots = [
        'User-agent: *', 'Disallow: /private/', '',
        'User-agent: bemoreswan-mysteryshopper', 'Disallow: /pricing', 'Allow: /pricing/public', '',
        'User-agent: bemoreswan-leaddiscovery', 'Disallow: /', '',
    ].join('\n');
    const ours = parseRobots(robots, CRAWLERS.mysteryShopper.token);
    assert.strictEqual(robotsAllowsPath(ours, '/pricing'), false, 'our own group applies');
    assert.strictEqual(robotsAllowsPath(ours, '/pricing/public'), true, 'longer Allow wins');
    assert.strictEqual(robotsAllowsPath(ours, '/private/x'), true, 'the * group does not apply when ours exists');
    assert.strictEqual(robotsAllowsPath(ours, '/'), true, 'the lead crawler being blocked does not block us');
    assert.strictEqual(robotsAllowsPath(parseRobots(robots), '/'), false, 'the default is still the lead crawler');
});

check('a later group (another bot, or * after ours) never adds rules to ours — the 2026-10-14 parser bug', () => {
    const robots = [
        'User-agent: bemoreswan-leaddiscovery', 'Disallow: /team', '',
        'User-agent: Googlebot', 'Disallow: /', '',
        'User-agent: *', 'Disallow: /private', '',
    ].join('\n');
    const lead = parseRobots(robots);
    assert.strictEqual(robotsAllowsPath(lead, '/team'), false);
    assert.strictEqual(robotsAllowsPath(lead, '/'), true, "Googlebot's Disallow: / is not ours");
    assert.strictEqual(robotsAllowsPath(lead, '/private'), true, 'a * group after ours does not apply');
    // Consecutive User-agent lines still form one group.
    const shared = parseRobots('User-agent: googlebot\nUser-agent: bemoreswan-leaddiscovery\nDisallow: /x');
    assert.strictEqual(robotsAllowsPath(shared, '/x'), false);
});

check('our robots token is the User-Agent product name, lowercased, without the version', () => {
    assert.ok(CRAWLERS.mysteryShopper.userAgent.toLowerCase().startsWith(`${CRAWLERS.mysteryShopper.token}/`));
});

console.log('\nGrounding');

check('quotes on the page are grounded, forgiving case, whitespace and curly quotes', () => {
    assert.ok(isGrounded("Empowering Tomorrow's Digital Synergy Today", weak));
    assert.ok(isGrounded('empowering   tomorrow’s digital synergy', weak));
    assert.ok(isGrounded('“Great team to work with!”', weak));
});

check('invented or too-short quotes are not grounded', () => {
    assert.ok(!isGrounded('We are the leading consultancy in Europe', weak));
    assert.ok(!isGrounded('We', weak));
});

check('rubric answers: unknown id, duplicate, non-boolean and ungrounded evidence are all dropped', () => {
    const { answers, dropped } = sanitiseRubricAnswers({ answers: [
        { id: 'says_what', yes: false, evidence: "Empowering Tomorrow's Digital Synergy Today" },
        { id: 'says_what', yes: true, evidence: '' },                       // duplicate
        { id: 'made_up', yes: true, evidence: '' },                         // unknown
        { id: 'says_who', yes: 'no', evidence: '' },                        // not boolean
        { id: 'jargon', yes: true, evidence: 'Leveraging cloud-native AI' }, // not on the page
        { id: 'h1_generic', yes: true, evidence: '' },
    ] }, 'clarity', weak);
    assert.deepStrictEqual(answers.map((a) => a.id), ['says_what', 'h1_generic']);
    assert.strictEqual(answers[0].yes, false, 'first answer per id wins');
    assert.strictEqual(dropped, 4);
});

check('rubric answers for another lens are refused', () => {
    const { answers } = sanitiseRubricAnswers([{ id: 'category_clear', yes: true, evidence: '' }], 'clarity', weak);
    assert.deepStrictEqual(answers, []);
});

check('fixes must quote the page and change something', () => {
    const { fixes, dropped } = groundFixes([
        { location: 'Hero H1', problem: 'Generic', currentText: "Empowering Tomorrow's Digital Synergy Today", suggestedText: 'Operations consulting for 10–50 person firms' },
        { location: 'Hero H1', problem: 'Generic', currentText: 'Award-winning consultancy', suggestedText: 'Something else' },
        { location: 'CTA', problem: 'Passive', currentText: 'Learn More', suggestedText: 'learn more' },
        { location: 'CTA', problem: '', currentText: 'Learn More', suggestedText: 'Book a call' },
    ], 'clarity', weak);
    assert.strictEqual(fixes.length, 1);
    assert.strictEqual(fixes[0].suggestedText, 'Operations consulting for 10–50 person firms');
    assert.strictEqual(dropped, 3);
});

check('a fix\'s location is words, never a page-data field name (bemoreswan.com, 2026-10-18)', () => {
    assert.strictEqual(plainLocation('pricingAndGuarantees / Proof section'), 'Pricing / Proof section');
    assert.strictEqual(plainLocation('proof'), 'Testimonials');
    assert.strictEqual(plainLocation('Top button'), 'Top button');
    const { fixes } = groundFixes([{ location: 'otherButtons', problem: 'Passive', currentText: 'Learn More', suggestedText: 'Book a call' }], 'clarity', weak);
    assert.strictEqual(fixes[0].location, 'Button');
});

check('a long testimonial is shortened at a word, and still grounds', () => {
    const quote = 'I knew that posting consistently on Facebook and Instagram was key to bringing in clients, but the constant loop of writing captions, sizing images, and struggling with scheduling tools was eating up all my energy. I would post heavily for a week, then go dark.';
    const page = extractSitePage(`<body><h1>Hello there all</h1><blockquote>"${quote}"</blockquote><p>— Jane, salon owner</p></body>`, 'https://x.example/');
    const snip = page.structure.proofSnippets.find((p) => p.includes('posting consistently'))!;
    assert.ok(snip, 'the testimonial is a proof snippet');
    assert.ok(snip.endsWith('…'));
    assert.ok(quote.includes(snip.replace(/^"/, '').replace(/…$/, '')), 'cut at a whole word');
    assert.ok(!/\beating u…$/.test(snip));
    assert.ok(isGrounded(snip, page));
});

check('a fix calling OUR shortened quote "truncated" is dropped; a real rewrite of it is kept (bemoreswan.com, 2026-10-20)', () => {
    const quote = 'I knew that posting consistently on Facebook and Instagram was key to bringing in clients, but the constant loop of writing captions, sizing images, and struggling with scheduling tools was eating up all my energy. I would post heavily for a week, then go dark for a month and lose the momentum I had built.';
    const page = extractSitePage(`<body><h1>Hello there all</h1><blockquote>"${quote}"</blockquote><p>— Cat, studio founder</p></body>`, 'https://x.example/');
    const snip = page.structure.proofSnippets.find((p) => p.includes('posting consistently'))!;
    assert.ok(snip.endsWith('…'));
    const { fixes, dropped } = groundFixes([
        { location: 'Proof', currentText: snip, suggestedText: 'Something with a number in it.',
          problem: 'Truncated testimonials with no concrete result are the weakest proof on the page — completing your reviews with measurable outcomes closes the gap.' },
        { location: 'Proof', currentText: snip, suggestedText: 'Something with a number in it.',
          problem: 'The quote describes the pain but never says what changed for her.' },
        { location: 'Headline', currentText: 'Hello there all', suggestedText: 'A better headline', problem: 'The full quote style headline is vague.' },
    ], 'compete', page);
    assert.strictEqual(dropped, 1);
    assert.deepStrictEqual(fixes.map((f) => f.problem.slice(0, 9)), ['The quote', 'The full ']);
});

check('the lens prompt says our "…" is ours, and a rewrite keeps its place\'s job', () => {
    const P = readFileSync(join(__dirname, '../src/utils/site-audit-prompts.ts'), 'utf8');
    assert.match(P, /A quote ending in "…" was shortened by US/);
    assert.match(P, /Never take a passage about one thing/);
    assert.match(P, /Never a field name from the page data/);
});

console.log('\nScore');

check('rubric and check ids are unique (an answer can only ever mean one thing)', () => {
    const ids = [...RUBRIC.map((q) => q.id), ...DETERMINISTIC_CHECKS.map((c) => c.id)];
    assert.strictEqual(new Set(ids).size, ids.length);
});

check('DETERMINISTIC: same answers in any order give the same score, every time', () => {
    const answers = { clarity: allGood('clarity'), ai: allBad('ai') };
    const shuffled = { ai: [...allBad('ai')].reverse(), clarity: [...allGood('clarity')].reverse() };
    const a = scoreAudit(weak, [], answers);
    for (let i = 0; i < 5; i++) {
        assert.deepStrictEqual(scoreAudit(weak, [], answers), a);
        assert.strictEqual(scoreAudit(weak, [], shuffled).overall, a.overall);
    }
});

check('no competitors: compete lens is null and overall is clarity+ai re-weighted', () => {
    const s = scoreAudit(strong, [], { clarity: allGood('clarity'), ai: allGood('ai') });
    assert.strictEqual(s.lenses.compete.score, null);
    assert.strictEqual(s.lenses.compete.partial, false, 'a lens that cannot apply is not "partial"');
    assert.strictEqual(s.overall, 100);
});

check('a lens whose model call failed scores on code checks alone and is flagged partial', () => {
    const s = scoreAudit(weak, [], { clarity: allGood('clarity') });
    assert.strictEqual(s.lenses.ai.partial, true);
    assert.strictEqual(s.lenses.clarity.partial, false);
    assert.notStrictEqual(s.lenses.ai.score, null);
});

check('the weak page scores well below the strong one given identical answers', () => {
    const answers = { clarity: allGood('clarity'), ai: allGood('ai') };
    const w = scoreAudit(weak, [], answers).overall!;
    const s = scoreAudit(strong, [], answers).overall!;
    assert.ok(s - w >= 20, `strong ${s} vs weak ${w}`);
});

check('rubric answers move the score: all-bad < all-good on the same page', () => {
    const good = scoreAudit(webflow, [], { clarity: allGood('clarity'), ai: allGood('ai') }).overall!;
    const bad = scoreAudit(webflow, [], { clarity: allBad('clarity'), ai: allBad('ai') }).overall!;
    assert.ok(good > bad, `${good} vs ${bad}`);
});

check('a thin page scores null everywhere — never a low number', () => {
    const s = scoreAudit(spa, [], { clarity: allBad('clarity'), ai: allBad('ai') });
    assert.strictEqual(s.overall, null);
    assert.ok(Object.values(s.lenses).every((l) => l.score === null));
    assert.deepStrictEqual(s.failures, []);
});

check('competitors: a competitor showing prices fails pricing_vs for a page without them', () => {
    const s = scoreAudit(weak, [strong], { compete: allGood('compete') });
    const outcome = s.outcomes.find((o) => o.id === 'pricing_vs')!;
    assert.strictEqual(outcome.result, 'fail');
    assert.notStrictEqual(s.lenses.compete.score, null);
});

check('competitors: an unreadable (SPA) competitor is ignored, not held against the user', () => {
    const s = scoreAudit(weak, [spa], { compete: allBad('compete') });
    assert.strictEqual(s.lenses.compete.score, null);
});

check('failures are listed heaviest first, ties by id — a stable order for the tooltip', () => {
    const s = scoreAudit(bare, [], {});
    const weights = s.failures.map((f) => f.weight);
    assert.deepStrictEqual(weights, [...weights].sort((a, b) => b - a));
    assert.strictEqual(s.failures[0].id, 'has_primary_cta');
});

check('the public taster agrees with the hired score on the first-impression lens', () => {
    const t = scoreTaster(weak, allBad('clarity'));
    const full = scoreAudit(weak, [], { clarity: allBad('clarity') });
    assert.strictEqual(t.score, full.lenses.clarity.score);
    assert.ok(t.failures.every((f) => f.lens === 'clarity'));
});

console.log(`\n${passed}/${total} passed`);
