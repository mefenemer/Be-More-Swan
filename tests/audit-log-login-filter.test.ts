// tests/audit-log-login-filter.test.ts
// Admin → Audit Log can filter to "Login": the endpoint reads login_events (not admin_audit_log)
// and returns rows in the same shape, so the viewer renders them unchanged.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'admin.html'), 'utf8');
const api = readFileSync(join(root, 'netlify/functions/admin-api.ts'), 'utf8');

// 1. The filter offers it.
assert.ok(html.includes('<option value="login">Login (users signing in)</option>'), 'audit-filter-action must offer Login');

// 2. The endpoint branches on it, before the admin_audit_log query, and reads login_events.
const branch = api.indexOf("if (filterAction === 'login') {");
const adminQuery = api.indexOf('.from(adminAuditLog)\n                .leftJoin(users, eq(users.id, adminAuditLog.adminId))');
assert.ok(branch !== -1, 'admin-audit-log must branch on the login filter');
assert.ok(adminQuery !== -1 && branch < adminQuery, 'the login branch must return before the admin_audit_log query');
const body = api.slice(branch, adminQuery);
assert.ok(body.includes('.from(loginEvents)'), 'the login branch must read login_events');
for (const field of ['action:', 'adminFirstName:', 'reason:', 'ipAddress:', 'createdAt:']) {
    assert.ok(body.includes(field), `login rows must carry ${field} so the viewer renders them`);
}

// 3. The first column says User, not Admin, for logins.
assert.ok(html.includes("document.getElementById('audit-col-who').textContent = isLogin ? 'User' : 'Admin';"));

// 4. "to" includes the whole day it names (it used to stop at midnight at the start).
assert.ok(api.includes('const toDate       = qs.to   ? new Date(new Date(qs.to).getTime() + 24 * 60 * 60 * 1000) : null;'));

console.log('audit-log-login-filter: all checks passed');
