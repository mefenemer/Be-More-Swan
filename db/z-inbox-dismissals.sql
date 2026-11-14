-- db/z-inbox-dismissals.sql — Admin ▸ Customers ▸ Inbox: "Ignore" a message without replying (FR#22, owner 2026-11-14).
--
-- Some messages need no reply (spam, a thank-you, an out-of-office). Ignoring one records it here; the Inbox then
-- shows it under Done. Nothing is sent to anyone and the ticket / issue / enquiry itself is not changed, so its own
-- page and the customer's view stay as they were. If the person writes again (any activity newer than the
-- dismissal) it comes back to its normal place. "Undo" deletes the row.
--
--   kind          'ticket' | 'issue' | 'enquiry'  (src/utils/support-inbox.ts InboxKind)
--   item_id       support_tickets.id / issue_reports.id / leads.id
--   dismissed_at  when it was ignored
--   dismissed_by  the admin who ignored it
--
-- Not declared in db/schema.ts; read raw behind inboxDismissalsReady(). Additive and idempotent: run on BOTH DBs.

BEGIN;

CREATE TABLE IF NOT EXISTS support_inbox_dismissals (
    kind         TEXT        NOT NULL CHECK (kind IN ('ticket', 'issue', 'enquiry')),
    item_id      INTEGER     NOT NULL,
    dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    dismissed_by INTEGER     REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (kind, item_id)
);

COMMIT;

-- Check (expect 1):
-- SELECT count(*) FROM information_schema.tables WHERE table_name = 'support_inbox_dismissals';
