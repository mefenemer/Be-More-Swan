// netlify/functions/migrate-vault-kek.ts
// US-GDPR-3.1.1: One-time migration to re-encrypt all legacy vault_secrets rows
// under the KEK/DEK hierarchy.
//
// POST /.netlify/functions/migrate-vault-kek
//   Auth: super_admin only
//   Body: { dryRun?: boolean }
//
// For each row where encryptedDek IS NULL:
//   1. Decrypt payload using legacy VAULT_KEY
//   2. Generate a fresh per-row DEK, encrypt payload with DEK, wrap DEK with KEK
//   3. Update row with new encryptedPayload, iv, authTag, encryptedDek
//
// Idempotent: rows with encryptedDek already set are skipped.
// Run once after deploying VAULT_KEK env var. Safe to re-run.

import { Handler } from '@netlify/functions';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { isNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { vaultSecrets } from '../../db/schema';
import { hasPermission } from '../../src/utils/rbac';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;
const ALGORITHM = 'aes-256-gcm';

function getKey(hex: string | undefined, name: string): Buffer {
    if (!hex || hex.length !== 64) throw new Error(`${name} env var missing or invalid.`);
    return Buffer.from(hex, 'hex');
}

function gcmDecryptLegacy(key: Buffer, encryptedPayload: string, iv: string, authTag: string): string {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    return Buffer.concat([
        decipher.update(Buffer.from(encryptedPayload, 'base64')),
        decipher.final(),
    ]).toString('utf8');
}

function gcmEncrypt(key: Buffer, plaintext: Buffer): { iv: string; authTag: string; ciphertext: string } {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

function wrapDek(kek: Buffer, dek: Buffer): string {
    const { iv, authTag, ciphertext } = gcmEncrypt(kek, dek);
    return `${iv}:${authTag}:${ciphertext}`;
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    let userId: number;
    let userRole: string;
    try {
        const decoded = jwt.verify(match[1], jwtSecret) as { userId: number; role?: string; adminRole?: string };
        userId = decoded.userId;
        userRole = decoded.adminRole ?? decoded.role ?? '';
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    if (!hasPermission(userRole, 'platform_config')) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Super admin only.' }) };
    }

    let body: any = {};
    try { body = JSON.parse(event.body || '{}'); } catch { /* ok */ }
    const dryRun = body.dryRun === true;

    const legacyKey = getKey(process.env.VAULT_KEY, 'VAULT_KEY');
    const kek = getKey(process.env.VAULT_KEK, 'VAULT_KEK');

    const db = getDb();

    // Load all legacy rows (encryptedDek IS NULL)
    const legacyRows = await db.select().from(vaultSecrets).where(isNull(vaultSecrets.encryptedDek));

    let migrated = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const row of legacyRows) {
        try {
            const plaintext = gcmDecryptLegacy(legacyKey, row.encryptedPayload, row.iv, row.authTag);
            const dek = crypto.randomBytes(32);
            const { iv, authTag, ciphertext } = gcmEncrypt(dek, Buffer.from(plaintext, 'utf8'));
            const encryptedDek = wrapDek(kek, dek);

            if (!dryRun) {
                const { eq } = await import('drizzle-orm');
                await db.update(vaultSecrets)
                    .set({ encryptedPayload: ciphertext, iv, authTag, encryptedDek, updatedAt: new Date() })
                    .where(eq(vaultSecrets.id, row.id));
            }
            migrated++;
        } catch (err: any) {
            failed++;
            errors.push(`row ${row.id} (${row.refKey}): ${err.message}`);
        }
    }

    console.log(`[migrate-vault-kek] dryRun=${dryRun} migrated=${migrated} failed=${failed}`);

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            dryRun,
            total: legacyRows.length,
            migrated,
            failed,
            ...(errors.length ? { errors } : {}),
        }),
    };
});
