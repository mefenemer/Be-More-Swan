-- Migration: normalise system_connections.service_name to lowercase.
--
-- service_name is canonically lowercase: the OAuth callbacks write literals ('instagram',
-- 'linkedin', 'x') and every consumer matches on a lowercase literal — publish-instagram.ts
-- (both the drizzle `eq` and the raw `service_name = 'instagram'` SQL), publish-social-posts.ts
-- (`eq(serviceName, post.platform)`), and findTenantCollision(). The generic POST /integrations
-- path used to persist the raw request body value, so a connection created as "Instagram" was
-- invisible to all of them. That write path is fixed in netlify/functions/integrations.ts; this
-- backfills the rows it already wrote.
--
-- Run once: psql $NETLIFY_DATABASE_URL -f db/connection-service-name-lowercase.sql
-- Idempotent — safe to re-run (the UPDATE matches nothing on a second pass).

-- Guard: db/connection-tenant-uniqueness.sql enforces a partial unique index over
-- (service_name, external_user_id) for live connections. Folding case could merge two distinct
-- keys into one and violate it. Refuse the whole migration rather than fail mid-UPDATE.
DO $$
DECLARE
    collision_count integer;
BEGIN
    SELECT count(*) INTO collision_count FROM (
        SELECT lower(service_name), external_user_id
        FROM   system_connections
        WHERE  is_active = true
          AND  status = 'active'
          AND  external_user_id IS NOT NULL
        GROUP  BY 1, 2
        HAVING count(*) > 1
    ) dupes;

    IF collision_count > 0 THEN
        RAISE EXCEPTION
            'Refusing to backfill: % (lower(service_name), external_user_id) group(s) would collide on system_connections_provider_tenant_unique. Inspect and resolve first.',
            collision_count;
    END IF;
END $$;

UPDATE system_connections
SET    service_name = lower(service_name),
       updated_at   = now()
WHERE  service_name <> lower(service_name);
