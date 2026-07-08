// netlify/functions/add-text-assets.ts
import { HandlerEvent } from '@netlify/functions';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { workspaceAssets } from '../../db/schema';
import { logAuditEvent } from '../../src/utils/audit';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    // Authenticate + resolve the active organisation (verifies membership; never trusts the claim alone).
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;

    try {

        // --- GET: LOAD EXISTING RULES ---
        if (event.httpMethod === 'GET') {
            const rows = await db
                .select({
                    id: workspaceAssets.id,
                    category: workspaceAssets.category,
                    extractedText: workspaceAssets.extractedText,
                    isActive: workspaceAssets.isActive,
                    priority: workspaceAssets.priority,
                })
                .from(workspaceAssets)
                .where(
                    and(
                        eq(workspaceAssets.organisationId, orgId),
                        eq(workspaceAssets.assetType, 'text')
                    )
                )
                .orderBy(workspaceAssets.category, workspaceAssets.priority);

            // Group by category
            const grouped: Record<string, Array<{ id: number, value: string, isActive: boolean, priority: number }>> = {};
            rows.forEach(row => {
                if (!grouped[row.category]) grouped[row.category] = [];
                grouped[row.category].push({
                    id: row.id,
                    value: row.extractedText || '',
                    isActive: row.isActive,
                    priority: row.priority,
                });
            });

            return { statusCode: 200, body: JSON.stringify({ rules: grouped }) };
        }

        // The payload is now an array of categories, each containing an array of rules
        const payload: Array<{ category: string, rules: Array<{ priority: number, value: string, isActive: boolean }> }> = JSON.parse(event.body || '[]');

        if (!Array.isArray(payload)) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid payload structure.' }) };
        }

        // 3. Flatten the nested payload into a single array of database rows
        const flatInsertPayload: any[] = [];

        payload.forEach(section => {
            section.rules.forEach(rule => {
                flatInsertPayload.push({
                    organisationId: orgId,
                    uploaderId: userId,
                    name: `System Rule: ${section.category}`, // Generic name for UI tracking
                    assetType: 'text',
                    category: section.category,
                    extractedText: rule.value,
                    priority: rule.priority,
                    isActive: rule.isActive,
                    status: 'ready' // Text rules require no background RAG processing
                });
            });
        });

        // 4. Synchronization Execution (Transaction-like behavior)
        // Step A: Delete all existing 'text' type assets for this organization to prevent duplicates
        await db.delete(workspaceAssets)
            .where(
                and(
                    eq(workspaceAssets.organisationId, orgId),
                    eq(workspaceAssets.assetType, 'text')
                )
            );

        // Step B: Bulk insert the newly prioritized batch
        // FIX: Explicitly type the array to resolve TS7034 and TS7005
        let insertedAssets: any[] = [];
        if (flatInsertPayload.length > 0) {
            insertedAssets = await db.insert(workspaceAssets).values(flatInsertPayload).returning();
        }

        // 5. Audit Log the Sync Event
        logAuditEvent({
            userId: userId,
            actionType: 'UPDATE', // Categorized as an update since it's a full sync
            resourceType: 'workspace_assets',
            resourceId: orgId, // Using orgId since multiple assets were touched
            newState: {
                action: 'bulk_sync_rules',
                totalRulesActive: insertedAssets.filter(a => a.isActive).length,
                totalRulesInactive: insertedAssets.filter(a => !a.isActive).length
            }
        });

        return { statusCode: 200, body: JSON.stringify({ success: true, count: insertedAssets.length }) };

    } catch (error) {
        console.error('Rules Engine Sync Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
});