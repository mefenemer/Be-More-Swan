// invoice-pdf.ts
// GET ?id=<invoiceId> → returns a printable HTML invoice for that invoice.
// Opens in a new tab; user can Print → Save as PDF from their browser.
// Pulls user's legal billing details from billingInformation table.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, invoices, billingInformation, organisations, userOrganisations } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

// Be More Swan corporate details (kept in one place for easy updating)
const AURA_COMPANY = {
    name:    'Be More Swan Ltd',
    address: '85 Great Portland Street, London, W1W 7LT, United Kingdom',
    email:   'billing@bemoreswan.com',
    website: 'bemoreswan.com',
};

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

    const invoiceId = parseInt(event.queryStringParameters?.id || '');
    if (!invoiceId) return { statusCode: 400, body: 'Invoice id required.' };

    try {
        const db = getDb();

        // Load invoice — verify ownership
        const [invoice] = await db.select()
            .from(invoices)
            .where(and(eq(invoices.id, invoiceId), eq(invoices.userId, userId)));
        if (!invoice) return { statusCode: 404, body: 'Invoice not found.' };

        // Load user
        const [user] = await db.select({
            firstName:      users.firstName,
            lastName:       users.lastName,
            email:          users.email,
            organisationId: userOrganisations.organisationId,
        }).from(users).leftJoin(userOrganisations, eq(users.id, userOrganisations.userId)).where(eq(users.id, userId));

        // Load legal billing details
        const [billingInfo] = await db.select()
            .from(billingInformation)
            .where(eq(billingInformation.userId, userId));

        // Load organisation name
        let orgName = '';
        if (user?.organisationId) {
            const [org] = await db.select({ name: organisations.name })
                .from(organisations).where(eq(organisations.id, user.organisationId));
            if (org) orgName = org.name;
        }

        // ── Format values ─────────────────────────────────────────
        const currency  = (invoice.currency || 'GBP').toUpperCase();
        const symbol    = currency === 'GBP' ? '£' : `${currency} `;
        const subtotal  = `${symbol}${parseFloat(String(invoice.subtotal)).toFixed(2)}`;
        const taxAmount = `${symbol}${parseFloat(String(invoice.taxAmount || 0)).toFixed(2)}`;
        const total     = `${symbol}${parseFloat(String(invoice.total)).toFixed(2)}`;
        const taxRate   = invoice.taxRate ? `${(parseFloat(String(invoice.taxRate)) * 100).toFixed(0)}%` : '0%';

        const issueDateStr = invoice.issueDate
            ? new Date(invoice.issueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
            : '—';

        const periodStr = (() => {
            if (invoice.billingPeriodStart && invoice.billingPeriodEnd) {
                const s = new Date(invoice.billingPeriodStart).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
                const e = new Date(invoice.billingPeriodEnd).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
                return `${s} – ${e}`;
            }
            return '—';
        })();

        const statusLabel = invoice.status === 'paid' ? 'PAID' : (invoice.status || '').toUpperCase();
        const statusColor = invoice.status === 'paid' ? '#059669' : '#d97706';

        // ── Billing address block ─────────────────────────────────
        const legalName = billingInfo?.fullName || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || orgName || 'Customer';
        const addrParts: string[] = [];
        if (billingInfo?.addressLine1) addrParts.push(billingInfo.addressLine1);
        if (billingInfo?.addressLine2) addrParts.push(billingInfo.addressLine2);
        if (billingInfo?.city)         addrParts.push(billingInfo.city);
        if (billingInfo?.state)        addrParts.push(billingInfo.state);
        if (billingInfo?.postalCode)   addrParts.push(billingInfo.postalCode);
        if (billingInfo?.country)      addrParts.push(billingInfo.country);
        const addrHtml = addrParts.map(_esc).join('<br>');
        const vatLine  = billingInfo?.vatNumber
            ? `<div class="billed-row"><span class="billed-label">VAT / Tax ID</span><span class="billed-val">${_esc(billingInfo.vatNumber)}</span></div>`
            : '';

        const billedEmail = billingInfo?.email || user?.email || '';

        // ── HTML ──────────────────────────────────────────────────
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Invoice ${_esc(invoice.invoiceNumber)} — Be More Swan</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f3f4f6; color: #111827; font-size: 14px; line-height: 1.5; }
  .page { max-width: 740px; margin: 40px auto; background: #fff; border-radius: 16px; box-shadow: 0 4px 32px rgba(0,0,0,.1); overflow: hidden; }

  /* Header */
  .header { background: linear-gradient(135deg, #064e3b 0%, #065f46 100%); padding: 40px 48px; color: #fff; display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  .logo { font-size: 24px; font-weight: 800; letter-spacing: -0.5px; }
  .logo span { color: #6ee7b7; }
  .logo-sub { font-size: 11px; opacity: .65; margin-top: 4px; letter-spacing: .05em; }
  .inv-meta { text-align: right; }
  .inv-meta .inv-label { font-size: 11px; text-transform: uppercase; letter-spacing: .1em; opacity: .65; }
  .inv-meta .inv-num { font-size: 22px; font-weight: 800; margin-top: 2px; }
  .inv-meta .inv-date { font-size: 13px; opacity: .8; margin-top: 4px; }
  .status-badge { display: inline-block; margin-top: 8px; padding: 3px 12px; border-radius: 999px; font-size: 11px; font-weight: 800; letter-spacing: .08em; color: #fff; background: ${statusColor}; }

  /* Two-column address section */
  .addresses { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; padding: 36px 48px 28px; border-bottom: 1px solid #f3f4f6; }
  .addr-block .addr-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; color: #9ca3af; margin-bottom: 10px; }
  .addr-block .addr-name { font-size: 15px; font-weight: 700; color: #111827; margin-bottom: 4px; }
  .addr-block .addr-detail { color: #6b7280; font-size: 13px; line-height: 1.7; }

  /* Billed-to sub-rows */
  .billed-row { display: flex; justify-content: space-between; font-size: 13px; padding: 2px 0; }
  .billed-label { color: #9ca3af; }
  .billed-val { color: #374151; font-weight: 500; text-align: right; }

  /* Line items */
  .items { padding: 28px 48px; }
  .items-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; color: #9ca3af; margin-bottom: 14px; }
  table.line-items { width: 100%; border-collapse: collapse; }
  table.line-items thead tr { border-bottom: 1px solid #e5e7eb; }
  table.line-items th { padding: 8px 0; text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: #9ca3af; }
  table.line-items th:last-child { text-align: right; }
  table.line-items tbody tr { border-bottom: 1px solid #f9fafb; }
  table.line-items td { padding: 12px 0; font-size: 14px; color: #374151; }
  table.line-items td:last-child { text-align: right; font-weight: 600; color: #111827; }
  .period-note { font-size: 12px; color: #9ca3af; margin-top: 2px; }

  /* Totals */
  .totals { padding: 0 48px 36px; }
  .totals-table { margin-left: auto; width: 280px; }
  .totals-row { display: flex; justify-content: space-between; padding: 7px 0; font-size: 14px; border-bottom: 1px solid #f3f4f6; }
  .totals-row:last-child { border-bottom: none; }
  .totals-row .t-label { color: #6b7280; }
  .totals-row .t-val { font-weight: 600; color: #111827; }
  .totals-total { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; padding: 14px 0; border-top: 2px solid #111827; }
  .totals-total .t-label { font-size: 16px; font-weight: 700; }
  .totals-total .t-val { font-size: 26px; font-weight: 800; }

  /* Footer */
  .footer { background: #f9fafb; border-top: 1px solid #f3f4f6; padding: 20px 48px; display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
  .footer p { font-size: 12px; color: #9ca3af; }
  .footer a { color: #059669; text-decoration: none; font-weight: 600; }
  .print-btn { background: #064e3b; color: #fff; border: none; padding: 8px 18px; border-radius: 8px; font-size: 13px; font-weight: 700; cursor: pointer; }
  .print-btn:hover { background: #065f46; }

  @media print {
    body { background: #fff; }
    .page { box-shadow: none; margin: 0; border-radius: 0; max-width: 100%; }
    .no-print { display: none !important; }
    .header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .status-badge { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
<div class="page">

  <!-- Header -->
  <div class="header">
    <div>
      <div class="logo">Be More Swan</div>
      <div class="logo-sub">${_esc(AURA_COMPANY.address)}</div>
      <div class="logo-sub">${_esc(AURA_COMPANY.email)}</div>
    </div>
    <div class="inv-meta">
      <div class="inv-label">Invoice</div>
      <div class="inv-num">${_esc(invoice.invoiceNumber)}</div>
      <div class="inv-date">Issued: ${issueDateStr}</div>
      <div class="inv-date">Period: ${periodStr}</div>
      <div><span class="status-badge">${statusLabel}</span></div>
    </div>
  </div>

  <!-- Addresses -->
  <div class="addresses">

    <div class="addr-block">
      <div class="addr-title">From</div>
      <div class="addr-name">${_esc(AURA_COMPANY.name)}</div>
      <div class="addr-detail">
        ${_esc(AURA_COMPANY.address)}<br>
        <a href="mailto:${_esc(AURA_COMPANY.email)}" style="color:#059669">${_esc(AURA_COMPANY.email)}</a>
      </div>
    </div>

    <div class="addr-block">
      <div class="addr-title">Billed To</div>
      <div class="addr-name">${_esc(legalName)}</div>
      ${addrHtml ? `<div class="addr-detail">${addrHtml}</div>` : ''}
      ${billedEmail ? `<div class="billed-row" style="margin-top:6px"><span class="billed-label">Email</span><span class="billed-val">${_esc(billedEmail)}</span></div>` : ''}
      ${vatLine}
    </div>

  </div>

  <!-- Line items -->
  <div class="items">
    <div class="items-title">Items</div>
    <table class="line-items">
      <thead>
        <tr>
          <th>Description</th>
          <th style="text-align:right">Amount</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <div>${_esc(invoice.planName)} Subscription</div>
            <div class="period-note">Billing period: ${periodStr}</div>
          </td>
          <td>${subtotal}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- Totals -->
  <div class="totals">
    <div class="totals-table">
      <div class="totals-row">
        <span class="t-label">Subtotal</span>
        <span class="t-val">${subtotal}</span>
      </div>
      <div class="totals-row">
        <span class="t-label">Tax / VAT (${taxRate})</span>
        <span class="t-val">${taxAmount}</span>
      </div>
      <div class="totals-total">
        <span class="t-label">Total Paid</span>
        <span class="t-val">${total}</span>
      </div>
    </div>
  </div>

  <!-- Footer -->
  <div class="footer">
    <div>
      <p>Thank you for your business. Questions? <a href="mailto:${_esc(AURA_COMPANY.email)}">${_esc(AURA_COMPANY.email)}</a></p>
      <p style="margin-top:4px">Invoice ${_esc(invoice.invoiceNumber)} · ${_esc(AURA_COMPANY.name)}</p>
    </div>
    <button class="print-btn no-print" onclick="window.print()">&#128438; Download / Print PDF</button>
  </div>

</div>
</body>
</html>`;

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Disposition': `inline; filename="${invoice.invoiceNumber}.html"`,
            },
            body: html,
        };

    } catch (err: any) {
        console.error('[invoice-pdf]', err);
        return { statusCode: 500, body: 'Failed to generate invoice.' };
    }
};

function _esc(str: string) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
