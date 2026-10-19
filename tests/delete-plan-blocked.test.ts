// tests/delete-plan-blocked.test.ts
// Admin ▸ Master Data ▸ Plans ▸ Delete must explain itself, not fail.
//
// WHY THIS EXISTS. Deleting the retired £349 Digital Employee answered "Failed to load preview:
// Unknown table: master_plans" (2026-10-19). Plans were simply missing from the delete screen's
// table list. They must not be deletable at all: subscribers' plans.master_plan_id and the beta
// plan's features (featureTierKey: beta → 'employee') resolve through the row. A plan is retired by
// making it inactive.
//
// Run:  npx tsx tests/delete-plan-blocked.test.ts

import assert from 'node:assert';
import { TABLE_DELETE_CONFIG } from '../src/utils/delete-tiers';

const cfg = TABLE_DELETE_CONFIG.master_plans;
assert.ok(cfg, 'master_plans has a delete rule (the screen used to say "Unknown table")');
assert.strictEqual(cfg.tier, 'blocked');
assert.match(cfg.blockedReason ?? '', /only made inactive/);
console.log('  ✓ plans are blocked from deletion with a reason the admin can act on\n\n1 passed');
