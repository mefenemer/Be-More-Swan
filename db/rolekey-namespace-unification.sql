-- Migration: Unify the dual roleKey namespaces (TODO.md tech-debt cleanup, steps 1–2).
-- Applied manually (like db/gamification.sql / db/catalog-engine.sql) rather than via
-- `drizzle-kit push`. Idempotent: safe to re-run — every statement is a no-op once the
-- legacy keys are gone. Wrapped in a single transaction so a failure leaves nothing half-migrated.
--
-- WHY: two roleKey vocabularies coexisted for the same assistants —
--   legacy seed keys  (seed/data/master_assistants.json, pre-catalog): social_media, seo, inbox, …
--   catalog keys      (db/seed-catalog.ts):                            social_media_manager, seo_content_strategist, …
-- Every role-keyed policy map had to list both spellings, and code that hard-coded one
-- silently missed assistants seeded with the other (cron jobs matching only
-- 'social_media_manager' matched ZERO live assistants — see src/constants/roles.ts history).
--
-- CANONICAL NAMESPACE: the db/seed-catalog.ts catalog keys.
--
-- Legacy → canonical mapping (merged where a catalog twin exists):
--   social_media   → social_media_manager      (the live SMM duplication that bit us)
--   community_mgmt → social_media_manager      (never launched; community engagement is SMM scope)
--   inbox          → inbox_manager
--   reporting      → status_report_generator
--   receipt_admin  → expense_categorizer
--   lead_welcomer  → lead_qualifier
--   seo            → seo_content_strategist
--
-- Legacy-only roles with no catalog twin KEEP their key (still one spelling each, so no
-- namespace duplication): paid_ads, data_entry, custom. They are however marked
-- is_active = FALSE at the bottom so the launch catalog (master-assistants GET filters
-- is_active) shows exactly the 20 catalog roles. Existing hired instances are untouched
-- (ai_assistants rows keep their FK + configuration), and the legacy post-purchase
-- onboarding wizards still resolve these rows by roleKey (onboarding.ts does not filter
-- is_active).
--
-- What gets rewritten for each merged pair:
--   1. ai_assistants.master_assistant_id      → repointed to the canonical row (FK has no cascade)
--   2. ai_assistants.configuration->>'type'   → rewritten to the canonical key (this IS the
--                                               instance roleKey — resolveAssistantRole/get-assistants read it)
--   3. waitlist / waitlist_referrals          → repointed, deduping on the (email, master) unique key
--   4. assistant_features / assistant_versions / risk_assessments
--                                             → repointed where no unique-key collision; colliding
--                                               leftovers are removed with the legacy row (ON DELETE CASCADE)
--   5. master_assistants.replacement_assistant_id → repointed
--   6. the legacy master_assistants row       → deleted
-- If the canonical row does not exist in an environment (never seeded from the catalog),
-- the legacy row is simply renamed to the canonical key instead.

BEGIN;

DO $$
DECLARE
    pair RECORD;
    legacy_id INTEGER;
    canon_id  INTEGER;
BEGIN
    FOR pair IN
        SELECT * FROM (VALUES
            ('social_media',   'social_media_manager'),
            ('community_mgmt', 'social_media_manager'),
            ('inbox',          'inbox_manager'),
            ('reporting',      'status_report_generator'),
            ('receipt_admin',  'expense_categorizer'),
            ('lead_welcomer',  'lead_qualifier'),
            ('seo',            'seo_content_strategist')
        ) AS m(legacy_key, canonical_key)
    LOOP
        SELECT id INTO legacy_id FROM master_assistants WHERE role_key = pair.legacy_key;
        SELECT id INTO canon_id  FROM master_assistants WHERE role_key = pair.canonical_key;

        -- Rewrite the instance roleKey regardless of which master rows exist — hired
        -- assistants carry it denormalised in configuration->>'type'.
        UPDATE ai_assistants
        SET configuration = jsonb_set(configuration, '{type}', to_jsonb(pair.canonical_key))
        WHERE configuration ->> 'type' = pair.legacy_key;

        IF legacy_id IS NULL THEN
            CONTINUE; -- already migrated (or this env never seeded the legacy key)
        END IF;

        IF canon_id IS NULL THEN
            -- No catalog twin in this environment: a rename is a complete migration.
            UPDATE master_assistants SET role_key = pair.canonical_key, updated_at = NOW()
            WHERE id = legacy_id;
            CONTINUE;
        END IF;

        -- ── Merge legacy row into the canonical row ───────────────────────────
        UPDATE ai_assistants SET master_assistant_id = canon_id
        WHERE master_assistant_id = legacy_id;

        -- waitlist: unique (email, master_assistant_id) — keep the earliest signup when
        -- someone joined both spellings' lists.
        UPDATE waitlist w SET master_assistant_id = canon_id
        WHERE w.master_assistant_id = legacy_id
          AND NOT EXISTS (
              SELECT 1 FROM waitlist d
              WHERE d.master_assistant_id = canon_id AND d.email = w.email
          );

        UPDATE waitlist_referrals SET master_assistant_id = canon_id
        WHERE master_assistant_id = legacy_id;

        -- assistant_features: unique (master_assistant_id, feature_key)
        UPDATE assistant_features f SET master_assistant_id = canon_id
        WHERE f.master_assistant_id = legacy_id
          AND NOT EXISTS (
              SELECT 1 FROM assistant_features d
              WHERE d.master_assistant_id = canon_id AND d.feature_key = f.feature_key
          );

        -- assistant_versions: unique (assistant_id, version_number)
        UPDATE assistant_versions v SET assistant_id = canon_id
        WHERE v.assistant_id = legacy_id
          AND NOT EXISTS (
              SELECT 1 FROM assistant_versions d
              WHERE d.assistant_id = canon_id AND d.version_number = v.version_number
          );

        UPDATE risk_assessments SET master_assistant_id = canon_id
        WHERE master_assistant_id = legacy_id;

        UPDATE master_assistants SET replacement_assistant_id = canon_id
        WHERE replacement_assistant_id = legacy_id;

        -- Remaining children (colliding waitlist/features/versions rows) go with the
        -- legacy row via ON DELETE CASCADE. Any table added later with a RESTRICT FK
        -- makes this DELETE fail loudly and roll the whole transaction back — that is
        -- intentional: extend the block above rather than losing rows silently.
        DELETE FROM master_assistants WHERE id = legacy_id;

        RAISE NOTICE 'merged % (id %) into % (id %)', pair.legacy_key, legacy_id, pair.canonical_key, canon_id;
    END LOOP;
END $$;

-- ── Launch catalog visibility ─────────────────────────────────────────────────
-- Legacy-only roles keep working for existing instances + the post-purchase wizards,
-- but are hidden from the public/workspace catalogs so launch shows exactly the
-- 20-role catalog (5 live + coming soon). Re-activate any of these deliberately
-- via the admin PATCH if they are productised later.
UPDATE master_assistants SET is_active = FALSE, updated_at = NOW()
WHERE role_key IN ('paid_ads', 'data_entry', 'custom') AND is_active = TRUE;

COMMIT;

-- Verification (run after applying):
--   SELECT role_key, name, is_active, coming_soon FROM master_assistants ORDER BY role_key;
--     → 23 rows, no short legacy keys, exactly 6 with coming_soon = false AND is_active = true
--   SELECT DISTINCT configuration->>'type' FROM ai_assistants;
--     → no 'social_media' / 'community_mgmt' / 'inbox' / 'reporting' / 'receipt_admin' / 'lead_welcomer' / 'seo'
