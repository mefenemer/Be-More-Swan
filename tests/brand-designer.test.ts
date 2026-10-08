// tests/brand-designer.test.ts
// The Brand Designer, Phase 1 — docs/brand-designer-plan.md §4. Briefs → rounds of options from
// stock, AI and branded cards → the user approves into the library. GUI and chat, one server path.
//
// What is pinned, and why each one would fail silently otherwise:
//   • A brief is normalised ONCE, the same for the tab and the chat card — and the SQL CHECKs agree
//     with the vocabulary, or a valid choice would 500 on insert.
//   • The user's exact card words are never paraphrased away by art direction, and a model that
//     fails or returns junk falls back to the brief as written (a round must never die for it).
//   • Money: only AI costs; a chat card can never start a round that spends; an option is decided
//     once; an approved branded card is exempt from the 30-day unused-card sweep; a rejected stock
//     option deletes nothing of ours (it is a Pexels link).
//   • Wiring: the role is registered everywhere a role must be (a missing connection-map entry fails
//     OPEN), the tab exists in the markup, the prompt names the tab the registry names.
// The credit settle-once SQL itself is proven on real Postgres: tests/visual-briefs-db.test.ts.
//
// Run:  npx tsx tests/brand-designer.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    BRIEF_ASPECT_RATIOS, BRIEF_PURPOSES, BRIEF_SOURCES, REJECT_REASONS, SOURCE_SPECS, normaliseBrief, roundCreditCost,
} from '../src/config/visual-brief-vocab';
import { defaultSourcesFor, fallbackArtDirection, parseArtDirection, setupAnswer } from '../src/utils/visual-briefs';
import { DEFAULT_BRAND_KIT } from '../src/utils/brand-kit';
import { IMAGE_CREDIT_COST } from '../src/utils/ai-credits';
import { ROLE_CONNECTIONS } from '../src/utils/connection-map';

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
    assert.notStrictEqual(b, -1, `Could not find the end of ${what}.`);
    return text.slice(a, b);
}

const engine = code(read('src/utils/visual-briefs.ts'));
const api = code(read('netlify/functions/brand-briefs.ts'));
const migration = read('db/z-brand-designer.sql');

console.log('\n──── a brief ────');

check('a brief needs a name and something to make — never a title alone', () => {
    assert.match((normaliseBrief({ message: 'x' }) as any).error, /name/);
    assert.match((normaliseBrief({ title: 'Spring' }) as any).error, /show|words/);
    assert.ok(normaliseBrief({ title: 'Spring', headline: 'Booking now open' }).ok, 'card words alone are enough');
});

check('purpose suggests a shape; an explicit shape wins; junk falls back', () => {
    const b = (raw: Record<string, unknown>) => { const r = normaliseBrief({ title: 't', message: 'm', ...raw }); assert.ok(r.ok); return r.brief; };
    assert.strictEqual(b({ purpose: 'blog_header' }).aspectRatio, '16:9');
    assert.strictEqual(b({ purpose: 'blog_header', aspectRatio: '1:1' }).aspectRatio, '1:1');
    assert.strictEqual(b({ purpose: 'billboard' }).purpose, 'social_post');
    assert.deepStrictEqual(b({ sources: ['stock', 'canva', 'ai_image'] }).sources, ['stock', 'ai_image'], 'unknown sources are dropped');
    assert.strictEqual(b({ dueDate: 'next Friday' }).dueDate, null, 'a free-text date is never guessed into one');
    assert.ok(!normaliseBrief({ title: 't', message: 'm', sources: ['canva'] }).ok, 'no runnable source is refused');
});

check('only AI costs, and it costs what generate-ai-image charges for a grid', () => {
    assert.strictEqual(roundCreditCost(['stock', 'brand_card']), 0);
    assert.strictEqual(roundCreditCost(['stock', 'ai_image', 'brand_card']), IMAGE_CREDIT_COST);
    assert.strictEqual(SOURCE_SPECS.ai_image.credits, IMAGE_CREDIT_COST);
    assert.match(SOURCE_SPECS.ai_image.cost, new RegExp(`^${IMAGE_CREDIT_COST} AI credit for ${SOURCE_SPECS.ai_image.optionsPerRound} images$`),
        'the cost line printed before the click must match what a round makes');
});

check('the migration\'s CHECKs accept exactly the vocabulary', () => {
    const list = (col: string) => {
        const m = migration.match(new RegExp(`${col}\\s+TEXT[^\\n]*\\n?[^\\n]*CHECK \\(${col} IN \\(([^)]*)\\)\\)`));
        assert.ok(m, `No CHECK found for ${col}.`);
        return m![1].split(',').map((x) => x.trim().replace(/'/g, ''));
    };
    assert.deepStrictEqual(list('purpose'), [...BRIEF_PURPOSES]);
    assert.deepStrictEqual(list('aspect_ratio'), [...BRIEF_ASPECT_RATIOS]);
    assert.deepStrictEqual(list('source'), [...BRIEF_SOURCES]);
});

console.log('\n──── art direction ────');

check('the user\'s exact card words survive whatever the model returns', () => {
    const fb = fallbackArtDirection({ title: 't', message: 'a team', headline: 'Booking now open', mood: null, mustInclude: null, mustAvoid: null }, DEFAULT_BRAND_KIT);
    const ad = parseArtDirection('{"imagePrompt":"a team","stockKeywords":"team office","cardHeadlines":["Bookings are open!"]}', fb, 'Booking now open');
    assert.strictEqual(ad.cardHeadlines[0], 'Booking now open');
    assert.strictEqual(ad.by, 'model');
});

check('junk from the model falls back to the brief as written, never an empty round', () => {
    const fb = fallbackArtDirection({ title: 't', message: 'a calm studio', headline: null, mood: 'warm', mustInclude: null, mustAvoid: 'handshakes' }, DEFAULT_BRAND_KIT, { mustAvoid: 'suits' });
    assert.strictEqual(parseArtDirection('sorry, I cannot', fb, null), fb);
    assert.match(fb.imagePrompt, /handshakes/);
    assert.match(fb.imagePrompt, /suits/, 'the house "never show" applies to every brief');
    assert.match(fb.imagePrompt, /no text/i, 'words belong on cards — image models render them badly');
    assert.ok(fb.cardHeadlines.length >= 1);
});

check('setup answers are read by plain key, and "free only" never ticks AI', () => {
    assert.strictEqual(setupAnswer({ photoStyle: '  bright  ' }, 'photoStyle'), 'bright');
    assert.strictEqual(setupAnswer({ photoStyle: '' }, 'photoStyle'), null);
    assert.deepStrictEqual(defaultSourcesFor({ defaultSources: 'free_only' }), ['stock', 'brand_card']);
    assert.ok(defaultSourcesFor(null).includes('ai_image'));
    const schema = read('src/public/assistant-onboarding-schemas.js');
    const block = span(schema, 'brand_designer: [', '\n    ],\n', 'the Brand Designer onboarding schema');
    for (const k of ['photoStyle', 'avoidAlways', 'defaultSources']) assert.match(block, new RegExp(`key: '${k}'`), `setup no longer asks ${k}`);
    assert.match(block, /operational: true/);
});

console.log('\n──── money and decisions ────');

check('a round holds its credit before it is marked generating, and gives it back on a lost race', () => {
    const fn = span(engine, 'export async function startRound', '\n}\n', 'startRound');
    assert.ok(fn.indexOf('holdCredits(') < fn.indexOf("status: 'generating'"), 'hold first, then claim');
    assert.match(fn, /if \(!rows\.length\) \{[\s\S]{0,200}settleHold\([^)]*success: false/);
    assert.match(fn, /orgHasAssistantFeature\(db, orgId, 'ai_image_generation'\)/, 'AI is gated like every other AI image surface');
});

check('a round is settled in ONE statement that reads the old hold and only matches a running round', () => {
    const fn = span(engine, 'export async function endRound', '\n}\n', 'endRound');
    assert.match(fn, /FOR UPDATE\) old/);
    assert.match(fn, /b\.status = 'generating'/);
    assert.match(fn, /RETURNING b\.organisation_id, old\.held/, 'RETURNING the NEW hold would always be 0 and nothing would ever be settled');
    const run = span(engine, 'export async function runRound', '\n}\n', 'runRound');
    assert.match(run, /\} finally \{\s*await endRound\(/, 'every exit from a round ends it');
});

check('every AI attempt is recorded where the platform-wide failure alert reads', () => {
    const fn = span(engine, 'async function aiOptions', '\n}\n', 'aiOptions');
    assert.ok((fn.match(/insert\(mediaGenerationJobs\)/g) || []).length >= 2, 'success AND failure rows');
    assert.match(fn, /persistRemoteMediaToR2\([^)]*folder: 'briefs'/, 'fal URLs expire — options are copied to R2 at once');
});

check('an option is decided once; approving puts it in the library; a card is kept from the sweep', () => {
    const fn = span(engine, 'export async function decideOption', '\n}\n', 'decideOption');
    assert.ok((fn.match(/eq\(visualBriefOptions\.status, 'proposed'\)/g) || []).length >= 2, 'both decisions claim the option conditionally');
    assert.match(fn, /insert\(contentAssets\)/);
    assert.match(fn, /provider: BRAND_CARD_PROVIDER[^}]*libraryKeptAt: new Date\(\)/,
        'without libraryKeptAt the 30-day unused-card sweep deletes an approved card from the library');
    assert.match(fn, /if \(opt\.storageKey && opt\.source !== 'stock'\) await deleteR2Object/, 'a stock option is a Pexels link — nothing of ours to delete');
    assert.match(fn, /status: 'proposed', decidedAt: null/, 'a failed approve gives the option back');
});

check('options are not library rows until approved', () => {
    assert.match(migration, /CREATE TABLE IF NOT EXISTS visual_brief_options/);
    const stock = span(engine, 'async function stockOptions', '\n}\n', 'stockOptions');
    assert.ok(!/contentAssets/.test(stock) && !/createPexelsAsset/.test(stock), 'a stock CANDIDATE must not create a library row');
});

check('the API: role-guarded, moderated before spending, a lost wake-up refunds at once', () => {
    assert.match(api, /\(\$\{aiAssistants\.configuration\} ->> 'type'\) = \$\{BRAND_DESIGNER_ROLE_KEY\}/);
    const gen = span(api, 'async function generate(', '\n    }\n', 'generate');
    assert.ok(gen.indexOf('enforcePromptModeration') < gen.indexOf('startRound'), 'moderate before holding a credit');
    assert.match(gen, /if \(!\(await triggerBriefRound[\s\S]{0,200}endRound\(db, brief\.id, \{ chargeAi: false/);
    assert.match(api, /await sweepStuckRounds\(db, orgId\)/, 'a stuck round is ended on the next load, never left spinning');
    const create = span(api, "if (action === 'create')", "if (action === 'edit')", 'create');
    assert.match(create, /json\(201, \{ ok: true, briefId: brief\.id, roundStarted: false, roundError/,
        'a saved brief whose round failed is still "created" — an error status would make the next Save a duplicate');
    const worker = code(read('netlify/functions/generate-brief-options-background.ts'));
    assert.match(worker, /if \(!secret\) \{[\s\S]{0,200}503/, 'the worker fails CLOSED without its secret');
});

console.log('\n──── the chat ────');

check('a chat card can never start a round that spends', () => {
    const reg = read('src/components/disruptive-ui-registry.js');
    const card = span(reg, 'function renderVisualBriefProposalCard', "register('visual_brief_proposal'", 'the brief card');
    assert.match(card, /const free = !brief\.sources\.includes\('ai_image'\)/);
    assert.match(card, /\$\{free \? `<button type="button" data-vbp-save="generate"/);
    const session = code(read('src/components/chat-session.js'));
    assert.match(session, /const generate = d\.generate === true && !\(Array\.isArray\(b\.sources\) && b\.sources\.includes\('ai_image'\)\)/,
        'enforced again where the request is made, not only where the button is drawn');
    assert.match(session, /origin: 'chat'/);
    for (const ev of ['brief:create', 'brief:review']) {
        assert.match(session, new RegExp(`addEventListener\\('${ev}'`));
        assert.match(session, new RegExp(`removeEventListener\\('${ev}'`));
    }
    assert.match(reg, /register\('visual_option_review'/);
});

check('the route reads the briefs every turn and names only real options', () => {
    const orch = read('netlify/functions/chat-orchestrator.ts');
    const route = span(orch, '    brand_designer: {', 'parseResponse: parseStructuredReply', 'the brand_designer route');
    assert.match(route, /usesBriefsSnapshot: true/);
    assert.match(route, /onboardingValue\(rc, 'photoStyle'\)/);
    assert.match(route, /only ids listed there, never invented/);
    assert.match(route, /cannot make AI video/i, 'Phase 4 sources must be stated as missing, not promised');
    assert.match(orch, /route\.usesBriefsSnapshot\s*\? await buildBriefsSnapshot/);
    // The prompt names the tab; the registry names the tab. They must agree.
    const reg = read('src/components/assistant-dashboard-registry.js');
    const label = reg.match(/briefsTab: \{\s*label: '([^']+)'/)![1];
    assert.match(orch, new RegExp(`"${label}" tab — the tab the user lands on`));
});

console.log('\n──── registered everywhere a role must be ────');

check('connection policy is EXPLICITLY empty — a missing entry fails open', () => {
    assert.ok(Object.prototype.hasOwnProperty.call(ROLE_CONNECTIONS, 'brand_designer'));
    assert.deepStrictEqual(ROLE_CONNECTIONS.brand_designer, []);
});

check('dashboard: own tab, own KPIs, no social Review Queue or empty Data Hub', () => {
    const fakeWindow: { AssistantDashboardRegistry?: { REGISTRY: Record<string, any> } } = {};
    new Function('window', read('src/components/assistant-dashboard-registry.js'))(fakeWindow);
    const cfg = fakeWindow.AssistantDashboardRegistry!.REGISTRY.brand_designer;
    assert.ok(cfg, 'a missing entry falls back to the SOCIAL dashboard');
    assert.strictEqual(cfg.metricsSource, 'brand');
    assert.strictEqual(cfg.kpis.length, 4);
    assert.strictEqual(cfg.hideReviewQueue, true);
    assert.strictEqual(cfg.hideDataHub, true);
    assert.strictEqual(cfg.defaultMainTab, 'briefs');
    const a = code(read('assistants.js'));
    assert.match(a, /toggle\('maintab-btn-review-queue', !cfg\.hideReviewQueue\)/);
    assert.match(a, /if \(source === 'brand'\) \{[\s\S]{0,80}_loadBrandMetrics\(assistantId\)/);
    assert.match(a, /if \(name === 'briefs'\) window\.AssistantBriefs\?\.activate\(\)/);
    assert.match(a, /window\.AssistantBriefs\?\.init\(\{ assistantId: data\.id \}\)/);
});

check('the tab exists in the markup and its script is loaded', () => {
    const html = read('assistant-detail.html');
    for (const id of ['maintab-btn-briefs', 'briefs-tab-label', 'briefs-review-badge', 'maintab-briefs', 'briefs-host']) {
        assert.match(html, new RegExp(`id="${id}"`), `#${id} is missing — the tab would render nothing`);
    }
    assert.match(read('workspace.html'), /<script src="\/src\/components\/assistant-briefs\.js"><\/script>/);
    const tab = read('src/components/assistant-briefs.js');
    assert.match(tab, /getElementById\('briefs-host'\)/);
    assert.match(tab, /getElementById\('briefs-review-badge'\)/);
    // Handlers bound to document at load — never from the render path.
    const renderFn = span(tab, '  function render() {', '\n  }\n', 'render');
    assert.ok(!/addEventListener/.test(renderFn), 'a handler bound in render is a button that renders and does nothing');
});

check('catalogue: migration, TS seed and JSON seed say the same thing', () => {
    const desc = migration.match(/'brand_designer',\s*'Brand Designer',\s*'([^']+)'/)![1];
    const ts = read('db/seed-catalog.ts');
    assert.ok(ts.includes(`description: '${desc}'`), 'seed-catalog.ts description drifted from the migration');
    const json = JSON.parse(read('seed/data/master_assistants.json')) as Array<Record<string, unknown>>;
    const row = json.find((r) => r.roleKey === 'brand_designer');
    assert.ok(row && row.description === desc, 'master_assistants.json drifted from the migration');
    assert.match(migration, /INSERT INTO assistant_features[\s\S]*'ai_image_generation'[\s\S]*WHERE ma\.role_key = 'brand_designer'/,
        'without the grant, the assistant whose job is pictures is refused AI images');
    assert.ok(!/ai_video_generation/.test(migration), 'video is Phase 4, and the grant is org-wide');
});

check('every reject reason the server knows is one the prompt offers', () => {
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.match(orch, /REJECT_REASONS\.map\(\(r\) => `"\$\{r\}"`\)/);
    assert.strictEqual(REJECT_REASONS.includes('other' as never), true, 'a free-text reason needs an "other" key');
});

console.log(`\n${passed} checks passed.`);
