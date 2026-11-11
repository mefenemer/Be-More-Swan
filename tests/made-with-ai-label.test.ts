// tests/made-with-ai-label.test.ts
// "Made with AI" on posts with realistic AI video (owner D-F4, 2026-11-11): realistic only, a workspace
// setting (default on), added at publish after the caption, never twice.
//
// Run:  npx tsx tests/made-with-ai-label.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { isRealisticAiVideo, AI_VIDEO_LABEL } from '../src/utils/ai-disclosure';
import { composePostText } from '../src/utils/post-link';
import { containsRealisticAi } from '../src/utils/video-render';
import { isRealisticStyle } from '../src/lib/ai-clip';
import type { Storyboard } from '../src/lib/storyboard';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const video = (provider: string | null, renderParams: unknown) => ({ assetType: 'video', provider, renderParams });

check('realistic means: not a 3D animated or 2D cartoon clip', () => {
    assert.ok(isRealisticStyle('realistic') && isRealisticStyle('cinematic') && isRealisticStyle('product') && isRealisticStyle('scene'));
    assert.ok(!isRealisticStyle('animated3d') && !isRealisticStyle('cartoon2d'));
    assert.ok(isRealisticAiVideo(video('fal', { aiStyle: 'realistic' })));
    assert.ok(isRealisticAiVideo(video('fal', { aiStyle: 'scene' })), 'an AI scene in a whole video');
    assert.ok(isRealisticAiVideo(video('fal', null)), 'an older clip with no style recorded: the safe side');
    assert.ok(!isRealisticAiVideo(video('fal', { aiStyle: 'cartoon2d' })));
    assert.ok(isRealisticAiVideo(video(null, { containsAi: true })), 'an older finished video');
    assert.ok(!isRealisticAiVideo(video(null, { containsAi: true, containsRealisticAi: false })));
    assert.ok(!isRealisticAiVideo(video(null, { containsAi: false })));
    assert.ok(!isRealisticAiVideo({ assetType: 'image', provider: 'fal', renderParams: null }), 'AI pictures are not this label');
});

check('a finished video records it', () => {
    const sb = (source: string) => ({ title: 't', caption: '', scenes: [{ id: 's1', beat: 'value', voiceover: '', source, targetS: 5 }] }) as unknown as Storyboard;
    assert.ok(containsRealisticAi(sb('ai_video'), null));
    assert.ok(containsRealisticAi(sb('ai_image'), {}));
    assert.ok(!containsRealisticAi(sb('ai_video'), { clip: { style: 'cartoon2d' } }));
    assert.ok(containsRealisticAi(sb('ai_video'), { clip: { style: 'cinematic' } }));
    assert.ok(!containsRealisticAi(sb('stock_video'), null));
    assert.ok(read('src/utils/video-render.ts').includes('containsRealisticAi: containsRealisticAi(sb,'));
    assert.ok(read('src/utils/video-producer.ts').includes("renderParams: { aiStyle: args.clip?.style ?? 'scene' },"));
});

check('the caption: after the words, before the hashtags, never twice', () => {
    const post = { caption: 'Our summer roast is back.', hashtags: '#coffee', linkUrl: null, ctaText: null };
    assert.strictEqual(composePostText(post, { aiLabel: AI_VIDEO_LABEL }), 'Our summer roast is back.\n\nMade with AI\n\n#coffee');
    assert.strictEqual(composePostText(post), 'Our summer roast is back.\n\n#coffee', 'no label → unchanged');
    assert.strictEqual(composePostText({ ...post, caption: 'Fresh roast. Made with AI.' }, { aiLabel: AI_VIDEO_LABEL }), 'Fresh roast. Made with AI.\n\n#coffee');
});

check('every publisher without a field asks for it; YouTube keeps its own', () => {
    for (const f of ['netlify/functions/publish-social-posts.ts', 'netlify/functions/publish-facebook.ts', 'netlify/functions/publish-instagram.ts']) {
        assert.ok(read(f).includes('{ aiLabel: await aiVideoLabelFor(db, post.organisation_id, post.content_asset_ids) }'), f);
    }
    const d = read('src/utils/ai-disclosure.ts');
    assert.ok(d.includes('.then((r) => r[0]?.on ?? true).catch(() => true);'), 'a failed read counts as on');
    assert.ok(read('netlify/functions/publish-youtube-background.ts').includes('containsSyntheticMedia: true'));
});

check('the setting: column default on, endpoint on the open workspace, Settings switch, chat card', () => {
    assert.ok(read('db/z-ai-video-label.sql').includes('ADD COLUMN IF NOT EXISTS ai_video_label_enabled BOOLEAN NOT NULL DEFAULT TRUE'));
    assert.ok(read('db/schema.ts').includes("aiVideoLabelEnabled: boolean('ai_video_label_enabled').notNull().default(true),"));
    const ep = read('netlify/functions/ai-video-label.ts');
    assert.ok(ep.includes('const ctx = await requireTenant(event, db);'));
    assert.ok(ep.includes("if (typeof body.enabled !== 'boolean')"));
    assert.ok(read('user-settings.html').includes('id="toggle-ai-video-label"'));
    assert.ok(read('src/components/disruptive-ui-registry.js').includes("register('ai_video_label_setting', renderAiVideoLabelSettingCard);"));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('{ "type": "ai_video_label_setting", "enabled": true | false }'));
});

check('help section is guarded with no semicolons in its body', () => {
    const sql = read('db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzzzzzzzz-made-with-ai-label.sql');
    assert.ok(!sql.slice(sql.indexOf('$$') + 2, sql.lastIndexOf('$$')).includes(';'));
    assert.ok(sql.includes(`AND content_md NOT LIKE '%## "Made with AI" on AI videos%'`));
});

console.log(`\n${passed} passed`);
