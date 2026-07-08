// src/utils/vault.ts
// US-AUD-4.2.1 / US-GDPR-3.1.1: AES-256-GCM secrets vault backed by PostgreSQL.
// Plaintext credentials NEVER appear in DB columns, logs, or error messages (SC2).
//
// Env required:
//   VAULT_KEK_VERSION — integer: current KEK version (e.g. "2"); defaults to 1
//   VAULT_KEK_<N>     — 64 hex chars (32 bytes) KEK for version N
//                       e.g. VAULT_KEK_1, VAULT_KEK_2
//   VAULT_KEK         — legacy alias for VAULT_KEK_1 (backwards compat)
//   VAULT_KEY         — legacy fallback (64 hex chars) for rows without encryptedDek
//
// KEK/DEK architecture (US-DB-1.6.1: multi-version key rotation):
//   - A random 32-byte DEK is generated per vault write and wrapped with the current KEK version.
//   - The wrapped DEK is stored in the encryptedDek column (iv:authTag:ciphertext).
//   - vault_secrets.keyVersion records which KEK version was used.
//   - On read: select KEK by keyVersion → unwrap DEK → decrypt payload.
//   - Lazy rotation: if keyVersion < current, re-encrypt with current KEK and write back.
//   - Legacy rows (encryptedDek IS NULL) fall back to the single VAULT_KEY.

import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { vaultSecrets } from '../../db/schema';

const ALGORITHM = 'aes-256-gcm';

// ── Key helpers ───────────────────────────────────────────────────────────────

/** Current KEK version — set VAULT_KEK_VERSION env var to rotate. */
function getCurrentKekVersion(): number {
    return parseInt(process.env.VAULT_KEK_VERSION || '1', 10);
}

/** Retrieve the KEK buffer for a specific version. */
function getKekByVersion(version: number): Buffer {
    // Support VAULT_KEK_<N> per version; fall back to VAULT_KEK for version 1 (backwards compat)
    const hex = process.env[`VAULT_KEK_${version}`] ?? (version === 1 ? process.env.VAULT_KEK : undefined);
    if (!hex || hex.length !== 64) {
        throw new Error(`VAULT_KEK_${version} env var is missing or not 64 hex chars.`);
    }
    return Buffer.from(hex, 'hex');
}

function getLegacyKey(): Buffer {
    const hex = process.env.VAULT_KEY;
    if (!hex || hex.length !== 64) {
        throw new Error('VAULT_KEY env var is missing or not 64 hex chars.');
    }
    return Buffer.from(hex, 'hex');
}

// ── Low-level GCM primitives ──────────────────────────────────────────────────

function gcmEncrypt(key: Buffer, plaintext: Buffer): { iv: string; authTag: string; ciphertext: string } {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
        iv: iv.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
    };
}

function gcmDecrypt(key: Buffer, iv: string, authTag: string, ciphertext: string): Buffer {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64')),
        decipher.final(),
    ]);
}

// ── DEK wrap / unwrap ─────────────────────────────────────────────────────────

/** Wrap a DEK with the current KEK version. Stored as iv:authTag:ciphertext (all base64, colon-separated). */
function wrapDek(dek: Buffer): string {
    const { iv, authTag, ciphertext } = gcmEncrypt(getKekByVersion(getCurrentKekVersion()), dek);
    return `${iv}:${authTag}:${ciphertext}`;
}

function unwrapDek(encryptedDek: string, kekVersion = 1): Buffer {
    const parts = encryptedDek.split(':');
    if (parts.length !== 3) throw new Error('Malformed encryptedDek.');
    const [iv, authTag, ciphertext] = parts;
    return gcmDecrypt(getKekByVersion(kekVersion), iv, authTag, ciphertext);
}

// ── Payload encrypt / decrypt ─────────────────────────────────────────────────

function encryptWithDek(plaintext: string): {
    encryptedPayload: string; iv: string; authTag: string; encryptedDek: string; keyVersion: number;
} {
    const keyVersion = getCurrentKekVersion();
    const dek = crypto.randomBytes(32);
    const { iv, authTag, ciphertext } = gcmEncrypt(dek, Buffer.from(plaintext, 'utf8'));
    const encryptedDek = gcmEncrypt(getKekByVersion(keyVersion), dek);
    return {
        encryptedPayload: ciphertext,
        iv,
        authTag,
        encryptedDek: `${encryptedDek.iv}:${encryptedDek.authTag}:${encryptedDek.ciphertext}`,
        keyVersion,
    };
}

function decryptRow(row: {
    encryptedPayload: string; iv: string; authTag: string; encryptedDek: string | null; keyVersion?: number | null;
}): string {
    if (row.encryptedDek) {
        const dek = unwrapDek(row.encryptedDek, row.keyVersion ?? 1);
        return gcmDecrypt(dek, row.iv, row.authTag, row.encryptedPayload).toString('utf8');
    }
    // Legacy path: single VAULT_KEY (pre-migration rows)
    return gcmDecrypt(getLegacyKey(), row.iv, row.authTag, row.encryptedPayload).toString('utf8');
}

/** True when row was encrypted with an older KEK version and should be re-encrypted. */
function needsRotation(row: { keyVersion?: number | null }): boolean {
    return (row.keyVersion ?? 1) < getCurrentKekVersion();
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Build a canonical vault reference key for a connection. */
export function buildRefKey(userId: number, serviceName: string, connectionType: string): string {
    // e.g. 'aura/user-42/google-oauth'
    const safeService = serviceName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const safeType = connectionType.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    return `aura/user-${userId}/${safeService}-${safeType}`;
}

/**
 * Store (or overwrite) a secret in the vault using KEK/DEK encryption.
 */
export async function storeSecret(
    db: NodePgDatabase<any>,
    refKey: string,
    payload: Record<string, unknown>
): Promise<void> {
    const plaintext = JSON.stringify(payload);
    const { encryptedPayload, iv, authTag, encryptedDek, keyVersion } = encryptWithDek(plaintext);

    await db
        .insert(vaultSecrets)
        .values({ refKey, encryptedPayload, iv, authTag, encryptedDek, keyVersion })
        .onConflictDoUpdate({
            target: vaultSecrets.refKey,
            set: { encryptedPayload, iv, authTag, encryptedDek, keyVersion, updatedAt: new Date() },
        });
}

/**
 * Retrieve and decrypt a secret from the vault.
 * Returns the parsed payload, or null if not found.
 */
export async function getSecret(
    db: NodePgDatabase<any>,
    refKey: string
): Promise<Record<string, unknown> | null> {
    const [row] = await db
        .select()
        .from(vaultSecrets)
        .where(eq(vaultSecrets.refKey, refKey))
        .limit(1);
    if (!row) return null;
    const plaintext = decryptRow(row);

    // US-DB-1.6.1: Lazy key rotation — re-encrypt with current KEK version on read
    if (needsRotation(row)) {
        const { encryptedPayload, iv, authTag, encryptedDek, keyVersion } = encryptWithDek(plaintext);
        await db
            .update(vaultSecrets)
            .set({ encryptedPayload, iv, authTag, encryptedDek, keyVersion, updatedAt: new Date() })
            .where(eq(vaultSecrets.refKey, refKey));
    }

    return JSON.parse(plaintext);
}

/**
 * Delete a single secret from the vault (SC5: per-connection revocation).
 */
export async function deleteSecret(
    db: NodePgDatabase<any>,
    refKey: string
): Promise<void> {
    await db.delete(vaultSecrets).where(eq(vaultSecrets.refKey, refKey));
}

/**
 * Delete all vault secrets whose refKey starts with the given prefix (SC4: org revocation).
 * Uses SQL LIKE: prefix must be safe (no SQL wildcards injected).
 */
export async function deleteSecretsByPrefix(
    db: NodePgDatabase<any>,
    prefix: string
): Promise<number> {
    const { like } = await import('drizzle-orm');
    const result = await db
        .delete(vaultSecrets)
        .where(like(vaultSecrets.refKey, `${prefix}%`))
        .returning({ id: vaultSecrets.id });
    return result.length;
}

/**
 * Log an integration API call. Caller must strip query params from endpoint (SC6).
 */
export async function logApiCall(
    db: NodePgDatabase<any>,
    opts: { userId: number; integrationId?: number | null; endpoint: string; httpStatus?: number | null; activeScenarioId?: number | null }
): Promise<void> {
    const { integrationApiCalls } = await import('../../db/schema');
    await db.insert(integrationApiCalls).values({
        userId: opts.userId,
        integrationId: opts.integrationId ?? null,
        endpoint: opts.endpoint,
        httpStatus: opts.httpStatus ?? null,
        activeScenarioId: opts.activeScenarioId ?? null,
    });
}
