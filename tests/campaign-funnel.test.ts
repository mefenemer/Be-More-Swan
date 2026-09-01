// tests/campaign-funnel.test.ts
// The Campaign Assistant's ROI funnel: the arithmetic, and — mostly — the things it refuses to say.
//
// Why this file is shaped the way it is: a funnel is the easiest surface in a product to lie with,
// because every missing number has a plausible-looking zero sitting next to it. This repo has paid
// for that twice (follower counts rendered a figure LinkedIn never supplies; SMART Goals shipped a
// progress bar wired to nothing), so most of the checks below assert that something is NULL,
// ABSENT, or accompanied by a caveat — not that a sum is correct.
//
// No database: pure functions plus source-consistency checks on the endpoint.
// Run:  npx tsx tests/campaign-funnel.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import {
    attributionCaveat, buildCampaignFunnel, emptyCampaignFunnel, formatGbp, ratio,
    type CampaignFunnelCounts,
} from '../src/utils/campaign-funnel';

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
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const counts = (over: Partial<CampaignFunnelCounts> = {}): CampaignFunnelCounts => ({
    campaignsTotal: 1, linksActive: 2,
    clicks: 100, botClicks: 0,
    contactsAttributed: 0, leadsAttributed: 0, recordsAttributed: 0,
    unattributedConversions: 0,
    won: 0, lost: 0, valueWonGbp: 0, revenueTrackableSubjects: 0,
    workSpent: 0, moneySpentGbp: 0,
    ...over,
});
const stage = (p: ReturnType<typeof buildCampaignFunnel>, key: string) =>
    p.stages.find((s) => s.key === key)!;

console.log('\n──── a number we cannot know is null, never zero ────');

check('cost per conversion is UNDEFINED at zero spend, not £0.00', () => {
    // The zero-spend case is EVERY campaign in the product today, so this is the default path.
    // "£0.00 per lead" reads as astonishingly good and is exactly what "no spend data" would
    // otherwise look like.
    const p = buildCampaignFunnel(counts({ contactsAttributed: 5 }));
    assert.strictEqual(p.rates.costPerConversion, null);
});

check('cost per conversion becomes real the moment spend does', () => {
    // The arithmetic has to be right on the day paid campaigns unlock, not written then.
    const p = buildCampaignFunnel(counts({ moneySpentGbp: 500, contactsAttributed: 10 }));
    assert.strictEqual(p.rates.costPerConversion, 50);
});

check('revenue reads "Not tracked", not £0, when nothing can carry revenue', () => {
    // ⚠️ revenue_events keys on discovered_lead_id, so a funnel full of newsletter contacts has NO
    // revenue path — not a zero. "£0" would say the campaign earned nothing; the truth is we
    // cannot see. Different sentence, different decision about whether to keep spending.
    const p = buildCampaignFunnel(counts({ contactsAttributed: 40, revenueTrackableSubjects: 0 }));
    assert.strictEqual(stage(p, 'won').value, null);
    assert.equal(stage(p, 'won').display, 'Not tracked');
    assert.match(stage(p, 'won').note, /carries revenue/);
});

check('but a real zero stays a zero when revenue WAS trackable', () => {
    // Leads that could have converted and did not is a measurement, and must not be hidden behind
    // the same "not tracked" wording as an absent capability.
    const p = buildCampaignFunnel(counts({ leadsAttributed: 8, revenueTrackableSubjects: 8, won: 0, lost: 3 }));
    assert.strictEqual(stage(p, 'won').value, 0);
    assert.equal(stage(p, 'won').display, '£0');
    assert.match(stage(p, 'won').note, /0 deals won, 3 lost/);
});

check('ratio never returns Infinity, NaN or a fake zero', () => {
    assert.strictEqual(ratio(5, 0), null);
    assert.strictEqual(ratio(0, 0), null);
    assert.strictEqual(ratio(5, -1), null);
    assert.strictEqual(ratio(NaN, 5), null);
    assert.strictEqual(ratio(3, 6), 0.5);
});

console.log('\n──── the win rate is denominated in what could actually win ────');

check('conversionToWon divides by revenue-trackable subjects, not all conversions', () => {
    // ⚠️ The subtle one. Dividing wins by a total that includes newsletter contacts — which can
    // never produce a `won` — reports a win rate that FALLS every time a campaign succeeds at
    // signing people up. The metric would punish the thing it is meant to reward.
    const p = buildCampaignFunnel(counts({
        contactsAttributed: 90, leadsAttributed: 10, revenueTrackableSubjects: 10, won: 5,
    }));
    assert.strictEqual(p.rates.conversionToWon, 0.5, 'win rate is being diluted by untrackable conversions');
});

check('click-to-conversion counts every conversion, because every one came from a click', () => {
    const p = buildCampaignFunnel(counts({ clicks: 200, contactsAttributed: 8, leadsAttributed: 2 }));
    assert.strictEqual(p.rates.clickToConversion, 0.05);
});

check('no clicks means no rate, not a zero rate', () => {
    const p = buildCampaignFunnel(counts({ clicks: 0 }));
    assert.strictEqual(p.rates.clickToConversion, null);
});

console.log('\n──── a stage we can never fill is absent, not empty ────');

check('there is no impressions row', () => {
    // Nothing in this system can observe an impression — it needs an ad network's reporting API,
    // and none is connected. "Impressions: 0" is a permanent accusation against a campaign that is
    // working fine.
    const p = buildCampaignFunnel(counts());
    assert.deepEqual(p.stages.map((s) => s.key), ['spend', 'clicks', 'conversions', 'won']);
});

check('what is missing is listed WITH the reason', () => {
    // An empty surface must say why it is empty and what would fill it.
    const p = buildCampaignFunnel(counts());
    const keys = p.unavailable.map((u) => u.key);
    assert.deepEqual(keys.sort(), ['ad_spend', 'impressions']);
    for (const u of p.unavailable) {
        assert.ok(u.reason.length > 20, `${u.key} has no real reason`);
        // ⚠️ Never "coming soon". These are blocked on approvals we do not control, and a date we
        // cannot keep is worse than an honest blocker.
        assert.ok(!/coming soon|shortly|soon/i.test(u.reason), `${u.key} promises a timeline`);
    }
});

console.log('\n──── the blind spot is reported, not absorbed ────');

check('unattributed conversions are counted and never folded into the total', () => {
    const p = buildCampaignFunnel(counts({ contactsAttributed: 12, unattributedConversions: 30 }));
    assert.equal(p.attribution.attributed, 12);
    assert.equal(p.attribution.unattributed, 30);
    assert.strictEqual(stage(p, 'conversions').value, 12, 'the unattributed leaked into the headline');
});

check('coverage is the honest share, and null when there is nothing to cover', () => {
    const p = buildCampaignFunnel(counts({ contactsAttributed: 25, unattributedConversions: 75 }));
    assert.strictEqual(p.attribution.coverage, 0.25);
    assert.strictEqual(buildCampaignFunnel(counts()).attribution.coverage, null);
});

check('the caveat names the gap and its causes, in plain words', () => {
    const many = attributionCaveat(10, 30);
    assert.match(many, /30 conversions/);
    assert.match(many, /not counted above/);
    assert.match(many, /device/, 'the caveat should say WHY the trail breaks');
    // The all-unattributed case is the one most likely to look like a broken product.
    assert.match(attributionCaveat(0, 12), /none of them are counted above/);
});

check('a clean period says so, rather than staying silent', () => {
    assert.match(attributionCaveat(9, 0), /Every conversion/);
    assert.match(attributionCaveat(0, 0), /No conversions recorded yet/);
});

console.log('\n──── the notes under each figure say something true ────');

check('bots are named in the clicks note, never added to the number', () => {
    const p = buildCampaignFunnel(counts({ clicks: 40, botClicks: 12 }));
    assert.strictEqual(stage(p, 'clicks').value, 40, 'bot traffic reached the headline click count');
    assert.match(stage(p, 'clicks').note, /12 automated visits excluded/);
});

check('conversions are broken down, so "12" is not an unexplained number', () => {
    const p = buildCampaignFunnel(counts({ contactsAttributed: 9, leadsAttributed: 3 }));
    assert.match(stage(p, 'conversions').note, /9 subscribers/);
    assert.match(stage(p, 'conversions').note, /3 leads/);
});

check('an empty funnel explains itself instead of showing four zeroes', () => {
    const p = emptyCampaignFunnel();
    assert.equal(p.hasData, false);
    assert.match(stage(p, 'conversions').note, /Nothing tied back to a click yet/);
    assert.match(stage(p, 'clicks').note, /No tracked links yet/);
});

check('the spend note names the budget that IS being spent', () => {
    // A campaign showing "£0" with no further words reads as a campaign doing nothing.
    const p = buildCampaignFunnel(counts({ workSpent: 14 }));
    assert.match(stage(p, 'spend').note, /No ad spend/);
    assert.match(stage(p, 'spend').note, /14 work items/);
});

check('money is formatted consistently', () => {
    assert.equal(formatGbp(0), '£0');
    assert.equal(formatGbp(1000), '£1,000');
    assert.equal(formatGbp(49.5), '£49.50');
});

console.log('\n──── the endpoint gathers what the arithmetic assumes ────');

const api = read('netlify/functions/get-campaign-funnel.ts');

check('no campaigns returns before any inArray', () => {
    // ⚠️ drizzle renders inArray([]) as `in ()`, which Postgres rejects. Not a harmless no-op.
    assert.ok(
        landmark(api, 'if (ids.length === 0) return json(emptyCampaignFunnel());') < landmark(api, 'inArray(campaignClickEvents.campaignId, ids)'),
        'an empty campaign list now reaches an inArray',
    );
});

check('every count is ::int and every sum is ::float8', () => {
    // postgres-js returns bigint counts and numerics as STRINGS; "12" + 1 is "121".
    const counts_ = api.match(/count\(\*\)[^`]*?::int/g) || [];
    assert.ok(counts_.length >= 5, `expected every count cast, found ${counts_.length}`);
    const sums = api.match(/sum\([^)]*\)[^`]*?::float8/g) || [];
    assert.ok(sums.length >= 2, `expected every sum cast, found ${sums.length}`);
});

check('the revenue join is pinned to the ONE subject type that has revenue', () => {
    // Without the subject_type predicate this is the polymorphic-key bug: it would join a
    // discovered_lead id against an audience_contact id that happens to match.
    const join = api.slice(landmark(api, '.innerJoin(campaignAttributions'), landmark(api, '.groupBy(revenueEvents.outcome)'));
    assert.match(join, /eq\(campaignAttributions\.subjectType, 'discovered_lead'\)/);
    assert.match(join, /eq\(revenueEvents\.organisationId, orgId\)/, 'the revenue query lost its org scope');
});

check('revenueTrackableSubjects is the lead count, not the conversion count', () => {
    assert.match(api, /revenueTrackableSubjects: leadsAttributed,/);
});

check('the unattributed count is floored at the first tracked click', () => {
    // Counting contacts from before tracking existed would report a permanent, meaningless
    // "failure to attribute" for a period when nothing could have been attributed.
    assert.match(api, /gte\(audienceContacts\.createdAt, firstClickAt\)/);
    assert.match(api, /const \[unattributedRow\] = firstClickAt/);
});

check('the endpoint is IDOR-guarded and scoped to the session org', () => {
    assert.match(api, /eq\(aiAssistants\.organisationId, orgId\)/);
    assert.match(api, /eq\(campaigns\.organisationId, orgId\)/);
});

check('it is lifetime — no window parameter to cliff-drop at rollover', () => {
    assert.ok(!/queryStringParameters\?\.days/.test(api), 'a window parameter appeared');
});

console.log('\n──── the renderer does not undo the arithmetic\'s honesty ────');

const ui = read('src/components/assistant-campaigns.js');

check('a null value renders the server\'s own display string, never coerced to 0', () => {
    // ⚠️ The whole point of the null, defeated in three characters. `s.value || 0` would turn
    // "Not tracked" into "0" and tell the user their campaign earned nothing.
    const fn = ui.slice(landmark(ui, 'function funnelStage('), landmark(ui, 'function pct('));
    assert.match(fn, /const known = s\.value !== null && s\.value !== undefined/);
    assert.match(fn, /esc\(s\.display\)/, 'the stage stopped rendering the server-formatted value');
    assert.ok(!/s\.value \|\| 0/.test(fn), 'a null value is being coerced to zero');
});

check('a rate we could not compute is an em dash, not 0%', () => {
    const fn = ui.slice(landmark(ui, 'function pct('), landmark(ui, 'function funnelHtml('));
    assert.match(fn, /\(v === null \|\| v === undefined\) \? '—'/);
});

check('the funnel renders nothing at all rather than a row of dashes', () => {
    // A load failure or an unstarted assistant must not leave a skeleton panel above the tab's own
    // empty state — that reads as broken rather than as "not started".
    assert.match(ui, /if \(state\.funnelError \|\| !state\.funnel \|\| !state\.funnel\.hasData\) return '';/);
});

check('the attribution caveat is rendered verbatim and unconditionally', () => {
    // The honesty claim lives in this sentence. It must not be behind a "only if it looks bad"
    // condition, and it must not be re-worded client-side.
    const fn = ui.slice(landmark(ui, 'function funnelHtml('), landmark(ui, '── Tracked links'));
    assert.match(fn, /\$\{a\.caveat \? `[\s\S]{0,200}esc\(a\.caveat\)/);
});

check('what cannot be shown is rendered with its reason', () => {
    const fn = ui.slice(landmark(ui, 'function funnelHtml('), landmark(ui, '── Tracked links'));
    assert.match(fn, /esc\(u\.label\)/);
    assert.match(fn, /esc\(u\.reason\)/, 'the blocker reason stopped being rendered');
});

check('the funnel never blocks the campaign list', () => {
    // It reads five tables and joins the revenue ledger. Awaiting it would leave the user on
    // "Loading campaigns…" while the part they came for was already in hand.
    assert.match(ui, /rerender\(\);\n    loadFunnel\(\);/);
});

console.log('\n──── the tracked-link form ────');

check('the medium picker reads the GENERATED vocabulary, never a local copy', () => {
    // A client-side fork of a closed vocabulary is how the browser's private cadence regex came to
    // disagree with the scheduler for weeks.
    assert.match(ui, /const mediums = \(C\(\) && C\(\)\.linkMediums\) \|\| \[\];/);
    assert.match(read('src/generated/platform-constants.js'), /linkMediums: CAMPAIGN_LINK_MEDIUMS/);
});

check('a failed create does NOT re-render, so the typed address survives', () => {
    // render() rewrites the whole tab's innerHTML. Re-rendering on failure hands the user an error
    // and an empty box to retype the URL into.
    const branch = ui.slice(landmark(ui, "sayLink(id, err.message || 'Could not create that link."), landmark(ui, "/** Status line under one campaign's link form. */"));
    assert.ok(!/render\(\)/.test(branch), 'a failed link creation now wipes the form');
});

check('the link status line pins style.display, not just the class', () => {
    // `hidden` loses to a class that sets display — the trap the tab badge above already documents.
    const fn = ui.slice(landmark(ui, 'function sayLink('), landmark(ui, 'document.addEventListener(\'change\''));
    assert.match(fn, /el\.style\.display = '';/);
});

check('the paid-only network box toggles BOTH the class and the inline style', () => {
    const fn = ui.slice(landmark(ui, "const sel = e.target.closest('[data-cmp-link-medium]')"), landmark(ui, '── Writes made from outside this tab'));
    assert.match(fn, /net\.classList\.toggle\('hidden', !paid\)/);
    assert.match(fn, /net\.style\.display = paid \? '' : 'none'/);
});

check('archiving states the consequence and that the history is kept', () => {
    // A tracked link may already be printed in an advert. "It stops working" is the fact the user
    // needs before they act, and "the clicks are kept" stops archive reading as a way to erase
    // results.
    const c = ui.slice(landmark(ui, "const ok = window.confirm(\n        'Archive this link?"), landmark(ui, 'archBtn.disabled = true;'));
    assert.match(c, /stop working immediately/);
    assert.match(c, /already recorded are kept/);
});

check('every rendered server value is escaped', () => {
    // The destination URL and label are tenant-supplied and land in innerHTML.
    const row = ui.slice(landmark(ui, 'function linkRow('), landmark(ui, 'function linksPanel('));
    for (const field of ['l.label || l.destinationUrl', 'l.medium', 'l.network']) {
        assert.ok(row.includes(`esc(${field})`), `${field} reaches innerHTML unescaped`);
    }
});

check('the money rate carries a currency symbol', () => {
    // "50.00 per conversion" beside "3.2 work items each" reads as two counts of the same kind of
    // thing. This is the only figure on the panel denominated in real money.
    assert.match(ui, /`£\$\{esc\(String\(r\.costPerConversion\.toFixed\(2\)\)\)\} per conversion`/);
});

console.log(`\n${passed} checks passed.\n`);
