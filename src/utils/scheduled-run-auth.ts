// Who may run a scheduled function: the cron secret, or Netlify's scheduler (a POST whose body carries `next_run`,
// or an empty body). Same rule as content-retention.ts mayRun. The marker can be typed by hand, so the real limit is
// what a run CAN do: work already due, nothing a caller can choose. Used by poll-mailboxes.ts and meeting-pickup.ts.

export function mayRunScheduled(event: { body?: string | null; headers?: Record<string, string | undefined> }): boolean {
    const secret = process.env.CRON_TRIGGER_SECRET;
    const token = String(event.headers?.['authorization'] ?? event.headers?.['Authorization'] ?? '').replace(/^Bearer\s+/i, '').trim();
    if (token) return Boolean(secret) && token === secret;
    const raw = event.body;
    if (raw == null || raw === '') return true;
    try { return typeof JSON.parse(String(raw))?.next_run === 'string'; } catch { return false; }
}
