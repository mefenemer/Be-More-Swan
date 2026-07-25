// tests/remotion-bundle-drift.test.ts
//
// Warns — never fails — when the Remotion composition has changed since the last site deploy.
//
// The Remotion site is an S3 bundle that a git push does NOT update. Editing PostOverlay.tsx and
// shipping the app leaves production rendering the previous composition: the code believes posts
// carry sound, the renders come back silent, and no error is raised anywhere. That has already
// happened once, when timed audio shipped without a site deploy.
//
// WARNING, not a gate, on purpose. Editing the composition locally is normal and correct, and only
// someone with AWS credentials can clear the condition — a hard failure would make the whole suite
// red for everyone else, and a suite people learn to ignore protects nothing. This mirrors the
// License Gate's non-blocking drift warning.
//
// To clear it:  npm run remotion:deploy-site-staging   (or -prod) — the deploy stamps it.
//
// Run:  npx tsx tests/remotion-bundle-drift.test.ts

import { bundleHash, readStamp } from '../scripts/stamp-remotion-bundle.mjs';

const now = bundleHash();
const stamped = readStamp();

console.log('\nRemotion bundle vs last deploy\n');

if (stamped === now) {
    console.log(`  ✓ the deployed bundle matches these sources (${now})`);
} else if (!stamped) {
    console.log('  ⚠️  NEVER STAMPED — no deploy has been recorded for this composition.');
    console.log('     If renders ignore recent changes (silent audio, missing text), the S3 site is stale.');
    console.log('     Deploy with: npm run remotion:deploy-site-staging');
} else {
    console.log(`  ⚠️  DRIFT: sources are at ${now}, last deploy was ${stamped}.`);
    console.log('     A git push does NOT update the Remotion site — it is an S3 bundle.');
    console.log('     Until it is redeployed, renders in that environment run the OLD composition.');
    console.log('     Deploy with: npm run remotion:deploy-site-staging  (or -prod)');
}

// Always green: this reports a deployment fact, not a defect in the code under test.
console.log('\n1/1 passed (advisory only)\n');
