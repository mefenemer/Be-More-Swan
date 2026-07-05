# TODO — Tech Debt

## Unify the dual roleKey namespaces (legacy `social_media` / `paid_ads` fallback maps)

Two roleKey vocabularies coexist for the same assistants:

- **Live seed keys** from `seed/data/master_assistants.json` — short names such as
  `social_media`, `community_mgmt`, `paid_ads`.
- **Catalog keys** from `db/seed-catalog.ts` — long names such as
  `social_media_manager` (plus the 20 Tier 1 keys like `lead_qualifier`,
  `crm_enricher`, `tier1_support_agent`).

Because both can appear in `masterAssistants.roleKey`, every role-keyed policy map has
to list both spellings, and code that hard-codes one silently misses assistants seeded
with the other (this already bit us once: cron jobs matching only
`social_media_manager` matched ZERO live assistants — see the header comment in
`src/constants/roles.ts`).

Current fallback/duplication sites:

- `src/utils/connection-map.ts` → `ROLE_CONNECTIONS` lists the live keys
  (`social_media`, `community_mgmt`, `paid_ads`) *and* the catalog keys, plus a
  display-name keyword fallback (`categoriesFromName`) for rows with no roleKey at all.
- `src/constants/roles.ts` → `SMM_ROLE_KEY` / `SMM_ROLE_KEYS` carry both spellings for
  the Social Media Manager.
- `netlify/functions/chat-orchestrator.ts` → `ROUTES` is keyed by catalog keys only;
  live-seed-keyed assistants fall through to `defaultRoute`.

### Cleanup plan (future)

1. Pick one canonical namespace (the `db/seed-catalog.ts` catalog keys — they are the
   ones new code targets) and write a data migration mapping live seed keys →
   catalog keys in `masterAssistants.roleKey`.
2. Re-export `seed/data/master_assistants.json` with the canonical keys so re-seeding
   doesn't reintroduce the drift.
3. Delete the duplicate entries in `ROLE_CONNECTIONS` and collapse `SMM_ROLE_KEYS`
   back to a single key.
4. Keep (or then remove) the keyword fallback in `connection-map.ts` once no
   pre-roleKey assistants remain.
5. Consider moving the connection policy to the DB (category column on the connector
   catalog + role→category table) as already noted in `connection-map.ts`.
