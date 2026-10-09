// tests/brand-designer-sources.test.ts
// The Brand Designer's Phase 4 sources — stock video, AI video, and "Add your own" (an upload, or a
// library picture, which is where a Canva import lands). docs/brand-designer-plan.md §6 step 4.
// The split image/video settlement is proven on real Postgres in visual-briefs-db.test.ts.
//
// What is pinned, and how each would fail silently:
//   • AI video is PAID everywhere "free" is decided — a chat card or a campaign plan that treated
//     "no AI images" as free would start a 5-credit round on the user's behalf.
//   • AI video has the same two locks as My Content (assistant feature AND plan tier), and the label
//     never charges for a source the round will skip.
//   • The video part of a hold is settled on its own, so a failed clip never costs its credits.
//   • "Your own" copies nothing and deletes nothing: it IS the user's library picture. Only files we
//     generated are deleted when turned down. Another tenant's asset id is never added.
//   • Uploads go through My Content's own upload + safety check — a brief can never hold a file the
//     library would have refused.
//   • The chat cannot upload, and says where the button is.
//
// Run:  npx tsx tests/brand-designer-sources.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    BRIEF_SOURCES, OPTION_SOURCES, PAID_SOURCES, SOURCE_SPECS, VIDEO_SOURCES, normaliseBrief, roundCreditCost, sourcesAreFree,
} from '../src/config/visual-brief-vocab';
import { VIDEO_CREDIT_COST, IMAGE_CREDIT_COST } from '../src/utils/ai-credits';
import { normalisePlanOrders } from '../src/utils/campaign-plan';

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

console.log('\n──── what is paid ────');

check('AI video is paid, one clip per round, at the platform\'s video price', () => {
    assert.deepStrictEqual([...PAID_SOURCES], ['ai_image', 'ai_video']);
    assert.strictEqual(SOURCE_SPECS.ai_video.credits, VIDEO_CREDIT_COST);
    assert.strictEqual(SOURCE_SPECS.ai_video.optionsPerRound, 1, 'four clips would be 20 credits for one brief');
    assert.strictEqual(SOURCE_SPECS.stock_video.credits, 0);
    assert.strictEqual(roundCreditCost(['ai_image', 'ai_video', 'stock_video']), IMAGE_CREDIT_COST + VIDEO_CREDIT_COST);
    assert.strictEqual(sourcesAreFree(['stock', 'stock_video', 'brand_card']), true);
    assert.strictEqual(sourcesAreFree(['stock', 'ai_video']), false);
    assert.deepStrictEqual([...VIDEO_SOURCES], ['stock_video', 'ai_video']);
    assert.ok(!BRIEF_SOURCES.includes('own' as never) && OPTION_SOURCES.includes('own' as never), '"own" is an option, never something a round generates');
});

check('every "free, so start it now" path counts AI video as paid', () => {
    assert.match(code(read('src/utils/campaign-visual-order.ts')), /allFree: sourcesAreFree\(n\.brief\.sources\)/);
    assert.match(code(read('src/components/chat-session.js')), /b\.sources\.some\(\(x\) => x === 'ai_image' \|\| x === 'ai_video'\)/);
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.match(reg, /const free = !brief\.sources\.some\(\(x\) => x === 'ai_image' \|\| x === 'ai_video'\)/);
    // Anywhere else deciding "free" from ai_image alone would quietly let AI video through.
    for (const f of ['src/components/chat-session.js', 'src/components/disruptive-ui-registry.js', 'src/utils/campaign-visual-order.ts']) {
        assert.ok(!/!\s*[\w.]*sources\.includes\('ai_image'\)/.test(code(read(f))), `${f} still decides "free" from AI images alone`);
    }
});

check('briefs and plans accept the video sources and "waiting on"', () => {
    const n = normaliseBrief({ title: 't', message: 'm', sources: ['stock_video', 'ai_video', 'own'], waitingOn: '  Sam (designer) ' });
    assert.ok(n.ok);
    assert.deepStrictEqual(n.brief.sources, ['stock_video', 'ai_video'], '"own" is not a round source');
    assert.strictEqual(n.brief.waitingOn, 'Sam (designer)');
    const [o] = normalisePlanOrders([{ action: 'commission_visuals', show: 'x', sources: ['ai_video', 'stock_video'] }]);
    assert.deepStrictEqual(o.brief.sources, ['stock_video', 'ai_video']);
});

console.log('\n──── AI video\'s locks and its own hold ────');

check('the same two locks as My Content: assistant feature AND plan tier', () => {
    const fn = span(engine, 'export async function videoUnavailableReason', '\n}\n', 'videoUnavailableReason');
    assert.match(fn, /orgHasAssistantFeature\(db, orgId, 'ai_video_generation'\)/);
    assert.match(fn, /tierCanGenerateVideo\(await getActiveTierKeyByOrg\(db, orgId\)\)/);
    const start = span(engine, 'export async function startRound', '\n}\n', 'startRound');
    assert.match(start, /const why = await videoUnavailableReason\(db, orgId\)/);
    assert.match(start, /creditHoldVideo: videoCredits/);
    const sql = read('db/z-brand-designer-sources.sql');
    assert.match(sql, /'ai_video_generation', true[\s\S]*role_key = 'brand_designer'/);
});

check('the video part of the hold is settled on its own, as video', () => {
    const fn = span(engine, 'export async function endRound', '\n}\n', 'endRound');
    assert.match(fn, /credit_hold_video = 0/, 'zeroed in the same statement as the rest');
    assert.match(fn, /RETURNING b\.organisation_id, old\.held, old\.held_video/);
    assert.match(fn, /success: outcome\.chargeVideo === true, mediaType: 'video'/, 'absent = refunded');
    const run = span(engine, 'export async function runRound', '\n}\n', 'runRound');
    assert.match(run, /brief\.creditHoldVideo >= VIDEO_CREDIT_COST \? aiVideoOptions/, 'the hold is the authority — no hold, no clip');
    assert.match(run, /chargeVideo: videoProduced/);
});

check('an AI clip is waited for inside the round, abandoned before the sweep, recorded, and copied to R2', () => {
    const fn = span(engine, 'async function aiVideoOptions', '\n}\n', 'aiVideoOptions');
    assert.match(fn, /if \(Date\.now\(\) > deadline\) throw new Error\('video_timeout'\)/);
    assert.match(engine, /const VIDEO_POLL_DEADLINE_MS = 8 \* 60 \* 1000/);
    assert.match(read('src/config/visual-brief-vocab.ts'), /GENERATION_TIMEOUT_MS = 10 \* 60 \* 1000/,
        'the clip must give up BEFORE the sweep refunds the round, or a late clip would be charged after "nothing was charged"');
    assert.ok((fn.match(/insert\(mediaGenerationJobs\)/g) || []).length >= 2, 'success and failure both reach the platform failure alert');
    assert.match(fn, /persistRemoteMediaToR2\(\{[^}]*folder: 'briefs'/);
});

console.log('\n──── "Add your own" ────');

check('own options point at the user\'s library asset: org-scoped, never rejected files, no copy, no delete', () => {
    const add = span(engine, 'export async function addOwnOptions', '\n}\n', 'addOwnOptions');
    assert.match(add, /eq\(contentAssets\.organisationId, args\.orgId\)/, 'another tenant\'s id must never be added');
    assert.match(add, /\$\{contentAssets\.status\} <> 'rejected'/, 'a file the safety check refused is never an option');
    assert.match(add, /contentAssetId: a\.id/);
    assert.ok(!/storageKey/.test(add), 'an own option holds no file of its own');
    const decide = span(engine, 'export async function decideOption', '\n}\n', 'decideOption');
    assert.match(decide, /if \(opt\.source === OWN_SOURCE && opt\.contentAssetId\) \{/);
    assert.ok(decide.indexOf('opt.source === OWN_SOURCE') < decide.indexOf('insert(contentAssets)'), 'approving "own" makes no second library row');
    assert.match(engine, /const GENERATED_SOURCES = new Set\(\['ai_image', 'brand_card', 'ai_video'\]\)/);
});

check('uploads go through My Content\'s own upload and safety check', () => {
    const tab = read('src/components/assistant-briefs.js');
    const up = span(tab, 'async function uploadToLibrary', '\n  }\n', 'uploadToLibrary');
    assert.match(up, /\/\.netlify\/functions\/content-upload-url/);
    assert.match(up, /\/\.netlify\/functions\/content-assets/);
    assert.match(up, /if \(data\.rejected\) throw/, 'a refused file must stop here, not become an option');
    assert.match(tab, /data-brief-own-open/);
    assert.match(tab, /designs you imported from Canva are here too/);
    const api = code(read('netlify/functions/brand-briefs.ts'));
    assert.match(api, /if \(action === 'add_own'\)/);
    assert.match(api, /if \(action === 'list_library'\)/);
    assert.match(api, /aiVideoUnavailable: videoBlocked/);
});

check('the tab never charges for a source the round will skip, and plays videos', () => {
    const tab = read('src/components/assistant-briefs.js');
    const label = span(tab, 'function roundButtonLabel', '\n  }\n', 'roundButtonLabel');
    assert.match(label, /\.filter\(\(k\) => !sourceBlocked\(k\)\)/);
    assert.match(tab, /<video src="\$\{esc\(o\.url\)\}" controls muted playsinline/);
});

check('the chat states the video lock and that it cannot upload', () => {
    const orch = read('netlify/functions/chat-orchestrator.ts');
    const route = span(orch, '    brand_designer: {', 'parseResponse: parseStructuredReply', 'the brand_designer route');
    assert.match(route, /only on the Saver and Employee plans/);
    assert.match(route, /which is where designs they import from Canva land/);
    assert.match(route, /"waitingOn"/);
    assert.match(read('src/components/disruptive-ui-registry.js'), /stock_video: 'Stock videos', ai_video: 'AI video'/);
});

console.log(`\n${passed} checks passed.`);
