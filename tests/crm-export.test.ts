// tests/crm-export.test.ts
// CRM-shaped lead export (Phase 2 item 12) — src/config/crm-export.ts and the CSV branch of
// netlify/functions/assistant-records.ts.
//
// The objection this removes: every competing tool integrates HubSpot and Salesforce, and we ask
// users to adopt Contacts as their CRM instead. Matching the column HEADERS to what those importers
// recognise removes it without building two integrations — but only if the headers are EXACTLY the
// strings those importers match on, and only if the columns are not empty.
//
// Two failure modes have tests of their own:
//   1. A tidied header ("Website" everywhere) silently stops auto-matching in one of the two tools.
//   2. The website column ships empty. A promoted lead's `data` is its scoring card, which carries
//      no domain at all — the value lives on `discovered_leads`. Header work alone would produce a
//      file missing the most valuable column in a CRM import after the address.
//
// Run:  npx tsx tests/crm-export.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { crmDescription, crmHeaders, crmRow, splitName, websiteUrl, isCrmTarget, CRM_TARGETS, LEAD_SOURCE } from '../src/config/crm-export';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const FULL = {
    company: 'Harrow Lane Bakery', firstName: 'Sarah', lastName: 'Jenkins',
    email: 'sarah.jenkins@harrowlane.co.uk', website: 'https://harrowlane.co.uk',
    industry: 'Food & Beverage', rating: 'warm', description: 'Fit score 68/100.',
};

console.log('\n──── the headers are the importers’ own, not ours ────');

check('Salesforce gets the Salesforce field names', () => {
    // These are the strings the Salesforce Lead importer auto-maps. "Company Name" would not match;
    // "Company" does. Tidying them into one shared vocabulary is the mistake this guards.
    assert.deepEqual(crmHeaders('salesforce'),
        ['First Name', 'Last Name', 'Company', 'Email', 'Website', 'Industry', 'Rating', 'Lead Source', 'Description']);
});

check('HubSpot gets the HubSpot field names', () => {
    assert.deepEqual(crmHeaders('hubspot'),
        ['First Name', 'Last Name', 'Email', 'Company Name', 'Website URL', 'Industry', 'Lead Source', 'Notes']);
});

check('the two vocabularies genuinely differ', () => {
    // If these ever converge, one of them has been "tidied" to match the other and half the
    // auto-mapping is gone.
    const sf = crmHeaders('salesforce'), hs = crmHeaders('hubspot');
    assert.ok(sf.includes('Company') && !sf.includes('Company Name'), 'Salesforce calls it Company');
    assert.ok(hs.includes('Company Name') && !hs.includes('Company'), 'HubSpot calls it Company Name');
    assert.ok(sf.includes('Website') && hs.includes('Website URL'), 'the website column differs between the two');
});

check('no status or lifecycle column is emitted', () => {
    // Both CRMs model lead status as a CUSTOMISABLE picklist. A value outside the org's picklist
    // fails the row, so the most-customised field is the one most likely to break the file.
    for (const t of CRM_TARGETS) {
        const h = crmHeaders(t).join('|');
        assert.ok(!/Status|Lifecycle/i.test(h), `${t} emits a picklist column that can fail an import`);
    }
});

check('every row has exactly one cell per header', () => {
    for (const t of CRM_TARGETS) {
        assert.equal(crmRow(t, FULL).length, crmHeaders(t).length, `${t} row and header lengths disagree`);
    }
});

console.log('\n──── the values ────');

check('Rating maps to the Salesforce picklist, capitalised', () => {
    // The one exact match in either vocabulary: standard Salesforce Lead Rating is Hot/Warm/Cold.
    const i = crmHeaders('salesforce').indexOf('Rating');
    assert.equal(crmRow('salesforce', { ...FULL, rating: 'hot' })[i], 'Hot');
    assert.equal(crmRow('salesforce', { ...FULL, rating: 'warm' })[i], 'Warm');
    assert.equal(crmRow('salesforce', { ...FULL, rating: 'cold' })[i], 'Cold');
});

check('an unexpected rating exports blank, never raw', () => {
    // A value outside the picklist fails the row; an empty cell imports fine.
    const i = crmHeaders('salesforce').indexOf('Rating');
    assert.equal(crmRow('salesforce', { ...FULL, rating: 'lukewarm' })[i], '');
    assert.equal(crmRow('salesforce', { ...FULL, rating: '' })[i], '');
});

check('HubSpot carries no Rating column at all', () => {
    assert.ok(!crmHeaders('hubspot').includes('Rating'), 'HubSpot has no standard Rating property');
});

check('Lead Source is stamped on every row', () => {
    for (const t of CRM_TARGETS) {
        const i = crmHeaders(t).indexOf('Lead Source');
        assert.equal(crmRow(t, FULL)[i], LEAD_SOURCE, `${t} does not attribute the row`);
    }
});

console.log('\n──── the description a sales team actually reads ────');

check('never leaks a raw enum into someone’s CRM', () => {
    // The first sample export wrote "Be More Swan status: pending_approval." into a field a sales
    // team reads. That is our database's word for it, not English.
    const d = crmDescription({ score: 68, reasons: [], nextStep: 'Find a contact', approvalStatus: 'pending_approval' });
    assert.ok(!/pending_approval/.test(d), 'the raw enum reached the Description column');
    assert.ok(/awaiting approval/.test(d), 'the state should read as words');
});

check('an unknown approval state contributes nothing', () => {
    // Rather than leaking whatever new token was added upstream.
    const d = crmDescription({ score: 68, approvalStatus: 'some_new_state' });
    assert.ok(!/some_new_state/.test(d), 'an unmapped state leaked through');
    assert.equal(d, 'Fit score 68/100.');
});

check('fragments are punctuated, so they do not run together', () => {
    // Assembled without this, the sample read "Next step: Find a contact Be More Swan status: …".
    const d = crmDescription({
        score: 68, reasons: ['Independent, 2 sites', 'No in-house marketing.'],
        nextStep: 'Find a contact', approvalStatus: 'approved',
    });
    assert.ok(/Independent, 2 sites\. No in-house marketing\. Next step: Find a contact\./.test(d),
        `fragments are not separated into sentences: ${d}`);
    assert.ok(!/\.\./.test(d), 'a fragment that already ended in a full stop got a second one');
});

check('an empty lead yields an empty description, not punctuation', () => {
    assert.equal(crmDescription({}), '');
    assert.equal(crmDescription({ reasons: [], nextStep: '   ' }), '');
});

console.log('\n──── names are split, never invented ────');

check('a full name splits across both columns', () => {
    assert.deepEqual(splitName('Sarah Jenkins'), { firstName: 'Sarah', lastName: 'Jenkins' });
});

check('a single token becomes the LAST name', () => {
    // Salesforce requires Last Name and ignores First, so one word is more useful there.
    assert.deepEqual(splitName('Cher'), { firstName: '', lastName: 'Cher' });
});

check('a multi-part surname stays intact', () => {
    assert.deepEqual(splitName('Maria del Carmen Ruiz'), { firstName: 'Maria', lastName: 'del Carmen Ruiz' });
});

check('no name means EMPTY cells, never a company name in the surname', () => {
    // The rule the whole lead module runs on: a blank is correct, a plausible guess is not. Most
    // discovery leads are a role inbox on a company, with no person attached — fabricating a
    // surname from the company to satisfy Salesforce would write a person who does not exist into
    // the user's CRM.
    for (const empty of ['', '   ', null, undefined]) {
        assert.deepEqual(splitName(empty), { firstName: '', lastName: '' }, `${JSON.stringify(empty)} invented a name`);
    }
    const row = crmRow('salesforce', { ...FULL, firstName: '', lastName: '' });
    const h = crmHeaders('salesforce');
    assert.equal(row[landmark(h, 'Last Name')], '');
    assert.equal(row[landmark(h, 'Company')], 'Harrow Lane Bakery', 'the company must still be exported');
});

check('a bare domain becomes a browsable URL', () => {
    assert.equal(websiteUrl('harrowlane.co.uk'), 'https://harrowlane.co.uk');
    assert.equal(websiteUrl('https://harrowlane.co.uk'), 'https://harrowlane.co.uk');
    assert.equal(websiteUrl('http://harrowlane.co.uk'), 'http://harrowlane.co.uk');
    assert.equal(websiteUrl(''), '', 'no domain must not become "https://"');
    assert.equal(websiteUrl(null), '');
});

console.log('\n──── the export is wired, and the website is not empty ────');

const FN = read('netlify/functions/assistant-records.ts');
const BRANCH = FN.slice(landmark(FN, 'const crmTarget ='), landmark(FN, '// Spreadsheet fallback'));

check('the website is read from discovered_leads, not only the record', () => {
    // THE failure this feature would otherwise ship with. `normaliseLeadCard` returns a closed
    // shape with no domain, so every discovery-found lead would export a blank Website.
    assert.ok(/from\(discoveredLeads\)/.test(BRANCH),
        'nothing reads discovered_leads — the Website column would be empty on every discovery lead');
    assert.ok(/websiteUrl\(domain\)/.test(BRANCH), 'the domain never reaches the row');
    const card = read('src/lib/discovery-scoring.ts');
    const shape = card.slice(landmark(card, 'export interface LeadScoringCard'), landmark(card, 'export interface ScoreResult'));
    assert.ok(!/\bdomain\b/.test(shape),
        'the scoring card now carries a domain — if so, the extra query may be avoidable, but check before removing it');
});

check('the discovery lookup is tenant-scoped', () => {
    assert.ok(/eq\(discoveredLeads\.organisationId, orgId\)/.test(BRANCH),
        'a record id alone would read another tenant’s discovery rows');
});

check('it only applies to leads, and only when asked', () => {
    assert.ok(/isCrmTarget\(crmTarget\) && recordType === 'lead'/.test(BRANCH),
        'the CRM shape must be opt-in and lead-only');
    // The generic export is what every other hub's Export CSV button uses. An unrecognised or
    // absent `crm` has to fall through to it untouched.
    assert.ok(landmark(FN, "if (event.queryStringParameters?.format === 'csv') {") > landmark(FN, 'const crmTarget ='),
        'the generic CSV branch is gone — every non-lead hub just lost its export');
});

check('a hand-added lead still exports what it has', () => {
    // No discovery row, but the CSV import template supplies website/industry on the record itself.
    assert.ok(/d\.website/.test(BRANCH), 'an imported lead’s own website field is ignored');
    assert.ok(/d\.contactName/.test(BRANCH), 'an imported lead’s own contact name is ignored');
});

check('the download is named for its target', () => {
    assert.ok(/filename="leads-\$\{crmTarget\}\.csv"/.test(BRANCH),
        'both exports would land in Downloads under the same name');
});

console.log('\n──── the offer is honest about the empty name columns ────');

check('the UI warns before the download, not after the failed import', () => {
    // The offer moved out of a permanent paragraph under the toolbar and into the Export modal
    // (openExportModal), beside the buttons it describes — but the warning has to travel with it.
    const hub = read('src/components/assistant-data-hub.js');
    const start = landmark(hub, 'function openExportModal(');
    const block = hub.slice(start, landmark(hub, 'data-export-plain', start) + 2000);
    assert.ok(/data-export-crm="hubspot"/.test(block) && /data-export-crm="salesforce"/.test(block),
        'both CRM shapes must be offered from the export modal');
    assert.ok(/Salesforce needs a last name/.test(block),
        'the export must say why rows with no named contact will not import as Leads');
    assert.ok(/hub\.recordType === 'lead'/.test(hub), 'the CRM offer must not appear on non-lead hubs');
});

check('a non-lead hub still downloads on one click', () => {
    // The modal exists because a lead export has three shapes and a live alternative. Every other
    // hub has exactly one CSV, and putting a dialog in front of it would be a question with one
    // answer — so the button must still go straight to the file there.
    const hub = read('src/components/assistant-data-hub.js');
    const handler = hub.slice(landmark(hub, "host.querySelector('[data-hub-export]')"));
    const body = handler.slice(0, landmark(handler, '});'));
    assert.ok(/recordType === 'lead'/.test(body) && /openExportModal\(\)/.test(body),
        'lead hubs open the modal');
    assert.ok(/downloadCsv\(null\)/.test(body),
        'every other hub must download the generic CSV directly, with no modal in the way');
});

check('an unknown target is rejected', () => {
    assert.ok(isCrmTarget('hubspot') && isCrmTarget('salesforce'));
    for (const bad of ['pipedrive', 'HUBSPOT', '', null, 1]) assert.ok(!isCrmTarget(bad), `${bad} accepted`);
});

console.log(`\n${passed} checks passed.`);
