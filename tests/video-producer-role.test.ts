// tests/video-producer-role.test.ts
// The Video Producer role (docs/video-producer-plan.md Phase 6) — every place a role must be wired,
// checked against each other so a rename in one cannot leave the others lying.
//
// What goes wrong silently if these drift:
//   · no connection-map entry → the role falls through to the fail-OPEN policy (a security hole)
//   · the chat naming a tab or button that does not exist on the page
//   · onboarding offering a voice the speech endpoint does not have
//   · a chat card that can SPEND (making a video must stay a click on the Videos tab)
//   · the role going live by accident (inserted hidden; go-live is the admin status change)
// No network, no database.
//
// Run:  npx tsx tests/video-producer-role.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VOICES } from '../src/lib/tts';
import { VIDEO_PRODUCER_ROLE_KEY } from '../src/constants/roles';
import { RULE_READING_ROLES } from '../src/utils/assistant-rules-prompt';
import { promptLayersFor, ROLE_MODEL_PATHS } from '../src/config/assistant-prompt-layers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

check('the role key is one constant, used verbatim everywhere', () => {
    assert.strictEqual(VIDEO_PRODUCER_ROLE_KEY, 'video_producer');
    for (const f of ['db/seed-catalog.ts', 'seed/data/master_assistants.json', 'db/z-video-producer-role.sql', 'src/utils/connection-map.ts',
        'src/config/assistant-build-manifest.ts', 'src/public/role-labels.js', 'src/public/assistant-onboarding-schemas.js',
        'src/components/assistant-dashboard-registry.js', 'netlify/functions/chat-orchestrator.ts']) {
        assert.ok(read(f).includes('video_producer'), f);
    }
});

check('it has an explicit connection policy — never the fail-open fallback', () => {
    assert.ok(/video_producer:\s*\['social', 'design'\]/.test(read('src/utils/connection-map.ts')));
});

check('inserted HIDDEN, with the three capability grants it needs', () => {
    const sql = read('db/z-video-producer-role.sql');
    assert.ok(/'\["standalone"\]'::jsonb,\s*false,\s*false\s*\)/.test(sql), 'coming_soon=false, is_active=false');
    assert.ok(sql.includes('ON CONFLICT (role_key) DO NOTHING'), 'the admin owns the row once it exists');
    for (const f of ['ai_video_generation', 'ai_image_generation', 'ai_music_generation']) assert.ok(sql.includes(`('${f}')`), f);
    const seed = read('db/seed-catalog.ts');
    const entry = seed.slice(seed.indexOf("roleKey: 'video_producer'"), seed.indexOf("roleKey: 'video_producer'") + 900);
    assert.ok(entry.includes('comingSoon: false') && entry.includes('isActive: false'), 'a fresh database seeds it hidden too');
});

check('onboarding offers exactly the voices the speech endpoint has, and one operational step', () => {
    const schema = read('src/public/assistant-onboarding-schemas.js');
    const at = schema.indexOf('    video_producer: [');
    const block = schema.slice(at, schema.indexOf('\n    ],\n', at));
    for (const v of VOICES) assert.ok(block.includes(`value: '${v.id}', label: '${v.label}'`), v.id);
    assert.strictEqual((block.match(/operational: true/g) || []).length, 1);
    // The chat route reads these keys.
    const chat = read('netlify/functions/chat-orchestrator.ts');
    for (const k of ['defaultLength', 'defaultCta', 'defaultAllowAi']) {
        assert.ok(block.includes(`key: '${k}'`) && chat.includes(`onboardingValue(rc, '${k}')`), k);
    }
    // Every setup answer also fills a brief that leaves it out.
    const vp = read('src/utils/video-producer.ts');
    for (const k of ['defaultVoice', 'defaultLength', 'defaultAllowAi', 'defaultCta']) assert.ok(vp.includes(`setup.${k}`), k);
});

check('the chat names only tabs and buttons that exist', () => {
    const chat = read('netlify/functions/chat-orchestrator.ts');
    const surfaces = chat.slice(chat.indexOf('function videoProducerSurfaces'), chat.indexOf('function websiteAssistantSurfaces'));
    const registry = read('src/components/assistant-dashboard-registry.js');
    const tab = read('src/components/assistant-videos.js');
    assert.ok(registry.includes("videosTab: { label: 'Videos' }") && surfaces.includes('"Videos" tab'));
    assert.ok(registry.includes("reviewQueue: { kind: 'posts', label: 'Review Queue' }") && surfaces.includes('"Review Queue" tab'));
    for (const button of ['New video', 'Change', 'Plan it again', 'Make the video', 'Cancel']) {
        assert.ok(surfaces.includes(`"${button}"`), `chat names "${button}"`);
        assert.ok(tab.includes(`>${button}`) || tab.includes(`>${button}$`) || tab.includes(`${button}</button>`) || tab.includes(`>Make the video\${`), `the tab has "${button}"`);
    }
});

check('no chat card can make (spend on) a video', () => {
    const chat = read('netlify/functions/chat-orchestrator.ts');
    const route = chat.slice(chat.indexOf('    video_producer: {'), chat.indexOf('    // Website Assistant (docs/website-assistant-plan.md §5.5)'));
    assert.ok(route.includes('usesVideosSnapshot: true'));
    assert.ok(!route.includes('"type": "video_build'), 'there is no build card');
    const session = read('src/components/chat-session.js');
    const handlers = session.slice(session.indexOf('function videoProjectsCall'), session.indexOf('// Post action card'));
    assert.ok(handlers.includes("action: 'create'") && handlers.includes("action: 'replan'"));
    assert.ok(!handlers.includes("action: 'build'"), 'chat handlers must never build');
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.ok(reg.includes("register('video_brief_proposal'") && reg.includes("register('video_replan_proposal'"));
});

check('the Videos tab is mounted, activated and binds to document', () => {
    assert.ok(read('assistant-detail.html').includes('id="maintab-btn-videos"') && read('assistant-detail.html').includes('id="videos-host"'));
    assert.ok(read('workspace.html').includes('<script src="/src/components/assistant-videos.js"></script>'));
    const a = read('assistants.js');
    assert.ok(a.includes("if (name === 'videos') window.AssistantVideos?.activate();"));
    assert.ok(a.includes('window.AssistantVideos?.init({ assistantId: data.id, assistantName: data.name });'));
    const tab = read('src/components/assistant-videos.js');
    assert.ok(tab.includes("document.addEventListener('click'") && tab.includes("document.addEventListener('submit'"));
    assert.ok(tab.includes("document.addEventListener('video:changed'"), 'chat writes must reload the tab');
});

check('its rules reach its planner and chat, and its model is pickable', () => {
    assert.ok(RULE_READING_ROLES.has('video_producer'));
    assert.ok(read('src/utils/video-producer.ts').includes('loadAssistantRulesBlock('));
    assert.ok(read('src/utils/video-producer.ts').includes("gatewayRoleModel(db, 'video_producer')"));
    assert.ok(ROLE_MODEL_PATHS.video_producer?.length === 1);
    assert.ok(promptLayersFor('video_producer').some((l) => l.key === 'storyboard_craft'));
    assert.ok(read('assistants.js').includes("window._detailRulesScope === 'video'"), 'the Rules tab says what its rules reach');
});

console.log(`\n${passed} checks passed`);
