// src/utils/swan-index/profile.ts
// The Swan Index — author profiles and the publication's admission rules.
//
// Keeping these out of the adapter is deliberate: the adapter is a transport, and every rule here
// (handle allocation, the monthly cap) has to hold for the editor tools and any future bulk import
// too, not only for the one code path that happens to publish.

import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { getDb } from '../../../db/client';
import { swanIndexProfiles, swanIndexPosts, organisations } from '../../../db/schema';

type Db = ReturnType<typeof getDb>;

/**
 * Reserved handles. These are all real or plausible top-level paths on the publication, and a
 * profile that claimed one would shadow it — /@about beats /about to nothing, but /latest and
 * /section are routes, and an author holding one would take the page down for everybody.
 */
export const RESERVED_HANDLES = new Set([
    'about', 'admin', 'api', 'author', 'authors', 'contact', 'editor', 'feed', 'featured',
    'help', 'index', 'latest', 'legal', 'login', 'privacy', 'rss', 'search', 'section',
    'sections', 'sitemap', 'staff', 'swanindex', 'terms', 'the-swan-index', 'www',
]);

/** Mirrors the DB CHECK exactly: lowercase alphanumeric + hyphen, 3–30 chars, no edge hyphen. */
export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

/** Normalise any name into a candidate handle. Returns '' when nothing usable survives. */
export function slugifyHandle(input: string): string {
    const base = String(input || '')
        .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')  // strip accents (escaped: raw combining marks are invisible in source)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 30)
        .replace(/-+$/g, '');
    return HANDLE_RE.test(base) ? base : '';
}

/**
 * Allocate a free handle for a name, suffixing -2, -3 … on collision.
 *
 * The suffix is appended to a base TRIMMED to fit, not to the full 30 characters — otherwise a long
 * organisation name produces a candidate that fails the length CHECK and the loop never terminates.
 */
export async function allocateHandle(db: Db, desired: string): Promise<string> {
    let base = slugifyHandle(desired) || 'contributor';
    if (RESERVED_HANDLES.has(base)) base = `${base}-co`.slice(0, 30).replace(/-+$/g, '');

    for (let n = 1; n <= 200; n++) {
        const suffix = n === 1 ? '' : `-${n}`;
        // Named `tryHandle`, not `candidate`: tests/raw-sql-date-params.test.ts flags any bare
        // identifier inside a sql`` template whose name looks like a Date, and "candi-date-" trips
        // that heuristic. The lint is deliberately crude because the precise version missed six real
        // bugs, so the local gets the different name rather than the net getting a wider hole.
        const tryHandle = `${base.slice(0, 30 - suffix.length).replace(/-+$/g, '')}${suffix}`;
        if (!HANDLE_RE.test(tryHandle) || RESERVED_HANDLES.has(tryHandle)) continue;
        const [taken] = await db
            .select({ id: swanIndexProfiles.id })
            .from(swanIndexProfiles)
            .where(sql`lower(${swanIndexProfiles.handle}) = ${tryHandle}`)
            .limit(1);
        if (!taken) return tryHandle;
    }
    // 200 collisions on one base name is not a naming problem, it is a bug or an attack.
    throw new Error('Could not allocate a Swan Index handle.');
}

export interface SwanProfileRow {
    id: number;
    organisationId: number;
    handle: string;
    displayName: string;
    roleTitle: string | null;
    companyName: string | null;
    bio: string | null;
    siteUrl: string | null;
    status: string;
    frontPageTier: boolean;
    monthlyPostCap: number | null;
}

const PROFILE_COLUMNS = {
    id: swanIndexProfiles.id,
    organisationId: swanIndexProfiles.organisationId,
    handle: swanIndexProfiles.handle,
    displayName: swanIndexProfiles.displayName,
    roleTitle: swanIndexProfiles.roleTitle,
    companyName: swanIndexProfiles.companyName,
    bio: swanIndexProfiles.bio,
    siteUrl: swanIndexProfiles.siteUrl,
    status: swanIndexProfiles.status,
    frontPageTier: swanIndexProfiles.frontPageTier,
    monthlyPostCap: swanIndexProfiles.monthlyPostCap,
};

export async function getProfileByOrg(db: Db, organisationId: number): Promise<SwanProfileRow | null> {
    const [row] = await db.select(PROFILE_COLUMNS).from(swanIndexProfiles)
        .where(eq(swanIndexProfiles.organisationId, organisationId)).limit(1);
    return row ?? null;
}

export async function getProfileByHandle(db: Db, handle: string): Promise<SwanProfileRow | null> {
    const [row] = await db.select(PROFILE_COLUMNS).from(swanIndexProfiles)
        .where(sql`lower(${swanIndexProfiles.handle}) = ${handle.toLowerCase()}`).limit(1);
    return row ?? null;
}

/**
 * The workspace's profile, created from the organisation record if it has none.
 *
 * Auto-creating is what makes the destination connect like every other one — the author ticks
 * "The Swan Index" and there is a masthead identity waiting, rather than a second form to fill in
 * before anything can publish. Everything here is editable afterwards.
 */
export async function ensureProfile(
    db: Db,
    organisationId: number,
    opts: { userId?: number | null; displayName?: string | null; siteUrl?: string | null } = {},
): Promise<SwanProfileRow> {
    const existing = await getProfileByOrg(db, organisationId);
    if (existing) return existing;

    const [org] = await db
        .select({ name: organisations.name, websiteUrl: organisations.websiteUrl })
        .from(organisations)
        .where(eq(organisations.id, organisationId))
        .limit(1);

    const displayName = (opts.displayName || org?.name || '').trim() || `Workspace ${organisationId}`;
    const handle = await allocateHandle(db, displayName);

    await db.insert(swanIndexProfiles).values({
        organisationId,
        createdBy: opts.userId ?? null,
        handle,
        displayName,
        companyName: org?.name ?? null,
        siteUrl: opts.siteUrl || org?.websiteUrl || null,
    });

    const created = await getProfileByOrg(db, organisationId);
    if (!created) throw new Error('Swan Index profile could not be created.');
    return created;
}

/** First day of the current calendar month, UTC. */
export function monthStart(now = new Date()): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Pieces this profile has put live in the current calendar month.
 *
 * Counts by `submittedAt`, not `liveAt`: a piece sitting in the editor queue has already consumed
 * a slot, and counting the other way would let a workspace queue up fifty submissions in a day and
 * only discover the cap when an editor started approving them. 'rejected' and 'withdrawn' are
 * excluded — a declined piece should not cost the author a slot.
 */
export async function monthlyPostCount(db: Db, profileId: number, now = new Date()): Promise<number> {
    const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(swanIndexPosts)
        .where(and(
            eq(swanIndexPosts.profileId, profileId),
            inArray(swanIndexPosts.status, ['pending', 'live', 'featured']),
            gte(swanIndexPosts.submittedAt, monthStart(now)),
        ));
    return row?.n ?? 0;
}

export interface AdmissionResult { ok: boolean; error?: string }

/**
 * May this profile submit one more piece right now?
 *
 * `existing` is true when the submission is an UPDATE of a piece already in the index — a re-publish
 * after an edit must not be refused for the cap it is already counted against, which would make the
 * adapter non-idempotent the moment an author hit their limit.
 */
export async function checkAdmission(
    db: Db,
    profile: SwanProfileRow,
    opts: { existing: boolean; now?: Date } = { existing: false },
): Promise<AdmissionResult> {
    if (profile.status === 'suspended') return { ok: false, error: 'This Swan Index profile is suspended.' };
    if (profile.status === 'withdrawn') return { ok: false, error: 'This Swan Index profile has been withdrawn.' };
    if (opts.existing || profile.monthlyPostCap == null) return { ok: true };

    const used = await monthlyPostCount(db, profile.id, opts.now);
    if (used >= profile.monthlyPostCap) {
        return {
            ok: false,
            error: `Swan Index monthly limit reached (${profile.monthlyPostCap} pieces). This post stays on your own blog; it will not be syndicated this month.`,
        };
    }
    return { ok: true };
}
