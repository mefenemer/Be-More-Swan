// scripts/stamp-view-version.mjs
//
// Build-time cache-buster stamp. Replaces the VIEW_VERSION literal in workspace.html
// with the current deploy's commit SHA so every deploy that changes a view partial
// (./*-content.html etc.) automatically invalidates the browser cache — no manual bump.
//
// Runs on Netlify after build:css:prod (see netlify.toml). Netlify provides COMMIT_REF;
// locally we fall back to `git rev-parse` and finally a timestamp. The edit happens in the
// ephemeral build checkout only — the committed workspace.html keeps its dev-fallback literal.

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['workspace.html'];

function resolveVersion() {
  // Netlify build env exposes the deployed commit on COMMIT_REF.
  const ref = process.env.COMMIT_REF;
  if (ref) return ref.slice(0, 8);
  try {
    return execSync('git rev-parse --short=8 HEAD', { cwd: root }).toString().trim();
  } catch {
    return `t${Date.now().toString(36)}`;
  }
}

const version = resolveVersion();
let stampedAny = false;

for (const file of TARGETS) {
  const path = resolve(root, file);
  let html;
  try {
    html = readFileSync(path, 'utf8');
  } catch {
    console.warn(`[stamp-view-version] skip (not found): ${file}`);
    continue;
  }
  const re = /const VIEW_VERSION = '[^']*';/;
  if (!re.test(html)) {
    console.warn(`[stamp-view-version] no VIEW_VERSION marker in ${file} — skipped`);
    continue;
  }
  writeFileSync(path, html.replace(re, `const VIEW_VERSION = '${version}';`));
  console.log(`[stamp-view-version] ${file} -> VIEW_VERSION='${version}'`);
  stampedAny = true;
}

if (!stampedAny) {
  console.warn('[stamp-view-version] nothing stamped.');
}
