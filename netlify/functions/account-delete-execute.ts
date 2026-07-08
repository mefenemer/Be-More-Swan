// netlify/functions/account-delete-execute.ts
// US-GAP-2.1.1 SC5: Scheduled job — hard-delete accounts pending for 24+ hours
//
// Scheduled hourly (schedule: "0 * * * *")
// Also handles the GDPR erasure log entry (SC3 / US-GAP-2.1.2 SC3)

import type { Handler } from '@netlify/functions';
import * as crypto from 'crypto';
import Stripe from 'stripe';
import { eq, and, lt, isNotNull, count } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, plans, organisations, userOrganisations, gdprErasureLog, jwtBlocklist, aiAssistants, aiUsageLog } from '../../db/schema';
import { sendEmail } from '../../src/utils/email';
import { purgeUserAssets } from '../../src/utils/gdpr-asset-purge';
import { withLambda } from '@netlify/aws-lambda-compat';

const stripe    = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-05-27.dahlia' })
    : null;
const BASE_URL  = process.env.BASE_URL || '';

// AC13 STOR-1.1.2: Delete all R2 objects under /{orgId}/ prefix when org is closed
async function _purgeOrgR2Prefix(orgId: number): Promise<void> {
    const endpoint  = process.env.R2_ENDPOINT;
    const accessKey = process.env.R2_ACCESS_KEY_ID;
    const secretKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucket    = process.env.R2_BUCKET_NAME;
    if (!endpoint || !accessKey || !secretKey || !bucket) return; // mock/dev mode

    const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
    const s3 = new S3Client({ region: 'auto', endpoint, credentials: { accessKeyId: accessKey, secretAccessKey: secretKey } });

    let continuationToken: string | undefined;
    do {
        const list = await s3.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: `${orgId}/`,
            ContinuationToken: continuationToken,
        }));
        const objects = list.Contents?.map(o => ({ Key: o.Key! })) ?? [];
        if (objects.length > 0) {
            await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
        }
        continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (continuationToken);

    console.log(`[account-delete-execute] R2 prefix /${orgId}/ purged.`);
}

async function executeDeleteions() {
    const db  = getDb();
    const now = new Date();
    const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Find users whose deletion was requested > 24h ago
    const pendingUsers = await db
        .select({
            id:               users.id,
            email:            users.email,
            firstName:        users.firstName,
            organisationId:   userOrganisations.organisationId,
        })
        .from(users)
        .leftJoin(userOrganisations, eq(users.id, userOrganisations.userId))
        .where(and(
            eq(users.pendingDeletion, true),
            isNotNull(users.pendingDeletionAt),
            lt(users.pendingDeletionAt, cutoff24h),
        ));

    for (const user of pendingUsers) {
        // Cancel Stripe subscription if active
        if (stripe) {
            const [activePlan] = await db
                .select({ stripeSubscriptionId: plans.stripeSubscriptionId, stripeCustomerId: plans.stripeCustomerId })
                .from(plans)
                .where(and(eq(plans.userId, user.id), eq(plans.status, 'active')))
                .limit(1);

            if (activePlan?.stripeSubscriptionId) {
                await stripe.subscriptions.cancel(activePlan.stripeSubscriptionId).catch(() => {});
            }
        }

        // US-GDPR-2.2.1: Purge workspace assets (extractedText + storageUrl nulled, isActive=false)
        const purgeResult = await purgeUserAssets(db, user.id).catch(() => ({
            assetsPurged: 0, storageBytesFreed: 0, embeddingsDeleted: 0, partialFailures: ['purge_threw'],
        }));

        // US-ADM-1.3.2: Blocklist all active tokens so any cached session is invalidated
        await db.insert(jwtBlocklist).values({
            userId:    user.id,
            blockType: 'userId',
            reason:    'account_delete',
        }).catch(() => {});

        // GDPR erasure log (SC3 / US-GAP-2.1.2 SC3) — include asset purge metadata
        const emailHash = crypto.createHash('sha256').update(user.email.toLowerCase()).digest('hex');
        await db.insert(gdprErasureLog).values({
            emailHash,
            requesterType: 'user',
            requestedBy:   null,
            erasedAt:      now,
            metadata: {
                assetsPurged:      purgeResult.assetsPurged,
                embeddingsDeleted: purgeResult.embeddingsDeleted,
                storageBytesFreed: purgeResult.storageBytesFreed,
                dataWipedFields:   [
                    'aiAssistants.onboardingContext',
                    'aiAssistants.configuration',
                    'aiAssistants.systemPrompt',
                    'aiUsageLog.sessionId',
                ],
                ...(purgeResult.partialFailures.length > 0
                    ? { partialFailures: purgeResult.partialFailures, erasureStatus: 'PARTIAL' }
                    : {}),
            },
        }).catch(() => {});

        // Check if the user is the sole org member — if so, delete the org + R2 prefix
        if (user.organisationId) {
            const [{ memberCount }] = await db
                .select({ memberCount: count() })
                .from(userOrganisations)
                .where(eq(userOrganisations.organisationId, user.organisationId))
                .catch(() => [{ memberCount: 0 }]);

            if (!memberCount || memberCount <= 1) {
                // AC13 STOR-1.1.2: Queue R2 prefix deletion for /{orgId}/ — runs async, completes within 24h
                void _purgeOrgR2Prefix(user.organisationId).catch(err =>
                    console.warn(`[account-delete-execute] R2 prefix purge failed for org ${user.organisationId}:`, err)
                );
                // Sole member — delete org (cascades via ON DELETE CASCADE)
                await db.delete(organisations).where(eq(organisations.id, user.organisationId)).catch(() => {});
            }
        }

        // US-GDPR-2.1.1: Wipe AI assistant personal data columns before cascade fires.
        // After db.delete(users) the aiAssistants.userId FK is set to null by cascade,
        // so this WHERE clause would match 0 rows — must run first.
        await db.update(aiAssistants)
            .set({ onboardingContext: null, configuration: null, systemPrompt: null })
            .where(eq(aiAssistants.userId, user.id))
            .catch(() => {});

        // Null sessionId in ai_usage_log before deletion so it's auditable.
        // (userId FK cascade sets userId=null on deletion; sessionId must be nulled explicitly.)
        await db.update(aiUsageLog)
            .set({ sessionId: null })
            .where(eq(aiUsageLog.userId, user.id))
            .catch(() => {});

        // Hard-delete user (cascades to all related tables via ON DELETE CASCADE)
        await db.delete(users).where(eq(users.id, user.id)).catch(err => {
            console.error(`[account-delete-execute] Failed to delete user ${user.id}:`, err);
        });

        console.log(`[account-delete-execute] Deleted user ${user.id} (email hash: ${emailHash.slice(0, 8)}...)`);
    }

    return pendingUsers.length;
}

export default withLambda(async () => {
    try {
        const deleted = await executeDeleteions();
        console.log(`[account-delete-execute] Processed ${deleted} deletion(s)`);
        return { statusCode: 200 };
    } catch (err) {
        console.error('[account-delete-execute]', err);
        return { statusCode: 500 };
    }
});
