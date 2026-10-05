// src/utils/beta-testers.ts
//
// Beta testers: people who applied through /beta — Be More Swan's OWN Email Marketing sign-up form,
// named by platform_config `beta_form_key`. Decided by the user 2026-10-05:
//   - everyone who applies may create an account, even while new registrations are locked;
//   - they get the free 'beta' plan (top-tier limits, no Stripe, no card) until beta is ended.
//
// The application IS the form submission. There is no second list to keep in step: whoever is in
// audience_form_submissions for that form, with a contact that has not opted out, is a beta tester.

import { and, eq, notInArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { audienceContacts, audienceFormSubmissions, audienceForms, masterPlans } from '../../db/schema';
import { CONFIG_KEYS, getPlatformConfig } from './platform-config';
import { FORM_KEY_RE } from './audience-forms';

type Db = ReturnType<typeof getDb>;

/** master_plans.tier_key of the free beta plan (db/beta-tester-plan.sql). */
export const BETA_TIER_KEY = 'beta';
/** plans.plan_type for a beta plan — what billing and reconciliation key off (there is no Stripe). */
export const BETA_PLAN_TYPE = 'beta';

/** A contact in one of these states has said "stop" — no account off the back of their application. */
const OPTED_OUT = ['unsubscribed', 'bounced', 'complained', 'suppressed'];

/**
 * Did this address apply to be a beta tester? False when no beta form is configured — beta access
 * only exists while the admin has a beta form switched on.
 */
export async function isBetaApplicant(db: Db, email: string): Promise<boolean> {
    const key = String((await getPlatformConfig(CONFIG_KEYS.BETA_FORM_KEY)) ?? '').trim();
    if (!FORM_KEY_RE.test(key)) return false;
    const addr = String(email || '').trim().toLowerCase();
    if (!addr) return false;
    const [hit] = await db
        .select({ id: audienceFormSubmissions.id })
        .from(audienceFormSubmissions)
        .innerJoin(audienceForms, eq(audienceForms.id, audienceFormSubmissions.formId))
        .innerJoin(audienceContacts, eq(audienceContacts.id, audienceFormSubmissions.contactId))
        .where(and(
            eq(audienceForms.publicKey, key),
            sql`lower(${audienceContacts.email}) = ${addr}`,
            notInArray(audienceContacts.status, OPTED_OUT),
        ))
        .limit(1);
    return !!hit;
}

/** The beta master plan, or null if db/beta-tester-plan.sql has not been applied. */
export async function getBetaMasterPlan(db: Db): Promise<{ id: number; name: string } | null> {
    const [row] = await db
        .select({ id: masterPlans.id, name: masterPlans.name })
        .from(masterPlans)
        .where(eq(masterPlans.tierKey, BETA_TIER_KEY))
        .limit(1);
    return row ?? null;
}
