// tests/lead-site-watch.test.ts
// Why now Phase 2, website + US part, built ON the Watch list (buying triggers Phase 2).
//
// WHY THIS EXISTS. These checks run every few days on every Lead Generator, unattended, and write "a
// reason to get in touch" onto leads a user then calls. What could go wrong, each held here:
//   1. ANNOUNCING HISTORY — the first look at a team page, careers page or SEC filer is a baseline. §1, §3.
//   2. SAYING MORE THAN THE PAGE — fixed wording; every signal has a link, a date and a unique ref. §1–§3.
//   3. NAMING THE WRONG COMPANY — the SEC match needs the same name AND a state on the lead's own site. §3.
//   4. WATCHING WHAT MUST NOT BE WATCHED — erased, do-not-contact, lost, deleted, turned down. §4.
//   5. BECOMING A SECOND SYSTEM — it must share the Watch list's switch, run, note, tab and lead write. §5.
//   6. WATCH NEWS NOT REACHING WHY NOW — Companies House and website news both set the lead's Why now. §6.
//
// No database, no network. Run:  npx tsx tests/lead-site-watch.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
    resolveLeadCountry, newTeamPeople, teamSignal, careersChanges, chooseEdgarFiler, usStatesInText,
    parseEdgarSubmissions, edgarFilingsSince, formDAmount, edgarSignal, normaliseUsCompanyName,
    nextSiteCheckDays, NO_CAREERS, SITE_CHECK_EVERY_DAYS, SITE_RECHECK_AFTER_POSITIVE_DAYS,
} from '../src/config/lead-site-watch';
import {
    extractTeamPeople, extractJobTitles, detectJobBoard, parseJobBoard, parseEdgarSearch, listHash,
} from '../src/lib/lead-watch-sources';
import { planSiteRows, leadDomain, type SiteCandidate } from '../src/utils/lead-site-watch';
import { groupForRollUp, rollUpText } from '../src/utils/lead-watch';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const TODAY = '2026-11-16';

console.log('\n──── 1. Team page ────');

check('team: first look silent; then only people not seen before, with a unique ref', () => {
    const now = [{ name: 'Jane Smith', title: 'Managing Director' }, { name: 'Raj Patel', title: 'Head of Sales' }];
    assert.deepStrictEqual(newTeamPeople(null, now), []);
    const fresh = newTeamPeople(['jane smith'], now);
    assert.deepStrictEqual(fresh.map((p) => p.name), ['Raj Patel']);
    const s = teamSignal(fresh[0], 'https://x.example/team', TODAY);
    assert.deepStrictEqual([s.text, s.ref, s.direction, s.occurredOn, s.source],
        ['New on their team page: Raj Patel, Head of Sales', 'team:raj patel', 'positive', TODAY, 'team_page']);
});

check('team page people are read without a model, and only with a senior title', () => {
    const html = `<html><body><nav>Our Team</nav>
      <div class="card"><h3>Jane Smith</h3><p>Managing Director</p></div>
      <div class="card"><h3>Raj Patel</h3><p>Head of Sales</p></div>
      <div class="card"><h3>Sam Lee</h3><p>Apprentice</p></div>
      <p>Tom Hardy – Founder</p>
      <h2>Meet The Team</h2><p>Lovely people</p>
      <footer><p>Bob Jones, Director</p></footer></body></html>`;
    const names = extractTeamPeople(html).map((p) => `${p.name} | ${p.title}`);
    assert.ok(names.includes('Jane Smith | Managing Director'));
    assert.ok(names.includes('Raj Patel | Head of Sales'));
    assert.ok(names.includes('Tom Hardy | Founder'));
    assert.ok(!names.some((n) => n.startsWith('Sam Lee')), 'an apprentice is not a decision-maker');
    assert.ok(!names.some((n) => n.startsWith('Meet')), 'a heading is not a person');
    assert.ok(!names.some((n) => n.startsWith('Bob Jones')), 'footers are skipped');
});

console.log('\n──── 2. Careers page and job boards ────');

check('careers: first look silent; none → some = "Started a careers page"; new titles = "Now hiring"', () => {
    const jobs = [{ title: 'Sales Executive', url: 'https://x.example/jobs/1', date: '2026-11-12' }, { title: 'Office Manager', url: null, date: null }];
    assert.deepStrictEqual(careersChanges(null, null, 'h', jobs, 'https://x.example/careers', TODAY), []);
    const started = careersChanges(NO_CAREERS, null, 'h', jobs, 'https://x.example/careers', TODAY);
    assert.deepStrictEqual(started.map((s) => [s.text, s.ref]), [['Started a careers page', 'careers:started']]);
    const fresh = careersChanges('old', ['Office Manager'], 'new', jobs, 'https://x.example/careers', TODAY);
    assert.deepStrictEqual(fresh.map((s) => [s.text, s.occurredOn, s.url, s.ref]),
        [['Now hiring: Sales Executive', '2026-11-12', 'https://x.example/jobs/1', 'job:sales executive']]);
    assert.deepStrictEqual(careersChanges('old', [], NO_CAREERS, [], null, TODAY), [], 'a careers page disappearing is not a reason to call');
});

check('careers page titles are read without a model; buttons and boilerplate are not jobs', () => {
    const html = `<body><h1>Careers</h1><h3>Sales Executive</h3><h3>Trainee Electrician</h3>
      <a href="/apply">Apply now</a><li>Join our team today</li><p>We value our people</p></body>`;
    assert.deepStrictEqual(extractJobTitles(html), ['Sales Executive', 'Trainee Electrician']);
});

check('job boards are detected and their public JSON parsed', () => {
    assert.deepStrictEqual(detectJobBoard('<a href="https://boards.greenhouse.io/acmeco">Jobs</a>'), { kind: 'greenhouse', id: 'acmeco' });
    assert.deepStrictEqual(detectJobBoard('<a href="https://jobs.lever.co/acme">'), { kind: 'lever', id: 'acme' });
    assert.deepStrictEqual(detectJobBoard('src="https://jobs.ashbyhq.com/Acme%20Co"'), { kind: 'ashby', id: 'Acme Co' });
    assert.deepStrictEqual(detectJobBoard('https://apply.workable.com/acme/'), { kind: 'workable', id: 'acme' });
    assert.strictEqual(detectJobBoard('<a href="/careers">'), null);
    assert.deepStrictEqual(parseJobBoard('greenhouse', { jobs: [{ title: 'AE', absolute_url: 'https://g/1', first_published: '2026-11-01T10:00:00Z' }] }),
        [{ title: 'AE', url: 'https://g/1', date: '2026-11-01' }]);
    assert.deepStrictEqual(parseJobBoard('lever', [{ text: 'SDR', hostedUrl: 'https://l/1', createdAt: Date.parse('2026-10-02T00:00:00Z') }]),
        [{ title: 'SDR', url: 'https://l/1', date: '2026-10-02' }]);
    assert.deepStrictEqual(parseJobBoard('ashby', { jobs: [{ title: 'Ops', jobUrl: 'https://a/1', publishedAt: '2026-09-09' }] }),
        [{ title: 'Ops', url: 'https://a/1', date: '2026-09-09' }]);
    assert.deepStrictEqual(parseJobBoard('lever', { not: 'an array' }), []);
});

check('the careers fingerprint ignores order and case', () => {
    assert.strictEqual(listHash(['A', 'b']), listHash(['B', 'a']));
    assert.notStrictEqual(listHash(['A']), listHash(['A', 'B']));
});

check('a lead that just moved is looked at sooner', () => {
    assert.strictEqual(nextSiteCheckDays([]), SITE_CHECK_EVERY_DAYS);
    assert.strictEqual(nextSiteCheckDays(careersChanges(NO_CAREERS, null, 'h', [], 'https://x/c', TODAY)), SITE_RECHECK_AFTER_POSITIVE_DAYS);
});

console.log('\n──── 3. US: SEC Form D, matched strictly ────');

check('country: Companies House → gb; else the search; else the web address; never the name', () => {
    assert.strictEqual(resolveLeadCountry({ chNumber: '01234567', searchCountry: 'us', domain: 'x.com' }), 'gb');
    assert.strictEqual(resolveLeadCountry({ searchCountry: 'us', domain: 'joesplumbing.com' }), 'us');
    assert.strictEqual(resolveLeadCountry({ domain: 'bloom.co.uk' }), 'gb');
    assert.strictEqual(resolveLeadCountry({ domain: 'acme.us' }), 'us');
    assert.strictEqual(resolveLeadCountry({ domain: 'acme.com' }), null);
});

check('US states are read only from addresses (code + ZIP)', () => {
    assert.deepStrictEqual(usStatesInText('Visit us at 1 Main St, Austin, TX 78701. Call now!'), ['TX']);
    assert.deepStrictEqual(usStatesInText('We are OK, IN fact great'), []);
    assert.deepStrictEqual(usStatesInText('London, UK SW1A 1AA'), []);
});

check('EDGAR: the same name AND a state on their site, or no link at all', () => {
    const hits = parseEdgarSearch({ hits: { hits: [
        { _source: { ciks: ['1234567'], display_names: ['Acme Plumbing, Inc.  (CIK 0001234567)'], biz_states: ['TX'] } },
        { _source: { ciks: ['7654321'], display_names: ['Acme Plumbing LLC  (CIK 0007654321)'], biz_states: ['OH'] } },
    ] } });
    assert.strictEqual(hits[0].cik, '0001234567');
    assert.strictEqual(chooseEdgarFiler('Acme Plumbing', hits, ['TX'])?.cik, '0001234567');
    assert.strictEqual(chooseEdgarFiler('Acme Plumbing', hits, ['CA']), null, 'name matches, state does not → no link');
    assert.strictEqual(chooseEdgarFiler('Acme Plumbing', hits, []), null, 'no state on their site → no link');
    assert.strictEqual(chooseEdgarFiler('Acme Plumbing', hits, ['TX', 'OH']), null, 'two filers pass → ambiguous → no link');
    assert.strictEqual(normaliseUsCompanyName('ACME PLUMBING, L.L.C.'), 'acme plumbing');
});

check('Form D: first look is a baseline; then a new D is "Raised $…" with the SEC link, filing date and ref', () => {
    const subs = parseEdgarSubmissions({ filings: { recent: {
        accessionNumber: ['0001-26-000003', '0001-26-000002', '0001-25-000001'],
        form: ['D', '10-Q', 'D'], filingDate: ['2026-11-12', '2026-10-01', '2025-05-01'],
        primaryDocument: ['primary_doc.xml', 'q.htm', 'primary_doc.xml'],
    } } });
    assert.deepStrictEqual(edgarFilingsSince(subs, null).fresh, [], 'first look');
    const { fresh, newest } = edgarFilingsSince(subs, '0001-26-000002');
    assert.strictEqual(newest, '0001-26-000003');
    const amount = formDAmount('<totalOfferingAmount>5000000</totalOfferingAmount><totalAmountSold>2,000,000</totalAmountSold>');
    assert.strictEqual(amount, 2000000, 'amount SOLD, not the target');
    const s = edgarSignal(fresh[0], '0001234567', amount, TODAY)!;
    assert.deepStrictEqual([s.text, s.occurredOn, s.ref, s.source], ['Raised $2,000,000 (SEC Form D)', '2026-11-12', 'sec:0001-26-000003', 'sec']);
    assert.match(s.url, /^https:\/\/www\.sec\.gov\/cgi-bin\/browse-edgar\?action=getcompany&CIK=1234567&type=D$/);
});

console.log('\n──── 4. Which leads ────');

const cand = (over: Partial<SiteCandidate>): SiteCandidate => ({
    recordId: 1, organisationId: 9, assistantId: 5, data: {}, approvalStatus: 'pending_approval',
    updatedAt: '2026-11-10T00:00:00Z', domain: 'bloom.co.uk', campaignIdea: 'florists in Leeds', approvedBrief: null, ...over,
});

check('erased, do-not-contact, lost, deleted, turned-down and siteless leads are never watched; customers always', () => {
    const rows = planSiteRows([
        cand({ recordId: 1 }),
        cand({ recordId: 2, data: { erasedAt: 'x' } }),
        cand({ recordId: 3, data: { doNotContact: true } }),
        cand({ recordId: 4, data: { dealOutcome: { outcome: 'lost' } } }),
        cand({ recordId: 5, data: { retention: { deletedAt: 'x' } } }),
        cand({ recordId: 6, approvalStatus: 'rejected' }),
        cand({ recordId: 7, domain: null }),
        cand({ recordId: 8, data: { dealOutcome: { outcome: 'won' } } }),
        cand({ recordId: 9, approvalStatus: 'scheduled' }),
    ], 300);
    assert.deepStrictEqual(rows.map((r) => r.recordId).sort(), [1, 8, 9],
        'emailed-with-no-reply (9) stays watched (why-now decision 5); won (8) is a customer');
});

check('customers first, then newest leads, up to the cap; a lead appearing twice (two searches) counts once', () => {
    const rows = planSiteRows([
        cand({ recordId: 1, updatedAt: '2026-11-01T00:00:00Z' }),
        cand({ recordId: 2, updatedAt: '2026-11-09T00:00:00Z' }),
        cand({ recordId: 2, updatedAt: '2026-11-09T00:00:00Z' }),
        cand({ recordId: 3, data: { dealOutcome: { outcome: 'won' } } }),
    ], 2);
    assert.deepStrictEqual(rows.map((r) => r.recordId), [3, 2]);
});

check('country comes from the search when the address does not settle it', () => {
    const [r] = planSiteRows([cand({ domain: 'joesplumbing.com', campaignIdea: 'plumbers in the USA' })], 10);
    assert.strictEqual(r.country, 'us');
});

check('a lead\'s domain is read from the search, then its record, and cleaned', () => {
    assert.strictEqual(leadDomain({ domain: null, data: { website: 'https://www.Bloom.co.uk/about?x=1' } }), 'bloom.co.uk');
    assert.strictEqual(leadDomain({ domain: 'bloom.co.uk', data: { website: 'other.com' } }), 'bloom.co.uk');
    assert.strictEqual(leadDomain({ domain: null, data: { website: 'not a site' } }), null);
});

console.log('\n──── 5. Part of the Watch list, not a second system ────');

check('one daily run: website checks follow the Companies House check inside the same budget', () => {
    const run = read('netlify/functions/run-lead-watch-background.ts');
    assert.match(run, /checkDueWatches\(db, \{ deadline: started \+ CH_MS \}\)[\s\S]*syncSiteWatch\(db\)[\s\S]*checkDueSiteWatches\(db, \{ deadline: started \+ RUN_MS \}\)[\s\S]*rollUpSignals/);
});

check('one switch: the Watch list\'s own setting pauses website watching too', () => {
    const src = read('src/utils/lead-site-watch.ts');
    assert.match(src, /LEFT JOIN lead_watch_settings s ON s\.ai_assistant_id = a\.id/);
    assert.match(src, /paused_reason = 'watching_off'/);
});

check('one note: the roll-up reads both signal tables and names where the news came from', () => {
    assert.match(read('src/utils/lead-watch.ts'), /FROM lead_site_watch_signals s JOIN assistant_records r/);
    const both = rollUpText(groupForRollUp([
        { organisation_id: 1, ai_assistant_id: 5, direction: 'positive', company_name: 'Bloom Florists' },
        { organisation_id: 1, ai_assistant_id: 5, direction: 'positive', company_name: 'Kiln & Co', site: true },
    ])[0]);
    assert.match(both.body, /from Companies House and their websites: Bloom Florists, Kiln & Co\./);
    const site = rollUpText(groupForRollUp([{ organisation_id: 1, ai_assistant_id: 5, direction: 'positive', company_name: 'Kiln & Co', site: true }])[0]);
    assert.match(site.body, /from their websites and filings: Kiln & Co\./);
    const reg = rollUpText(groupForRollUp([{ organisation_id: 1, ai_assistant_id: 5, direction: 'negative', company_name: 'Bloom' }])[0]);
    assert.match(reg.body, /from Companies House: Bloom\./, 'register-only notes read exactly as before');
});

check('one tab: the News list includes website and SEC news, with the right link text', () => {
    assert.match(read('src/utils/lead-watch-list.ts'), /FROM lead_site_watch_signals s JOIN assistant_records r/);
    assert.match(read('src/components/assistant-watch-list.js'), /SOURCE_LINK\[s\.source\] \|\| 'Check on Companies House'/);
});

check('the missing table is a quiet skip, never a failed run', () => {
    const src = read('src/utils/lead-site-watch.ts');
    assert.match(src, /if \(isMissingTable\(err\)\) return \{ setUp: false, watched: 0, paused: 0 \}/);
    assert.match(src, /if \(isMissingTable\(err\)\) return \{ \.\.\.out, setUp: false \}/);
    assert.match(read('src/utils/lead-watch.ts'), /siteRows = [\s\S]{0,400}if \(!isMissingTable\(err\)\) throw err;/);
});

check('erasure deletes the website watch and its news; the export includes both', () => {
    const er = read('src/utils/prospect-erasure.ts');
    assert.match(er, /db\.delete\(leadSiteWatchSignals\)/);
    assert.match(er, /db\.delete\(leadSiteWatch\)/);
    const ex = read('src/utils/workspace-export.ts');
    assert.match(ex, /leadSiteWatch: s\.leadSiteWatch/);
    assert.match(ex, /leadSiteWatchSignals: s\.leadSiteWatchSignals/);
});

console.log('\n──── 6. Watch news becomes the lead\'s Why now ────');

check('both Companies House and website news go through ONE lead write that sets Why now', () => {
    const lw = read('src/utils/lead-watch.ts');
    assert.match(lw, /await applySignalToLead\(db, row\.assistant_record_id, \{ kind: sig\.kind/, 'Companies House news');
    assert.match(read('src/utils/lead-site-watch.ts'), /await applySignalToLead\(db, row\.assistant_record_id, sig\)/, 'website news');
    const fn = lw.slice(lw.indexOf('export async function applySignalToLead'));
    assert.match(fn, /'\{intel,whyNow\}'/);
    assert.match(fn, /COALESCE\(data #>> '\{intel,whyNow,date\}', ''\) < \$\{sig\.occurredOn\}/, 'only a NEWER reason replaces the Why now');
    assert.match(fn, /const becomesWhyNow = positive &&/, 'only a positive signal becomes a Why now');
    assert.match(fn, /jsonb_typeof\(data -> 'intel'\) <> 'object' OR data -> 'intel' IS NULL THEN data/, 'never creates intel on an unresearched lead');
    assert.match(fn, /updated_at = CASE WHEN \$\{positive\} THEN now\(\) ELSE updated_at END/, 'a positive signal restarts the deletion countdown');
});

check('the SEC contact header is an operator setting, never a customer\'s address', () => {
    const src = read('src/lib/lead-watch-sources.ts');
    assert.match(src, /process\.env\.SEC_USER_AGENT/);
    assert.ok(!/userEmail|user\.email|ownerEmail/.test(src));
});

console.log(`\n${passed} checks passed.\n`);
