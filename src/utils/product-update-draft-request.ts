// src/utils/product-update-draft-request.ts
// "Draft this week's email now" — a request the admin raises on the What's New page and the Mac picks up.
//
// Why a request and not a job: the draft is written by a Claude task on the founder's Mac, because the
// screenshots come from a signed-in browser there. The website cannot start that task. So the button
// records "a draft is wanted", and the scheduled Mac task polls for it (upload-draft.ts --pending),
// claims it, does the full weekly run, and reports how it ended. Nothing here ever sends an email to a
// customer — the draft lands as "Waiting for review" exactly like the weekly one.
//
// Stored as ONE platform_config row (no migration): only one request can be outstanding at a time.
// Pure — the transitions are tested without a database (tests/product-update-draft-request.test.ts).

export type DraftRequestStatus = 'pending' | 'working' | 'done';
export type DraftRequestOutcome = 'uploaded' | 'nothing' | 'failed' | 'waiting_for_review';

export interface DraftRequest {
    status: DraftRequestStatus;
    requestedAt: string;
    requestedBy: string | null;
    pickedUpAt?: string | null;
    finishedAt?: string | null;
    outcome?: DraftRequestOutcome | null;
    /** What the Mac reported — shown to the admin. Plain text, capped. */
    note?: string | null;
}

/** A claim older than this is treated as abandoned (the Mac slept, the run died) and offered again. */
export const STALE_CLAIM_MS = 3 * 60 * 60 * 1000;
export const OUTCOMES: readonly DraftRequestOutcome[] = ['uploaded', 'nothing', 'failed', 'waiting_for_review'];

export function parseDraftRequest(raw: unknown): DraftRequest | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (r.status !== 'pending' && r.status !== 'working' && r.status !== 'done') return null;
    if (typeof r.requestedAt !== 'string') return null;
    return r as unknown as DraftRequest;
}

/** Is the request still outstanding (pending, or claimed but not yet finished)? */
export function isOutstanding(req: DraftRequest | null, _now?: Date): boolean {
    if (!req) return false;
    if (req.status === 'pending') return true;
    // A stale claim is still outstanding: hasWork() offers it to the Mac again.
    return req.status === 'working';
}

export function isStaleClaim(req: DraftRequest, now: Date): boolean {
    return req.status === 'working' && !!req.pickedUpAt && now.getTime() - new Date(req.pickedUpAt).getTime() > STALE_CLAIM_MS;
}

/**
 * The admin presses the button. Refused while a draft already waits for review (the run would stop
 * at its own first check) or while a request is already outstanding.
 */
export function raiseRequest(current: DraftRequest | null, opts: { by: string | null; draftWaiting: boolean; now: Date }):
    { ok: true; next: DraftRequest } | { ok: false; error: string } {
    if (opts.draftWaiting) return { ok: false, error: 'A draft is already waiting for review. Approve or discard it first.' };
    if (current && isOutstanding(current, opts.now) && !isStaleClaim(current, opts.now)) {
        return { ok: false, error: current.status === 'working'
            ? 'Your Mac is drafting it now. It will appear here when it is ready.'
            : 'A draft has already been asked for. Your Mac picks it up next time it checks.' };
    }
    return { ok: true, next: { status: 'pending', requestedAt: opts.now.toISOString(), requestedBy: opts.by, pickedUpAt: null, finishedAt: null, outcome: null, note: null } };
}

/** The Mac asks whether there is work. Pending, or a claim abandoned long enough ago to retry. */
export function hasWork(req: DraftRequest | null, now: Date): boolean {
    if (!req) return false;
    return req.status === 'pending' || isStaleClaim(req, now);
}

/** The Mac claims it, so a second run started meanwhile does not draft it twice. */
export function claimRequest(req: DraftRequest | null, now: Date): { ok: true; next: DraftRequest } | { ok: false; error: string } {
    if (!hasWork(req, now)) return { ok: false, error: 'Nothing to claim.' };
    return { ok: true, next: { ...req!, status: 'working', pickedUpAt: now.toISOString() } };
}

/** The run ends — however it ended. A finished or absent request is left alone. */
export function finishRequest(req: DraftRequest | null, outcome: DraftRequestOutcome, note: unknown, now: Date): DraftRequest | null {
    if (!req || req.status === 'done') return null;
    const text = typeof note === 'string' ? note.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
    return { ...req, status: 'done', finishedAt: now.toISOString(), outcome, note: text || null };
}

/** One line for the admin page. */
export function describeRequest(req: DraftRequest | null, now: Date): string | null {
    if (!req) return null;
    const when = (iso?: string | null) => iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }) : '';
    if (req.status === 'pending') return `Draft asked for ${when(req.requestedAt)} — waiting for your Mac to pick it up.`;
    if (req.status === 'working') return isStaleClaim(req, now)
        ? `Your Mac started drafting ${when(req.pickedUpAt)} but has not finished — it will try again next time it checks.`
        : `Your Mac is drafting it now (started ${when(req.pickedUpAt)}).`;
    const tail = req.note ? ` ${req.note}` : '';
    switch (req.outcome) {
        case 'uploaded': return `Last draft asked for ${when(req.requestedAt)} arrived ${when(req.finishedAt)}.${tail}`;
        case 'nothing': return `Checked ${when(req.finishedAt)}: nothing customer-facing to write about since the last email.${tail}`;
        case 'waiting_for_review': return `Checked ${when(req.finishedAt)}: a draft was already waiting for review.${tail}`;
        case 'failed': return `The draft asked for ${when(req.requestedAt)} could not be made.${tail}`;
        default: return null;
    }
}
