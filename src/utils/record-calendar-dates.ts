// src/utils/record-calendar-dates.ts
// The date a Data Hub record belongs on, for the assistant Calendar tab.
//
// Most records assistants publish nothing and schedule nothing, so their calendar showed only
// completed task runs — the AR Clerk's calendar never showed a single invoice, the Minute Taker's
// never a single meeting, though both records carry a date that is the whole point of them. This
// gives each such record ONE honest date, or none:
//
//   invoice → its due date: a due date the record states (an import's "due date" column), else the
//             day it was recorded MINUS the days-past-due it was recorded with — an exact
//             subtraction, not a guess, and flagged `derived` so the chip says so. Neither present
//             → no date. Never "today" for an invoice we cannot date: a due date we invented would
//             put a chase on the wrong day.
//   meeting → the meeting's own time when the record states one (imports carry "date"), else the
//             day the notes were taken, labelled as that — never presented as the meeting time.
//
// Other record types return null: a ticket or an enrichment has no date beyond "when it was made",
// which the Activity tab already shows.

export type RecordCalendarKind = 'invoice_due' | 'meeting' | 'notes_taken';

export interface RecordCalendarDate {
    at: Date;
    kind: RecordCalendarKind;
    /** The date was computed (recorded day − days past due), not stated on the record. */
    derived: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function firstDate(data: Record<string, unknown>, keys: string[]): Date | null {
    for (const k of keys) {
        const v = data[k];
        if (typeof v !== 'string' && typeof v !== 'number') continue;
        const d = new Date(v);
        if (!Number.isNaN(d.getTime()) && d.getFullYear() > 2000 && d.getFullYear() < 2100) return d;
    }
    return null;
}

/** The invoice inside a record: imports store it flat, chat stores { invoices: [inv] }. */
function invoiceOf(data: Record<string, unknown>): Record<string, unknown> {
    const list = Array.isArray(data.invoices) ? data.invoices : null;
    return list && list[0] && typeof list[0] === 'object' ? { ...data, ...(list[0] as Record<string, unknown>) } : data;
}

export function recordCalendarDate(recordType: string, rawData: unknown, createdAt: Date | string): RecordCalendarDate | null {
    const data = rawData && typeof rawData === 'object' ? (rawData as Record<string, unknown>) : {};
    const created = new Date(createdAt);
    if (recordType === 'invoice') {
        const inv = invoiceOf(data);
        const stated = firstDate(inv, ['dueDate', 'due_date', 'due date', 'Due date', 'Due Date']);
        if (stated) return { at: stated, kind: 'invoice_due', derived: false };
        const days = Number(inv.daysPastDue ?? inv['days overdue'] ?? inv.daysOverdue);
        if (Number.isFinite(days) && days >= 0 && !Number.isNaN(created.getTime())) {
            return { at: new Date(created.getTime() - Math.round(days) * DAY_MS), kind: 'invoice_due', derived: true };
        }
        return null;
    }
    if (recordType === 'meeting') {
        const stated = firstDate(data, ['meetingTime', 'startTime', 'date', 'Date', 'when']);
        if (stated) return { at: stated, kind: 'meeting', derived: false };
        return Number.isNaN(created.getTime()) ? null : { at: created, kind: 'notes_taken', derived: false };
    }
    return null;
}

/** Record types that have a calendar date at all. */
export const DATED_RECORD_TYPES = ['invoice', 'meeting'] as const;
