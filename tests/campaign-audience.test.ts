// tests/campaign-audience.test.ts
// §9.2 of docs/campaign-orchestrator-plan.md: who a campaign is for, and who it must leave alone.
//
// WHY THIS EXISTS. "A goal without an audience is just a wish." The audience has to reach the two
// places that act on it — drafting (blueprint section 13) and lead searches (excluded domains) —
// and the history of this codebase is that a field can be saved, displayed, and reach neither.
// SMART Goals is the receipt. So this suite pins the route as well as the shape.
//
// It also pins three ways to get this subtly wrong that were each one keystroke away:
//   • mutating the SHARED default guardrails object in a warm function, which would leak one
//     tenant's customer list into another tenant's searches;
//   • a chat card replacing — and so deleting — the "also leave out" list the user typed;
//   • the chat switching the customer exclusion OFF.
//
// Run:  npx tsx tests/campaign-audience.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    AUDIENCE_EXCLUDE_DOMAINS_MAX, audienceLine, normaliseAudience, normaliseCompanyDomain, parseDomainList,
} from '../src/config/campaign-audience';

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
function code(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}
function span(text: string, start: string, end: string, what: string): string {
    const a = text.indexOf(start);
    assert.notStrictEqual(a, -1, `Could not find ${what} — the anchor ${JSON.stringify(start)} is gone.`);
    const b = text.indexOf(end, a + start.length);
    assert.notStrictEqual(b, -1, `Could not find the end of ${what} — the anchor ${JSON.stringify(end)} is gone.`);
    return text.slice(a, b);
}

console.log('\n──── the shape ────');

check('a company identifier normalises to the key discovered leads are stored under', () => {
    assert.strictEqual(normaliseCompanyDomain('https://www.Acme.co.uk/about?x=1'), 'acme.co.uk');
    assert.strictEqual(normaliseCompanyDomain('jo@example.com'), 'example.com');
    assert.strictEqual(normaliseCompanyDomain('  Example.COM.  '), 'example.com');
    assert.strictEqual(normaliseCompanyDomain('Acme Ltd'), null,
        'A company NAME can never match a domain comparison — storing it would exclude nothing while looking like it does.');
    assert.strictEqual(normaliseCompanyDomain(42), null);
});

check('a pasted list is split, normalised, de-duplicated and capped', () => {
    assert.deepStrictEqual(parseDomainList('acme.co.uk, www.acme.co.uk\nexample.com; nonsense'),
        ['acme.co.uk', 'example.com']);
    const many = Array.from({ length: 300 }, (_, i) => `c${i}.com`).join(',');
    assert.strictEqual(parseDomainList(many).length, AUDIENCE_EXCLUDE_DOMAINS_MAX);
});

check('an empty audience is null, not {}', () => {
    assert.strictEqual(normaliseAudience({ persona: ' ', description: '', excludeDomains: 'Acme Ltd' }), null,
        'null means "not said yet" and the directive omits the line; {} would read as an audience that says nothing.');
    assert.deepStrictEqual(normaliseAudience({ persona: 'SMB founders', junk: 1 }), { persona: 'SMB founders' });
});

check('an order\'s own audience beats the campaign\'s', () => {
    const campaign = { persona: 'SMB founders', description: 'owners of 5–50 person firms' };
    assert.strictEqual(audienceLine(campaign), 'SMB founders — owners of 5–50 person firms');
    assert.strictEqual(audienceLine(campaign, 'IT directors at 500+ firms'), 'IT directors at 500+ firms',
        'One campaign must be able to brief the Blog Writer for Persona A and the Lead Generator for Persona B.');
    assert.strictEqual(audienceLine(null), null);
    assert.strictEqual(audienceLine({ excludeDomains: ['a.com'] }), null, 'An exclusion list is not an audience.');
});

console.log('\n──── the database ────');

check('the migration is z-prefixed and adds both columns, exclusion ON by default', () => {
    const sql = read('db/z-campaign-audience.sql');
    assert.match(sql, /ADD COLUMN IF NOT EXISTS audience JSONB/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS exclude_existing_customers BOOLEAN NOT NULL DEFAULT TRUE/);
    // The runner sorts '-' before '.', so 'campaign-audience.sql' would run before campaigns.sql
    // on a fresh database. The file name is the fix.
    assert.ok(['campaigns.sql', 'z-campaign-audience.sql'].sort()[1] === 'z-campaign-audience.sql');
});

check('the drizzle mirror matches', () => {
    const schema = read('db/schema.ts');
    const campaignsTable = span(schema, 'export const campaigns = pgTable("campaigns"', '\n});', 'the campaigns table');
    assert.match(campaignsTable, /audience: jsonb\(\)/);
    assert.match(campaignsTable, /excludeExistingCustomers: boolean\("exclude_existing_customers"\)\.notNull\(\)\.default\(true\)/);
});

console.log('\n──── it reaches drafting ────');

check('blueprint section 13 reads the campaign audience, with the order\'s taking precedence', () => {
    const bp = code(read('src/utils/blueprint.ts'));
    assert.match(bp, /audience: campaigns\.audience/, 'The live-campaign select must read campaigns.audience.');
    assert.match(bp, /audience: audienceLine\(liveCampaign\.audience, campaignBrief\.audience\)/);
});

check('an audience edit recompiles the assistants the campaign briefs', () => {
    const api = code(read('netlify/functions/campaigns.ts'));
    const edit = span(api, "action === 'edit'", "action === 'start'", 'edit');
    assert.match(edit, /patch\.audience !== undefined\) \{[\s\S]{0,40}recompileCampaignTargets|\|\| patch\.audience !== undefined\)/,
        'Generation reads the PERSISTED blueprint; an audience change that does not recompile never arrives.');
});

console.log('\n──── it reaches lead searches ────');

check('a campaign-linked search skips won customers and the campaign\'s own list, resolved per run', () => {
    const ex = code(read('src/utils/customer-exclusion.ts'));
    assert.match(ex, /dealOutcome' ->> 'outcome' = 'won'/,
        'Customers are companies marked won — the current truth on the record, not the append-only ledger.');
    assert.match(ex, /artefactKind, 'discovery_campaign'/, 'Only searches a campaign order points at.');
    assert.match(ex, /eq\(discoveryCampaigns\.organisationId, campaigns\.organisationId\)/,
        'The org match is the IDOR guard: a forged artefact id must not pull in another tenant\'s customers.');
    assert.match(ex, /excludeDomains/);
});

check('the discovery job merges exclusions into a COPY of its guardrails', () => {
    const job = code(read('netlify/functions/process-discovery-jobs.ts'));
    assert.match(job, /campaignExclusionsForSearch\(db, job\.campaign_id\)/);
    assert.ok(!/guardrails\.excludedDomains\s*=/.test(job),
        'Never assign into the loaded guardrails: with no guardrail row, loadGuardrails returns the shared '
        + 'DEFAULT_GUARDRAILS, and a write there leaks this campaign\'s customers into every later run in the warm function.');
    assert.match(job, /\{ \.\.\.loadedGuardrails, excludedDomains:/);
});

console.log('\n──── the chat may only narrow who a campaign reaches ────');

check('edit refuses switching the exclusion off from the chat', () => {
    const api = code(read('netlify/functions/campaigns.ts'));
    const edit = span(api, "action === 'edit'", "action === 'start'", 'edit');
    assert.match(edit, /body\.viaChat === true && body\.excludeExistingCustomers === false/);
});

check('a chat audience edit MERGES the exclusion list, never replaces it', () => {
    const api = code(read('netlify/functions/campaigns.ts'));
    const edit = span(api, "action === 'edit'", "action === 'start'", 'edit');
    assert.match(edit, /\.\.\.\(prev\.excludeDomains \?\? \[\]\), \.\.\.\(next\?\.excludeDomains \?\? \[\]\)/,
        'A card naming a new persona must not silently delete the "also leave out" list typed on the tab.');
});

check('the chat edit handler can only send the exclusion as true', () => {
    const chat = code(read('src/components/chat-session.js'));
    const fn = span(chat, 'function onCampaignEdit', '\n    }\n', 'the chat edit handler');
    assert.match(fn, /excludeExistingCustomers: c\.excludeExistingCustomers === true \? true : undefined/);
});

check('create keeps the exclusion ON unless false is explicit', () => {
    const api = code(read('netlify/functions/campaigns.ts'));
    const create = span(api, "action === 'create'", "action === 'edit'", 'create');
    assert.match(create, /excludeExistingCustomers: body\.excludeExistingCustomers !== false/);
    assert.match(create, /audience: normaliseAudience\(body\.audience\)/);
});

console.log('\n──── GUI and chat both say it (§9.0) ────');

check('the proposal card shows who it is for and whether customers are included', () => {
    const card = code(read('src/components/disruptive-ui-registry.js'));
    const fn = span(card, 'function renderCampaignStrategyProposalCard', '\n  register(', 'the proposal card');
    assert.match(fn, /For:<\/span>/);
    assert.match(fn, /Includes your existing customers/,
        'Approving a card that includes customers must say so — the user is approving that.');
    assert.match(fn, /audience: aud \?/, 'The card must send the audience it shows.');
});

check('the Campaigns tab form, rows and Add work all carry the audience', () => {
    const tab = code(read('src/components/assistant-campaigns.js'));
    assert.match(tab, /data-cmpf="persona"/);
    assert.match(tab, /data-cmpf="excludeExistingCustomers"/);
    assert.match(tab, /data-cmpf="excludeDomains"/);
    assert.match(tab, /function audienceHtml/);
    assert.match(tab, /No audience set/, 'A missing audience must be stated on the row, not left blank.');
    assert.match(tab, /brief\.audience = forWho/, 'Add work must let one brief name its own audience.');
});

check('the chat prompt and snapshot speak the same words as the tab', () => {
    const orch = code(read('netlify/functions/chat-orchestrator.ts'));
    const tab = read('src/components/assistant-campaigns.js');
    assert.ok(tab.includes('Leave out existing customers.') && orch.includes('"Leave out existing customers"'),
        'The prompt must name the toggle exactly as the tab labels it, or it sends the user looking for a control that is not there.');
    assert.match(orch, /"audience": \{ "persona":/);
    const plan = code(read('src/utils/campaign-plan.ts'));
    assert.match(plan, /leaves existing customers out of its lead searches/);
});

console.log(`\n${passed} checks passed.`);
