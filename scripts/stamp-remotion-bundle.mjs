#!/usr/bin/env node
// scripts/stamp-remotion-bundle.mjs
//
// Records, PER DEPLOYED SITE, a hash of the Remotion composition sources into remotion/.deployed-hash.
//
// ── Why ─────────────────────────────────────────────────────────────────────────────────────────
// The Remotion site is an S3 BUNDLE. A git push does not update it. So editing PostOverlay.tsx and
// deploying the app leaves that environment rendering the OLD composition — the code says posts have
// sound, the renders come back silent, and nothing anywhere says why. It has already happened once
// (timed audio shipped without a site deploy).
//
// ── Why PER SITE ────────────────────────────────────────────────────────────────────────────────
// There are TWO sites — bemoreswan-overlay-staging and bemoreswan-overlay-prod — and they are
// deployed by two separate commands. The first version of this script kept ONE hash, so whichever
// site was deployed most recently certified BOTH. On 2026-08-03 that hid a prod bundle months out of
// date: `--check` said "in step" (from a staging deploy on 07-31) while prod still ran a composition
// with no <Img> branch, and every prod render of a still died with "No `src` was passed to
// <OffthreadVideo>". A check that answers for a site it was never told about is worse than no check,
// because it is believed. So a stamp now names its site, and a site with no stamp of its own reads
// as UNKNOWN rather than inheriting the other one's.
//
// This stays the cheap half of the fix. The authoritative answer is the deployed bundle itself,
// which is a public S3 object:
//   curl -s .../sites/bemoreswan-overlay-prod/bundle.js | grep -c getImageDimensions
// Use that whenever the answer actually matters (before a promote, or when a render misbehaves in
// one environment only). This script only remembers what was deployed from this working tree.
//
// tests/remotion-bundle-drift.test.ts warns on drift. Deliberately a WARNING, not a gate — a
// developer editing the composition locally has done nothing wrong, and a red suite they cannot fix
// without AWS credentials would just be routed around.
//
// Usage:  node scripts/stamp-remotion-bundle.mjs staging   record a staging deploy
//         node scripts/stamp-remotion-bundle.mjs prod      record a production deploy
//         node scripts/stamp-remotion-bundle.mjs --check   print drift per site (never fails)

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'remotion');
export const STAMP_PATH = join(dir, '.deployed-hash');

/** The sites `npm run remotion:deploy-site-*` can deploy to. Order is display order. */
export const SITES = ['staging', 'prod'];

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

/**
 * What each site was last stamped with: `{ staging: {hash, at} | null, prod: … }`.
 *
 * A LEGACY file — the old single bare hash, with no site named — resolves to null for every site,
 * on purpose. It genuinely does not say which site it describes, and guessing is what produced the
 * incident this format replaced. Unknown is the honest answer, and it warns instead of certifying.
 */
export function readStamps() {
    const out = Object.fromEntries(SITES.map(s => [s, null]));
    if (!existsSync(STAMP_PATH)) return out;
    for (const line of readFileSync(STAMP_PATH, 'utf8').split('\n')) {
        const text = line.trim();
        if (!text || text.startsWith('#')) continue;
        const [site, hash, at] = text.split(/\s+/);
        if (SITES.includes(site) && hash) out[site] = { hash, at: at ?? null };
    }
    return out;
}

/** Rewrite the stamp file with `site` set to the current sources, leaving the other sites alone. */
export function writeStamp(site, hash, now = new Date()) {
    const stamps = readStamps();
    stamps[site] = { hash, at: now.toISOString() };
    const body = SITES
        .filter(s => stamps[s])
        .map(s => `${s} ${stamps[s].hash} ${stamps[s].at ?? ''}`.trim())
        .join('\n');
    writeFileSync(
        STAMP_PATH,
        `# Written by scripts/stamp-remotion-bundle.mjs on a site deploy. Do not edit.\n`
        + `# One line per SITE: <site> <bundle-hash> <deployed-at>. A site absent here has never been\n`
        + `# deployed from this working tree — it does NOT inherit another site's hash.\n`
        + `${body}\n`,
    );
}

// Only act when RUN, never when imported. The drift test imports bundleHash/readStamps, and without
// this guard merely running the test stamped the bundle — reporting "in step with the last deploy"
// for a composition that had never been deployed at all. A check that certifies itself is worse
// than no check.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('stamp-remotion-bundle.mjs');
const arg = process.argv[2];

if (!invokedDirectly) {
    // imported — expose the helpers and do nothing else
} else if (arg === '--check') {
    const now = bundleHash();
    const stamps = readStamps();
    console.log(`Remotion composition sources are at ${now}`);
    for (const site of SITES) {
        const s = stamps[site];
        if (!s) console.log(`  ${site.padEnd(8)} UNKNOWN — no deploy recorded from this tree`);
        else if (s.hash === now) console.log(`  ${site.padEnd(8)} in step (deployed ${s.at ?? 'at an unrecorded time'})`);
        else console.log(`  ${site.padEnd(8)} DRIFTED — deployed ${s.hash}, sources are ${now}`);
    }
} else if (SITES.includes(arg)) {
    const hash = bundleHash();
    writeStamp(arg, hash);
    console.log(`Stamped Remotion bundle ${hash} for ${arg}`);
} else {
    // Refuse rather than stamp something. A bare invocation used to stamp "the deploy", which is
    // precisely how one site's deploy came to vouch for the other.
    console.error(`Which site was deployed? Pass one of: ${SITES.join(', ')}`);
    console.error('  node scripts/stamp-remotion-bundle.mjs prod');
    process.exit(1);
}
