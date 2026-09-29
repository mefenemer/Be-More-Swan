// tests/user-deletion-sole-org.test.ts
// Deleting a user must not leave their empty workspace behind — and must never take a shared or
// still-billing one with it.
//
// Run:  npx tsx tests/user-deletion-sole-org.test.ts
//
// The bug: organisations has no FK to its owner, so `DELETE FROM users` cascaded the membership away
// and left the org standing. purge-ghost-accounts did that to every signup that never verified —
// prod org 42 (2026-09-17) was a customer's abandoned first attempt, sitting next to the org she
// went on to pay from. Nothing errors when this regresses, so the invariants are asserted here.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { decideOrgFate } from '../src/utils/user-deletion';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const ROOT = path.join(__dirname, '..');
const code = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const helper = code('src/utils/user-deletion.ts');
const purge = code('netlify/functions/purge-ghost-accounts.ts');
const admin = code('netlify/functions/admin-api.ts');
const register = code('netlify/functions/register.ts');

console.log('\nUser deletion takes the sole-member workspace with it\n');

check('an org with other members is left alone', () => {
    assert.strictEqual(decideOrgFate({ otherMembers: 1, hasLiveSubscription: false }), 'leave');
    assert.strictEqual(decideOrgFate({ otherMembers: 3, hasLiveSubscription: true }), 'leave');
});
check('an empty org with no live subscription is deleted', () => {
    assert.strictEqual(decideOrgFate({ otherMembers: 0, hasLiveSubscription: false }), 'delete');
});
check('an empty org still billing in Stripe is KEPT, never stranded', () => {
    assert.strictEqual(decideOrgFate({ otherMembers: 0, hasLiveSubscription: true }), 'keep_billed');
});

check('user and org are deleted inside one transaction', () => {
    assert.ok(/db\.transaction\(/.test(helper), 'helper must open a transaction');
    assert.ok(/tx\s*\.delete\(users\)/.test(helper), 'user delete must run on the transaction');
    assert.ok(/\.delete\(organisations\)/.test(helper), 'helper must delete the org');
});
check('the org delete is in a savepoint, so a stray FK cannot undo the user delete', () => {
    assert.ok(/tx\.transaction\(/.test(helper), 'org delete must be a nested transaction (savepoint)');
});
check('live-subscription check ignores ended plans', () => {
    assert.ok(/isNotNull\(plans\.stripeSubscriptionId\)/.test(helper));
    assert.ok(/notInArray\(plans\.status/.test(helper));
});

check('purge-ghost-accounts goes through the helper, not a bare user delete', () => {
    assert.ok(purge.includes('deleteUserAndSoleOrgs('), 'purge must call deleteUserAndSoleOrgs');
    assert.ok(!/db\.delete\(users\)/.test(purge), 'purge must not delete users directly');
});
check('purge re-checks the ghost predicate inside the DELETE (verify-mid-run race)', () => {
    assert.ok(/onlyIf:\s*isGhost/.test(purge));
});
check('purge waits 24h after the last link expired, not the moment it expires', () => {
    assert.ok(/GHOST_GRACE_MS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(purge));
    assert.ok(/lt\(users\.tokenExpiresAt,\s*cutoff\)/.test(purge), 'must compare against the grace cutoff');
    assert.ok(!/lt\(users\.tokenExpiresAt,\s*now\)/.test(purge), 'the old expire-and-purge predicate is back');
});

check('admin hard-delete goes through the helper', () => {
    assert.ok(admin.includes('deleteUserAndSoleOrgs(db, uid)'));
    assert.ok(!/db\.delete\(users\)\.where\(eq\(users\.id,\s*uid\)\)/.test(admin), 'bare admin user delete is back');
});

check('re-registering an unverified email sends a fresh link instead of nothing', () => {
    const i = register.indexOf("existingUser.status === 'pending_verification'");
    assert.ok(i > -1, 'pending branch missing from the duplicate check');
    const branch = register.slice(i, register.indexOf('return { statusCode: 200', i));
    assert.ok(branch.includes('sendMagicLinkEmail('), 'pending branch must send a link');
    assert.ok(branch.includes('verificationToken'), 'pending branch must rotate the token');
});

console.log(`\n${passed}/${total} checks passed\n`);
