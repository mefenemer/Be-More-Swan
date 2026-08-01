// src/utils/roi-period.ts
// Single source of truth for the ROI reporting window, shared by roi-stats.ts
// (dashboard hero) and get-assistant-metrics.ts (assistant detail Impact & ROI)
// so the two views always aggregate over the same date range for a given period.
//
// Note the month-boundary quirk this guards against (issue: detail tab showed
// 1.5h while the dashboard showed 1.3h): early in a month, the calendar week
// (Sunday-start) reaches back into the previous month, so "this week" can
// legitimately exceed "this month". Comparing figures across the two periods
// is expected to differ — comparing within the same period must not.

export type RoiPeriod = 'week' | 'month' | 'all';

export function parseRoiPeriod(raw: string | undefined | null): RoiPeriod {
    if (raw === 'month') return 'month';
    if (raw === 'all') return 'all';
    return 'week';
}

/**
 * Start of the reporting window: current calendar week (Sunday 00:00), current
 * calendar month (1st 00:00) — both server-local — or the epoch for 'all'.
 *
 * 'all' exists because both calendar windows cliff-drop to zero the instant they
 * roll over: the ROI hero read 0 hours / £0 / 0 tasks on the morning of 1 August
 * despite a full month of real activity the previous day. A value-proof widget
 * that periodically claims you've saved nothing is worse than useless, so the
 * dashboard now defaults to the cumulative figure, which only ever goes up.
 */
export function roiPeriodStart(period: RoiPeriod, now: Date = new Date()): Date {
    if (period === 'all') return new Date(0);
    if (period === 'week') {
        const start = new Date(now);
        start.setDate(now.getDate() - now.getDay()); // back to Sunday
        start.setHours(0, 0, 0, 0);
        return start;
    }
    return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** Human label for the window, for tile sub-captions and modal subtitles. */
export function roiPeriodLabel(period: RoiPeriod): string {
    return period === 'all' ? 'all time' : period === 'week' ? 'this week' : 'this month';
}
