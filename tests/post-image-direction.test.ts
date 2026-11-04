// tests/post-image-direction.test.ts
// The post editor's generate button writes its picture with everything the Brand Designer knows
// (owner, 2026-11-04), and the Brand Designer's four AI options are four different pictures.
//
// Run:  npx tsx tests/post-image-direction.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    WRITER_BUDGET_MS, firstUsable, postImageSystemPrompt, postImageUserPrompt, type PostImageBriefing,
} from '../src/utils/post-image-direction';
import { fallbackArtDirection, parseArtDirection } from '../src/utils/visual-briefs';
import { parseStoredRejection } from '../src/utils/art-direction-context';
import { formatRulesBlock } from '../src/utils/assistant-rules-prompt';
import { normalizeBrandKit } from '../src/utils/brand-kit';
import { normaliseGuidelines } from '../src/utils/brand-guidelines';

let passed = 0, total = 0;
async function test(name: string, fn: () => void | Promise<void>) {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

const briefing = (over: Partial<PostImageBriefing> = {}): PostImageBriefing => ({
    request: 'A boiler being serviced before winter',
    requestIsCaption: false,
    platform: 'instagram',
    ctx: {
        kit: normalizeBrandKit({ primaryColor: '#1f6f5c', textColor: '#111111', backgroundColor: '#ffffff' }),
        orgName: 'Brightside Heating', industry: 'Plumbing', description: 'Family heating engineers in Leeds.',
        guidelines: normaliseGuidelines({ photoStyle: 'Bright, natural daylight', mustAvoid: 'Cartoon flames' }),
    },
    rejections: [], postFeedback: [], currentPicturePrompt: null,
    ...over,
});

(async () => {
    console.log('what the writer knows');

    await test('the business, its brand colours in words, and its picture guidelines', () => {
        const u = postImageUserPrompt(briefing());
        assert.match(u, /BUSINESS: Brightside Heating \(Plumbing\)/);
        assert.match(u, /ABOUT THEM: Family heating engineers in Leeds\./);
        assert.match(u, /BRAND COLOURS[^\n]*accent deep teal \(#1f6f5c\)/);
        assert.match(u, /Bright, natural daylight/);
        assert.match(u, /Cartoon flames/);
        assert.match(u, /FOR: a social post on instagram\./);
    });

    await test('the Rules tab and the art-direction craft', () => {
        const rules = formatRulesBlock([{ ruleText: 'Never show vans', origin: 'manual' }, { ruleText: 'No stock smiles', origin: 'rejection_feedback' }]);
        const s = postImageSystemPrompt(rules);
        assert.match(s, /Never show vans/);
        assert.match(s, /No stock smiles \(from feedback/);
        assert.match(s, /ART DIRECTION/);
        assert.match(s, /keep them anonymous/);
        assert.ok(!/RULES FROM YOUR USER/.test(postImageSystemPrompt(null)));
    });

    await test('it still separates words from the scene, and never writes copy', () => {
        const s = postImageSystemPrompt(null);
        assert.match(s, /\{"scene": string, "words": string\[\]\}/);
        assert.match(s, /"words": ONLY the exact words/);
    });

    await test('a caption is flagged as a caption, not a request for words', () => {
        assert.match(postImageUserPrompt(briefing({ requestIsCaption: true })), /WHAT THE POST SAYS \(its caption/);
        assert.match(postImageUserPrompt(briefing()), /WHAT THE PICTURE SHOULD SHOW OR SAY/);
    });

    console.log('what it learns from');

    await test('pictures turned down, in the user\'s own words', () => {
        const r = parseStoredRejection('ai_image', 'other: too dark, looks like a cellar', 'A dim boiler room');
        assert.strictEqual(r.note, 'too dark, looks like a cellar');
        const u = postImageUserPrompt(briefing({ rejections: [r] }));
        assert.match(u, /TURNED DOWN EARLIER:/);
        assert.match(u, /too dark, looks like a cellar/);
        assert.match(u, /it was made from: A dim boiler room/);
    });

    await test('feedback on rejected posts, and that only picture feedback applies', () => {
        const u = postImageUserPrompt(briefing({ postFeedback: ['The photo looks nothing like us'] }));
        assert.match(u, /WHAT THEY SAID WHEN REJECTING RECENT POSTS:\n- "The photo looks nothing like us"/);
        assert.match(postImageSystemPrompt(null), /Rules and feedback about wording do not apply to a picture/);
    });

    await test('pressing again moves away from the picture already there', () => {
        const u = postImageUserPrompt(briefing({ currentPicturePrompt: 'An engineer kneeling at a boiler' }));
        assert.match(u, /THE PICTURE ON THIS POST NOW[^\n]*different idea[^\n]*An engineer kneeling at a boiler/);
    });

    await test('sections with nothing to say are left out', () => {
        const u = postImageUserPrompt(briefing());
        for (const absent of ['TURNED DOWN', 'REJECTING', 'PICTURE ON THIS POST']) assert.ok(!u.includes(absent), absent);
    });

    console.log('a slow or failed writer never costs the picture');

    await test('the writer wins when it answers in time', async () => {
        const r = await firstUsable(Promise.resolve('smart'), Promise.resolve('plain'), 50);
        assert.deepStrictEqual(r, { value: 'smart', by: 'model' });
    });

    await test('over budget: the fallback, without waiting for the writer', async () => {
        const started = Date.now();
        const slow = new Promise<string | null>((res) => setTimeout(() => res('late'), 1000));
        const r = await firstUsable(slow, Promise.resolve('plain'), 20);
        assert.deepStrictEqual(r, { value: 'plain', by: 'fallback' });
        assert.ok(Date.now() - started < 500);
    });

    await test('a writer that throws or returns nothing falls back at once', async () => {
        assert.strictEqual((await firstUsable(Promise.reject(new Error('down')), Promise.resolve('plain'), 1000)).by, 'fallback');
        assert.strictEqual((await firstUsable(Promise.resolve(null), Promise.resolve('plain'), 1000)).by, 'fallback');
    });

    console.log('the 26 s function');
    const fn = read('netlify/functions/regenerate-post-media.ts');

    await test('writer and image together stay inside the function, with room to store the picture', () => {
        assert.match(fn, /Math\.min\(18_000, Math\.max\(12_000, 23_000 - \(Date\.now\(\) - startedAt\)\)\)/);
        assert.ok(WRITER_BUDGET_MS + 12_000 <= 23_000, 'budget + the floor stays within 23 s');
    });

    await test('the writer is always Opus 5.5: the Social Media Assistant\'s drafting model does not move it', () => {
        const direction = read('src/utils/post-image-direction.ts');
        assert.match(direction, /const WRITER = \{ model: 'claude-opus-5-5', thinking: 'low' as const \}/);
        assert.match(direction, /\.\.\.WRITER,\n\s+deadlineMs: WRITER_BUDGET_MS,/);
        assert.ok(!direction.includes('gatewayRoleModel('), 'must not read the role choice');
    });

    await test('the function does not load the card and flyer renderers', () => {
        const direction = read('src/utils/post-image-direction.ts');
        const context = read('src/utils/art-direction-context.ts');
        for (const src of [fn, direction, context]) assert.ok(!/from '[^']*visual-briefs'/.test(src));
    });

    await test('the plain plan starts with the writer, so it is ready if the writer is late', () => {
        const direction = read('src/utils/post-image-direction.ts');
        assert.match(direction, /firstUsable\(writeDirection\(db, args, usage\), planImage\(args\.request, usage\), WRITER_BUDGET_MS\)/);
    });

    console.log('drafting: the writer runs only where there is time for it');
    const jobs = read('netlify/functions/process-content-jobs.ts');

    await test('the cron hands off to the background drain, and drains itself only if that fails', () => {
        const cron = jobs.slice(jobs.indexOf('export default withLambda'), jobs.indexOf('async function processJob('));
        const poke = cron.indexOf("await triggerContentDrain(undefined, 'cron', 'process-content-jobs')");
        const inline = cron.indexOf('await drainContentJobs()');
        assert.ok(poke > 0 && inline > poke);
        assert.match(cron, /handed off to the background drain/);
    });

    await test('only the 15-minute background lane turns the writer on', () => {
        assert.match(read('netlify/functions/run-content-jobs-background.ts'), /drainContentJobs\(\{ imageWriter: true \}\)/);
        const staging = read('netlify/functions/run-content-jobs.ts');
        assert.match(staging, /await triggerContentDrain\(/);
        assert.ok(!staging.includes('imageWriter'));
        assert.match(jobs, /const processed = await drainContentJobs\(\);/);
    });

    await test('it starts from the drafter\'s brief, after the credit hold, and falls back to that brief inline', () => {
        const at = jobs.indexOf('const generateAi = async');
        const win = jobs.slice(at, at + 2600);
        assert.ok(win.indexOf('holdCredits(') < win.indexOf('directPostImage('), 'no Opus call for a workspace out of credits');
        assert.match(win, /const prompt = imageWriter\s+\? \(await directPostImage\(db, \{/);
        assert.match(win, /: aiMediaContext;/);
        assert.match(win, /wordsOnPicture: false,/);
        assert.match(win, /\n\s+prompt, aspectRatio: aspect, generationJobId: genJob\.id,/);
    });

    await test('where no words will be added, the writer is told to leave no space for them', () => {
        assert.match(postImageUserPrompt(briefing({ wordsOnPicture: false })), /NO WORDS WILL BE ADDED/);
        assert.ok(!postImageUserPrompt(briefing()).includes('NO WORDS WILL BE ADDED'));
    });

    console.log('the daily autonomous drafter');
    const daily = read('netlify/functions/autonomous-media-suggestions.ts');
    const dailyBg = read('netlify/functions/run-autonomous-drafts-background.ts');

    await test('the cron hands off, and runs the work itself only if that fails', () => {
        const cron = daily.slice(daily.indexOf('export default withLambda'));
        const poke = cron.indexOf("await triggerAutonomousDrafts(undefined, 'cron', 'autonomous-media-suggestions')");
        const inline = cron.indexOf('await runAutonomousDrafts()');
        assert.ok(cron.indexOf('isGlobalAiDisabled()') < poke && poke > 0 && inline > poke);
        assert.match(cron, /handedOff: true/);
    });

    await test('the background function is locked, respects the kill switch, and is the only lane with the writer', () => {
        assert.ok(dailyBg.indexOf('!== secret') < dailyBg.indexOf('runAutonomousDrafts('), 'auth first');
        assert.ok(dailyBg.indexOf('isGlobalAiDisabled()') < dailyBg.indexOf('runAutonomousDrafts('));
        assert.match(dailyBg, /runAutonomousDrafts\(\{ imageWriter: true \}\)/);
        assert.match(dailyBg, /if \(!secret\) \{[\s\S]{0,160}statusCode: 503/, 'fails closed');
    });

    await test('a failed run does not answer with an error status that invites a paid retry', () => {
        const caught = dailyBg.slice(dailyBg.indexOf('} catch (err) {'));
        assert.match(caught, /statusCode: 200/);
        assert.ok(!/statusCode: 5/.test(caught));
    });

    await test('an assistant gets at most one run a day, checked before anything is spent', () => {
        const at = daily.indexOf('const [alreadyToday]');
        assert.ok(at > 0 && at < daily.indexOf('const copy = await draftCopy('));
        assert.match(daily, /eq\(scheduledPosts\.isAutonomous, true\)/);
        assert.match(daily, /if \(alreadyToday\) \{ skippedAlreadyToday\+\+; continue; \}/);
    });

    await test('one assistant failing does not end the run or lose the notifications', () => {
        const loop = daily.indexOf('for (const a of assistants) {');
        const caught = daily.indexOf('assistant ${a.id} failed:');
        const note = daily.indexOf("createNotification(db, 'ai_review_batch'");
        assert.ok(loop > 0 && caught > loop && note > caught);
    });

    await test('its image is written after the credit hold, from the drafter\'s prompt', () => {
        const at = daily.indexOf('const generateAi = async');
        const win = daily.slice(at, at + 1700);
        assert.ok(win.indexOf('holdAutonomousCredits(') < win.indexOf('directPostImage('));
        assert.match(win, /const prompt = opts\.imageWriter\s+\? \(await directPostImage\(db, \{/);
        assert.match(win, /: copy\.imagePrompt;/);
        assert.match(win, /wordsOnPicture: false,/);
    });

    console.log('the Brand Designer: four different pictures');
    const brief = { title: 'A picture', message: 'A boiler before winter', headline: null, mood: null, mustInclude: null, mustAvoid: null };
    const kit = normalizeBrandKit({ primaryColor: '#1f6f5c' });

    await test('one prompt per option, the model\'s own, with colour codes taken out', () => {
        const prompts = ['A warm kitchen radiator with a cat asleep on it (#1f6f5c)', 'An engineer\'s hands on a pressure gauge at dawn', 'A frosted window, a warm room behind it', 'A family in socks on a warm floor, cropped low'];
        const ad = parseArtDirection(JSON.stringify({ imagePrompt: prompts[0], imageAlternatives: prompts.slice(1), stockKeywords: 'radiator', cardHeadlines: ['Warm by winter'] }), fallbackArtDirection(brief, kit), null);
        assert.strictEqual(ad.imagePrompts!.length, 4);
        assert.strictEqual(new Set(ad.imagePrompts).size, 4);
        assert.strictEqual(ad.imagePrompts![0], ad.imagePrompt);
        assert.ok(!/#1f6f5c/.test(ad.imagePrompts!.join(' ')));
    });

    await test('too few from the model, or none at all, is still four different prompts', () => {
        const one = parseArtDirection(JSON.stringify({ imagePrompt: 'A warm kitchen radiator with a cat asleep on it', imageAlternatives: ['short', 7] }), fallbackArtDirection(brief, kit), null);
        assert.strictEqual(new Set(one.imagePrompts).size, 4);
        assert.strictEqual(new Set(fallbackArtDirection(brief, kit).imagePrompts).size, 4);
    });

    await test('each option is drawn from, and remembers, its own prompt', () => {
        const vb = read('src/utils/visual-briefs.ts');
        assert.match(vb, /await generateImageVariants\(\{ prompts, aspectRatio,/);
        assert.match(vb, /source: 'ai_image', storageKey, externalUrl, mimeType, width: img\.width \|\| null, height: img\.height \|\| null, prompt: img\.prompt \}/);
        assert.match(read('src/lib/fal-gateway.ts'), /\{ \.\.\.img, prompt: prompts\[i\] \}/);
    });

    await test('the art direction asks for them', () => {
        const vb = read('src/utils/visual-briefs.ts');
        assert.match(vb, /"imageAlternatives" — three more prompts/);
        assert.match(vb, /maxTokens: 1500,/);
    });

    console.log(`\n${passed}/${total} passed`);
    if (passed !== total) process.exit(1);
})();
