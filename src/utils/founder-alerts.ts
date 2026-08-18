// src/utils/founder-alerts.ts
//
// Internal founder alerts — subscribed, upgraded, downgraded, cancelled. Sent to
// hello@bemoreswan.com (override with FOUNDER_ALERT_EMAIL).
//
// These are INTERNAL ops emails, deliberately NOT routed through renderTemplate()/the
// admin-editable email_templates catalog: those are customer comms, and a missing or
// deactivated template there silently drops the send (see sendTemplatedEmail). A founder
// alert should never be silently droppable by an admin edit or an unseeded table.
//
// Callers:
//   - new subscriber → stripe-webhook.ts, both checkout branches
//   - upgrade        → billing-upgrade.ts, inside the existing idempotency guard
//   - downgrade      → billing-downgrade.ts, at schedule time (not when it activates)
//   - cancellation   → billing-cancel.ts, at request time (not when the period ends)
//
// The two churn alerts fire on the REQUEST, while the customer is still a customer and a
// save is still possible. The webhook events that follow weeks later (subscription.updated
// for the downgrade phase, subscription.deleted for the cancellation) are the receipt.
//
// Every send here is best-effort and NEVER throws. In the webhook a throw would release
// the processed_webhook_events claim and trigger a Stripe retry that re-runs plan
// activation; in the billing functions it would turn a completed change into a 5xx for
// the customer. An undelivered alert is logged and swallowed.

import { eq } from 'drizzle-orm';
import { users, organisations, masterPlans } from '../../db/schema';
import { sendEmail } from './email';

const FOUNDER_EMAIL = process.env.FOUNDER_ALERT_EMAIL || 'hello@bemoreswan.com';

// ─────────────────────────────────────────────────────────────────────────────
// Shared rendering
// ─────────────────────────────────────────────────────────────────────────────

function esc(v: unknown): string {
    return String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function formatMoney(minorUnits: number, currency: string): string {
    const code = (currency || 'gbp').toUpperCase();
    try {
        return new Intl.NumberFormat('en-GB', { style: 'currency', currency: code }).format(minorUnits / 100);
    } catch {
        // Unknown/invalid ISO code — never let a formatting quirk cost us the alert.
        return `${(minorUnits / 100).toFixed(2)} ${code}`;
    }
}

function row(label: string, value: string): string {
    return `<tr>
        <td style="padding:10px 16px;border-bottom:1px solid #eae4d7;color:#5c564b;font-size:13px;white-space:nowrap;vertical-align:top">${esc(label)}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #eae4d7;color:#1f1e1b;font-size:14px;font-weight:600">${value}</td>
    </tr>`;
}

function stripeLink(kind: 'customers' | 'subscriptions', id?: string | null): string {
    return id
        ? `<a href="https://dashboard.stripe.com/${kind}/${esc(id)}" style="color:#047857">${esc(id)}</a>`
        : '—';
}

/** The common card: coloured header, label/value table, muted trace footer. */
function shell(opts: { accent: string; headline: string; rowsHtml: string; footerHtml: string }): string {
    return `
        <div style="font-family:-apple-system,Segoe UI,sans-serif;background:#faf8f3;padding:24px">
          <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #eae4d7;border-radius:12px;overflow:hidden">
            <div style="background:${opts.accent};padding:20px 24px">
              <div style="color:#ffffffcc;font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:700">Be More Swan</div>
              <div style="color:#fff;font-size:20px;font-weight:700;margin-top:4px">${opts.headline}</div>
            </div>
            <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">
              ${opts.rowsHtml}
            </table>
            <div style="padding:14px 16px;background:#faf8f3;color:#8b8578;font-size:11px;line-height:1.6">
              ${opts.footerHtml}
            </div>
          </div>
        </div>`;
}

/** Look up the person + company shown at the top of every alert. */
async function loadSubject(db: any, userId: number, organisationId: number | null) {
    const [person] = await db
        .select({
            firstName: users.firstName,
            lastName:  users.lastName,
            email:     users.email,
            createdAt: users.createdAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

    let company: { name: string; industry: string | null; websiteUrl: string | null } | undefined;
    if (organisationId) {
        [company] = await db
            .select({
                name:       organisations.name,
                industry:   organisations.industry,
                websiteUrl: organisations.websiteUrl,
            })
            .from(organisations)
            .where(eq(organisations.id, organisationId))
            .limit(1);
    }

    return {
        person,
        company,
        fullName: [person?.firstName, person?.lastName].filter(Boolean).join(' ').trim(),
        companyName: company?.name || '(no organisation on record)',
    };
}

function personCell(fullName: string, email?: string | null): string {
    return `${esc(fullName || '(no name on record)')}<br><a href="mailto:${esc(email)}" style="color:#047857;font-weight:400;font-size:13px">${esc(email || '—')}</a>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// New subscriber
// ─────────────────────────────────────────────────────────────────────────────

export interface NewSubscriberAlertParams {
    db: any;
    userId: number;
    organisationId: number | null;
    /** Plan name as written onto the plans row — used when masterPlanId can't be resolved. */
    planName: string;
    masterPlanId: number | null;
    /** Amount actually charged, in minor units, straight from the Stripe event. */
    amountPence: number;
    /** ISO 4217 from the Stripe event, e.g. 'gbp'. */
    currency: string;
    billingCycle?: string | null;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    /** Which webhook branch fired — shown in the footer so odd cases are traceable. */
    source: 'checkout.session.completed' | 'payment_intent.succeeded';
}

/** Everything the new-subscriber email renders, already resolved from the DB. */
export interface NewSubscriberAlertData {
    companyName: string;
    fullName: string;
    email: string | null;
    planLabel: string;
    resolvedPlanName: string;
    priceLabel: string;
    cycleLabel: string;
    industry?: string | null;
    websiteUrl?: string | null;
    userId: number;
    organisationId: number | null;
    registeredOn?: string | null;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    source: string;
}

/**
 * Pure renderer — kept separate from the send so the exact shipping output can be
 * previewed and asserted without a DB or a Resend key.
 */
export function buildNewSubscriberAlertEmail(d: NewSubscriberAlertData): { subject: string; html: string; text: string } {
    const html = shell({
        accent: '#047857',
        headline: 'New subscriber 🎉',
        rowsHtml: [
            row('Company', esc(d.companyName)),
            row('Person', personCell(d.fullName, d.email)),
            row('Plan', esc(d.planLabel)),
            row('Price', `${esc(d.priceLabel)}<span style="font-weight:400;color:#5c564b;font-size:13px"> · ${esc(d.cycleLabel)} billing</span>`),
            d.industry   ? row('Industry', esc(d.industry)) : '',
            d.websiteUrl ? row('Website', `<a href="${esc(d.websiteUrl)}" style="color:#047857">${esc(d.websiteUrl)}</a>`) : '',
            row('Stripe customer', stripeLink('customers', d.stripeCustomerId)),
            row('Subscription', stripeLink('subscriptions', d.stripeSubscriptionId)),
        ].join(''),
        footerHtml: `
              User #${esc(d.userId)} · Org #${esc(d.organisationId ?? '—')} ·
              Registered ${esc(d.registeredOn || 'unknown')} ·
              Charged ${esc(new Date().toUTCString())}<br>
              Triggered by <code>${esc(d.source)}</code>`,
    });

    const text = [
        'New subscriber',
        `Company: ${d.companyName}`,
        `Person:  ${d.fullName || '(no name on record)'} <${d.email || '—'}>`,
        `Plan:    ${d.planLabel}`,
        `Price:   ${d.priceLabel} (${d.cycleLabel} billing)`,
        `Stripe:  customer ${d.stripeCustomerId || '—'} / subscription ${d.stripeSubscriptionId || '—'}`,
        `User #${d.userId} · Org #${d.organisationId ?? '—'} · via ${d.source}`,
    ].join('\n');

    return {
        subject: `💷 New subscriber: ${d.companyName} — ${d.resolvedPlanName} (${d.priceLabel})`,
        html,
        text,
    };
}

export async function sendNewSubscriberAlert(params: NewSubscriberAlertParams): Promise<void> {
    const {
        db, userId, organisationId, planName, masterPlanId,
        amountPence, currency, billingCycle, stripeCustomerId, stripeSubscriptionId, source,
    } = params;

    try {
        const { person, company, fullName, companyName } = await loadSubject(db, userId, organisationId);

        let tierKey: string | null = null;
        let resolvedPlanName = planName;
        if (masterPlanId) {
            const [mp] = await db
                .select({ name: masterPlans.name, tierKey: masterPlans.tierKey })
                .from(masterPlans)
                .where(eq(masterPlans.id, masterPlanId))
                .limit(1);
            if (mp) { resolvedPlanName = mp.name; tierKey = mp.tierKey; }
        }

        const { subject, html, text } = buildNewSubscriberAlertEmail({
            companyName,
            fullName,
            email:        person?.email ?? null,
            planLabel:    tierKey ? `${resolvedPlanName} (${tierKey})` : resolvedPlanName,
            resolvedPlanName,
            priceLabel:   `${formatMoney(amountPence, currency)} / ${billingCycle === 'annual' ? 'year' : 'month'}`,
            cycleLabel:   billingCycle === 'annual' ? 'Annual' : 'Monthly',
            industry:     company?.industry,
            websiteUrl:   company?.websiteUrl,
            userId,
            organisationId,
            registeredOn: person?.createdAt ? new Date(person.createdAt).toISOString().slice(0, 10) : null,
            stripeCustomerId,
            stripeSubscriptionId,
            source,
        });

        await sendEmail({ to: FOUNDER_EMAIL, subject, html, text });
        console.log(`[founder-alerts] new-subscriber alert sent to ${FOUNDER_EMAIL} for user ${userId} (org ${organisationId})`);
    } catch (err: any) {
        console.error('[founder-alerts] new-subscriber alert FAILED (non-blocking):', err?.message || err);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan upgrade
//
// Fires from billing-upgrade.ts rather than the customer.subscription.updated webhook
// branch. That branch sees only the post-change subscription, so telling an upgrade from
// a scheduled downgrade activation (or from unrelated subscription noise like a payment
// method swap) means inferring direction after the fact. billing-upgrade already holds
// the exact old tier, new tier, and prorated amount — no inference needed, and no risk of
// alerting on a downgrade.
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanUpgradeAlertParams {
    db: any;
    userId: number;
    organisationId: number | null;
    fromPlanName: string | null;
    fromTierKey: string | null;
    /** Major-unit monthly price of the old tier, e.g. '29.00'. */
    fromMonthlyPriceGbp: string | null;
    toPlanName: string;
    toTierKey: string;
    toMonthlyPriceGbp: string;
    /** Prorated amount charged immediately, in pence. Null when Stripe reported none. */
    proratedPence: number | null;
    invoiceUrl?: string | null;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
}

export interface PlanUpgradeAlertData {
    companyName: string;
    fullName: string;
    email: string | null;
    fromLabel: string;
    toLabel: string;
    toPlanName: string;
    fromPriceLabel: string;
    toPriceLabel: string;
    deltaLabel: string | null;
    proratedLabel: string | null;
    invoiceUrl?: string | null;
    userId: number;
    organisationId: number | null;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
}

/** Pure renderer — same reasoning as buildNewSubscriberAlertEmail. */
export function buildPlanUpgradeAlertEmail(d: PlanUpgradeAlertData): { subject: string; html: string; text: string } {
    const html = shell({
        accent: '#1d4ed8',
        headline: 'Plan upgrade ⬆️',
        rowsHtml: [
            row('Company', esc(d.companyName)),
            row('Person', personCell(d.fullName, d.email)),
            row('Upgrade', `${esc(d.fromLabel)} <span style="color:#5c564b;font-weight:400">→</span> ${esc(d.toLabel)}`),
            row('New price', `${esc(d.toPriceLabel)}<span style="font-weight:400;color:#5c564b;font-size:13px"> · was ${esc(d.fromPriceLabel)}</span>`),
            d.deltaLabel     ? row('MRR change', `<span style="color:#047857">${esc(d.deltaLabel)}</span>`) : '',
            d.proratedLabel  ? row('Charged now', `${esc(d.proratedLabel)}${d.invoiceUrl ? ` <a href="${esc(d.invoiceUrl)}" style="color:#047857;font-weight:400;font-size:13px">invoice →</a>` : ''}`) : '',
            row('Stripe customer', stripeLink('customers', d.stripeCustomerId)),
            row('Subscription', stripeLink('subscriptions', d.stripeSubscriptionId)),
        ].join(''),
        footerHtml: `
              User #${esc(d.userId)} · Org #${esc(d.organisationId ?? '—')} ·
              Upgraded ${esc(new Date().toUTCString())}<br>
              Triggered by <code>billing-upgrade</code>`,
    });

    const text = [
        'Plan upgrade',
        `Company:     ${d.companyName}`,
        `Person:      ${d.fullName || '(no name on record)'} <${d.email || '—'}>`,
        `Upgrade:     ${d.fromLabel} -> ${d.toLabel}`,
        `New price:   ${d.toPriceLabel} (was ${d.fromPriceLabel})`,
        d.deltaLabel ? `MRR change:  ${d.deltaLabel}` : '',
        d.proratedLabel ? `Charged now: ${d.proratedLabel}` : '',
        `Stripe:      customer ${d.stripeCustomerId || '—'} / subscription ${d.stripeSubscriptionId || '—'}`,
        `User #${d.userId} · Org #${d.organisationId ?? '—'} · via billing-upgrade`,
    ].filter(Boolean).join('\n');

    return {
        subject: `⬆️ Upgrade: ${d.companyName} — ${d.fromLabel} → ${d.toLabel} (${d.toPriceLabel})`,
        html,
        text,
    };
}

export async function sendPlanUpgradeAlert(params: PlanUpgradeAlertParams): Promise<void> {
    const {
        db, userId, organisationId, fromPlanName, fromTierKey, fromMonthlyPriceGbp,
        toPlanName, toTierKey, toMonthlyPriceGbp, proratedPence, invoiceUrl,
        stripeCustomerId, stripeSubscriptionId,
    } = params;

    try {
        const { person, fullName, companyName } = await loadSubject(db, userId, organisationId);

        // Prices are GBP major-unit numerics on master_plans; ×100 into the shared
        // minor-unit formatter so both alert types render money identically.
        const fromPence = fromMonthlyPriceGbp !== null ? Math.round(parseFloat(fromMonthlyPriceGbp) * 100) : null;
        const toPence   = Math.round(parseFloat(toMonthlyPriceGbp) * 100);
        const deltaPence = fromPence !== null && Number.isFinite(fromPence) ? toPence - fromPence : null;

        const { subject, html, text } = buildPlanUpgradeAlertEmail({
            companyName,
            fullName,
            email:          person?.email ?? null,
            fromLabel:      fromPlanName ? (fromTierKey ? `${fromPlanName} (${fromTierKey})` : fromPlanName) : '(unknown plan)',
            toLabel:        `${toPlanName} (${toTierKey})`,
            toPlanName,
            fromPriceLabel: fromPence !== null && Number.isFinite(fromPence) ? `${formatMoney(fromPence, 'gbp')} / month` : 'unknown',
            toPriceLabel:   `${formatMoney(toPence, 'gbp')} / month`,
            deltaLabel:     deltaPence !== null ? `+${formatMoney(Math.abs(deltaPence), 'gbp')} / month` : null,
            proratedLabel:  proratedPence !== null && proratedPence > 0 ? formatMoney(proratedPence, 'gbp') : null,
            invoiceUrl,
            userId,
            organisationId,
            stripeCustomerId,
            stripeSubscriptionId,
        });

        await sendEmail({ to: FOUNDER_EMAIL, subject, html, text });
        console.log(`[founder-alerts] upgrade alert sent to ${FOUNDER_EMAIL} for user ${userId} (${fromTierKey || '?'} → ${toTierKey})`);
    } catch (err: any) {
        console.error('[founder-alerts] upgrade alert FAILED (non-blocking):', err?.message || err);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan downgrade (scheduled)
//
// Fires from billing-downgrade.ts at REQUEST time, not when the lower tier actually
// activates. Same reasoning as the upgrade alert — the request site knows both tiers
// exactly — plus the founder-facing one: a downgrade taking effect at period end is old
// news, while a downgrade just requested is still a save opportunity. `effectiveDate`
// carries when the MRR actually drops.
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanDowngradeAlertParams {
    db: any;
    userId: number;
    organisationId: number | null;
    fromPlanName: string | null;
    fromTierKey: string | null;
    fromMonthlyPriceGbp: string | null;
    toPlanName: string;
    toTierKey: string;
    toMonthlyPriceGbp: string;
    /** When the lower price takes effect (current period end). */
    effectiveDate?: Date | null;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
}

export interface PlanDowngradeAlertData {
    companyName: string;
    fullName: string;
    email: string | null;
    fromLabel: string;
    toLabel: string;
    toPlanName: string;
    fromPriceLabel: string;
    toPriceLabel: string;
    deltaLabel: string | null;
    effectiveLabel: string | null;
    userId: number;
    organisationId: number | null;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
}

export function buildPlanDowngradeAlertEmail(d: PlanDowngradeAlertData): { subject: string; html: string; text: string } {
    const html = shell({
        accent: '#b45309',
        headline: 'Plan downgrade ⬇️',
        rowsHtml: [
            row('Company', esc(d.companyName)),
            row('Person', personCell(d.fullName, d.email)),
            row('Downgrade', `${esc(d.fromLabel)} <span style="color:#5c564b;font-weight:400">→</span> ${esc(d.toLabel)}`),
            row('New price', `${esc(d.toPriceLabel)}<span style="font-weight:400;color:#5c564b;font-size:13px"> · was ${esc(d.fromPriceLabel)}</span>`),
            d.deltaLabel     ? row('MRR change', `<span style="color:#b91c1c">${esc(d.deltaLabel)}</span>`) : '',
            d.effectiveLabel ? row('Takes effect', `${esc(d.effectiveLabel)}<span style="font-weight:400;color:#5c564b;font-size:13px"> · still on the old tier until then</span>`) : '',
            row('Stripe customer', stripeLink('customers', d.stripeCustomerId)),
            row('Subscription', stripeLink('subscriptions', d.stripeSubscriptionId)),
        ].join(''),
        footerHtml: `
              User #${esc(d.userId)} · Org #${esc(d.organisationId ?? '—')} ·
              Requested ${esc(new Date().toUTCString())}<br>
              Triggered by <code>billing-downgrade</code>`,
    });

    const text = [
        'Plan downgrade (scheduled)',
        `Company:      ${d.companyName}`,
        `Person:       ${d.fullName || '(no name on record)'} <${d.email || '—'}>`,
        `Downgrade:    ${d.fromLabel} -> ${d.toLabel}`,
        `New price:    ${d.toPriceLabel} (was ${d.fromPriceLabel})`,
        d.deltaLabel ? `MRR change:   ${d.deltaLabel}` : '',
        d.effectiveLabel ? `Takes effect: ${d.effectiveLabel}` : '',
        `Stripe:       customer ${d.stripeCustomerId || '—'} / subscription ${d.stripeSubscriptionId || '—'}`,
        `User #${d.userId} · Org #${d.organisationId ?? '—'} · via billing-downgrade`,
    ].filter(Boolean).join('\n');

    return {
        subject: `⬇️ Downgrade: ${d.companyName} — ${d.fromLabel} → ${d.toLabel} (${d.toPriceLabel})`,
        html,
        text,
    };
}

export async function sendPlanDowngradeAlert(params: PlanDowngradeAlertParams): Promise<void> {
    const {
        db, userId, organisationId, fromPlanName, fromTierKey, fromMonthlyPriceGbp,
        toPlanName, toTierKey, toMonthlyPriceGbp, effectiveDate,
        stripeCustomerId, stripeSubscriptionId,
    } = params;

    try {
        const { person, fullName, companyName } = await loadSubject(db, userId, organisationId);

        const fromPence = fromMonthlyPriceGbp !== null ? Math.round(parseFloat(fromMonthlyPriceGbp) * 100) : null;
        const toPence   = Math.round(parseFloat(toMonthlyPriceGbp) * 100);
        const hasFrom   = fromPence !== null && Number.isFinite(fromPence);
        const deltaPence = hasFrom ? toPence - (fromPence as number) : null;

        const { subject, html, text } = buildPlanDowngradeAlertEmail({
            companyName,
            fullName,
            email:          person?.email ?? null,
            fromLabel:      fromPlanName ? (fromTierKey ? `${fromPlanName} (${fromTierKey})` : fromPlanName) : '(unknown plan)',
            toLabel:        `${toPlanName} (${toTierKey})`,
            toPlanName,
            fromPriceLabel: hasFrom ? `${formatMoney(fromPence as number, 'gbp')} / month` : 'unknown',
            toPriceLabel:   `${formatMoney(toPence, 'gbp')} / month`,
            deltaLabel:     deltaPence !== null ? `-${formatMoney(Math.abs(deltaPence), 'gbp')} / month` : null,
            effectiveLabel: effectiveDate ? effectiveDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : null,
            userId,
            organisationId,
            stripeCustomerId,
            stripeSubscriptionId,
        });

        await sendEmail({ to: FOUNDER_EMAIL, subject, html, text });
        console.log(`[founder-alerts] downgrade alert sent to ${FOUNDER_EMAIL} for user ${userId} (${fromTierKey || '?'} → ${toTierKey})`);
    } catch (err: any) {
        console.error('[founder-alerts] downgrade alert FAILED (non-blocking):', err?.message || err);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation (at period end)
//
// Fires from billing-cancel.ts, which sets cancel_at_period_end rather than cancelling
// outright — so this is the churn signal while the customer is still a customer. The
// subscription.deleted webhook that follows weeks later is the receipt, not the news.
// ─────────────────────────────────────────────────────────────────────────────

export interface CancellationAlertParams {
    db: any;
    userId: number;
    organisationId: number | null;
    /** Plan name from the plans row; masterPlanId refines it to name + tier + price. */
    planName: string | null;
    masterPlanId: number | null;
    /** Last day of paid access (current period end). */
    effectiveDate?: Date | null;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
}

export interface CancellationAlertData {
    companyName: string;
    fullName: string;
    email: string | null;
    planLabel: string;
    mrrLostLabel: string | null;
    effectiveLabel: string | null;
    customerSinceLabel: string | null;
    userId: number;
    organisationId: number | null;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
}

export function buildCancellationAlertEmail(d: CancellationAlertData): { subject: string; html: string; text: string } {
    const html = shell({
        accent: '#b91c1c',
        headline: 'Cancellation ✕',
        rowsHtml: [
            row('Company', esc(d.companyName)),
            row('Person', personCell(d.fullName, d.email)),
            row('Plan', esc(d.planLabel)),
            d.mrrLostLabel       ? row('MRR lost', `<span style="color:#b91c1c">${esc(d.mrrLostLabel)}</span>`) : '',
            d.effectiveLabel     ? row('Access until', `${esc(d.effectiveLabel)}<span style="font-weight:400;color:#5c564b;font-size:13px"> · still reachable until then</span>`) : '',
            d.customerSinceLabel ? row('Customer since', esc(d.customerSinceLabel)) : '',
            row('Stripe customer', stripeLink('customers', d.stripeCustomerId)),
            row('Subscription', stripeLink('subscriptions', d.stripeSubscriptionId)),
        ].join(''),
        footerHtml: `
              User #${esc(d.userId)} · Org #${esc(d.organisationId ?? '—')} ·
              Requested ${esc(new Date().toUTCString())}<br>
              Triggered by <code>billing-cancel</code> · cancels at period end, not immediately`,
    });

    const text = [
        'Cancellation (at period end)',
        `Company:      ${d.companyName}`,
        `Person:       ${d.fullName || '(no name on record)'} <${d.email || '—'}>`,
        `Plan:         ${d.planLabel}`,
        d.mrrLostLabel ? `MRR lost:     ${d.mrrLostLabel}` : '',
        d.effectiveLabel ? `Access until: ${d.effectiveLabel}` : '',
        d.customerSinceLabel ? `Customer since: ${d.customerSinceLabel}` : '',
        `Stripe:       customer ${d.stripeCustomerId || '—'} / subscription ${d.stripeSubscriptionId || '—'}`,
        `User #${d.userId} · Org #${d.organisationId ?? '—'} · via billing-cancel`,
    ].filter(Boolean).join('\n');

    return {
        subject: `✕ Cancellation: ${d.companyName} — ${d.planLabel}${d.mrrLostLabel ? ` (${d.mrrLostLabel})` : ''}`,
        html,
        text,
    };
}

export async function sendCancellationAlert(params: CancellationAlertParams): Promise<void> {
    const {
        db, userId, organisationId, planName, masterPlanId, effectiveDate,
        stripeCustomerId, stripeSubscriptionId,
    } = params;

    try {
        const { person, fullName, companyName } = await loadSubject(db, userId, organisationId);

        let tierKey: string | null = null;
        let resolvedPlanName = planName || 'unknown plan';
        let mrrPence: number | null = null;
        if (masterPlanId) {
            const [mp] = await db
                .select({ name: masterPlans.name, tierKey: masterPlans.tierKey, price: masterPlans.monthlyPriceGbp })
                .from(masterPlans)
                .where(eq(masterPlans.id, masterPlanId))
                .limit(1);
            if (mp) {
                resolvedPlanName = mp.name;
                tierKey = mp.tierKey;
                const p = Math.round(parseFloat(String(mp.price)) * 100);
                if (Number.isFinite(p)) mrrPence = p;
            }
        }

        const { subject, html, text } = buildCancellationAlertEmail({
            companyName,
            fullName,
            email:              person?.email ?? null,
            planLabel:          tierKey ? `${resolvedPlanName} (${tierKey})` : resolvedPlanName,
            mrrLostLabel:       mrrPence !== null ? `-${formatMoney(mrrPence, 'gbp')} / month` : null,
            effectiveLabel:     effectiveDate ? effectiveDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : null,
            customerSinceLabel: person?.createdAt ? new Date(person.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : null,
            userId,
            organisationId,
            stripeCustomerId,
            stripeSubscriptionId,
        });

        await sendEmail({ to: FOUNDER_EMAIL, subject, html, text });
        console.log(`[founder-alerts] cancellation alert sent to ${FOUNDER_EMAIL} for user ${userId} (${resolvedPlanName})`);
    } catch (err: any) {
        console.error('[founder-alerts] cancellation alert FAILED (non-blocking):', err?.message || err);
    }
}
