// tests/remotion-bundle-drift.test.ts
//
// Warns — never fails — when a deployed Remotion site is not running these composition sources.
//
// The Remotion site is an S3 bundle that a git push does NOT update. Editing PostOverlay.tsx and
// shipping the app leaves that environment rendering the previous composition: the code believes
// posts carry sound, the renders come back silent, and no error is raised anywhere. That has
// happened twice — once when timed audio shipped without a site deploy, and again on 2026-08-03 when
// prod was months behind staging and every render of a still died with "No `src` was passed to
// <OffthreadVideo>".
//
// The second one is why this reports PER SITE. There are two (staging, prod), deployed by two
// separate commands, and the old single stamp let whichever was deployed last vouch for both. A site
// with no stamp of its own now reads UNKNOWN instead of inheriting the other's hash.
//
// WARNING, not a gate, on purpose. Editing the composition locally is normal and correct, and only
// someone with AWS credentials can clear the condition — a hard failure would make the whole suite
// red for everyone else, and a suite people learn to ignore protects nothing. This mirrors the
// License Gate's non-blocking drift warning.
//
// ⚠️ This reports what was deployed FROM THIS WORKING TREE. It cannot see a deploy someone else ran,
// and it is not evidence about the bundle actually sitting in S3 — that is public and greppable:
//   curl -s <serve-url-origin>/sites/bemoreswan-overlay-prod/bundle.js | grep -c getImageDimensions
// Check it that way before a promote that touches remotion/*, or when renders misbehave in one
// environment only.
//
// To clear a warning:  npm run remotion:deploy-site-staging   (or -prod) — the deploy stamps it.
//
// Run:  npx tsx tests/remotion-bundle-drift.test.ts

import { bundleHash, readStamps, SITES } from '../scripts/stamp-remotion-bundle.mjs';

const now = bundleHash();
const stamps = readStamps();

console.log('\nRemotion bundle vs last deploy, per site\n');
console.log(`  sources: ${now}\n`);

let warnings = 0;
for (const site of SITES) {
    const s = stamps[site];
    if (s && s.hash === now) {
        console.log(`  ✓ ${site.padEnd(8)} the deployed bundle matches these sources`);
        continue;
    }
    warnings++;
    if (!s) {
        console.log(`  ⚠️  ${site.padEnd(8)} UNKNOWN — no deploy recorded from this working tree.`);
        console.log(`     It does NOT inherit another site's stamp. If renders there ignore recent`);
        console.log(`     changes (silent audio, missing text, "No src was passed"), the S3 site is stale.`);
    } else {
        console.log(`  ⚠️  ${site.padEnd(8)} DRIFT: deployed ${s.hash}, sources are ${now}.`);
        console.log(`     A git push does NOT update the Remotion site — it is an S3 bundle.`);
        console.log(`     Until it is redeployed, renders there run the OLD composition.`);
    }
    console.log(`     Deploy with: npm run remotion:deploy-site-${site}`);
}

if (!warnings) console.log('\n  Both sites are in step.');

// Always green: this reports a deployment fact, not a defect in the code under test.
console.log('\n1/1 passed (advisory only)\n');
