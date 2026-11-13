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
// admin.html since 2026-11-13: its VIEW_VERSION is read by version-check.js (it fetches no view
// partials), and stamping also cache-busts its local <script> tags like the workspace's.
// The standalone signed-in pages people may leave open (2026-11-13) — same reason.
const TARGETS = [
  'workspace.html', 'admin.html',
  'assistant-chat.html', 'onboarding.html', 'onboarding-social-media.html', 'assistant-setup.html',
];

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

/**
 * Cache-bust every LOCAL <script src> on the page.
 *
 * VIEW_VERSION above covers the view partials this page FETCHES. It never covered the component
 * files it <script>-loads, and those had no versioning of any kind — so a browser holding an old
 * /src/components/*.js could keep running it while the HTML around it was current. That is not
 * hypothetical: it is indistinguishable from a feature "disappearing", because the markup a stale
 * component emits is simply the markup of an older release, and hunting it costs hours.
 *
 * Netlify serves these with `max-age=0, must-revalidate`, which asks the browser to revalidate but
 * does not force it to — a tab that never reloads keeps the copy it parsed at first load. A changing
 * URL does force it, because it is a different resource.
 *
 * Absolute URLs (CDNs) are skipped: their versions are not ours to set. A src that already carries a
 * query string is skipped too — those are deliberate manual pins, and appending a second `?v=` would
 * corrupt them.
 */
function stampLocalScripts(html, version) {
  let count = 0;
  const out = html.replace(/(<script\b[^>]*\bsrc=")([^"]+\.js)(")/g, (whole, head, src, tail) => {
    if (/^(https?:)?\/\//.test(src) || src.includes('?')) return whole;
    count += 1;
    return `${head}${src}?v=${version}${tail}`;
  });
  return { html: out, count };
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
  const stamped = stampLocalScripts(html.replace(re, `const VIEW_VERSION = '${version}';`), version);
  writeFileSync(path, stamped.html);
  console.log(`[stamp-view-version] ${file} -> VIEW_VERSION='${version}' (+${stamped.count} script tags)`);
  stampedAny = true;
}

if (!stampedAny) {
  console.warn('[stamp-view-version] nothing stamped.');
}

// The full deployed commit, for the functions (src/generated/build-commit.ts). Only on Netlify:
// locally there is no deploy, and rewriting a committed file from a dev build would leave it dirty.
// The Issues live check (src/utils/issue-fix-live.ts) compares a fix's merge commit against this.
const fullRef = process.env.COMMIT_REF;
if (fullRef && /^[0-9a-f]{40}$/i.test(fullRef)) {
  const commitFile = resolve(root, 'src/generated/build-commit.ts');
  try {
    const src = readFileSync(commitFile, 'utf8');
    const re = /export const BUILD_COMMIT: string = '[^']*';/;
    if (re.test(src)) {
      writeFileSync(commitFile, src.replace(re, `export const BUILD_COMMIT: string = '${fullRef}';`));
      console.log(`[stamp-view-version] BUILD_COMMIT='${fullRef}'`);
    } else {
      console.warn('[stamp-view-version] no BUILD_COMMIT marker in src/generated/build-commit.ts — skipped');
    }
  } catch (e) {
    console.warn(`[stamp-view-version] could not stamp BUILD_COMMIT: ${e?.message || e}`);
  }
}
