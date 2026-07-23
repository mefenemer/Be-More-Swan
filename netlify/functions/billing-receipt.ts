// billing-receipt.ts
// GET ?id=<paymentId> → returns a printable HTML receipt for that payment.
// Opens in a new tab; user can print or use browser "Save as PDF".
// Works entirely from DB data — no Stripe dependency.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, payments, plans, organisations, userOrganisations, invoices } from '../../db/schema';
import { bmsDocCss, bmsHeader, voucherCallout, resolveInvoiceVoucher, currencySymbol, BMS } from '../../src/utils/billing-doc';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;
const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-05-27.dahlia' })
    : null;
const LOGO_URL = '/images/BeMoreSwan_SwanAI.png';

export default withLambda(async (event) => {
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
        const statusColor = statusLabel === 'Paid' ? BMS.green : '#d97706';

        // ── Voucher (best-effort) ─────────────────────────────────
        // payments store no discount; resolve the voucher from the payment's linked Stripe invoice
        // (found via the invoices table, which shares the payment-intent id). Same figures as the
        // billing page. Null when Stripe is off, unlinked, or no voucher applied.
        let voucher = null as Awaited<ReturnType<typeof resolveInvoiceVoucher>>;
        if (payment.externalPaymentId) {
            const [linkedInvoice] = await db.select({ stripeInvoiceId: invoices.stripeInvoiceId })
                .from(invoices)
                .where(and(eq(invoices.userId, userId), eq(invoices.stripePaymentIntentId, payment.externalPaymentId)))
                .limit(1);
            voucher = await resolveInvoiceVoucher(stripe, linkedInvoice?.stripeInvoiceId);
        }
        const netPaidNum = payment.amount ? parseFloat(String(payment.amount)) : 0;
        const csym = currencySymbol(currency);

        // Voucher-aware amount breakdown: the payment stores the NET paid, so the pre-voucher price
        // is net + saved. Shown as rows above the total only when a voucher applied.
        const voucherRows = voucher ? `
      <div class="row"><span class="label">Price before voucher</span><span class="value">${csym}${(netPaidNum + voucher.discountAmount).toFixed(2)}</span></div>
      <div class="row"><span class="label">Voucher${voucher.codes[0] ? ` (${_esc(voucher.codes[0])})` : ''} — ${_esc(voucher.label)}</span><span class="value" style="color:${BMS.pinkDeep}">−${csym}${voucher.discountAmount.toFixed(2)}</span></div>` : '';

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Receipt ${receiptNo} — Be More Swan</title>
<style>${bmsDocCss(statusColor)}</style>
</head>
<body>
<div class="page">
${bmsHeader({
    logoUrl: LOGO_URL,
    subtitle: 'AI teammates for your business',
    metaHtml: `
      <div class="eyebrow">Payment Receipt</div>
      <div class="num">${receiptNo}</div>
      <div class="date">${dateStr}</div>`,
})}

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
      ${payment.externalPaymentId ? `<div class="row"><span class="label">Transaction ID</span><span class="value" style="font-size:12px;font-family:ui-monospace,monospace">${_esc(payment.externalPaymentId)}</span></div>` : ''}
    </div>

    ${voucherCallout(voucher)}

    <div class="totals">
      ${voucherRows}
      <div class="t-total"><span class="t-label">Total Paid</span><span class="t-val">${_esc(amount)}</span></div>
    </div>

  </div>

  <div class="footer">
    <p>Be More Swan · <a href="mailto:support@bemoreswan.com">support@bemoreswan.com</a></p>
    <p class="no-print"><button class="print-btn" onclick="window.print()">&#128438; Print / Save as PDF</button></p>
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
});

function _cap(s: string) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function _esc(str: string) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
