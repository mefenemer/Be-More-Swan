// invoice-pdf.ts
// GET ?id=<invoiceId> → returns a printable HTML invoice for that invoice.
// Opens in a new tab; user can Print → Save as PDF from their browser.
// Pulls user's legal billing details from billingInformation table.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, invoices, billingInformation, organisations, userOrganisations } from '../../db/schema';
import { bmsDocCss, bmsHeader, voucherCallout, resolveInvoiceVoucher, currencySymbol, BMS } from '../../src/utils/billing-doc';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;
const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-05-27.dahlia' })
    : null;
const LOGO_URL = '/images/BeMoreSwan_SwanAI.png';

// Be More Swan corporate details (kept in one place for easy updating)
const AURA_COMPANY = {
    name:    'Be More Swan Ltd',
    address: '85 Great Portland Street, London, W1W 7LT, United Kingdom',
    email:   'billing@bemoreswan.com',
    website: 'bemoreswan.com',
};

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

        // ── Voucher (best-effort, from Stripe) ────────────────────
        // invoice.total is the NET amount actually paid (post-discount); the DB keeps no record of the
        // voucher, so resolve it from the linked Stripe invoice. Same logic + figures as the billing
        // page (src/utils/billing-doc.ts). Null when Stripe is off, unlinked, or no voucher applied.
        const voucher = await resolveInvoiceVoucher(stripe, invoice.stripeInvoiceId);

        // ── Format values ─────────────────────────────────────────
        const currency  = (invoice.currency || 'GBP').toUpperCase();
        const sym       = currencySymbol(currency) || `${currency} `;
        const money     = (n: number) => `${sym}${n.toFixed(2)}`;
        const netTotal  = parseFloat(String(invoice.total));
        const taxNum    = parseFloat(String(invoice.taxAmount || 0));
        const discountNum = voucher ? voucher.discountAmount : 0;
        // With a voucher, the true pre-discount subtotal is net + discount (gross = net + saved).
        const grossSubtotalNum = voucher ? (netTotal - taxNum + discountNum) : parseFloat(String(invoice.subtotal));
        const subtotal  = money(grossSubtotalNum);
        const taxAmount = money(taxNum);
        const total     = money(netTotal);
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
        const statusColor = invoice.status === 'paid' ? BMS.green : '#d97706';

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

        // Discount row shown only when a voucher applied — keeps the breakdown adding up
        // (gross subtotal − voucher = net paid).
        const discountRow = voucher ? `
      <div class="t-row discount">
        <span class="t-label">Voucher${voucher.codes[0] ? ` (${_esc(voucher.codes[0])})` : ''} — ${_esc(voucher.label)}</span>
        <span class="t-val">−${money(discountNum)}</span>
      </div>` : '';

        // ── HTML ──────────────────────────────────────────────────
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Invoice ${_esc(invoice.invoiceNumber)} — Be More Swan</title>
<style>${bmsDocCss(statusColor)}</style>
</head>
<body>
<div class="page">
${bmsHeader({
    logoUrl: LOGO_URL,
    subtitle: 'AI teammates for your business',
    metaHtml: `
      <div class="eyebrow">Invoice</div>
      <div class="num">${_esc(invoice.invoiceNumber)}</div>
      <div class="date">Issued: ${issueDateStr}</div>
      <div class="date">Period: ${periodStr}</div>
      <div><span class="status-badge">${statusLabel}</span></div>`,
})}

  <div class="body">

    <div class="section">
      <div class="grid2">
        <div>
          <div class="section-title">From</div>
          <div class="addr-name">${_esc(AURA_COMPANY.name)}</div>
          <div class="addr-detail">
            ${_esc(AURA_COMPANY.address)}<br>
            <a href="mailto:${_esc(AURA_COMPANY.email)}" style="color:${BMS.pink};font-weight:700;text-decoration:none">${_esc(AURA_COMPANY.email)}</a>
          </div>
        </div>
        <div>
          <div class="section-title">Billed To</div>
          <div class="addr-name">${_esc(legalName)}</div>
          ${addrHtml ? `<div class="addr-detail">${addrHtml}</div>` : ''}
          ${billedEmail ? `<div class="row" style="margin-top:6px"><span class="label">Email</span><span class="value">${_esc(billedEmail)}</span></div>` : ''}
          ${vatLine}
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Items</div>
      <table class="items">
        <thead><tr><th>Description</th><th>Amount</th></tr></thead>
        <tbody>
          <tr>
            <td>
              <div>${_esc(invoice.planName)} Subscription</div>
              <div class="muted-note">Billing period: ${periodStr}</div>
            </td>
            <td>${subtotal}</td>
          </tr>
        </tbody>
      </table>
    </div>

    ${voucherCallout(voucher)}

    <div class="totals">
      <div class="t-row"><span class="t-label">Subtotal</span><span class="t-val">${subtotal}</span></div>
      ${discountRow}
      <div class="t-row"><span class="t-label">Tax / VAT (${taxRate})</span><span class="t-val">${taxAmount}</span></div>
      <div class="t-total"><span class="t-label">Total Paid</span><span class="t-val">${total}</span></div>
    </div>

  </div>

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
});

function _esc(str: string) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
