// netlify/functions/trigger-key-rotation.ts
// US-DB-1.6.1: SuperAdmin-only endpoint to trigger an eager full KEK rotation job.
// Idempotent: rows already at the current keyVersion are skipped by getSecret's lazy rotation check.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { lt } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { vaultSecrets } from '../../db/schema';
import { getSecret } from '../../src/utils/vault';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let adminRole: string;
    try {
        const decoded = jwt.verify(cookie, jwtSecret) as { adminRole?: string };
        adminRole = decoded.adminRole ?? '';
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    if (adminRole !== 'super_admin') {
        return { statusCode: 403, body: JSON.stringify({ error: 'SuperAdmin access required.' }) };
    }

    const currentVersion = parseInt(process.env.VAULT_KEK_VERSION || '1', 10);
    const db = getDb();

    // Find all rows encrypted with an older KEK version
    const staleRows = await db
        .select({ refKey: vaultSecrets.refKey })
        .from(vaultSecrets)
        .where(lt(vaultSecrets.keyVersion, currentVersion));

    let rotated = 0;
    const failures: string[] = [];

    for (const { refKey } of staleRows) {
        try {
            // getSecret performs lazy rotation — re-encrypts with current KEK version on read
            await getSecret(db, refKey);
            rotated++;
        } catch (err: any) {
            failures.push(`${refKey}: ${err?.message ?? 'unknown error'}`);
        }
    }

    return {
        statusCode: 200,
        body: JSON.stringify({
            targetVersion: currentVersion,
            total: staleRows.length,
            rotated,
            failed: failures.length,
            failures,
        }),
    };
});
