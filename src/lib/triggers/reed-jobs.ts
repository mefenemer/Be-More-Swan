// src/lib/triggers/reed-jobs.ts
// Buying-trigger source 2 (docs/buying-triggers-plan.md §1 row 4, §5 Phase 5): local businesses that are
// HIRING, from the Reed Jobseeker API. ADMIN ONLY for now (owner 2026-11-17: measure first, like Phase 1;
// the customer "find" machinery is Phase 3, behind the 15 Dec stop/go reading).
//
// ── Terms (decision 6) ───────────────────────────────────────────────────────────────────────────
// The owner registered with Reed and confirmed on 2026-11-17 that this use may proceed. What we promised
// Reed (docs/reed-api-terms-email.md), enforced here:
//   - read only employer name, job title, location, date posted and the job's link (NEVER the job
//     description, salary or anything about job seekers): `toEvent` copies only those fields;
//   - credit Reed and link back to the job on reed.co.uk wherever a result is shown;
//   - keep it 90 days (trigger-engine.ts EVENT_KEEP_DAYS), stay gentle (one request at a time, a gap);
//   - leave recruitment agencies out (postedByDirectEmployer=true, plus a name check).
//
// Key: REED_API_KEY (Basic auth, key as user, empty password). Off switch: TRIGGER_SOURCE_REED_JOBS=off.

import type { TriggerEvent, TriggerLabel } from './types';

const API = 'https://www.reed.co.uk/api/1.0/search';
const TIMEOUT_MS = 20_000;
export const REED_SOURCE = 'reed_jobs' as const;
export const REED_PAGE_SIZE = 100;
export const REED_MAX_PAGES = 3;
export const REED_GAP_MS = 700;
/** A job first seen now but posted longer ago than this is an old advert surfacing, not news. */
export const REED_FRESH_DAYS = 3;

export function isReedConfigured(): boolean {
    return !!String(process.env.REED_API_KEY ?? '').trim();
}
export function isReedSourceEnabled(): boolean {
    return String(process.env.TRIGGER_SOURCE_REED_JOBS ?? '').toLowerCase() !== 'off';
}

/**
 * What we read for the measurement: roles that small businesses hire for and that a customer of Be More
 * Swan sells around (payroll, HR, training, uniforms, insurance, recruitment, fit-out, signs…), in the big
 * UK cities. Admin only, so the list is in code; Phase 3 replaces it with each customer's own trade + area.
 */
export const REED_ROLES = ['chef', 'bookkeeper', 'receptionist', 'office manager', 'sales executive', 'marketing executive', 'van driver', 'hairdresser'] as const;
export const REED_LOCATIONS = ['London', 'Birmingham', 'Manchester', 'Leeds', 'Bristol', 'Glasgow', 'Newcastle upon Tyne', 'Nottingham'] as const;
export const REED_DISTANCE_MILES = 10;

export interface ReedQuery { role: string; location: string }
export function reedQueries(): ReedQuery[] {
    const out: ReedQuery[] = [];
    for (const location of REED_LOCATIONS) for (const role of REED_ROLES) out.push({ role, location });
    return out;
}
export const queryKey = (q: ReedQuery) => `${q.role}@${q.location}`;

/** One result as Reed returns it (only the fields we are allowed to keep are declared). */
export interface ReedJob {
    jobId: number;
    employerId?: number | null;
    employerName?: string | null;
    jobTitle?: string | null;
    locationName?: string | null;
    date?: string | null;
    jobUrl?: string | null;
}

// ── Pure helpers (tests/reed-jobs.test.ts) ──────────────────────────────────────────────────────

/** Recruitment agencies that slip past postedByDirectEmployer. Narrow on purpose. */
const AGENCY_RE = /\b(recruit\w*|staffing|personnel|resourcing|talent|appointments|employment agency|headhunt\w*|search (?:&|and) selection)\b/i;
export function looksLikeAgency(employerName: string | null | undefined): boolean {
    return AGENCY_RE.test(String(employerName || ''));
}

/** "16/11/2026" → "2026-11-16". Null when unreadable. */
export function reedDate(raw: string | null | undefined): string | null {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(raw || '').trim());
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** A full UK postcode in Reed's location field ("LS196LP"), or null (most say a town or county). */
export function reedPostcode(locationName: string | null | undefined): string | null {
    const m = String(locationName || '').toUpperCase().replace(/\s+/g, '').match(/^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/);
    return m ? `${m[1]} ${m[2]}` : null;
}

export function roleCode(role: string): string {
    return role.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Is this posting fresh enough to be news (posted within REED_FRESH_DAYS of `today`)? */
export function isFreshPosting(postedOn: string | null, today: string): boolean {
    if (!postedOn) return false;
    const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${postedOn}T00:00:00Z`)) / 86_400_000;
    return age >= -1 && age <= REED_FRESH_DAYS;
}

/**
 * One new job → one trigger event. Only the fields Reed agreed we may keep: no description, no salary.
 * `employerJobsInRun` = how many of this employer's jobs this run saw (a rough "small employer" sign).
 */
export function reedToEvent(job: ReedJob, q: ReedQuery, seenOn: string, employerJobsInRun: number): TriggerEvent {
    const postedOn = reedDate(job.date);
    return {
        kind: 'hiring',
        source: REED_SOURCE,
        sourceEventId: String(job.jobId),
        country: 'GB',
        subjectType: 'reed_employer',
        subjectId: String(job.employerId ?? `name:${String(job.employerName || '').toLowerCase()}`),
        name: String(job.employerName || '').trim() || null,
        postcode: reedPostcode(job.locationName),
        area: q.location,
        tradeCodes: [roleCode(q.role)],
        occurredOn: postedOn && postedOn <= seenOn ? postedOn : seenOn,
        payload: {
            jobTitle: String(job.jobTitle || '').trim().slice(0, 200) || null,
            location: String(job.locationName || '').trim().slice(0, 120) || null,
            postedOn,
            url: typeof job.jobUrl === 'string' && job.jobUrl.startsWith('https://www.reed.co.uk/') ? job.jobUrl : `https://www.reed.co.uk/jobs/${job.jobId}`,
            role: q.role,
            employerJobsInRun,
        },
    };
}

/** Fixed wording: says where it is from and credits Reed. */
export function reedLabel(ev: Pick<TriggerEvent, 'occurredOn' | 'payload' | 'area'>): TriggerLabel {
    const title = typeof ev.payload?.jobTitle === 'string' && ev.payload.jobTitle ? ev.payload.jobTitle : 'staff';
    const where = typeof ev.payload?.location === 'string' && ev.payload.location ? ev.payload.location : (ev.area || 'the area');
    const d = new Date(`${ev.occurredOn}T12:00:00Z`);
    const when = Number.isNaN(d.getTime()) ? ev.occurredOn : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    return { text: `Hiring: ${title} in ${where}, advertised on Reed (${when})`, direction: 'positive' };
}

// ── Network ──────────────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function getPage(q: ReedQuery, skip: number): Promise<{ results: ReedJob[]; total: number }> {
    const key = String(process.env.REED_API_KEY ?? '').trim();
    const params = new URLSearchParams({
        keywords: q.role, locationName: q.location, distanceFromLocation: String(REED_DISTANCE_MILES),
        postedByDirectEmployer: 'true', resultsToTake: String(REED_PAGE_SIZE), resultsToSkip: String(skip),
    });
    const waits = [3_000, 10_000];
    let lastErr: unknown;
    for (let attempt = 0; attempt <= waits.length; attempt++) {
        try {
            const res = await fetch(`${API}?${params}`, {
                headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`, accept: 'application/json', 'user-agent': 'BeMoreSwan-triggers/1.0' },
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (res.ok) {
                const j = await res.json() as { results?: ReedJob[]; totalResults?: number };
                return { results: Array.isArray(j.results) ? j.results.filter((r) => Number.isInteger(r?.jobId)) : [], total: Number(j.totalResults) || 0 };
            }
            await res.arrayBuffer().catch(() => null);
            lastErr = new Error(`HTTP ${res.status}`);
            if (res.status !== 429 && res.status < 500) break;
        } catch (err) {
            lastErr = err;
        }
        if (attempt < waits.length) await sleep(waits[attempt]);
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Every current direct-employer job for one role + place, up to REED_MAX_PAGES pages. Throws on failure. */
export async function fetchReedJobs(q: ReedQuery): Promise<ReedJob[]> {
    const out: ReedJob[] = [];
    for (let page = 0; page < REED_MAX_PAGES; page++) {
        const { results, total } = await getPage(q, page * REED_PAGE_SIZE);
        out.push(...results);
        if (results.length < REED_PAGE_SIZE || out.length >= total) break;
        await sleep(REED_GAP_MS);
    }
    return out;
}
