// tests/assistant-go-live.test.ts
// Admin ▸ Assistants (2026-10-10): one status per role, changed only through admin-assistants.ts,
// and a move to Coming soon / Beta / Live refused while a go-live check fails. Replaces the
// "Assistant Catalog" + "Master Data → Assistants" pair, where three switches decided hireability,
// five of six lifecycle states did nothing, a new role was hireable the moment it was created, and
// ANY signed-in user could launch a role through master-assistants PATCH.
//
// Run:  npx tsx tests/assistant-go-live.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    statusOf, columnsFor, runGoLiveChecks, blockersFor, announcesLaunch, ASSISTANT_STATUSES, type GoLiveInput,
} from '../src/utils/assistant-go-live';
import { ASSISTANT_BUILD } from '../src/config/assistant-build-manifest';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
function slice(text: string, start: string, end: string): string {
    const i = text.indexOf(start);
    assert.ok(i >= 0, `marker not found: ${start}`);
    assert.strictEqual(text.indexOf(start, i + 1), -1, `marker not unique: ${start}`);
    const j = text.indexOf(end, i + start.length);
    assert.ok(j > i, `end marker not found after ${start}`);
    return text.slice(i, j);
}

console.log('\nOne status');
check('the stored columns read as what a customer experiences', () => {
    assert.strictEqual(statusOf({ isActive: false, comingSoon: false, lifecycleState: 'draft' }), 'hidden');
    assert.strictEqual(statusOf({ isActive: false, comingSoon: true, lifecycleState: 'live' }), 'hidden');
    assert.strictEqual(statusOf({ isActive: false, comingSoon: false, lifecycleState: 'archived' }), 'retired');
    assert.strictEqual(statusOf({ isActive: true, comingSoon: true, lifecycleState: 'beta' }), 'coming_soon');
    assert.strictEqual(statusOf({ isActive: true, comingSoon: false, lifecycleState: 'beta' }), 'beta');
    // The trap this replaces: a "draft" that is active and not coming soon is hireable by everyone.
    assert.strictEqual(statusOf({ isActive: true, comingSoon: false, lifecycleState: 'draft' }), 'live');
});
check('every status is written as all three columns and reads back as itself', () => {
    for (const s of ASSISTANT_STATUSES) assert.strictEqual(statusOf(columnsFor(s)), s, s);
});
check('only a first move to Live announces a launch', () => {
    assert.ok(announcesLaunch('coming_soon', 'live') && announcesLaunch('beta', 'live') && announcesLaunch('hidden', 'live'));
    assert.ok(!announcesLaunch('live', 'live') && !announcesLaunch('coming_soon', 'beta') && !announcesLaunch('live', 'retired'));
});

console.log('\nGo-live checks');
const complete: GoLiveInput = {
    roleKey: 'blog_writer', name: 'Blog Writer', tagline: 'Articles that rank.', category: 'Marketing & Sales',
    description: 'Plans, drafts and publishes SEO articles for your blog, in your voice, on your schedule.',
    iconKey: 'pen', iconColor: 'pink', keyFeatures: ['A', 'B', 'C'], integrations: ['WordPress'], worksWith: ['standalone', 'social_media_manager'],
    video: { url: 'https://x' }, currentVersionId: 4, riskClassification: 'limited', specialCategoryClauseEnabled: true,
    knownRoleKeys: ['blog_writer', 'social_media_manager'], capabilityRowCount: 2,
};
check('a complete, built role passes everything', () => {
    const c = runGoLiveChecks(complete);
    assert.deepStrictEqual(c.filter((x) => !x.ok).map((x) => x.key), []);
    assert.strictEqual(blockersFor('live', c).length, 0);
});
check('an unbuilt role can never go Live or Beta — but can be Coming soon', () => {
    const c = runGoLiveChecks({ ...complete, roleKey: 'sop_writer', knownRoleKeys: [...complete.knownRoleKeys, 'sop_writer'] });
    assert.deepStrictEqual(blockersFor('live', c).map((x) => x.key).sort(), ['chat', 'dashboard', 'setup']);
    assert.strictEqual(blockersFor('beta', c).length, 3);
    assert.strictEqual(blockersFor('coming_soon', c).length, 0, 'a waitlist does not need code');
});
check('Coming soon needs its public card right; Hidden and Retired need nothing', () => {
    const c = runGoLiveChecks({ ...complete, tagline: '', keyFeatures: ['one'] });
    assert.deepStrictEqual(blockersFor('coming_soon', c).map((x) => x.key).sort(), ['keyFeatures', 'tagline']);
    assert.strictEqual(blockersFor('hidden', c).length, 0);
    assert.strictEqual(blockersFor('retired', c).length, 0);
});
check('a typo in "works with" blocks Live', () => {
    const c = runGoLiveChecks({ ...complete, worksWith: ['blog_writr'] });
    assert.deepStrictEqual(blockersFor('live', c).map((x) => x.key), ['worksWith']);
    assert.ok(/blog_writr/.test(c.find((x) => x.key === 'worksWith')!.fix!));
});
check('a BUILT role\'s prompt and special-category checks are answered by its code prompts, not the master version', () => {
    const c = runGoLiveChecks({ ...complete, currentVersionId: null, specialCategoryClauseEnabled: false });
    assert.ok(c.find((x) => x.key === 'version')!.ok && c.find((x) => x.key === 'specialCategory')!.ok);
    assert.ok(/in code/.test(c.find((x) => x.key === 'version')!.label));
});
check('an UNBUILT role still needs a master prompt version and the admin\'s confirmation', () => {
    const c = runGoLiveChecks({ ...complete, roleKey: 'sop_writer', currentVersionId: null, specialCategoryClauseEnabled: false, knownRoleKeys: [...complete.knownRoleKeys, 'sop_writer'] });
    const keys = blockersFor('live', c).map((x) => x.key);
    assert.ok(keys.includes('version') && keys.includes('specialCategory'));
});
check('missing integrations, video or capabilities warn but never block', () => {
    const c = runGoLiveChecks({ ...complete, integrations: [], video: null, capabilityRowCount: 0 });
    assert.deepStrictEqual(c.filter((x) => !x.ok).map((x) => x.severity), ['warning', 'warning', 'warning']);
    assert.strictEqual(blockersFor('live', c).length, 0);
});

console.log('\nThe build manifest matches the code');
const S = read('src/public/assistant-onboarding-schemas.js');
const schemaKeys = [...S.matchAll(/^ {4}([a-z_0-9]+): \[/gm)].map((m) => m[1]);
const chat = read('netlify/functions/chat-orchestrator.ts');
const routesBlock = slice(chat, 'const ROUTES: Record<string, AssistantRoute> = {', '\n};');
const routeKeys = [...routesBlock.matchAll(/^ {4}([a-z_0-9]+):/gm)].map((m) => m[1]);
const dash = read('src/components/assistant-dashboard-registry.js');
const dashKeys = [...slice(dash, 'const REGISTRY = {', '\n  };').matchAll(/^ {4}([a-z_0-9]+): \{/gm)].map((m) => m[1]);
const wizardKeys = [...slice(read('assistant-catalogue.html'), 'const ROLE_ONBOARDING_PAGE = {', '};').matchAll(/([a-z_0-9]+): '/g)].map((m) => m[1]);
const built = Object.keys(ASSISTANT_BUILD).sort();
check('the source lists were found (a stale marker would make every comparison vacuous)', () => {
    assert.ok(schemaKeys.length >= 5 && routeKeys.length >= 5 && dashKeys.length >= 5 && wizardKeys.length >= 1,
        `schemas ${schemaKeys.length}, routes ${routeKeys.length}, dashboard ${dashKeys.length}, wizards ${wizardKeys.length}`);
});
check('every role with a chat route, set-up and dashboard is in the manifest — and nothing else', () => {
    const complete3 = routeKeys.filter((k) => (schemaKeys.includes(k) || wizardKeys.includes(k)) && dashKeys.includes(k)).sort();
    assert.deepStrictEqual(built, complete3);
});
check('each manifest entry names its set-up correctly', () => {
    for (const [k, b] of Object.entries(ASSISTANT_BUILD)) {
        assert.ok(b.setup === 'wizard' ? wizardKeys.includes(k) : schemaKeys.includes(k), `${k}: setup '${b.setup}'`);
    }
});

console.log('\nStatus changes only through the checked route');
check('admin-assistants refuses a status while a blocking check fails, and is admin-only', () => {
    const ep = code('netlify/functions/admin-assistants.ts');
    assert.ok(/hasPermission\(row\.role, 'assistant_catalog'\)/.test(ep));
    const post = slice(ep, "if (event.httpMethod === 'POST' && q.action === 'status')", "return json(405");
    assert.ok(post.indexOf('blockersFor(next, checks)') < post.indexOf('db.update(masterAssistants)'), 'written before the checks ran');
    assert.ok(/announcesLaunch\(status, next\)/.test(post));
});
check('Master Data no longer writes status, and a new role starts Hidden', () => {
    const md = code('netlify/functions/master-data-api.ts');
    const patch = slice(md, "if (method === 'PATCH') {\n        if (!id) return badRequest('id required.');\n        const body = JSON.parse(event.body || '{}');\n        const [prev] = await db.select().from(masterAssistants)", "updates.updatedAt = new Date();");
    assert.ok(!/'comingSoon'|'isActive'|'lifecycleState'/.test(patch), 'status still writable from Master Data');
    assert.ok(/isActive: false, comingSoon: false, lifecycleState: 'draft'/.test(md), 'a new role is hireable on creation');
});
check('the old unchecked routes are gone from admin-api', () => {
    const api = code('netlify/functions/admin-api.ts');
    for (const r of ["resource === 'assistant-lifecycle'", "resource === 'assistant-bulk-publish'", "event.httpMethod === 'PATCH' && resource === 'catalog'"]) assert.ok(!api.includes(r), r);
});
check('master-assistants PATCH (the old Launch toggle) is admin-only', () => {
    const ma = code('netlify/functions/master-assistants.ts');
    const patch = slice(ma, 'async function handlePatch(event: any)', 'const id = parseInt(');
    assert.ok(/hasPermission\(caller\.role, 'assistant_catalog'\)/.test(patch), 'any signed-in customer can launch a role');
});

console.log('\nThe page');
const admin = read('admin.html');
check('one "Assistants" page; the Master Data tab and the old catalog code are gone', () => {
    assert.ok(admin.includes("label: 'Assistants',          perm: 'assistant_catalog'"));
    assert.ok(!admin.includes('data-tab="assistants" onclick="mdSwitchTab'), 'Master Data → Assistants still there');
    for (const gone of ['function loadCatalog', 'toggleCatalogStatus', 'openLifecycleTransition', 'openBulkPublish', 'id="lifecycle-modal"']) assert.ok(!admin.includes(gone), gone);
    assert.ok(admin.includes("if (view === 'catalog')      loadAssistantsAdmin();"));
});
check('the drawer lives at body level (inside an .admin-view it would never open)', () => {
    const drawer = admin.indexOf('<div id="aa-drawer"');
    assert.ok(drawer > admin.indexOf('<!-- ── Cross-view modals'), 'drawer is inside a view section');
});
check('status buttons are locked by the same blockers the server enforces, and changes are confirmed', () => {
    const header = slice(admin, 'function aaPaintHeader() {', 'function aaTab(tab) {');
    assert.ok(/const blocked = !current && blockersOf\(st\)\.length > 0/.test(header));
    assert.ok(/aaSetStatus[\s\S]*window\.confirmModal/.test(slice(admin, 'async function aaSetStatus(next) {', 'loadAssistantsAdmin();\n}')));
});
check('everything from the database is escaped before it is shown', () => {
    const list = slice(admin, 'function aaRender() {', 'function aaClose() {');
    assert.ok(list.includes('_aaEsc(r.name)') && list.includes('_aaEsc(r.roleKey)') && list.includes('_aaEsc(r.category)'));
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — with FAILURES above' : ''}`);
