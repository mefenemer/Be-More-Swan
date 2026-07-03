// src/constants/roles.ts — canonical master-assistant role keys.
//
// Historical footgun: two seed sources disagree on the Social Media Manager's role key.
//   • seed/data/master_assistants.json (the LIVE catalogue) → 'social_media'
//   • db/seed-catalog.ts                                    → 'social_media_manager'
// Cron jobs and role gates that hard-coded only 'social_media_manager' silently matched
// ZERO live assistants (whose key is 'social_media'), so scheduled draft generation never
// ran. Match BOTH keys so the gates work regardless of which source seeded an environment.

/** The live catalogue's role key for the Social Media Manager. */
export const SMM_ROLE_KEY = 'social_media';

/** Every role key that denotes a Social Media Manager (live + legacy catalog). Use with
 *  drizzle `inArray(masterAssistants.roleKey, SMM_ROLE_KEYS)`. */
export const SMM_ROLE_KEYS: string[] = ['social_media', 'social_media_manager'];
