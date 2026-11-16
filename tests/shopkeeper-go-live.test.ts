// tests/shopkeeper-go-live.test.ts
// Getting the hidden Shopkeeper Assistant ready for an admin to launch (online shop FR#35,
// docs/online-shop-review-plan.md §10). Status is never written here or by SQL: Admin ▸ Assistants
// runs these same checks (src/utils/assistant-go-live.ts) before it moves a role out of Hidden.
//
// On 2026-11-16 the row on BOTH databases failed three blocking checks (tagline, key features,
// "Works with") and three warnings (connects-with, demo video, capabilities). The copy now comes from
// db/z-copy-shopkeeper.sql and the video from db/z-assistant-showcases.sql; this runs the real checks
// on that copy so the SQL and the checks cannot drift apart.
//
// Run:  npx tsx tests/shopkeeper-go-live.test.ts

import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blockersFor, runGoLiveChecks, type GoLiveInput } from '../src/utils/assistant-go-live';
import { normaliseShowcase } from '../src/utils/assistant-showcase';
import { shopSnapshotText, shopStepsLeft } from '../src/utils/shop-snapshot';
import { EMPTY_SHOP_SETTINGS, type ShopSettings } from '../src/utils/shop-settings';
import { ASSISTANT_PAGE_SLUGS } from '../scripts/seo/ai-readability.mjs';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const COPY_SQL = read('db/z-copy-shopkeeper.sql');
const INSERT_SQL = read('db/z-shopkeeper.sql');
const SHOWCASES = JSON.parse(read('db/assistant-showcases.json'));
const SC = SHOWCASES.shopkeeper;

/** The value a fill-blank line in z-copy-shopkeeper.sql writes for one column. */
function copyValue(col: string): string {
    const m = COPY_SQL.match(new RegExp(`${col}\\s*=[\\s\\S]*?'([^']*(?:''[^']*)*)'(?:::jsonb)?\\)?\\s*(?:,|ELSE)`));
    assert.ok(m, `${col} not found in z-copy-shopkeeper.sql`);
    return m![1].replace(/''/g, "'");
}
const TAGLINE = COPY_SQL.match(/COALESCE\(NULLIF\(btrim\(tagline\), ''\),\s*'([^']+)'\)/)![1];
const KEY_FEATURES: string[] = JSON.parse(copyValue('key_features'));
const INTEGRATIONS: string[] = JSON.parse(copyValue('integrations'));
const WORKS_WITH: string[] = JSON.parse(copyValue('works_with'));
const NEW_DESCRIPTION = COPY_SQL.match(/THEN '(Runs your online shop with you[^']*)'/)![1];

// The row as it stood on staging and prod, 2026-11-16 (read-only check of both databases).
const ROW_BEFORE: GoLiveInput = {
    roleKey: 'shopkeeper', name: 'Shopkeeper Assistant', tagline: null,
    description: 'Runs your online shop with you: connects Stripe so buyers pay you directly (Be More Swan takes no fee), fills in the Delivery & returns details UK law asks for, and keeps your orders in one place. Works with your Be More Swan website or on its own.',
    category: 'Marketing & Sales', iconKey: 'chart', iconColor: 'green', keyFeatures: [], integrations: [], worksWith: [],
    video: null, currentVersionId: null, riskClassification: 'limited', specialCategoryClauseEnabled: false,
    knownRoleKeys: ['shopkeeper', 'website_assistant', 'social_media_manager'], capabilityRowCount: 0,
};

console.log('\nGo-live checks');

check('before: exactly tagline, key features and "Works with" block Live; three warnings', () => {
    const checks = runGoLiveChecks(ROW_BEFORE);
    assert.deepStrictEqual(blockersFor('live', checks).map((c) => c.key), ['tagline', 'keyFeatures', 'worksWith']);
    assert.deepStrictEqual(checks.filter((c) => !c.ok && c.severity === 'warning').map((c) => c.key), ['integrations', 'video', 'rows']);
});

check('after the copy SQL and the showcase SQL: nothing blocks Live or Beta', () => {
    const checks = runGoLiveChecks({
        ...ROW_BEFORE, tagline: TAGLINE, keyFeatures: KEY_FEATURES, integrations: INTEGRATIONS, worksWith: WORKS_WITH,
        description: NEW_DESCRIPTION, video: { url: '/videos/assistants/shopkeeper.mp4' },
    });
    assert.deepStrictEqual(blockersFor('live', checks), []);
    assert.deepStrictEqual(blockersFor('beta', checks), []);
    // Only the capabilities warning is left: it has no AI images, video or other capability to switch on.
    assert.deepStrictEqual(checks.filter((c) => !c.ok).map((c) => c.key), ['rows']);
    assert.ok(read('db/z-assistant-showcases.sql').includes(`"url":"/videos/assistants/shopkeeper.mp4"`) && read('db/z-assistant-showcases.sql').includes("WHERE role_key = 'shopkeeper'"));
});

check('the copy SQL fills blanks only and never writes status', () => {
    assert.match(COPY_SQL, /tagline\s*=\s*COALESCE\(NULLIF\(btrim\(tagline\), ''\)/);
    for (const col of ['key_features', 'integrations', 'works_with']) {
        assert.match(COPY_SQL, new RegExp(`${col}\\s*=\\s*CASE WHEN jsonb_array_length\\(COALESCE\\(${col}, '\\[\\]'::jsonb\\)\\) = 0`), col);
    }
    assert.match(COPY_SQL, /description\s*=\s*CASE WHEN description = 'Runs your online shop with you: connects Stripe so buyers pay you directly \(Be More Swan takes no fee\)/, 'only the untouched original description is replaced');
    const body = COPY_SQL.replace(/^--.*$/gm, '');
    assert.doesNotMatch(body, /is_active|coming_soon|lifecycle_state/, 'status belongs to Admin ▸ Assistants');
    assert.match(body, /WHERE role_key = 'shopkeeper';/);
});

check('fresh databases get the same copy: z-shopkeeper.sql insert and seed-catalog.ts', () => {
    assert.ok(INSERT_SQL.includes(`'${TAGLINE}'`));
    assert.ok(INSERT_SQL.includes(`'${JSON.stringify(KEY_FEATURES)}'::jsonb`));
    assert.ok(INSERT_SQL.includes(`'${JSON.stringify(INTEGRATIONS)}'::jsonb`) && INSERT_SQL.includes(`'${JSON.stringify(WORKS_WITH)}'::jsonb`));
    assert.ok(INSERT_SQL.includes(NEW_DESCRIPTION) && read('db/seed-catalog.ts').includes(NEW_DESCRIPTION));
    assert.ok(INSERT_SQL.includes("false, false, 'draft')"), 'still inserted Hidden');
    // z-copy sorts before z-shopkeeper ("c" < "s"), so on a fresh database the insert carries the copy.
    assert.ok('z-copy-shopkeeper.sql' < 'z-shopkeeper.sql');
});

check('no copy claims it sells without a Be More Swan website, or a basket', () => {
    const all = [TAGLINE, NEW_DESCRIPTION, ...KEY_FEATURES, JSON.stringify(SC)].join(' ');
    assert.doesNotMatch(all, /on its own/i);
    assert.match(NEW_DESCRIPTION, /Buy buttons on a website made with the Website Assistant/);
    assert.deepStrictEqual(WORKS_WITH, ['website_assistant'], 'it can only sell through a Website Assistant site today');
    assert.doesNotMatch(all, /every penny/i, 'Stripe still charges card fees');
});

console.log('\nPublic page');

check('the showcase passes the admin validation and every screenshot and the video exist', () => {
    assert.ok(SC, 'shopkeeper missing from db/assistant-showcases.json');
    assert.ok(normaliseShowcase(SC).ok);
    const shots = SC.features.filter((f: { image?: string }) => f.image).map((f: { image: string }) => f.image);
    assert.ok(shots.length >= 3);
    for (const f of shots) assert.ok(existsSync(join(root, f)), f);
    for (const f of ['videos/assistants/shopkeeper.mp4', 'videos/assistants/shopkeeper.jpg']) assert.ok(existsSync(join(root, f)), f);
    assert.ok(read('scripts/render-assistant-videos.mjs').includes("shopkeeper:            { name: 'Shopkeeper Assistant'"));
});

check('the sample work is real files, never the staging workspace name', () => {
    const page = read('assistant.html');
    const all = page.slice(page.indexOf('const SAMPLE_WORK = {'), page.indexOf('function render('));
    const block = all.slice(all.indexOf('shopkeeper: {'));
    const files = [...block.matchAll(/'(\/images\/samples\/shopkeeper\/[\w-]+\.jpg)'/g)].map((m) => m[1]);
    assert.strictEqual(files.length, 2);
    for (const f of files) assert.ok(existsSync(join(root, f)), f);
    assert.doesNotMatch(block, /Marmalade/);
    assert.match(block, /01632 960482|Ofcom/, 'fake contact details only');
});

check('its page URL is pinned before launch', () => {
    assert.strictEqual((ASSISTANT_PAGE_SLUGS as Record<string, string>).shopkeeper, 'ai-shopkeeper-assistant');
});

console.log('\nThe chat names only the steps really left');

const COMPLETE: ShopSettings = {
    ...EMPTY_SHOP_SETTINGS, traderName: 'Willowbrook Coffee', traderAddress: '14 Mill Lane, Willowbrook WB1 4MC',
    contactEmail: 'hello@willowbrookcoffee.co.uk', deliveryText: 'Royal Mail Tracked 48, within 2 working days.',
};

check('details saved, Stripe not connected → one step left, and the returns window is not one', () => {
    // The 2026-11-16 staging sample: the chat said "two things still need doing", the second being to
    // "confirm your returns window", when only Stripe was left.
    assert.deepStrictEqual(shopStepsLeft({ connected: false, chargesEnabled: false, shop: COMPLETE }), ['connect Stripe']);
    const t = shopSnapshotText({ connected: false, chargesEnabled: false, shop: COMPLETE, orders: [] });
    assert.ok(t.includes('- So: the shop can NOT take orders yet. Steps left (1): connect Stripe. Nothing else is required.'));
    assert.ok(t.includes('Optional, never a step left to do:') && t.includes('the days to cancel (14 set; 14 is the legal minimum)'));
});

check('nothing set up → two steps in the Shop tab order; Stripe half-done says finish', () => {
    assert.deepStrictEqual(shopStepsLeft({ connected: false, chargesEnabled: false, shop: null }),
        ['connect Stripe', 'fill in the Delivery & returns details (missing: Business or trading name, Business address, Email for customers, How and when you deliver)']);
    assert.deepStrictEqual(shopStepsLeft({ connected: true, chargesEnabled: false, shop: COMPLETE }), ['finish setting up Stripe']);
});

check('ready → no steps, and it says so', () => {
    assert.deepStrictEqual(shopStepsLeft({ connected: true, chargesEnabled: true, shop: COMPLETE }), []);
    assert.ok(shopSnapshotText({ connected: true, chargesEnabled: true, shop: COMPLETE, orders: [] }).includes('the shop CAN take orders now. Nothing is left to set up.'));
});

check('the prompt answers from "Steps left" and never adds one of its own', () => {
    const o = read('netlify/functions/chat-orchestrator.ts');
    const route = o.slice(o.indexOf('    shopkeeper: {'), o.indexOf('    business_mentor: {'));
    assert.ok(route.includes('name only the "Steps left" it lists, with its count'));
    assert.ok(route.includes('Never add a step of your own'));
});

console.log(`\n${passed}/${total} passed`);
