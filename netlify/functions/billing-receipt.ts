// billing-receipt.ts
// GET ?id=<paymentId> → returns a printable HTML receipt for that payment.
// Opens in a new tab; user can print or use browser "Save as PDF".
// Works entirely from DB data — no Stripe dependency.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, payments, plans, organisations, userOrganisations } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!jwtSecret) return { statusCode: 500, body: 'Server misconfigured.' };

    // ── Auth ──────────────────────────────────────────────────────
    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return { statusCode: 401, body: 'Unauthorized.' };

    let userId: number;
    try {
        userId = (jwt.verify(cookie, jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: 'Invalid session.' };
    }

    const paymentId = parseInt(event.queryStringParameters?.id || '');
    if (!paymentId) return { statusCode: 400, body: 'Payment id required.' };

    try {
        const db = getDb();

        // Load payment — verify ownership
        const [payment] = await db.select().from(payments)
            .where(and(eq(payments.id, paymentId), eq(payments.userId, userId)));
        if (!payment) return { statusCode: 404, body: 'Payment not found.' };

        // Load user + organisation for receipt header
        const [user] = await db.select({
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
            organisationId: userOrganisations.organisationId,
        }).from(users).leftJoin(userOrganisations, eq(users.id, userOrganisations.userId)).where(eq(users.id, userId));

        let orgName = 'Be More Swan Customer';
        if (user?.organisationId) {
            const [org] = await db.select({ name: organisations.name })
                .from(organisations).where(eq(organisations.id, user.organisationId));
            if (org) orgName = org.name;
        }

        // Load plan name — append " Plan" suffix if not already present
        let planName = payment.description || 'Be More Swan Subscription';
        if (payment.planId) {
            const [plan] = await db.select({ planName: plans.planName })
                .from(plans).where(eq(plans.id, payment.planId));
            if (plan) {
                const base = plan.planName.replace(/\s*Plan\s*$/i, '').trim();
                planName = `${base} Plan`;
            }
        }

        // Format values
        const currency    = (payment.currency || 'GBP').toUpperCase();
        const symbol      = currency === 'GBP' ? '£' : `${currency} `;
        const amount      = payment.amount ? `${symbol}${parseFloat(String(payment.amount)).toFixed(2)}` : '—';
        const date        = payment.paidAt || payment.createdAt;
        const dateStr     = date
            ? new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
            : '—';
        const receiptNo   = `RCP-${String(payment.id).padStart(6, '0')}`;
        const customerName = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || orgName;

        // Payment type: prefer card details columns → then paymentMethod text → fallback to "Card payment"
        const cardLine = (() => {
            if (payment.cardBrand && payment.cardLast4) {
                const expiry = payment.cardExpMonth
                    ? ` (exp ${String(payment.cardExpMonth).padStart(2, '0')}/${payment.cardExpYear})`
                    : '';
                return `${_cap(payment.cardBrand)} ending ${payment.cardLast4}${expiry}`;
            }
            if (payment.paymentMethod) {
                // paymentMethod is a text like "visa ending 4242" — capitalise first word
                return payment.paymentMethod.replace(/^([a-z])/, (_: string, c: string) => c.toUpperCase());
            }
            return 'Card payment';
        })();

        const statusLabel = payment.status === 'completed' || payment.status === 'paid' ? 'Paid' : _cap(payment.status || '');
        const statusColor = statusLabel === 'Paid' ? '#059669' : '#d97706';

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Receipt ${receiptNo} — Be More Swan</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f9fafb; color: #111827; }
  .page { max-width: 680px; margin: 40px auto; background: #fff; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,.08); overflow: hidden; }
  .header { background: linear-gradient(135deg, #064e3b 0%, #065f46 100%); padding: 36px 40px; color: #fff; display: flex; justify-content: space-between; align-items: flex-start; }
  .logo { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; }
  .logo span { color: #6ee7b7; }
  .receipt-label { text-align: right; }
  .receipt-label p { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; opacity: .7; }
  .receipt-label h2 { font-size: 20px; font-weight: 700; margin-top: 2px; }
  .receipt-label .date { font-size: 13px; opacity: .8; margin-top: 4px; }
  .body { padding: 36px 40px; }
  .section { margin-bottom: 28px; }
  .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: #9ca3af; margin-bottom: 12px; }
  .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #f3f4f6; font-size: 14px; }
  .row:last-child { border-bottom: none; }
  .row .label { color: #6b7280; }
  .row .value { font-weight: 600; color: #111827; text-align: right; }
  .total-row { display: flex; justify-content: space-between; align-items: center; padding: 16px 0; border-top: 2px solid #111827; margin-top: 8px; }
  .total-row .label { font-size: 15px; font-weight: 700; }
  .total-row .value { font-size: 24px; font-weight: 800; }
  .status-badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; color: #fff; background: ${statusColor}; }
  .footer { background: #f9fafb; border-top: 1px solid #f3f4f6; padding: 20px 40px; display: flex; justify-content: space-between; align-items: center; }
  .footer p { font-size: 12px; color: #9ca3af; }
  .footer a { color: #059669; text-decoration: none; font-weight: 600; }
  @media print {
    body { background: #fff; }
    .page { box-shadow: none; margin: 0; border-radius: 0; }
    .no-print { display: none; }
  }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="logo">Be More Swan</div>
    <div class="receipt-label">
      <p>Payment Receipt</p>
      <h2>${receiptNo}</h2>
      <div class="date">${dateStr}</div>
    </div>
  </div>

  <div class="body">

    <div class="section">
      <div class="section-title">Billed To</div>
      <div class="row"><span class="label">Name</span><span class="value">${_esc(customerName)}</span></div>
      <div class="row"><span class="label">Organisation</span><span class="value">${_esc(orgName)}</span></div>
      <div class="row"><span class="label">Email</span><span class="value">${_esc(user?.email || '—')}</span></div>
    </div>

    <div class="section">
      <div class="section-title">Payment Details</div>
      <div class="row"><span class="label">Description</span><span class="value">${_esc(planName)}</span></div>
      <div class="row"><span class="label">Payment Method</span><span class="value">${_esc(cardLine)}</span></div>
      ${payment.cardPostalCode ? `<div class="row"><span class="label">Billing Postcode</span><span class="value">${_esc(payment.cardPostalCode)}</span></div>` : ''}
      <div class="row"><span class="label">Date</span><span class="value">${dateStr}</span></div>
      <div class="row"><span class="label">Status</span><span class="value"><span class="status-badge">${statusLabel}</span></span></div>
      ${payment.externalPaymentId ? `<div class="row"><span class="label">Transaction ID</span><span class="value" style="font-size:12px;font-family:monospace">${_esc(payment.externalPaymentId)}</span></div>` : ''}
    </div>

    <div class="total-row">
      <span class="label">Total Paid</span>
      <span class="value">${_esc(amount)}</span>
    </div>

  </div>

  <div class="footer">
    <p>Be More Swan · <a href="mailto:support@bemoreswan.com">support@bemoreswan.com</a></p>
    <p class="no-print"><a href="javascript:window.print()">🖨 Print / Save as PDF</a></p>
  </div>
</div>
</body>
</html>`;

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
            body: html,
        };

    } catch (err: any) {
        console.error('[billing-receipt]', err);
        return { statusCode: 500, body: 'Failed to generate receipt.' };
    }
};

function _cap(s: string) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function _esc(str: string) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
