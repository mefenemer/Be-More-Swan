// netlify/functions/db-seed.ts
// US-ADM-1.7.2: Database Seeding — Export current master data / Import with dry-run + apply
//
// Requires super_admin role for all operations.
//
// GET  /.netlify/functions/db-seed?action=export[&tables=masterPlans,planPrices,...]
//   → JSON seed file attachment (aura-seed-YYYY-MM-DD-vN.json)
//
// POST /.netlify/functions/db-seed?action=dry-run
//   Body: { seedData: SeedFile }
//   → { tables: { [table]: { inserts, updates, skips, conflicts } } }
//
// POST /.netlify/functions/db-seed?action=apply
//   Body: { seedData: SeedFile, tables?: string[] }  // tables = selection filter
//   → { ok: true, appliedTables: string[], rowsAffected: number }
//
// Seedable tables (master/reference data only; user/operational data excluded):
//   masterPlans, planPrices, masterAssistants, featureFlags, platformConfig
//
// Idempotency: upsert by natural key, never by numeric PK (which may differ between environments).
// Schema version check: minor mismatch = warning, major mismatch = block.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    users,
    masterPlans,
    planPrices,
    masterAssistants,
    assistantVersions,
    featureFlags,
    platformConfig,
    supportedLanguages,
} from '../../db/schema';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

// Bump MAJOR when column renames/drops happen; MINOR for additive changes.
export const SCHEMA_VERSION = '1.0';

const SEEDABLE_TABLES = ['masterPlans', 'planPrices', 'masterAssistants', 'assistantVersions', 'featureFlags', 'platformConfig', 'supportedLanguages'] as const;
type SeedableTable = typeof SEEDABLE_TABLES[number];

interface SeedMeta {
    version: string;        // e.g. '2026-06-12-v1'
    schemaVersion: string;  // e.g. '1.0'
    exportedAt: string;
    tables: SeedableTable[];
    exportedBy?: number;
}

interface SeedFile {
    meta: SeedMeta;
    masterPlans?: any[];
    planPrices?: any[];
    masterAssistants?: any[];
    assistantVersions?: any[];
    featureFlags?: any[];
    platformConfig?: any[];
    supportedLanguages?: any[];
}

interface TableStats {
    inserts: number;
    updates: number;
    skips: number;
    conflicts: string[];
}

async function requireSuperAdmin(event: any): Promise<number | null> {
    if (!jwtSecret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    let userId: number;
    try {
        userId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId;
    } catch {
        return null;
    }
    const db = getDb();
    const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    if (row?.role !== 'super_admin') return null;
    return userId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

async function exportSeed(adminId: number, requestedTables?: string[]): Promise<SeedFile> {
    const db = getDb();
    const tables = (requestedTables?.length
        ? requestedTables.filter(t => SEEDABLE_TABLES.includes(t as SeedableTable))
        : [...SEEDABLE_TABLES]) as SeedableTable[];

    const seed: SeedFile = {
        meta: {
            version: `${new Date().toISOString().slice(0, 10)}-v1`,
            schemaVersion: SCHEMA_VERSION,
            exportedAt: new Date().toISOString(),
            tables,
            exportedBy: adminId,
        },
    };

    if (tables.includes('masterPlans')) {
        seed.masterPlans = await db.select().from(masterPlans).orderBy(masterPlans.id);
    }
    if (tables.includes('planPrices')) {
        seed.planPrices = await db.select().from(planPrices).orderBy(planPrices.id);
    }
    if (tables.includes('masterAssistants')) {
        seed.masterAssistants = await db.select().from(masterAssistants).orderBy(masterAssistants.id);
    }
    if (tables.includes('assistantVersions')) {
        seed.assistantVersions = await db.select().from(assistantVersions).orderBy(assistantVersions.id);
    }
    if (tables.includes('featureFlags')) {
        seed.featureFlags = await db.select().from(featureFlags);
    }
    if (tables.includes('platformConfig')) {
        seed.platformConfig = await db.select().from(platformConfig);
    }
    if (tables.includes('supportedLanguages')) {
        seed.supportedLanguages = await db.select().from(supportedLanguages).orderBy(supportedLanguages.sortOrder);
    }

    return seed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dry Run
// ─────────────────────────────────────────────────────────────────────────────

async function dryRun(seed: SeedFile, selectedTables?: string[]): Promise<Record<string, TableStats>> {
    const db = getDb();
    const result: Record<string, TableStats> = {};
    const tables = (selectedTables?.length
        ? selectedTables.filter(t => SEEDABLE_TABLES.includes(t as SeedableTable))
        : seed.meta.tables) as SeedableTable[];

    for (const table of tables) {
        const rows: any[] = (seed as any)[table] ?? [];
        const stats: TableStats = { inserts: 0, updates: 0, skips: 0, conflicts: [] };

        if (table === 'masterPlans') {
            const existing = await db.select().from(masterPlans);
            const existingMap = new Map(existing.map(r => [r.tierKey, r]));
            for (const row of rows) {
                if (!row.tierKey) { stats.conflicts.push(`Row missing tierKey`); continue; }
                const ex = existingMap.get(row.tierKey);
                if (!ex) { stats.inserts++; continue; }
                const changed = ex.name !== row.name || String(ex.monthlyPriceGbp) !== String(row.monthlyPriceGbp) || ex.assistantLimit !== row.assistantLimit || ex.monthlyTaskLimit !== row.monthlyTaskLimit || ex.isActive !== row.isActive;
                changed ? stats.updates++ : stats.skips++;
            }
        }

        if (table === 'planPrices') {
            const existing = await db.select().from(planPrices);
            const existingMap = new Map(existing.map(r => [`${r.masterPlanId}:${r.currency}`, r]));
            for (const row of rows) {
                if (!row.masterPlanId || !row.currency) { stats.conflicts.push(`Row missing masterPlanId or currency`); continue; }
                const ex = existingMap.get(`${row.masterPlanId}:${row.currency}`);
                if (!ex) { stats.inserts++; continue; }
                const changed = String(ex.monthlyPriceMajorUnit) !== String(row.monthlyPriceMajorUnit) || ex.stripePriceId !== row.stripePriceId || ex.isActive !== row.isActive;
                changed ? stats.updates++ : stats.skips++;
            }
        }

        if (table === 'masterAssistants') {
            const existing = await db.select().from(masterAssistants);
            const existingMap = new Map(existing.map(r => [r.roleKey, r]));
            for (const row of rows) {
                if (!row.roleKey) { stats.conflicts.push(`Row missing roleKey`); continue; }
                const ex = existingMap.get(row.roleKey);
                if (!ex) { stats.inserts++; continue; }
                const changed = ex.name !== row.name || ex.description !== row.description || ex.isActive !== row.isActive || ex.comingSoon !== row.comingSoon;
                changed ? stats.updates++ : stats.skips++;
            }
        }

        if (table === 'assistantVersions') {
            const existing = await db.select().from(assistantVersions);
            const existingMap = new Map(existing.map(r => [`${r.assistantId}:${r.versionNumber}`, r]));
            for (const row of rows) {
                if (!row.assistantId || row.versionNumber == null) { stats.conflicts.push(`Row missing assistantId or versionNumber`); continue; }
                const ex = existingMap.get(`${row.assistantId}:${row.versionNumber}`);
                if (!ex) { stats.inserts++; continue; }
                const changed = ex.systemPrompt !== row.systemPrompt || ex.changeNote !== row.changeNote || JSON.stringify(ex.config) !== JSON.stringify(row.config);
                changed ? stats.updates++ : stats.skips++;
            }
        }

        if (table === 'featureFlags') {
            const existing = await db.select().from(featureFlags);
            const existingMap = new Map(existing.map(r => [r.key, r]));
            for (const row of rows) {
                if (!row.key) { stats.conflicts.push(`Row missing key`); continue; }
                const ex = existingMap.get(row.key);
                if (!ex) { stats.inserts++; continue; }
                const changed = ex.enabled !== row.enabled || ex.rolloutPercentage !== row.rolloutPercentage || ex.description !== row.description;
                changed ? stats.updates++ : stats.skips++;
            }
        }

        if (table === 'platformConfig') {
            const existing = await db.select().from(platformConfig);
            const existingMap = new Map(existing.map(r => [r.key, r]));
            for (const row of rows) {
                if (!row.key) { stats.conflicts.push(`Row missing key`); continue; }
                const ex = existingMap.get(row.key);
                if (!ex) { stats.inserts++; continue; }
                const changed = ex.value !== row.value;
                changed ? stats.updates++ : stats.skips++;
            }
        }

        if (table === 'supportedLanguages') {
            const existing = await db.select().from(supportedLanguages);
            const existingMap = new Map(existing.map(r => [r.code, r]));
            for (const row of rows) {
                if (!row.code) { stats.conflicts.push(`Row missing code`); continue; }
                const ex = existingMap.get(row.code);
                if (!ex) { stats.inserts++; continue; }
                const changed = ex.name !== row.name || ex.nativeName !== row.nativeName || ex.isActive !== row.isActive || ex.sortOrder !== row.sortOrder;
                changed ? stats.updates++ : stats.skips++;
            }
        }

        result[table] = stats;
    }

    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply
// ─────────────────────────────────────────────────────────────────────────────

async function applySeed(
    seed: SeedFile,
    adminId: number,
    selectedTables?: string[],
): Promise<{ appliedTables: string[]; rowsAffected: number }> {
    const db = getDb();
    const tables = (selectedTables?.length
        ? selectedTables.filter(t => SEEDABLE_TABLES.includes(t as SeedableTable))
        : seed.meta.tables) as SeedableTable[];

    let rowsAffected = 0;

    // Apply each table in dependency order inside a transaction
    await db.transaction(async (tx) => {
        for (const table of tables) {
            const rows: any[] = (seed as any)[table] ?? [];

            if (table === 'masterPlans') {
                for (const row of rows) {
                    if (!row.tierKey) continue;
                    const { id: _id, createdAt: _c, ...vals } = row;
                    await tx.insert(masterPlans).values(vals).onConflictDoUpdate({
                        target: masterPlans.tierKey,
                        set: { name: vals.name, monthlyPriceGbp: vals.monthlyPriceGbp, assistantLimit: vals.assistantLimit, monthlyTaskLimit: vals.monthlyTaskLimit, monthlyTokenLimit: vals.monthlyTokenLimit, appConnectionLimit: vals.appConnectionLimit, seatLimit: vals.seatLimit, isActive: vals.isActive },
                    });
                    rowsAffected++;
                }
            }

            if (table === 'planPrices') {
                for (const row of rows) {
                    if (!row.masterPlanId || !row.currency) continue;
                    const { id: _id, createdAt: _c, ...vals } = row;
                    await tx.insert(planPrices).values(vals).onConflictDoUpdate({
                        target: [planPrices.masterPlanId, planPrices.currency],
                        set: { monthlyPriceMajorUnit: vals.monthlyPriceMajorUnit, stripePriceId: vals.stripePriceId, isActive: vals.isActive },
                    });
                    rowsAffected++;
                }
            }

            if (table === 'masterAssistants') {
                for (const row of rows) {
                    if (!row.roleKey) continue;
                    // Skip FK columns that may not resolve in target env
                    const { id: _id, currentVersionId: _cv, replacementAssistantId: _ra, createdAt: _c, updatedAt: _u, ...vals } = row;
                    await tx.insert(masterAssistants).values(vals).onConflictDoUpdate({
                        target: masterAssistants.roleKey,
                        set: { name: vals.name, description: vals.description, category: vals.category, iconKey: vals.iconKey, iconColor: vals.iconColor, comingSoon: vals.comingSoon, isActive: vals.isActive, lifecycleState: vals.lifecycleState, riskClassification: vals.riskClassification },
                    });
                    rowsAffected++;
                }
            }

            if (table === 'assistantVersions') {
                for (const row of rows) {
                    if (!row.assistantId || row.versionNumber == null) continue;
                    const { id: _id, createdAt: _c, createdBy: _cb, ...vals } = row;
                    await tx.insert(assistantVersions).values({ ...vals, createdBy: adminId }).onConflictDoUpdate({
                        target: [assistantVersions.assistantId, assistantVersions.versionNumber],
                        set: { systemPrompt: vals.systemPrompt, config: vals.config, changeNote: vals.changeNote },
                    });
                    rowsAffected++;
                }
            }

            if (table === 'featureFlags') {
                for (const row of rows) {
                    if (!row.key) continue;
                    const { updatedAt: _u, updatedBy: _ub, ...vals } = row;
                    await tx.insert(featureFlags).values({ ...vals, updatedBy: adminId }).onConflictDoUpdate({
                        target: featureFlags.key,
                        set: { enabled: vals.enabled, rolloutPercentage: vals.rolloutPercentage, allowedWorkspaceIds: vals.allowedWorkspaceIds, allowedTiers: vals.allowedTiers, description: vals.description, updatedBy: adminId, updatedAt: new Date() },
                    });
                    rowsAffected++;
                }
            }

            if (table === 'platformConfig') {
                for (const row of rows) {
                    if (!row.key) continue;
                    await tx.insert(platformConfig).values({ key: row.key, value: row.value, updatedBy: adminId, reason: `Seed import ${seed.meta.version}` }).onConflictDoUpdate({
                        target: platformConfig.key,
                        set: { value: row.value, updatedBy: adminId, updatedAt: new Date(), reason: `Seed import ${seed.meta.version}` },
                    });
                    rowsAffected++;
                }
            }

            if (table === 'supportedLanguages') {
                for (const row of rows) {
                    if (!row.code) continue;
                    await tx.insert(supportedLanguages).values({ code: row.code, name: row.name, nativeName: row.nativeName || null, isActive: row.isActive ?? true, sortOrder: row.sortOrder ?? 0 }).onConflictDoUpdate({
                        target: supportedLanguages.code,
                        set: { name: row.name, nativeName: row.nativeName || null, isActive: row.isActive ?? true, sortOrder: row.sortOrder ?? 0 },
                    });
                    rowsAffected++;
                }
            }
        }
    });

    return { appliedTables: tables, rowsAffected };
}

function checkSchemaVersion(seedVersion: string): { blocked: boolean; warning: boolean; message: string } {
    const [currentMajor, currentMinor] = SCHEMA_VERSION.split('.').map(Number);
    const [seedMajor, seedMinor] = (seedVersion || '0.0').split('.').map(Number);

    if (seedMajor !== currentMajor) {
        return { blocked: true, warning: false, message: `Schema major version mismatch: seed is v${seedVersion}, current is v${SCHEMA_VERSION}. Import blocked.` };
    }
    if (seedMinor !== currentMinor) {
        return { blocked: false, warning: true, message: `Schema minor version mismatch: seed is v${seedVersion}, current is v${SCHEMA_VERSION}. Proceed with caution.` };
    }
    return { blocked: false, warning: false, message: '' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

export default withLambda(async (event) => {
    const adminId = await requireSuperAdmin(event);
    if (!adminId) {
        return { statusCode: 401, body: JSON.stringify({ error: 'super_admin required.' }) };
    }

    const action = event.queryStringParameters?.action;
    const ip = getAdminIp(event.headers);
    const ua = event.headers['user-agent'] || undefined;

    // ── Export ────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET' && action === 'export') {
        const tablesParam = event.queryStringParameters?.tables;
        const selectedTables = tablesParam ? tablesParam.split(',').map(t => t.trim()) : undefined;

        const seed = await exportSeed(adminId, selectedTables);
        const filename = `aura-seed-${seed.meta.version}.json`;

        void insertAdminAuditLog({
            adminId, action: 'sar_export',
            targetType: 'seed_export',
            newState: { filename, tables: seed.meta.tables, schemaVersion: SCHEMA_VERSION },
            ipAddress: ip, userAgent: ua,
        });

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Content-Disposition': `attachment; filename="${filename}"`,
            },
            body: JSON.stringify(seed, null, 2),
        };
    }

    // ── Dry Run / Apply ───────────────────────────────────────────────────────
    if (event.httpMethod === 'POST' && (action === 'dry-run' || action === 'apply')) {
        let body: { seedData?: SeedFile; tables?: string[] };
        try {
            body = JSON.parse(event.body || '{}');
        } catch {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
        }

        const { seedData, tables: selectedTables } = body;
        if (!seedData?.meta) {
            return { statusCode: 400, body: JSON.stringify({ error: 'seedData with meta header required.' }) };
        }

        const schemaCheck = checkSchemaVersion(seedData.meta.schemaVersion);
        if (schemaCheck.blocked) {
            return { statusCode: 422, body: JSON.stringify({ error: schemaCheck.message }) };
        }

        if (action === 'dry-run') {
            const preview = await dryRun(seedData, selectedTables);
            return {
                statusCode: 200,
                body: JSON.stringify({
                    preview,
                    schemaWarning: schemaCheck.warning ? schemaCheck.message : null,
                    seedVersion: seedData.meta.version,
                    seedSchemaVersion: seedData.meta.schemaVersion,
                }),
            };
        }

        // Apply
        const result = await applySeed(seedData, adminId, selectedTables);

        void insertAdminAuditLog({
            adminId, action: 'sar_export',
            targetType: 'seed_import',
            newState: { seedVersion: seedData.meta.version, ...result },
            ipAddress: ip, userAgent: ua,
        });

        return {
            statusCode: 200,
            body: JSON.stringify({
                ok: true,
                ...result,
                schemaWarning: schemaCheck.warning ? schemaCheck.message : null,
            }),
        };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'action must be export, dry-run, or apply.' }) };
});
