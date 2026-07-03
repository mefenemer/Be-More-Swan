// src/utils/issue-reports.ts
// Shared constants/helpers for the testing-phase "Report an Issue" feature.

import { eq, or } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { users, notifications, issueReports, issueReportMessages } from '../../db/schema';
import { sendEmail } from './email';
import { resolveBaseUrl } from './base-url';
import { isEmailAllowedForUser } from './notification-email-gate';

type Db = ReturnType<typeof getDb>;

// Canonical lifecycle states. KEEP IN SYNC with db/issue-reports.sql status CHECK.
export const ISSUE_STATUSES = [
    'reported',
    'fix_in_progress',
    'fixed_ready_to_test',
    'more_info_required',
    'closed',
    'roadmap',
] as const;

export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export function isIssueStatus(v: unknown): v is IssueStatus {
    return typeof v === 'string' && (ISSUE_STATUSES as readonly string[]).includes(v);
}

// Human-readable labels — match the wording the admin owner sees in the portal.
export const ISSUE_STATUS_LABEL: Record<IssueStatus, string> = {
    reported: 'Reported',
    fix_in_progress: 'Fix In Progress',
    fixed_ready_to_test: 'Fixed & Ready to Test',
    more_info_required: 'More Info Required',
    closed: 'Closed',
    roadmap: 'On Roadmap',
};

// Screenshots are stored inline as base64 data URLs. Cap the decoded payload so a stray
// huge upload can't blow up the row / the admin notification email.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

export const ALLOWED_IMAGE_MIME = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
]);

/**
 * Validate an inbound `data:` image URL. Returns the mime type on success or an error
 * string. Keeps the function handlers thin and the rules in one place.
 */
export function validateImageDataUrl(dataUrl: string): { mime: string } | { error: string } {
    const m = /^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
    if (!m) return { error: 'Image must be a base64 data URL.' };
    const mime = m[1].toLowerCase();
    if (!ALLOWED_IMAGE_MIME.has(mime)) return { error: `Unsupported image type: ${mime}` };
    // base64 length → decoded byte estimate.
    const approxBytes = Math.floor((m[2].length * 3) / 4);
    if (approxBytes > MAX_IMAGE_BYTES) return { error: 'Image exceeds the 5 MB limit.' };
    return { mime };
}

export interface AdminRecipient { id: number; email: string; firstName: string | null }

/**
 * The "admin portal owner(s)" to email when a new issue is recorded. Prefers the
 * ISSUE_REPORT_NOTIFY_EMAIL env override; otherwise every super_admin / admin account.
 */
export async function getAdminRecipients(db: Db): Promise<AdminRecipient[]> {
    const override = process.env.ISSUE_REPORT_NOTIFY_EMAIL;
    if (override) {
        return override.split(',').map((e, i) => ({ id: -1 - i, email: e.trim(), firstName: null })).filter((r) => r.email);
    }
    const rows = await db
        .select({ id: users.id, email: users.email, firstName: users.firstName })
        .from(users)
        .where(or(eq(users.role, 'super_admin'), eq(users.role, 'admin')));
    return rows;
}

/**
 * Notify the reporting user that their issue changed state — an in-app notification
 * plus an email with a link back into their workspace. Shared by the admin triage
 * endpoint and the AI auto-fix handoff endpoint so the messaging stays consistent.
 *
 * Best-effort: never throws; each side-channel failure is logged and swallowed so a
 * notification problem can't fail the status update that triggered it.
 */
export async function notifyIssueUser(
    db: Db,
    opts: {
        userId: number;
        issueId: number;
        status: IssueStatus;
        adminMessage?: string;
        headers?: Record<string, string | undefined>;
    },
): Promise<void> {
    const { userId, issueId, status, adminMessage = '' } = opts;
    const label = ISSUE_STATUS_LABEL[status];

    // Status-specific call to action.
    const cta =
        status === 'fixed_ready_to_test' ? 'Please re-test and confirm the fix worked.' :
        status === 'more_info_required'  ? 'The team needs more information to proceed.' :
        status === 'fix_in_progress'     ? 'A fix is now in progress.' :
        status === 'roadmap'             ? "We've added your request to our feature roadmap, where it'll be prioritised and delivered as soon as we can." :
        status === 'closed'              ? 'This issue has been closed.' :
        'Your reported issue has been updated.';

    const title =
        status === 'fixed_ready_to_test' ? `✅ Issue #${issueId} fixed — ready to test` :
        status === 'more_info_required'  ? `❓ Issue #${issueId} — more info needed` :
        status === 'roadmap'             ? `🗺️ Issue #${issueId} added to our roadmap` :
        `🔧 Issue #${issueId} updated: ${label}`;

    const messageLine = adminMessage ? ` — “${adminMessage}”` : '';

    // In-app notification (canonical table). type 'issue_update' defaults to the
    // 'informational' category until/unless added to the categorization map.
    await db.insert(notifications).values({
        userId,
        type: 'issue_update',
        title,
        message: `${cta}${messageLine}`,
        metadata: { issueId, status },
    }).catch((e) => console.error('[issue-reports] notification insert failed:', e?.message || e));

    // Email the user too — subject to their notification preferences.
    if (!(await isEmailAllowedForUser(userId, 'issue_update'))) return;
    const [u] = await db.select({ email: users.email, firstName: users.firstName })
        .from(users).where(eq(users.id, userId)).limit(1);
    if (!u?.email) return;

    const base = resolveBaseUrl(opts.headers || {}) || process.env.BASE_URL || 'https://bemoreswan.com';
    const link = `${base}/workspace.html?issue=${issueId}`;
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = `
        <p>Hi ${esc(u.firstName || 'there')},</p>
        <p>There's an update on the issue you reported (#${issueId}).</p>
        <p><strong>Status:</strong> ${esc(label)}</p>
        <p>${esc(cta)}</p>
        ${adminMessage ? `<blockquote style="border-left:3px solid #e5e7eb;margin:0;padding:8px 16px;color:#374151;white-space:pre-wrap;">${esc(adminMessage)}</blockquote>` : ''}
        <p style="margin-top:24px;">
          <a href="${link}" style="background:#059669;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
            View in your workspace →
          </a>
        </p>
        <p style="color:#6b7280;font-size:13px;">Thank you for helping us test Be More Swan.</p>`;

    await sendEmail({ to: u.email, subject: title, html })
        .catch((e) => console.error('[issue-reports] email failed:', e?.message || e));
}

/**
 * Advance an AI-handed-off issue to "Fixed & Ready to Test" — but only once BOTH gates
 * are satisfied: the fix PR is merged to staging (dev_merge_status='merged') AND any
 * proposed migration has been applied (dev_sql_status is not 'pending'). When it advances,
 * it threads a note and notifies the reporter. No-op (returns false) if a gate is unmet or
 * the issue is already past testing. Shared by the merge-result and run-SQL endpoints so
 * whichever finishes last triggers the single advance + reporter notification.
 */
export async function maybeAdvanceToReadyToTest(
    db: Db,
    issueId: number,
    headers?: Record<string, string | undefined>,
): Promise<boolean> {
    const [row] = await db.select().from(issueReports).where(eq(issueReports.id, issueId)).limit(1);
    if (!row) return false;
    if (row.status === 'fixed_ready_to_test' || row.status === 'closed') return false;
    if (row.devMergeStatus !== 'merged') return false;     // not merged to staging yet
    if (row.devSqlStatus === 'pending') return false;       // migration still outstanding

    await db.update(issueReports)
        .set({ status: 'fixed_ready_to_test', updatedAt: new Date() })
        .where(eq(issueReports.id, issueId));

    await db.insert(issueReportMessages).values({
        issueId,
        authorType: 'admin',
        authorId: null,
        body: '✅ Merged to staging — the fix is live on staging and ready to test.',
        status: 'fixed_ready_to_test',
    });

    await notifyIssueUser(db, { userId: row.userId, issueId, status: 'fixed_ready_to_test', headers })
        .catch((e) => console.error('[issue-reports] ready-to-test notify failed:', e?.message || e));
    return true;
}
