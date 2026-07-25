#!/usr/bin/env node
// scripts/stamp-remotion-bundle.mjs
//
// Records a hash of the Remotion composition sources into remotion/.deployed-hash.
//
// ── Why ─────────────────────────────────────────────────────────────────────────────────────────
// The Remotion site is an S3 BUNDLE. A git push does not update it. So editing PostOverlay.tsx and
// deploying the app leaves production rendering the OLD composition — the code says posts have
// sound, the renders come back silent, and nothing anywhere says why. It has already happened once
// (timed audio shipped without a site deploy).
//
// This is the cheap half of the fix: `npm run remotion:deploy-site-*` stamps what it deployed, and
// tests/remotion-bundle-drift.test.ts warns when the working tree has moved on since. Deliberately a
// WARNING, not a gate — a developer editing the composition locally has done nothing wrong, and a
// red suite they cannot fix without AWS credentials would just be routed around.
//
// Usage:  node scripts/stamp-remotion-bundle.mjs          write the stamp
//         node scripts/stamp-remotion-bundle.mjs --check  print drift (never fails)

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'remotion');
export const STAMP_PATH = join(dir, '.deployed-hash');

/** Hash every source that ends up in the bundle. tsconfig is included: it changes the output. */
export function bundleHash() {
    const files = readdirSync(dir)
        .filter(f => /\.(tsx?|json)$/.test(f))
        .sort();
    const h = createHash('sha256');
    for (const f of files) {
        h.update(f);
        h.update(readFileSync(join(dir, f)));
    }
    return h.digest('hex').slice(0, 16);
}

export function readStamp() {
    if (!existsSync(STAMP_PATH)) return null;
    return readFileSync(STAMP_PATH, 'utf8').trim().split('\n')[0].trim() || null;
}

// Only act when RUN, never when imported. The drift test imports bundleHash/readStamp, and without
// this guard merely running the test stamped the bundle — reporting "in step with the last deploy"
// for a composition that had never been deployed at all. A check that certifies itself is worse
// than no check.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('stamp-remotion-bundle.mjs');

if (!invokedDirectly) {
    // imported — expose the helpers and do nothing else
} else if (process.argv[2] === '--check') {
    const now = bundleHash();
    const stamped = readStamp();
    if (stamped === now) console.log(`Remotion bundle is in step with the last deploy (${now}).`);
    else console.log(`Remotion bundle has changed since the last deploy: ${stamped ?? 'never stamped'} → ${now}`);
} else {
    const hash = bundleHash();
    writeFileSync(STAMP_PATH, `${hash}\n# Written by scripts/stamp-remotion-bundle.mjs on a site deploy. Do not edit.\n`);
    console.log(`Stamped Remotion bundle ${hash}`);
}
