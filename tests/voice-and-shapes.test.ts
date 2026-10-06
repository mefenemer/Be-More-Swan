// tests/voice-and-shapes.test.ts
// Tone settings must produce AUDIBLY different writing, and posts/articles must not share one
// structure (user report, 2026-10-06). What could quietly regress:
//   · a generator going back to "in a ${tone} tone" — one undefined adjective, every tone the same
//   · a negated trait ("not formal") being read as asked for
//   · every social slot or blog post landing on the same shape again
//   · the social standards re-asking every post to be a list
//
// Run:  npx tsx tests/voice-and-shapes.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectVoiceTraits, voiceDirective } from '../src/utils/voice-profile';
import { SOCIAL_POST_SHAPES, socialShapeFor, blogArticleTypeFor, BLOG_ARTICLE_TYPES, allowedSocialShapes, articleTypeByKey } from '../src/utils/content-shapes';
import { encodeInteractiveBrief, decodeInteractiveBrief } from '../src/utils/blog-interactive-brief';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

check('every fixed tone option maps to its own trait', () => {
    const cases: Record<string, string> = {
        Professional: 'professional', Casual: 'casual', Confident: 'confident', Friendly: 'friendly',
        formal: 'professional', casual: 'casual', empathetic: 'empathetic', energetic: 'inspirational',
    };
    for (const [tone, key] of Object.entries(cases)) {
        assert.deepStrictEqual(detectVoiceTraits(tone), [key], `"${tone}"`);
    }
});

check('free text combines traits and respects negation', () => {
    assert.deepStrictEqual(detectVoiceTraits('Professional yet friendly and witty').sort(), ['friendly', 'professional', 'witty']);
    assert.deepStrictEqual(detectVoiceTraits('Friendly, not too formal'), ['friendly']);
    assert.deepStrictEqual(detectVoiceTraits('Friendly and supportive, avoiding overly salesy language.'), ['friendly']);
});

check('different tones produce materially different directives', () => {
    const a = voiceDirective('Professional', { surface: 'social' });
    const b = voiceDirective('Casual', { surface: 'social' });
    const c = voiceDirective('Confident', { surface: 'social' });
    assert.notStrictEqual(a, b);
    assert.match(a, /Few or no contractions/);
    assert.match(b, /contractions everywhere/);
    assert.match(c, /No hedging words at all/);
    for (const d of [a, b, c]) assert.match(d, /Sounds like:[\s\S]*Never sounds like:/);
});

check('an unrecognised or empty tone still demands a committed voice', () => {
    const d = voiceDirective('Like a Yorkshire grandmother', { surface: 'blog' });
    assert.match(d, /"Like a Yorkshire grandmother"/);
    assert.match(d, /turn that description into four or five CONCRETE habits/);
    assert.match(voiceDirective('', { surface: 'email', fallback: 'professional' }), /"professional"/);
});

check('surface-only rules stay on their surface', () => {
    assert.match(voiceDirective('Casual', { surface: 'social' }), /emoji/);
    assert.doesNotMatch(voiceDirective('Casual', { surface: 'blog' }), /emoji/);
});

check('no generator passes tone as a bare adjective any more', () => {
    for (const f of ['netlify/functions/process-content-jobs.ts', 'src/utils/blog-generate.ts', 'src/utils/newsletter-generate.ts',
        'netlify/functions/lead-generation.ts', 'netlify/functions/process-sequence-sends.ts']) {
        const s = read(f);
        assert.doesNotMatch(s, /in a \$\{[a-zA-Z.]*[tT]one\} (?:tone|voice)/, `${f} still says "in a \${tone} tone"`);
        assert.doesNotMatch(s, /Write in a \$\{tone\} tone/, f);
        assert.match(s, /voiceDirective\(/, `${f} does not use voiceDirective`);
    }
    assert.match(read('netlify/functions/chat-orchestrator.ts'), /voiceDirective\(supportTone,/);
});

check('social: a run of daily slots cycles every shape; two slots on one day differ', () => {
    const base = Date.UTC(2026, 9, 1, 9);
    const seen = new Set<string>();
    for (let d = 0; d < SOCIAL_POST_SHAPES.length; d++) seen.add(socialShapeFor(new Date(base + d * 86_400_000)).shape.key);
    assert.strictEqual(seen.size, SOCIAL_POST_SHAPES.length);
    assert.notStrictEqual(socialShapeFor(new Date(base)).shape.key, socialShapeFor(new Date(base + 6 * 3_600_000)).shape.key);
});

check('social: the shape is in the prompt, and the standards no longer ask every post to be a list', () => {
    const jobs = read('netlify/functions/process-content-jobs.ts');
    assert.match(jobs, /const shapeLine = socialShapeLine\(job\.target_publish_date, brandCtx\.allowed_post_shapes\);/);
    assert.match(jobs, /formatBlock,\s*shapeLine,/);
    const q = read('src/constants/content-quality.ts');
    assert.doesNotMatch(q, /list\/step formats/);
    assert.match(q, /WRITE LIKE A PERSON, NOT A TEMPLATE/);
    // The hook list must not ask for a statistic the standards forbid.
    assert.doesNotMatch(jobs, /'a surprising statistic/);
});

check('blog: consecutive posts never share an article type, and all types are used', () => {
    const keys = Array.from({ length: BLOG_ARTICLE_TYPES.length }, (_, i) => blogArticleTypeFor(i).key);
    assert.strictEqual(new Set(keys).size, BLOG_ARTICLE_TYPES.length);
    for (let i = 1; i < 40; i++) assert.notStrictEqual(blogArticleTypeFor(i).key, blogArticleTypeFor(i - 1).key);
    const gen = read('src/utils/blog-generate.ts');
    assert.doesNotMatch(gen, /3–6 level-2 sections with substantive paragraphs/);
    assert.match(gen, /blogArticleTypeBlock\(articleType\)/);
});

check('Content mix: only allowed shapes are used, and a bad setting falls back to all', () => {
    const allowed = ['story', 'opinion', 'question'];
    const base = Date.UTC(2026, 9, 1, 9);
    const seen = new Set<string>();
    for (let d = 0; d < 30; d++) seen.add(socialShapeFor(new Date(base + d * 86_400_000), allowed).shape.key);
    assert.deepStrictEqual([...seen].sort(), [...allowed].sort());
    assert.strictEqual(allowedSocialShapes(['nonsense']).length, SOCIAL_POST_SHAPES.length);
    assert.strictEqual(allowedSocialShapes(null).length, SOCIAL_POST_SHAPES.length);
    for (const subset of [['guide', 'story'], ['guide', 'story', 'opinion'], ['guide', 'story', 'opinion', 'list', 'myth', 'qa']]) {
        const keys = Array.from({ length: subset.length * 2 }, (_, i) => blogArticleTypeFor(i, subset).key);
        assert.deepStrictEqual([...new Set(keys)].sort(), [...subset].sort(), `subset ${subset}`);
        for (let i = 1; i < keys.length; i++) assert.notStrictEqual(keys[i], keys[i - 1], `subset ${subset} repeats`);
    }
});

check('Blog Studio\'s article type survives the job queue and wins over the rotation', () => {
    const b = decodeInteractiveBrief(encodeInteractiveBrief({ topic: 'x', articleType: 'story' }));
    assert.strictEqual(b?.articleType, 'story');
    assert.strictEqual(articleTypeByKey('story')?.key, 'story');
    assert.strictEqual(articleTypeByKey('<script>'), null);
    assert.match(read('netlify/functions/process-blog-jobs.ts'), /articleType = brief\?\.articleType;/);
    assert.match(read('src/utils/blog-generate.ts'), /articleTypeByKey\(opts\.articleType\) \?\? blogArticleTypeFor\(sequence, allowedTypes\)/);
    assert.match(read('src/components/blog-studio-modal.js'), /articleType: \(el\('bs-ai-type'\)/);
});

check('the profile setting is saved under the keys the generators read, and survives a setup re-run', () => {
    const a = read('assistants.js');
    assert.match(a, /key: 'allowed_post_shapes'/);
    assert.match(a, /key: 'allowed_article_types'/);
    assert.match(read('netlify/functions/update-assistant-context.ts'), /'allowed_post_shapes', 'allowed_article_types', 'voice'\]/);
    assert.match(read('src/generated/platform-constants.js'), /window\.ContentShapes = \{/);
});

check('pillars are read live and balanced by actual use, so none can be starved', () => {
    const jobs = read('netlify/functions/process-content-jobs.ts');
    assert.match(jobs, /const rawPillars = brandCtx\.content_pillars \?\? answers\['content_pillars'\];/);
    assert.match(jobs, /const least = Math\.min\(\.\.\.pillarList\.map\(count\)\);\s*candidates = pillarList\.filter\(\(p\) => count\(p\) === least\);/);
    assert.match(jobs, /rotatedPillar = candidates\[dayIndex % candidates\.length\];/);
});

console.log(`\n${passed} checks passed`);
