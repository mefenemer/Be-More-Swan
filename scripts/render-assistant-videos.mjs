#!/usr/bin/env node
// scripts/render-assistant-videos.mjs — render each assistant's overview video and poster from
// db/assistant-showcases.json with the AssistantExplainer composition (remotion/explainer/).
//
//   node scripts/render-assistant-videos.mjs                 # every role
//   node scripts/render-assistant-videos.mjs blog_writer     # one role
//
// Writes videos/assistants/<role>.mp4 and <role>.jpg (the poster), which db/z-assistant-showcases.sql
// points master_assistants.video at. Screenshots are copied into a throwaway public dir so the bundle
// carries only what the videos use — pointing --public-dir at the repo would bundle node_modules.
import { readFileSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const showcases = JSON.parse(readFileSync(join(root, 'db/assistant-showcases.json'), 'utf8'));

// Names as the catalogue shows them, and each role's accent (the catalogue icon colours).
const META = {
    social_media_manager:  { name: 'Social Media Assistant',         accent: '#db2777' },
    blog_writer:           { name: 'Blog Writing Assistant',         accent: '#7c3aed' },
    newsletter_editor:     { name: 'Email Marketing Assistant',      accent: '#0d9488' },
    lead_qualifier:        { name: 'Lead Generation Assistant',      accent: '#2563eb' },
    campaign_orchestrator: { name: 'Marketing Campaign Orchestrator', accent: '#ea580c' },
    brand_designer:        { name: 'Brand Designer',                 accent: '#db2777' },
    mystery_shopper:       { name: 'Mystery Shopper',                accent: '#db2777' },
};

const only = process.argv.slice(2);
const roles = Object.keys(showcases).filter((r) => !r.startsWith('_') && (!only.length || only.includes(r)));
const pub = join(tmpdir(), `bms-explainer-public-${process.pid}`);
mkdirSync(join(pub, 'images'), { recursive: true });
cpSync(join(root, 'images/assistants'), join(pub, 'images/assistants'), { recursive: true });
mkdirSync(join(root, 'videos/assistants'), { recursive: true });

const remotion = join(root, 'node_modules/.bin/remotion');
for (const role of roles) {
    const s = showcases[role];
    const meta = META[role] || { name: role, accent: '#ff007f' };
    const props = {
        name: meta.name, accent: meta.accent, headline: s.headline,
        steps: s.steps || [], highlights: s.highlights || [],
        features: (s.features || []).map((f) => ({ title: f.title, body: f.body, ...(f.image ? { image: f.image } : {}) })),
    };
    const propsFile = join(pub, `${role}.json`);
    writeFileSync(propsFile, JSON.stringify(props));
    const common = ['remotion/explainer/index.ts', 'AssistantExplainer', `--props=${propsFile}`, `--public-dir=${pub}`];
    console.log(`▶ ${role}`);
    execFileSync(remotion, ['render', ...common, join(root, `videos/assistants/${role}.mp4`), '--codec=h264', '--crf=26'], { cwd: root, stdio: 'inherit' });
    // The poster is the title card, after it has animated in.
    execFileSync(remotion, ['still', ...common, join(root, `videos/assistants/${role}.jpg`), '--frame=75', '--image-format=jpeg'], { cwd: root, stdio: 'inherit' });
}
rmSync(pub, { recursive: true, force: true });
console.log(`done: ${roles.length} video(s)`);
