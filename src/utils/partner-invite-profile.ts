// src/utils/partner-invite-profile.ts
// A partner's own invite page (docs/partner-onboarding-plan.md §3.3, Phase 2): their photo, a headline
// and a short quote on /invite/<code>, above our standard offer. It's on OUR domain, so it is shown
// only after an admin approves it (owner decision D4) — see db/z-partner-invite-page.sql for the columns.
//
//   partner-hub.ts         → submit / withdraw (the partner, from their Partner page)
//   partner-assistant.ts   → propose_invite_page: a card that FILLS the same form (they still submit)
//   admin-partners.ts      → approve / ask for changes / take down (screen + Partner Ops chat cards)
//   invite-lookup.ts       → the approved profile, for invite.html
//   partner-photo.ts       → serves the photo: an approved photo to anyone, a pending one only to the
//                            partner and partner admins
//
// The text rules are pure; the R2 helpers never throw past the caller's catch.

import { randomBytes } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

export interface InviteProfile { headline: string; quote: string; photoKey: string | null; submittedAt: string }

export const HEADLINE_MAX = 90;
export const QUOTE_MAX = 280;
export const PHOTO_MAX_BYTES = 400 * 1024;   // the page resizes to 480px JPEG first, so this is generous
export const PHOTO_PREFIX = 'partner-photos/';

// A link or handle on our page would send our visitors somewhere else, or look like an endorsement of it.
const LINK_RE = /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|co\.uk|uk|net|org|io|ai|app|me|us)\b|@[a-z0-9_]{2,}/i;
// Words that would make the page look like it's from us, or promise what we can't back.
const CLAIM_RE = /\b(official|guarantee[ds]?|risk[- ]free|100%|get rich|passive income)\b/i;

/** Tidy and check what the partner wrote. Errors are written for the partner. */
export function validateInviteText(raw: { headline?: unknown; quote?: unknown }):
    { ok: true; headline: string; quote: string } | { ok: false; error: string } {
    const tidy = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '').slice(0, max + 1);
    const headline = tidy(raw.headline, HEADLINE_MAX);
    const quote = tidy(raw.quote, QUOTE_MAX);
    if (headline.length < 4) return { ok: false, error: 'Please write a headline (a few words is plenty).' };
    if (headline.length > HEADLINE_MAX) return { ok: false, error: `Please keep the headline to ${HEADLINE_MAX} characters.` };
    if (quote.length > QUOTE_MAX) return { ok: false, error: `Please keep your words to ${QUOTE_MAX} characters.` };
    if (LINK_RE.test(headline) || LINK_RE.test(quote)) return { ok: false, error: 'Please leave out links, web addresses and @handles — your invite link is the page itself.' };
    if (CLAIM_RE.test(headline) || CLAIM_RE.test(quote)) return { ok: false, error: 'Please leave out words like “official”, “guaranteed” or income promises — the Partner Terms (5.2) ask for honest, accurate words.' };
    return { ok: true, headline, quote };
}

/** A JPEG the page made (it re-encodes every photo through a canvas). Anything else is refused. */
export function checkJpeg(base64: unknown): { ok: true; bytes: Buffer } | { ok: false; error: string } {
    if (typeof base64 !== 'string' || !base64) return { ok: false, error: 'No photo was received.' };
    const b64 = base64.replace(/^data:image\/jpeg;base64,/, '');
    if (!/^[A-Za-z0-9+/=]+$/.test(b64)) return { ok: false, error: 'That photo could not be read. Please choose it again.' };
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length > PHOTO_MAX_BYTES) return { ok: false, error: 'That photo is too large. Please choose a smaller one.' };
    if (bytes.length < 200 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return { ok: false, error: 'That photo could not be read. Please choose a JPEG or PNG photo.' };
    return { ok: true, bytes };
}

export function newPhotoKey(partnerId: number): string {
    return `${PHOTO_PREFIX}${partnerId}/${randomBytes(12).toString('hex')}.jpg`;
}

/** A key belongs to THIS partner and has our shape — never trust a key from a request. */
export function isOwnPhotoKey(partnerId: number, key: unknown): key is string {
    return typeof key === 'string' && new RegExp(`^${PHOTO_PREFIX}${partnerId}/[a-f0-9]{24}\\.jpg$`).test(key);
}

/** The public URL for a photo key (partner-photo.ts decides who may see it). */
export function photoUrl(partnerId: number, key: string | null | undefined): string | null {
    if (!key) return null;
    return `/.netlify/functions/partner-photo?p=${partnerId}&k=${encodeURIComponent(key.split('/').pop() || '')}`;
}

/** Waiting for review, sent back, live, or nothing yet — for the Partner page and the admin screen. */
export function inviteProfileState(row: { inviteProfile: InviteProfile | null; inviteProfilePending: InviteProfile | null; inviteProfileNote: string | null }):
    'none' | 'waiting' | 'changes_requested' | 'live' {
    if (row.inviteProfilePending) return row.inviteProfileNote ? 'changes_requested' : 'waiting';
    return row.inviteProfile ? 'live' : 'none';
}

/** A partner's invite page for the admin screen and the Partner Ops chat. */
export function invitePageView(r: Record<string, any>) {
    const live = r.invite_profile as InviteProfile | null;
    const pending = r.invite_profile_pending as InviteProfile | null;
    const view = (x: InviteProfile | null) => x ? { headline: x.headline, quote: x.quote, photoUrl: photoUrl(r.id, x.photoKey), submittedAt: x.submittedAt } : null;
    return {
        state: inviteProfileState({ inviteProfile: live, inviteProfilePending: pending, inviteProfileNote: r.invite_profile_note ?? null }),
        live: view(live), pending: view(pending), note: r.invite_profile_note ?? null, reviewedAt: r.invite_profile_reviewed_at ?? null,
    };
}


// ── R2 ─────────────────────────────────────────────────────────────────────────────────────────

function r2(): { client: S3Client; bucket: string } | null {
    const { R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = process.env;
    if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) return null;
    return {
        client: new S3Client({ region: 'auto', endpoint: R2_ENDPOINT, credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }, requestChecksumCalculation: 'WHEN_REQUIRED' }),
        bucket: R2_BUCKET_NAME,
    };
}

export async function putPhoto(key: string, bytes: Buffer): Promise<boolean> {
    const s = r2();
    if (!s) return false;
    await s.client.send(new PutObjectCommand({ Bucket: s.bucket, Key: key, Body: bytes, ContentType: 'image/jpeg' }));
    return true;
}

export async function getPhoto(key: string): Promise<Buffer | null> {
    const s = r2();
    if (!s) return null;
    const obj = await s.client.send(new GetObjectCommand({ Bucket: s.bucket, Key: key }));
    return obj.Body ? Buffer.from(await obj.Body.transformToByteArray()) : null;
}

/** Best-effort: a photo nobody points at any more. Never throws. */
export async function deletePhoto(key: string | null | undefined): Promise<void> {
    if (!key || !key.startsWith(PHOTO_PREFIX)) return;
    const s = r2();
    if (!s) return;
    await s.client.send(new DeleteObjectCommand({ Bucket: s.bucket, Key: key }))
        .catch((err) => console.error('[partner-invite-profile] photo delete failed (non-blocking):', err));
}

/** Keys a profile change leaves unused: the old ones not kept by either remaining profile. */
export function orphanedKeys(before: Array<string | null | undefined>, after: Array<string | null | undefined>): string[] {
    const keep = new Set(after.filter(Boolean));
    return [...new Set(before.filter((k): k is string => !!k && !keep.has(k)))];
}
