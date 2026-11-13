// src/utils/issue-reports.ts
// Shared constants/helpers for the testing-phase "Report an Issue" feature.

import { eq, or, and, lt, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { users, issueReports, issueReportMessages } from '../../db/schema';
import { createNotification } from './notify';
import { sendEmail } from './email';
import { resolveBaseUrl } from './base-url';
import { isEmailAllowedForUser } from './notification-email-gate';

import { adminInbox } from './admin-inbox';
import { fixLiveColumnsReady } from './issue-fix-live';
type Db = ReturnType<typeof getDb>;

// Canonical lifecycle states. KEEP IN SYNC with db/issue-reports.sql status CHECK.
export const ISSUE_STATUSES = [
    'reported',
    'investigating',   // db/z-issue-investigating.sql (owner 2026-11-13): looking for the cause
    'backlog',
    'on_hold',
    'fix_in_progress',
    'merge',
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
    investigating: 'Investigation In Progress',
    backlog: 'Backlog',
    on_hold: 'On Hold',
    fix_in_progress: 'Fix In Progress',
    merge: 'Merge',
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
 * Who to email when a new issue is recorded. Prefers the ISSUE_REPORT_NOTIFY_EMAIL env override;
 * otherwise the business inbox (admin-inbox.ts) — NOT every admin account, which sent it to a
 * personal address (changed 2026-10-03).
 */
export async function getAdminRecipients(_db: Db): Promise<AdminRecipient[]> {
    const override = process.env.ISSUE_REPORT_NOTIFY_EMAIL;
    const list = override ? override.split(',').map((e) => e.trim()).filter(Boolean) : adminInbox();
    return list.map((email, i) => ({ id: -1 - i, email, firstName: null }));
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
        /** NULL for an automatic incident (platform-incident.ts): there is nobody to tell. */
        userId: number | null;
        issueId: number;
        status: IssueStatus;
        adminMessage?: string;
        headers?: Record<string, string | undefined>;
        /**
         * Copy for the two automatic messages (src/utils/issue-fix-live.ts):
         * 'live' — the fix reached the site this reporter uses; 'auto_closed' — no reply 7 days after it.
         */
        variant?: 'live' | 'auto_closed';
    },
): Promise<void> {
    const { userId, issueId, status, adminMessage = '', variant } = opts;
    if (userId == null) return;
    const label = ISSUE_STATUS_LABEL[status];

    // Status-specific call to action.
    const cta =
        variant === 'live'               ? "The fix is live now. Could you give it another try? If it's still not right, just reply and we'll pick it straight back up. If we don't hear from you, it closes on its own in 7 days." :
        variant === 'auto_closed'        ? "We've closed this as we haven't heard back in 7 days since the fix went out. If it's still not working, reply and we'll reopen it." :
        status === 'fixed_ready_to_test' ? "We've pushed a fix — could you give it another try and let us know how it goes?" :
        status === 'more_info_required'  ? "We'd love to help, but we need a bit more detail from you first." :
        status === 'investigating'       ? "We're looking into this now to find out what's causing it." :
        status === 'fix_in_progress'     ? "We've picked this up and are working on a fix now." :
        status === 'backlog'             ? "We've added this to our backlog and will investigate as soon as we can." :
        status === 'on_hold'             ? "We're putting this on hold for now while we weigh it up against other work — we'll come back to it." :
        status === 'merge'               ? "The fix is done and queued to be merged to staging — nearly there!" :
        status === 'roadmap'             ? "We've added your request to our roadmap — we'll get to it as soon as we can." :
        status === 'closed'              ? "We've closed this one out. Thanks again for flagging it!" :
        "There's an update on the issue you reported.";

    const title =
        variant === 'live'               ? `✅ Issue #${issueId} is fixed and live` :
        variant === 'auto_closed'        ? `Issue #${issueId} closed` :
        status === 'fixed_ready_to_test' ? `✅ Issue #${issueId} fixed — ready to test` :
        status === 'more_info_required'  ? `❓ Issue #${issueId} — more info needed` :
        status === 'investigating'       ? `🔎 Issue #${issueId}: we're investigating` :
        status === 'backlog'             ? `🗂️ Issue #${issueId} added to the backlog` :
        status === 'on_hold'             ? `⏸️ Issue #${issueId} placed on hold` :
        status === 'roadmap'             ? `🗺️ Issue #${issueId} added to our roadmap` :
        `🔧 Issue #${issueId} updated: ${label}`;

    const messageLine = adminMessage ? ` — “${adminMessage}”` : '';

    // In-app notification. The status picks a per-status template; each carries the same
    // copy the `cta`/`title` above build (kept here because the email below reuses them).
    const ISSUE_TEMPLATE_KEY: Record<string, string> = {
        fixed_ready_to_test: 'issue_fixed_ready_to_test',
        more_info_required:  'issue_more_info_required',
        fix_in_progress:     'issue_fix_in_progress',
        backlog:             'issue_backlog',
        on_hold:             'issue_on_hold',
        merge:               'issue_merge',
        roadmap:             'issue_roadmap',
        closed:              'issue_closed',
    };
    const templateKey = variant === 'live' ? 'issue_fixed_live'
        : variant === 'auto_closed' ? 'issue_auto_closed'
        : (ISSUE_TEMPLATE_KEY[status] ?? 'issue_updated');
    await createNotification(db, templateKey, {
        userId,
        context: { issue: { id: issueId, status_label: label, admin_message: messageLine } },
        metadata: { issueId, status },
    });

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
 *
 * ⚠️ Since db/z-issue-fix-live.sql: once both gates pass this only threads "merged, we'll tell you
 * when it's live" and returns false. The scheduled live check (issue-fix-live.ts) advances the issue
 * when this environment's deployed commit contains the fix. The old path below runs only on a
 * database the SQL hasn't reached.
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

    // Once db/z-issue-fix-live.sql is in, merged is not live: the scheduled live check
    // (issue-fix-live.ts) moves the issue on, and tells the reporter, when THIS site's deployed
    // commit contains the fix. Telling them now asked prod customers to re-test a staging-only fix.
    if (await fixLiveColumnsReady(db)) {
        await db.insert(issueReportMessages).values({
            issueId,
            authorType: 'admin',
            authorId: null,
            body: "🔀 The fix is merged. We'll let you know as soon as it's live.",
            status: null,
        });
        return false;
    }

    await db.update(issueReports)
        .set({ status: 'fixed_ready_to_test', updatedAt: new Date() })
        .where(eq(issueReports.id, issueId));

    await db.insert(issueReportMessages).values({
        issueId,
        authorType: 'admin',
        authorId: null,
        body: "✅ Good news — the fix is live on staging now, ready for you to test.",
        status: 'fixed_ready_to_test',
    });

    await notifyIssueUser(db, { userId: row.userId, issueId, status: 'fixed_ready_to_test', headers })
        .catch((e) => console.error('[issue-reports] ready-to-test notify failed:', e?.message || e));
    return true;
}

/**
 * Fire the Netlify staging build hook once the merge queue has drained — called after
 * every recorded merge outcome (issue-cloud-merge.ts, success or failure) so "Merge to Staging" alone puts the fix live,
 * matching what maybeAdvanceToReadyToTest already tells the reporter. Only fires when
 * nothing else is still queued/merging, so a bulk "merge all" still yields one rebuild
 * instead of one per PR. Best-effort: a hook failure is logged, never thrown.
 */
export async function triggerStagingDeployIfDrained(db: Db): Promise<void> {
    const hook = process.env.NETLIFY_STAGING_BUILD_HOOK;
    if (!hook) return;

    const [pending] = await db.select({ n: sql<number>`count(*)::int` }).from(issueReports)
        .where(inArray(issueReports.devMergeStatus, ['queued', 'merging']));
    if (pending && pending.n > 0) return;

    try {
        const res = await fetch(hook, { method: 'POST' });
        if (!res.ok) console.error(`[issue-reports] staging deploy hook returned ${res.status}`);
    } catch (e) {
        console.error('[issue-reports] staging deploy hook unreachable:', e instanceof Error ? e.message : e);
    }
}

// A merge to staging runs in GitHub Actions (issue-cloud-merge.ts): the claim stamps
// dev_runner_heartbeat with its start time and nothing refreshes it while the workflow runs.
// A merge takes seconds, so a claim older than STALE_MERGE_MINS that nothing has confirmed lets
// a super-admin force a restart (admin-issue-reports ?action=request-merge { force }). The
// workflow treats an already-merged PR as success, so a restart after a merge that did land is
// harmless. syncCloudMerge also marks a run that never finished as failed on its own.
export const STALE_MERGE_MINS = 15;

export function isMergeClaimStale(heartbeat: Date | string | null | undefined, now = Date.now()): boolean {
    return !heartbeat || now - new Date(heartbeat).getTime() > STALE_MERGE_MINS * 60_000;
}
