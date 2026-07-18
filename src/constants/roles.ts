// src/constants/roles.ts — canonical master-assistant role keys.
//
// History: two seed sources used to disagree on the Social Media Manager's role key
// ('social_media' from the old seed JSON vs 'social_media_manager' from db/seed-catalog.ts),
// so cron jobs that hard-coded one spelling silently matched ZERO assistants seeded with
// the other. The namespaces were unified by db/rolekey-namespace-unification.sql — the
// db/seed-catalog.ts catalog keys are now the ONLY namespace, and seed/data/
// master_assistants.json is exported with the same keys so re-seeding cannot
// reintroduce the drift.

/** The canonical role key for the Social Media Manager. */
export const SMM_ROLE_KEY = 'social_media_manager';

/** Every role key that denotes a Social Media Manager. Collapsed to the single canonical
 *  key post-unification; kept as an array so drizzle `inArray(...)` call sites are stable. */
export const SMM_ROLE_KEYS: string[] = [SMM_ROLE_KEY];

/** The canonical role key for the Blog Writer. */
export const BLOG_WRITER_ROLE_KEY = 'blog_writer';

/** Every role key that denotes a Blog Writer. Array-shaped for the same `inArray(...)` reason
 *  as SMM_ROLE_KEYS above — Blog Autopilot's cron selects on it. */
export const BLOG_WRITER_ROLE_KEYS: string[] = [BLOG_WRITER_ROLE_KEY];
