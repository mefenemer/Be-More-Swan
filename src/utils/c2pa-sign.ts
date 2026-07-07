// src/utils/c2pa-sign.ts
// US 6.1 (EU AI Act Art. 50(2)) — C2PA image-byte signing. SCAFFOLD: cert-ready but OFF by default.
//
// Text provenance, AI disclosure and the audit edit-log already ship (content_provenance +
// [[content-provenance]]). The one missing provenance piece is signing the *image bytes* so the
// C2PA manifest travels with the pixels once a post leaves the platform — not just as a DB row.
//
// Two gates guard this, and BOTH are external (ops/procurement), not code:
//   (a) the native `c2pa-node` lib must be installed — it is an OPTIONAL dependency, lazy-loaded
//       via a computed specifier so a missing package never breaks the build or typecheck; and
//   (b) a signing certificate + private key must be provisioned via env (C2PA_SIGN_CERT /
//       C2PA_SIGN_KEY). The cert is the real gate — see docs/content-engine-remaining-build.md §C.
//
// Until BOTH exist, isC2paSigningEnabled() is false and signImageBytes() is an identity passthrough,
// so the publish path is byte-for-byte unchanged in production today. Flip it on by installing
// `c2pa-node` and setting the env vars — no code change required.
//
// The manifest summary returned here is meant to be persisted onto content_provenance
// (image_manifest / image_signer / image_signed_at — db/c2pa-image-signing.sql), so the signer and
// manifest identity live beside the existing text provenance row.

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { and, eq } from 'drizzle-orm';
import { contentAssets } from '../../db/schema';

// ── Config gates ───────────────────────────────────────────────────────────────
const C2PA_SIGN_CERT = process.env.C2PA_SIGN_CERT; // PEM certificate chain (leaf + intermediates)
const C2PA_SIGN_KEY  = process.env.C2PA_SIGN_KEY;  // PEM private key matching the leaf cert
const C2PA_SIGN_ALG  = process.env.C2PA_SIGN_ALG || 'es256'; // es256 | es384 | es512 | ps256 | ed25519
const C2PA_TSA_URL   = process.env.C2PA_TSA_URL;   // optional RFC-3161 timestamp authority

const R2_ENDPOINT          = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET            = process.env.R2_BUCKET_NAME;
const r2Configured = !!(R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);

const CREATOR_SYSTEM = 'Be More Swan';
const CLAIM_GENERATOR = 'be_more_swan/1.0';

// IPTC digital-source-type controlled vocabulary (what the pixels ultimately are).
const DIGITAL_SOURCE = {
    ai: 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia',
    human: 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture',
} as const;

/** True only when the signing cert AND key are both provisioned. The single production switch. */
export function isC2paSigningEnabled(): boolean {
    return !!(C2PA_SIGN_CERT && C2PA_SIGN_KEY);
}

export interface ManifestClaims {
    title: string;
    aiGenerated: boolean;       // drives the c2pa.created digitalSourceType assertion
    modelHint?: string;         // e.g. 'ai-generated' | model family — never the raw model id
    contentId?: string;         // ties the manifest back to content_provenance.contentId
    authorLabel?: string;       // e.g. "AI: Marketing Mike" | "Jane Smith"
}

export interface ManifestSummary {
    urn: string | null;         // active-manifest label / instance URN, when the signer returns one
    signer: string;             // signer identity (cert subject or configured label)
    algorithm: string;
    signedAt: string;           // ISO timestamp
    claims: ManifestClaims;
}

export interface SignResult {
    signed: boolean;
    bytes: Uint8Array;          // signed bytes when signed === true, otherwise the untouched input
    manifest?: ManifestSummary; // present only when signed === true
    skippedReason?: string;     // why signing was a no-op (disabled | lib-missing | error)
}

/**
 * Build the C2PA manifest definition (claim generator + assertions). Pure and dependency-free so it
 * is unit-testable without the native lib or a cert. The shape matches c2pa-node's ManifestBuilder
 * definition; adjust field names here if the pinned c2pa-node version diverges.
 */
export function buildManifest(claims: ManifestClaims, format: string): Record<string, unknown> {
    const digitalSourceType = claims.aiGenerated ? DIGITAL_SOURCE.ai : DIGITAL_SOURCE.human;
    return {
        claim_generator: CLAIM_GENERATOR,
        format,
        title: claims.title,
        assertions: [
            {
                label: 'c2pa.actions',
                data: {
                    actions: [
                        {
                            action: 'c2pa.created',
                            digitalSourceType,
                            ...(claims.modelHint ? { softwareAgent: `${CREATOR_SYSTEM} (${claims.modelHint})` } : {}),
                        },
                    ],
                },
            },
            {
                label: 'stds.schema-org.CreativeWork',
                kind: 'Json',
                data: {
                    '@context': 'https://schema.org',
                    '@type': 'CreativeWork',
                    creator: [{ '@type': 'Organization', name: CREATOR_SYSTEM }],
                    ...(claims.authorLabel ? { author: [{ '@type': 'Person', name: claims.authorLabel }] } : {}),
                    ...(claims.contentId ? { identifier: claims.contentId } : {}),
                },
            },
        ],
    };
}

// Lazy-load the optional native lib via a COMPUTED specifier so `tsc --noEmit` never tries to
// resolve a package that isn't installed yet (avoids TS2307). Returns null when absent.
async function loadC2pa(): Promise<any | null> {
    try {
        const spec = ['c2pa', 'node'].join('-'); // → 'c2pa-node', opaque to the type checker
        return await import(spec);
    } catch {
        return null;
    }
}

/**
 * Embed a signed C2PA manifest into `bytes`. Identity passthrough (signed: false) whenever signing
 * is disabled, the native lib is absent, or signing throws — publishing must never fail because
 * provenance signing is unavailable.
 *
 * NOTE: the native call below is written against the documented c2pa-node API but is UNVERIFIED —
 * it cannot be exercised until a cert lands. Treat it as the wiring to confirm on first enable.
 */
export async function signImageBytes(bytes: Uint8Array, mimeType: string, claims: ManifestClaims): Promise<SignResult> {
    if (!isC2paSigningEnabled()) {
        return { signed: false, bytes, skippedReason: 'disabled' };
    }
    const c2pa = await loadC2pa();
    if (!c2pa) {
        return { signed: false, bytes, skippedReason: 'lib-missing' };
    }
    try {
        // ── UNVERIFIED native path — confirm against the pinned c2pa-node version on first enable ──
        const signer = c2pa.createSigner({
            type: 'local',
            certificate: Buffer.from(C2PA_SIGN_CERT as string),
            privateKey: Buffer.from(C2PA_SIGN_KEY as string),
            algorithm: C2PA_SIGN_ALG,
            ...(C2PA_TSA_URL ? { tsaUrl: C2PA_TSA_URL } : {}),
        });
        const builder = new c2pa.ManifestBuilder(buildManifest(claims, mimeType));
        const instance = c2pa.createC2pa({ signer });
        const { signedAsset } = await instance.sign({
            asset: { buffer: Buffer.from(bytes), mimeType },
            manifest: builder,
        });
        const signedBytes: Uint8Array = signedAsset?.buffer ?? bytes;
        return {
            signed: true,
            bytes: signedBytes,
            manifest: {
                urn: builder?.definition?.instanceId ?? null,
                signer: signerLabel(),
                algorithm: C2PA_SIGN_ALG,
                signedAt: new Date().toISOString(),
                claims,
            },
        };
    } catch (err) {
        // Fail open: log for ops, return the original bytes so publish still succeeds.
        console.error('[c2pa-sign] signing failed, publishing unsigned bytes:', err);
        return { signed: false, bytes, skippedReason: 'error' };
    }
}

function signerLabel(): string {
    return process.env.C2PA_SIGNER_LABEL || `${CREATOR_SYSTEM} content signer`;
}

function getR2Client(): S3Client {
    return new S3Client({
        region: 'auto',
        endpoint: R2_ENDPOINT,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID!, secretAccessKey: R2_SECRET_ACCESS_KEY! },
    });
}

async function streamToBytes(body: any): Promise<Uint8Array> {
    if (!body) return new Uint8Array();
    if (typeof body.transformToByteArray === 'function') return body.transformToByteArray();
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
    return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Orchestrates in-place signing of a stored feature/inline image: fetch bytes from R2, embed the
 * manifest, write the signed bytes back to the SAME storage key, and return the summary for
 * content_provenance. Returns null (no-op) when signing is disabled, R2 is unconfigured, the asset
 * has no R2 key, or anything fails — callers stamp the summary only when it is non-null.
 *
 * Writing back to the same key is safe because published_payload references the assetId (not a URL),
 * so widget-api resolves a fresh presigned URL at read time — see blog-publish.ts.
 */
export async function signStoredImageAsset(
    db: any,
    opts: { assetId: number; organisationId: number; claims: ManifestClaims },
): Promise<ManifestSummary | null> {
    if (!isC2paSigningEnabled() || !r2Configured) return null;

    const [asset] = await db
        .select({ storageKey: contentAssets.storageKey, mimeType: contentAssets.mimeType })
        .from(contentAssets)
        .where(and(eq(contentAssets.id, opts.assetId), eq(contentAssets.organisationId, opts.organisationId)))
        .limit(1);
    if (!asset?.storageKey) return null;

    const mimeType = asset.mimeType || 'image/jpeg';
    try {
        const s3 = getR2Client();
        const obj = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: asset.storageKey }));
        const original = await streamToBytes(obj.Body);

        const result = await signImageBytes(original, mimeType, opts.claims);
        if (!result.signed || !result.manifest) return null;

        await s3.send(new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: asset.storageKey,
            Body: Buffer.from(result.bytes),
            ContentType: mimeType,
        }));
        return result.manifest;
    } catch (err) {
        console.error('[c2pa-sign] signStoredImageAsset failed:', err);
        return null;
    }
}
