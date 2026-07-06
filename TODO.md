# TODO — Tech Debt

## ✅ Unify the dual roleKey namespaces (legacy `social_media` / `paid_ads` fallback maps) — DONE (Launch Sprint, Jul 2026)

The two roleKey vocabularies (legacy seed keys like `social_media` vs the canonical
`db/seed-catalog.ts` keys like `social_media_manager`) are unified. Canonical namespace:
**the `db/seed-catalog.ts` catalog keys.**

Cleanup plan execution:

- [x] **1. Data migration** — `db/rolekey-namespace-unification.sql` maps every legacy key
      to its catalog twin, merging duplicate `master_assistants` rows (repoints
      `ai_assistants.master_assistant_id`, rewrites `ai_assistants.configuration->>'type'`,
      dedupes waitlist/features/versions) and renames where no twin exists.
      Legacy-only roles with no catalog equivalent keep their single key but are marked
      `is_active = FALSE` so the launch catalog shows exactly the 20 catalog roles:
      `paid_ads`, `data_entry`, `custom`.
      Applied to the database on 2026-07-06 (verification queries are at the bottom of
      the file if the state ever needs re-checking).
- [x] **2. Seed re-export** — `seed/data/master_assistants.json` now carries the canonical
      keys (full 20-role catalog + the 3 deactivated legacy roles), so `npm run db:seed`
      cannot reintroduce the drift. The stale hardcoded list in `db/seed.ts` was removed.
- [x] **3. Constants collapsed** — `SMM_ROLE_KEY = 'social_media_manager'`,
      `SMM_ROLE_KEYS = [SMM_ROLE_KEY]` (array kept so `inArray` call sites are stable);
      `ROLE_CONNECTIONS` no longer lists `social_media` / `community_mgmt` duplicates.
      `onboarding.ts` now resolves the master row by roleKey (display-name → key map)
      instead of by name; workspace's generate-post filter matches the canonical key.
- [x] **4. Keyword fallback kept** — `categoriesFromName` in `connection-map.ts` stays until
      no pre-roleKey assistants remain; a regression test pins that an un-migrated
      `social_media` row still resolves social scope from its display name (fail-closed,
      never unrestricted). Frontend: unknown roleKeys fall back to the
      `social_media_manager` entry in both `assistant-dashboard-registry.js` (existing)
      and `assistant-role-content.js` (legacy aliases added) — no undefined errors.
- [ ] **5. (Deferred) Move the connection policy to the DB** — category column on the
      connector catalog + role→category table, as noted in `connection-map.ts`. Do this
      when non-social connectors ship.
