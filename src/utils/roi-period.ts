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

export type RoiPeriod = 'week' | 'month';

export function parseRoiPeriod(raw: string | undefined | null): RoiPeriod {
    return raw === 'month' ? 'month' : 'week';
}

/** Start of the current calendar week (Sunday 00:00) or month (1st 00:00), server-local time. */
export function roiPeriodStart(period: RoiPeriod, now: Date = new Date()): Date {
    if (period === 'week') {
        const start = new Date(now);
        start.setDate(now.getDate() - now.getDay()); // back to Sunday
        start.setHours(0, 0, 0, 0);
        return start;
    }
    return new Date(now.getFullYear(), now.getMonth(), 1);
}
