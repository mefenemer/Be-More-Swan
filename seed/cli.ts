// seed/cli.ts
// Epic: Superadmin Environment Management — US6.4 (seed execution from CLI).
//
//   npm run db:seed                 → seed LIVE (NETLIFY_DATABASE_URL + STRIPE_SECRET_KEY)
//   npm run db:seed -- --sandbox    → seed SANDBOX (SANDBOX_DATABASE_URL + STRIPE_SECRET_KEY_TEST)
//   npm run db:seed -- --no-stripe  → skip Stripe Product/Price sync
//
// The environment is bound via runWithEnvironment so getDb()/getStripe() route to
// the correct database + Stripe account.

import { config } from 'dotenv';
import * as path from 'path';
config({ path: path.resolve(process.cwd(), '.env') });

import { runWithEnvironment, type AppEnv } from '../src/utils/env-context';
import { runSeed } from './run-seed';

const env: AppEnv = process.argv.includes('--sandbox') ? 'sandbox' : 'live';
const noStripe = process.argv.includes('--no-stripe');

(async () => {
    console.log(`\n🌱 Seeding "${env}" environment…\n`);
    try {
        await runWithEnvironment(env, () => runSeed({ syncStripe: !noStripe }));
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Seed failed:', err);
        process.exit(1);
    }
})();
