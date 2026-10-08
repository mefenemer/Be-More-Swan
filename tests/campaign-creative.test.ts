// tests/campaign-creative.test.ts
// §9.3 of docs/campaign-orchestrator-plan.md: a campaign's tone of voice and its own pictures.
//
// WHY THIS EXISTS. "If the Orchestrator tells the SMM to post 14 times, it needs to attach approved
// campaign visual assets and enforce a specific campaign tone — without this the AI will generate
// disjointed, text-heavy spam." Both halves have to REACH generation, not just be saved: the tone
// through blueprint section 13, the pictures through the media resolver.
//
// One property matters more than the rest: a campaign picture keeps its REAL origin. The resolver's
// `source` feeds the auto-publish gate, where AI imagery must never qualify. Reporting every
// campaign picture as 'manual' would let an AI image someone attached to a campaign publish
// unattended — so the source is read from the asset's provider, and an unknown provider is 'ai'.
//
// Run:  npx tsx tests/campaign-creative.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    CAMPAIGN_TONE_MAX, MAX_CAMPAIGN_ASSETS, mediaSourceForProvider, normaliseAssetIds, normaliseTone,
} from '../src/config/campaign-creative';
import { buildCampaignDirective } from '../src/utils/campaign-directive';

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

const resolver = code(read('src/utils/media-resolver.ts'));
const api = code(read('netlify/functions/campaigns.ts'));

console.log('\n──── a campaign picture keeps its real origin ────');

check('the source is read from the provider, and an unknown provider is treated as AI', () => {
    assert.strictEqual(mediaSourceForProvider(null), 'manual');
    assert.strictEqual(mediaSourceForProvider('canva'), 'manual');
    assert.strictEqual(mediaSourceForProvider('pexels'), 'stock', 'Stock keeps its credit line.');
    assert.strictEqual(mediaSourceForProvider('brand_card'), 'brand_card');
    assert.strictEqual(mediaSourceForProvider('fal'), 'ai');
    assert.strictEqual(mediaSourceForProvider('some-new-generator'), 'ai',
        'An unknown provider must fail SAFE — the auto-publish gate never lets AI imagery publish unattended.');
});

check('the resolver reports a campaign picture by its provider, never as "campaign" or a blanket "manual"', () => {
    assert.match(resolver, /source: mediaSourceForProvider\(picked\.provider\)/);
});

console.log('\n──── the pictures reach the posts ────');

check('campaign pictures are tried BEFORE the assistant\'s usual sources', () => {
    const fn = span(resolver, 'export async function resolveMediaForPost', '\n}\n', 'resolveMediaForPost');
    const campaignFirst = fn.indexOf('pickCampaignAsset(');
    const loop = fn.indexOf('for (const source of order)');
    assert.ok(campaignFirst !== -1 && campaignFirst < loop);
});

check('a failing campaign lookup falls through instead of costing the post its picture', () => {
    const fn = span(resolver, 'if (args.campaignId) {', 'for (const source of order)', 'the campaign block');
    assert.match(fn, /catch \(err\)/);
});

check('the campaign picker is org-scoped twice, skips dead assets, and rotates least-used first', () => {
    const fn = span(resolver, 'async function pickCampaignAsset', '\n}\n', 'pickCampaignAsset');
    assert.match(fn, /eq\(campaignAssets\.organisationId, orgId\)/);
    assert.match(fn, /eq\(contentAssets\.organisationId, orgId\)/);
    assert.match(fn, /isNull\(contentAssets\.purgedAt\)/);
    assert.match(fn, /ne\(contentAssets\.status, 'rejected'\)/);
    assert.match(fn, /SELECT count\(\*\) FROM scheduled_post_assets/,
        'Least-used first: a campaign picture may be reused (one look across the flight) but must rotate.');
});

check('the content job passes its campaign, and never for a Short', () => {
    const jobs = code(read('netlify/functions/process-content-jobs.ts'));
    assert.match(jobs, /campaignId: campaignOfJob\?\.campaignId \?\? null/);
    assert.match(jobs, /isYoutubeShort \? \[\] : await db/,
        'A Short needs 9:16 — a campaign photo at the wrong ratio would be a postage stamp on a black field.');
});

console.log('\n──── the tone reaches the drafting ────');

check('the directive carries the tone, inside the brand voice', () => {
    const d = buildCampaignDirective({
        id: 1, objective: 'Launch the autumn range', outcomeMetric: 'leads', pace: 'unknown',
        tone: 'warm and celebratory, no discount language',
    })!.directive;
    assert.match(d, /warm and celebratory, no discount language/);
    assert.match(d, /they win/, 'The tone narrows the brand voice and must say so, or "playful" drops the brand\'s rules.');
    const none = buildCampaignDirective({ id: 1, objective: 'x', outcomeMetric: 'leads', pace: 'unknown' })!.directive;
    assert.ok(!/tone this campaign asks for/.test(none));
});

check('the blueprint reads the tone, and a tone edit recompiles', () => {
    const bp = code(read('src/utils/blueprint.ts'));
    assert.match(bp, /tone: campaigns\.tone/);
    assert.match(bp, /directiveInputFrom\(liveCampaign,/);
    const d = code(read('src/utils/campaign-directive.ts'));
    assert.match(d, /tone: c\.tone \?\? null/);
    const edit = span(api, "action === 'edit'", "action === 'start'", 'edit');
    assert.match(edit, /patch\.tone !== undefined\)/);
});

check('tone and ids are normalised the same way everywhere', () => {
    assert.strictEqual(normaliseTone('  warm   and\nkind '), 'warm and kind');
    assert.strictEqual(normaliseTone('   '), null);
    assert.strictEqual(normaliseTone('x'.repeat(999))!.length, CAMPAIGN_TONE_MAX);
    assert.deepStrictEqual(normaliseAssetIds([3, '3', 0, -1, 'x', 4.5, 7]), [3, 7]);
    assert.strictEqual(normaliseAssetIds(Array.from({ length: 99 }, (_, i) => i + 1)).length, MAX_CAMPAIGN_ASSETS);
});

console.log('\n──── the boundary ────');

check('attaching checks every id against this organisation\'s live library, and caps the set', () => {
    const fn = span(api, 'async function attachAssets', '\n    }\n', 'attachAssets');
    assert.match(fn, /eq\(contentAssets\.organisationId, orgId\)/,
        'An id from another tenant\'s library must never be attached.');
    assert.match(fn, /isNull\(contentAssets\.purgedAt\)/);
    assert.match(fn, /MAX_CAMPAIGN_ASSETS - Number\(n\)/);
    assert.match(fn, /onConflictDoNothing\(\)/, 'Attaching twice must not fail or duplicate.');
});

check('detaching and listing are scoped to the organisation', () => {
    const detach = span(api, "action === 'detach_asset'", "action === 'complete_task'", 'detach_asset');
    assert.match(detach, /eq\(campaignAssets\.organisationId, orgId\)/);
    const lib = span(api, "action === 'list_library'", "action === 'attach_assets'", 'list_library');
    assert.match(lib, /eq\(contentAssets\.organisationId, orgId\)/);
    assert.match(lib, /resolveAssetDisplayUrl\(a\)/, 'R2 is private — thumbnails must be signed URLs, never raw keys.');
});

check('the migration is a link table that cannot break the media library', () => {
    const sql = read('db/z-campaign-creative.sql');
    assert.match(sql, /ADD COLUMN IF NOT EXISTS tone TEXT/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS campaign_assets/);
    assert.match(sql, /content_asset_id INTEGER NOT NULL REFERENCES content_assets\(id\) ON DELETE CASCADE/);
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS campaign_assets_pair_uidx/);
    assert.ok(!/ALTER TABLE content_assets/i.test(sql),
        'content_assets is read with bare selects by the library — a new column there breaks it before the migration is applied.');
    const schema = read('db/schema.ts');
    assert.match(schema, /export const campaignAssets = pgTable\("campaign_assets"/);
    assert.match(schema, /tone: text\(\),/);
});

console.log('\n──── GUI and chat both reach it (§9.0) ────');

check('the Campaigns tab sets a tone and attaches pictures, counting from the server\'s answer', () => {
    const tab = code(read('src/components/assistant-campaigns.js'));
    assert.match(tab, /data-cmpf="tone"/);
    assert.match(tab, /function picturesPanel/);
    assert.match(tab, /action: 'attach_assets'/);
    assert.match(tab, /action: 'detach_asset'/);
    assert.match(tab, /data\.attached\.length/, 'The toast must count what the SERVER attached.');
});

check('the chat can only attach pictures it was shown, and the cards send what they name', () => {
    const plan = code(read('src/utils/campaign-plan.ts'));
    assert.match(plan, /the only assetId values you may attach/);
    const orch = code(read('netlify/functions/chat-orchestrator.ts'));
    assert.match(orch, /Only attach assetId values from the library list above/);
    const card = code(read('src/components/disruptive-ui-registry.js'));
    assert.match(card, /attachAssetIds: attach\.map\(\(a\) => a\.id\)/);
    assert.match(card, /changes\.detachAssetIds = removePics\.map/);
    const chat = code(read('src/components/chat-session.js'));
    assert.match(chat, /detachAssetIds: c\.detachAssetIds/);
});

console.log(`\n${passed} checks passed.`);
