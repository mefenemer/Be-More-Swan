// admin-inbox.ts — where Be More Swan's OWN operational emails go.
//
// Admin alerts (a new issue report, the quarterly bias review, the monthly bias sampling report,
// a P0 security incident) used to be emailed to every admin USER account — which meant a personal
// address, not the business inbox, and one copy per admin. They now go to one place: the business
// inbox, overridable with ADMIN_ALERT_EMAIL (comma-separated for several). The in-app notifications
// to each admin are unchanged — this is only the email.
//
// Read at call time, not module load, so a test or a redeploy with a new env value is honoured.
export function adminInbox(): string[] {
    const raw = process.env.ADMIN_ALERT_EMAIL || 'hello@bemoreswan.com';
    return [...new Set(raw.split(',').map(e => e.trim()).filter(Boolean))];
}
