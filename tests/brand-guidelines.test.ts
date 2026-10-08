// tests/brand-guidelines.test.ts
// Picture guidelines — Brand Designer plan, Phase 2 (§4.5). src/utils/brand-guidelines.ts.
//
// What is pinned, and how each would fail silently:
//   • Guidelines live OUTSIDE brand_kit. Website extraction replaces the kit wholesale, so a guideline
//     stored inside it would vanish the next time the colours were re-read — and saving one must not
//     mark the kit 'manual', which would stop colour extraction for ever.
//   • A partial save changes only what it names; a bad colour is refused, not quietly dropped.
//   • Every AUTOMATIC AI image reads them (one choke point: generateAndPersistImage), a failed read
//     never costs the picture, and the manual "Generate with AI" prompt is left as the user typed it.
//   • The Brand Designer: workspace guidelines win; Phase 1 setup answers only fill an EMPTY one.
//   • GUI and chat both reach the one save, and the chat is shown the current text (its card
//     REPLACES a field, so a model that only saw the new part would delete the old one).
//
// Run:  npx tsx tests/brand-guidelines.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    EMPTY_GUIDELINES, applyGuidelinesToImagePrompt, guidelinesPromptLines, hasGuidelines, mergeGuidelines, normaliseGuidelines,
} from '../src/utils/brand-guidelines';
import { withSetupFallback } from '../src/utils/visual-briefs';

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

console.log('\n──── the shape ────');

check('stored junk normalises to usable guidelines; colours are deduped and capped', () => {
    assert.deepStrictEqual(normaliseGuidelines(null), { ...EMPTY_GUIDELINES, secondaryColors: [] });
    const g = normaliseGuidelines({ photoStyle: '  bright   and natural ', secondaryColors: ['#FFD166', '#ffd166', 'pink', '#06d6a0', '#111111', '#222222', '#333333'] });
    assert.strictEqual(g.photoStyle, 'bright and natural');
    assert.deepStrictEqual(g.secondaryColors, ['#ffd166', '#06d6a0', '#111111', '#222222']);
    assert.strictEqual(hasGuidelines(normaliseGuidelines({})), false);
});

check('a save changes only the fields it names; null or "" clears one', () => {
    const current = normaliseGuidelines({ photoStyle: 'bright', mustAvoid: 'suits', secondaryColors: ['#ffd166'] });
    const r = mergeGuidelines(current, { mustAvoid: 'suits, handshakes' });
    assert.ok(r.ok);
    assert.strictEqual(r.guidelines.photoStyle, 'bright', 'an absent key must not be touched');
    assert.strictEqual(r.guidelines.mustAvoid, 'suits, handshakes');
    assert.deepStrictEqual(r.guidelines.secondaryColors, ['#ffd166']);
    assert.ok(r.guidelines.updatedAt);
    const cleared = mergeGuidelines(current, { photoStyle: null, secondaryColors: [] });
    assert.ok(cleared.ok);
    assert.strictEqual(cleared.guidelines.photoStyle, null);
    assert.deepStrictEqual(cleared.guidelines.secondaryColors, []);
});

check('a bad colour is REFUSED, not silently dropped', () => {
    const r = mergeGuidelines(EMPTY_GUIDELINES, { secondaryColors: ['#ffd166', 'pinkish'] });
    assert.ok(!r.ok);
    assert.match((r as { error: string }).error, /pinkish.*not a colour/);
    assert.ok(!mergeGuidelines(EMPTY_GUIDELINES, { secondaryColors: ['#111111', '#222222', '#333333', '#444444', '#555555'] }).ok);
});

console.log('\n──── who reads them ────');

check('an image prompt is unchanged when there are none, and keeps its subject first when there are', () => {
    assert.strictEqual(applyGuidelinesToImagePrompt('A bakery at dawn', EMPTY_GUIDELINES), 'A bakery at dawn');
    const g = normaliseGuidelines({ photoStyle: 'warm film look', mustAvoid: 'people eating', secondaryColors: ['#ffd166'] });
    const p = applyGuidelinesToImagePrompt('A bakery at dawn', g);
    assert.ok(p.startsWith('A bakery at dawn '));
    assert.match(p, /Style: warm film look\./);
    assert.match(p, /Never show: people eating\./);
    assert.match(p, /#ffd166/);
    const long = applyGuidelinesToImagePrompt('x', normaliseGuidelines({ photoStyle: 'a'.repeat(500), mustAvoid: 'b'.repeat(300) }));
    assert.ok(long.length <= 1 + 1 + 450, 'the guidelines may not drown the subject');
});

check('EVERY automatic AI image goes through the one function that applies them', () => {
    const persist = code(read('src/lib/media-persist.ts'));
    const fn = span(persist, 'export async function generateAndPersistImage', '\n}\n', 'generateAndPersistImage');
    assert.match(fn, /prompt = applyGuidelinesToImagePrompt\(params\.prompt, await readBrandGuidelines\(db, params\.orgId\)\)/);
    assert.match(fn, /catch \(err\) \{[\s\S]{0,200}prompt used as written/, 'a failed read must never cost the picture');
    assert.match(fn, /generateImages\(\{ prompt, /, 'the GUIDED prompt is the one sent');
    for (const f of ['netlify/functions/process-content-jobs.ts', 'netlify/functions/autonomous-media-suggestions.ts', 'netlify/functions/regenerate-post-media.ts']) {
        const src = code(read(f));
        assert.match(src, /generateAndPersistImage\(/, `${f} no longer goes through generateAndPersistImage — it would skip the guidelines`);
        assert.ok(!/generateImages\(/.test(src), `${f} calls fal directly — it would skip the guidelines`);
    }
});

check('the manual "Generate with AI" prompt is left exactly as the user typed it', () => {
    const manual = code(read('netlify/functions/generate-ai-image.ts'));
    assert.ok(!/applyGuidelinesToImagePrompt|readBrandGuidelines/.test(manual),
        'silently rewriting a prompt someone typed is worse than leaving it — this was a deliberate choice');
});

check('the Brand Designer: workspace guidelines win; Phase 1 setup answers only fill an empty one', () => {
    const ws = normaliseGuidelines({ photoStyle: 'workspace style' });
    const merged = withSetupFallback(ws, { photoStyle: 'setup style', avoidAlways: 'setup avoid' });
    assert.strictEqual(merged.photoStyle, 'workspace style');
    assert.strictEqual(merged.mustAvoid, 'setup avoid');
    const engine = code(read('src/utils/visual-briefs.ts'));
    assert.match(engine, /\.\.\.guidelinesPromptLines\(ctx\.guidelines\)/, 'art direction reads them');
    assert.match(engine, /fallbackArtDirection\(brief, ctx\.kit, ctx\.guidelines\)/, 'and so does the fallback when the model is down');
    const schema = read('src/public/assistant-onboarding-schemas.js');
    assert.match(schema, /Used when your workspace has no photo style set under Business Information ▸ Brand Assets/,
        'the setup question must say it is only a fallback now');
});

console.log('\n──── stored apart from the kit ────');

check('a column of its own, applied before code that names it', () => {
    assert.match(read('db/z-brand-guidelines.sql'), /ALTER TABLE organisations ADD COLUMN IF NOT EXISTS brand_guidelines JSONB;/);
    assert.match(read('db/schema.ts'), /brandGuidelines: jsonb\('brand_guidelines'\)/);
});

check('extraction never writes them, and saving them never marks the kit "manual"', () => {
    const api = code(read('netlify/functions/brand-kit.ts'));
    const save = span(api, "if (body.action === 'save_guidelines')", "if (body.action !== 'extract')", 'save_guidelines');
    assert.match(save, /set\(\{ brandGuidelines: merged\.guidelines, updatedAt: new Date\(\) \}\)/);
    assert.ok(!/brandKit|source/.test(save), 'saving guidelines must not touch the kit or its source');
    const extract = span(api, "if (body.action !== 'extract')", "if (event.httpMethod === 'PATCH')", 'extract');
    assert.ok(!/brandGuidelines/.test(extract));
    assert.ok(!/brandGuidelines/.test(code(read('src/lib/brand-extract-fetch.ts'))));
    assert.match(api, /guidelines: normaliseGuidelines\(org\.guidelines\)/, 'GET returns them');
});

console.log('\n──── GUI and chat, one save ────');

check('Business Information ▸ Brand Assets has the section and saves through the API', () => {
    const page = read('assets.html');
    const section = span(page, 'Picture guidelines (src/utils/brand-guidelines.ts)', '── Brand assets ──', 'the guidelines section');
    for (const id of ['bg-photoStyle', 'bg-mustInclude', 'bg-mustAvoid', 'bg-secondaryColors', 'guidelines-save', 'guidelines-msg']) {
        assert.match(section, new RegExp(`id="${id}"`));
    }
    assert.match(section, /action: 'save_guidelines'/);
    assert.match(section, /data-explain="brand-guidelines"/);
    assert.match(page, /const wanted = window\._bizinfoInitialTab;\s*window\._bizinfoInitialTab = null;/, 'the deep link is one-shot');
});

check('the Briefs tab shows them and links straight to Brand Assets', () => {
    const tab = read('src/components/assistant-briefs.js');
    assert.match(tab, /function guidelinesHtml\(\)/);
    assert.match(tab, /window\._bizinfoInitialTab = 'assets';\s*if \(window\.loadView\) window\.loadView\('assets'\)/);
    assert.match(code(read('netlify/functions/brand-briefs.ts')), /readBrandGuidelines\(db, orgId\)\.catch\(\(\) => null\)/);
});

check('the chat sees the current text and its card replaces whole fields through the same save', () => {
    const engine = code(read('src/utils/visual-briefs.ts'));
    const snap = span(engine, 'export async function buildBriefsSnapshot', '\n}\n', 'buildBriefsSnapshot');
    assert.match(snap, /readBrandGuidelines\(db, orgId\)/);
    assert.ok((snap.match(/\$\{guide\}/g) || []).length === 2, 'both the empty and the full snapshot carry the guidelines');
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.match(orch, /"type": "brand_guideline_proposal"/);
    assert.match(orch, /the WHOLE new text of each field it changes/);
    assert.match(orch, /read by EVERY AI image any assistant here makes/);
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.match(reg, /register\('brand_guideline_proposal', renderBrandGuidelineProposalCard\)/);
    const session = code(read('src/components/chat-session.js'));
    assert.match(session, /action: 'save_guidelines', guidelines: d\.guidelines \|\| \{\}/);
    assert.match(session, /addEventListener\('brand:saveGuidelines'/);
    assert.match(session, /removeEventListener\('brand:saveGuidelines'/);
});

check('prompt lines say what applies to every picture', () => {
    const lines = guidelinesPromptLines(normaliseGuidelines({ photoStyle: 's', mustAvoid: 'a' }));
    assert.deepStrictEqual(lines, ['HOUSE PHOTO STYLE (applies to every picture): s', 'NEVER SHOW (applies to every picture): a']);
});

console.log(`\n${passed} checks passed.`);
