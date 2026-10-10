// tests/products-and-team-awareness.test.ts
// 2026-10-09: (1) a business records its Products & Services once, on Business Information, and
// EVERY assistant reads them; (2) every assistant's chat knows what its teammates did and what is
// booked to go out, read per turn from the workspace's records.
//
// Run:  npx tsx tests/products-and-team-awareness.test.ts

import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProductsBlock, renderProductFacts, PRODUCT_PROMPT_MAX, type OrgProduct } from '../src/utils/org-products';
import { productFields, cleanProductUrl } from '../netlify/functions/org-products';
import { senderIdentityBlock } from '../src/config/sender-identity';
import { renderTeamActivityBlock, type TeamMember } from '../src/utils/team-activity';
import type { ActivityItem } from '../src/utils/role-activity';

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
/** Comments stripped, so a check cannot pass on a comment that merely mentions the call. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
function slice(text: string, start: string, end: string): string {
    const i = text.indexOf(start);
    assert.ok(i >= 0, `marker not found: ${start}`);
    assert.strictEqual(text.indexOf(start, i + 1), -1, `marker not unique: ${start}`);
    const j = text.indexOf(end, i + start.length);
    assert.ok(j > i, `end marker not found after ${start}`);
    return text.slice(i, j);
}

const kit: OrgProduct = { kind: 'product', name: 'Sourdough Starter Kit', description: 'Everything to bake your first loaf.', benefits: 'Live starter, banneton, scraper', price: '£29', audience: 'Home bakers', url: 'https://example.com/kit' };
const course: OrgProduct = { kind: 'service', name: 'Bread Masterclass', description: 'A three-hour class.', price: null, url: null };

console.log('\nProducts — what every prompt is given');
check('no products → no block at all (callers carry on as before)', () => {
    assert.strictEqual(renderProductsBlock([]), null);
    assert.strictEqual(renderProductsBlock(null), null);
    assert.strictEqual(renderProductsBlock([{ kind: 'product', name: '   ' }]), null);
});
check('names, prices, links and who it is for are carried exactly', () => {
    const b = renderProductsBlock([kit, course], 'Crumb & Co')!;
    for (const s of ['Sourdough Starter Kit (product)', 'Price: £29', 'Link: https://example.com/kit', 'Who it is for: Home bakers', 'Bread Masterclass (service)', 'What Crumb & Co sells']) {
        assert.ok(b.includes(s), `missing: ${s}`);
    }
    const masterclass = b.slice(b.indexOf('• Bread Masterclass'));
    assert.ok(!/Price:/.test(masterclass), 'a price was printed for a product with none');
});
check('the rules forbid invented products, rounded prices and invented discounts', () => {
    const b = renderProductsBlock([kit])!;
    assert.ok(/Never invent one that is not listed/.test(b));
    assert.ok(/Quote a price ONLY when it is listed/.test(b) && /never round it/.test(b) && /discount/.test(b));
    assert.ok(/If a price is not listed, do not state one/.test(b));
    assert.ok(/Not every piece of work is a sales pitch/.test(b), 'products would be pushed into every post');
});
check(`a big catalogue is capped at ${PRODUCT_PROMPT_MAX} and says how many were left out`, () => {
    const many = Array.from({ length: PRODUCT_PROMPT_MAX + 1 }, (_, i) => ({ kind: 'product', name: `Item ${i}` }));
    const b = renderProductsBlock(many)!;
    assert.ok(b.includes(`Item ${PRODUCT_PROMPT_MAX - 1}`) && !b.includes(`Item ${PRODUCT_PROMPT_MAX}\n`));
    assert.ok(/1 more not shown/.test(b));
});
check('the reviewer gets bare facts, and "no price listed" where there is none', () => {
    const f = renderProductFacts([kit, course]);
    assert.ok(f.includes('Sourdough Starter Kit (product) — £29'));
    assert.ok(f.includes('Bread Masterclass (service) — no price listed'));
    assert.strictEqual(renderProductFacts([]), '');
});
check('only ACTIVE products are loaded, in the business\'s own order', () => {
    const src = slice(code('src/utils/org-products.ts'), 'export async function loadOrgProducts', 'export async function loadProductsBlock');
    assert.ok(src.includes("eq(orgProducts.status, 'active')"));
    assert.ok(src.includes('asc(orgProducts.sortOrder)'));
    assert.ok(/catch \(err\)[\s\S]*return \[\]/.test(src), 'a missing table would throw into every drafting seam');
});

console.log('\nProducts — saving');
check('a name is required; kind is product or service', () => {
    assert.ok('error' in productFields({ name: '  ' }, false));
    assert.ok('error' in productFields({ name: 'X', kind: 'subscription' }, false));
    const ok = productFields({ name: ' Kit ', kind: 'service' }, false);
    assert.ok('values' in ok && ok.values.name === 'Kit' && ok.values.kind === 'service');
});
check('a link must be a web address — a bare domain gets https, a javascript: link is refused', () => {
    assert.strictEqual(cleanProductUrl('example.com/kit'), 'https://example.com/kit');
    assert.strictEqual(cleanProductUrl('javascript:alert(1)'), 'invalid');
    assert.strictEqual(cleanProductUrl(''), null);
});
check('a PATCH touches only what was sent; status and order are validated', () => {
    const p = productFields({ price: '£35' }, true);
    assert.ok('values' in p && Object.keys(p.values).join() === 'price');
    assert.ok('error' in productFields({ status: 'deleted' }, true));
    assert.ok('error' in productFields({ sortOrder: -1 }, true));
});
check('every statement in the endpoint is scoped to the caller\'s organisation', () => {
    const src = code('netlify/functions/org-products.ts');
    // GET, the POST count, PATCH and DELETE filter on it; the INSERT writes it.
    assert.strictEqual((src.match(/eq\(orgProducts\.organisationId, orgId\)/g) || []).length, 4, 'an unscoped read or write');
    assert.ok(/insert\(orgProducts\)[\s\S]{0,200}organisationId: orgId/.test(src), 'a product inserted without its org');
});
check('the migration exists, is idempotent, and the Drizzle mirror matches', () => {
    assert.ok(existsSync(join(root, 'db/z-org-products.sql')));
    const sql = read('db/z-org-products.sql');
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS org_products') && sql.includes("CHECK (status IN ('active', 'archived'))"));
    assert.ok(read('db/schema.ts').includes('export const orgProducts = pgTable("org_products"'));
});

console.log('\nProducts — the tab');
const assets = read('assets.html');
check('Business Information has a Products & Services tab and panel', () => {
    assert.ok(assets.includes('data-tab="products">Products &amp; Services</button>'));
    assert.ok(assets.includes('data-panel="products"'));
    assert.ok(assets.includes("const API = '/.netlify/functions/org-products';"));
});
check('everything the user typed is escaped before it is shown', () => {
    const c = slice(assets, 'function card(p, i, active) {', 'function render() {');
    for (const f of ['esc(p.name)', 'esc(p.price)', 'esc(p.description)', 'esc(p.url)', 'esc(p.audience)']) assert.ok(c.includes(f), `unescaped: ${f}`);
});
check('delete asks first; archive is the reversible way out', () => {
    assert.ok(/op-delete[\s\S]{0,400}window\.confirmModal/.test(assets));
    assert.ok(assets.includes("setStatus(id, 'archived')") && assets.includes("setStatus(id, 'active')"));
});
check('an edit finds its card AFTER closing the other editor (which re-renders the list)', () => {
    const o = slice(assets, 'function openEditor(p) {', 'function closeEditor() {');
    assert.ok(o.indexOf('closeEditor();') < o.indexOf('listEl.querySelector(`.op-card[data-id='), 'the anchor would be a detached node');
});

console.log('\nProducts — every assistant reads them');
const SEAMS: Array<[string, string]> = [
    ['netlify/functions/chat-orchestrator.ts', 'loadProductsBlock('],
    ['netlify/functions/process-content-jobs.ts', 'loadProductsBlock('],
    ['src/utils/blog-generate.ts', 'loadProductsBlock('],
    ['src/utils/blog-topic-ideation.ts', 'loadProductsBlock('],
    ['src/utils/newsletter-campaign-generate.ts', 'loadProductsBlock('],
    ['src/utils/sender-identity.ts', 'loadProductsBlock('],
    ['src/utils/post-quality-review.ts', 'loadOrgProducts('],
];
for (const [file, call] of SEAMS) {
    check(`${file} reads the products`, () => assert.ok(code(file).includes(call)));
}
check('both email drafting paths (issue + campaign step) read the products', () => {
    assert.strictEqual((code('src/utils/newsletter-generate.ts').match(/loadProductsBlock\(/g) || []).length, 2);
});
check('outreach: the sender block carries the products into all four lead prompts', () => {
    const block = senderIdentityBlock({ businessName: 'Crumb & Co', productsBlock: renderProductsBlock([kit], 'Crumb & Co') });
    assert.ok(block.includes('Sourdough Starter Kit') && block.includes('£29'));
    assert.ok(!senderIdentityBlock({ businessName: 'Crumb & Co' }).includes('products_and_services'));
});
check('email campaigns keep product links (grounding would otherwise strip them)', () => {
    const src = code('src/utils/newsletter-campaign-generate.ts');
    assert.ok(/\[input\.facts, input\.goal, input\.audience, productsBlock \?\? ''\]/.test(src));
});
check('chat: every role gets products, the handoff call too', () => {
    const src = code('netlify/functions/chat-orchestrator.ts');
    assert.ok(/\[rolePrompt, rulesBlock, productsBlock, teamBlock\]/.test(src), 'not on every route');
    assert.ok(/buildRolePrompt\(\{[\s\S]{0,400}\}\) \+ \(productsBlock/.test(src), 'the handoff target writes without them');
});

console.log('\nTeam awareness');
const NOW = new Date('2026-10-09T12:00:00Z');
const team: TeamMember[] = [
    { id: 1, name: 'Sky', roleKey: 'social_media_manager', roleLabel: 'Social Media Assistant', lifecycleStatus: 'working' },
    { id: 2, name: 'Nina', roleKey: 'newsletter_editor', roleLabel: 'Email Marketing Assistant', lifecycleStatus: 'working' },
    { id: 3, name: 'Leo', roleKey: 'lead_qualifier', roleLabel: 'Lead Generator', lifecycleStatus: 'paused' },
];
const item = (id: string, description: string, daysAgo: number, status: ActivityItem['status'] = 'success'): ActivityItem =>
    ({ id, type: 'x', icon: 'x', description, createdAt: new Date(NOW.getTime() - daysAgo * 86_400_000), status });
const work = new Map<number, ActivityItem[]>([
    [1, [item('a', 'Published a post to Instagram: “New autumn loaves”.', 1)]],
    [2, [item('b', 'Sent “October offers” to 412 subscribers.', 2)]],
    [3, [item('c', 'Emailed Bakehouse Ltd.', 3, 'failed')]],
]);

check('the asking assistant sees its own work as YOU and the rest as TEAMMATE', () => {
    const b = renderTeamActivityBlock({ selfId: 1, team, work, booked: [], now: NOW, timezone: 'Europe/London' })!;
    assert.ok(/YOU — Sky \(Social Media Assistant\)\n {2}- .*New autumn loaves/.test(b));
    assert.ok(/TEAMMATE — Nina \(Email Marketing Assistant\)\n {2}- .*October offers/.test(b));
    assert.ok(b.includes('TEAMMATE — Leo (Lead Generator) [paused]'));
    assert.ok(b.includes('Emailed Bakehouse Ltd. (failed)'), 'a failure read as a success');
});
check('it never lets an assistant claim a teammate\'s work, or guess beyond the summary', () => {
    const b = renderTeamActivityBlock({ selfId: 2, team, work, booked: [], now: NOW })!;
    assert.ok(/Only claim work listed under YOU as your own/.test(b));
    assert.ok(/Never guess at what a teammate did/.test(b));
    assert.ok(/cannot instruct a teammate/.test(b));
});
check('booked items are named with who booked them — "you" for the asking assistant', () => {
    const b = renderTeamActivityBlock({
        selfId: 2, team, work, now: NOW, timezone: 'Europe/London',
        booked: [
            { kind: 'post', at: new Date('2026-10-10T09:00:00Z'), label: 'Post to Instagram', assistantId: 1 },
            { kind: 'email', at: new Date('2026-10-11T08:00:00Z'), label: 'Email: Weekend bake', assistantId: 2 },
        ],
    })!;
    assert.ok(/BOOKED TO GO OUT IN THE NEXT 7 DAYS/.test(b));
    assert.ok(/Post to Instagram — Sky/.test(b) && /Email: Weekend bake — you/.test(b));
});
check('a teammate with nothing recent says so instead of vanishing', () => {
    const b = renderTeamActivityBlock({ selfId: 1, team, work: new Map([[1, []]]), booked: [], now: NOW })!;
    assert.ok(/TEAMMATE — Nina[^\n]*\n {2}- Nothing finished in the last 14 days\./.test(b));
});
check('a lone assistant with nothing booked gets no block', () => {
    assert.strictEqual(renderTeamActivityBlock({ selfId: 1, team: [team[0]], work, booked: [], now: NOW }), null);
});
check('the block is bounded however big the team', () => {
    const big: TeamMember[] = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, name: `A${i}`, roleKey: 'blog_writer', roleLabel: 'Blog Writer', lifecycleStatus: 'working' }));
    const w = new Map(big.map((m) => [m.id, Array.from({ length: 5 }, (_, j) => item(`${m.id}-${j}`, 'x'.repeat(300), j))]));
    const b = renderTeamActivityBlock({ selfId: 1, team: big, work: w, booked: [], now: NOW })!;
    assert.ok(b.length < 9000, `block is ${b.length} chars`);
    assert.ok(/more teammates not shown/.test(b));
});
check('chat reads it per turn for every role, cached a minute per workspace', () => {
    const chat = code('netlify/functions/chat-orchestrator.ts');
    assert.ok(chat.includes('buildTeamActivityBlock(db, orgId, session.aiAssistantId'));
    assert.ok(!/route\.uses\w+\s*\?\s*await buildTeamActivityBlock/.test(chat), 'gated to some roles');
    const ta = code('src/utils/team-activity.ts');
    assert.ok(/const CACHE_MS = 60_000;/.test(ta));
    assert.ok(/catch \(err\)[\s\S]{0,120}return null;\s*\}\s*\}\s*$/.test(ta), 'a failed read would fail the turn');
});
check('the dashboard and the assistants read the SAME definition of the team\'s work', () => {
    assert.ok(code('netlify/functions/dashboard-recent-work.ts').includes("from '../../src/utils/team-activity'"));
    assert.ok(code('netlify/functions/dashboard-agenda.ts').includes('loadBooked('));
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — with FAILURES above' : ''}`);
