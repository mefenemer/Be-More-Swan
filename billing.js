// billing.js — Billing & Subscription page controller
(function () {

    // ── Module state ──────────────────────────────────────────────
    let _subscriptions  = [];
    let _cancelTarget   = null;
    let _billingInfo    = null;   // cached billing details object

    // Stripe Elements state
    let _stripe         = null;
    let _elements       = null;
    let _cardNumber     = null;
    let _cardExpiry     = null;
    let _cardCvc        = null;
    let _setupClientSecret = null;

    // ── Public entry point ────────────────────────────────────────
    window.initBilling = async function () {
        _cancelTarget = null;
        _showState('loading');
        try {
            const [billingRes, invoicesRes, billingInfoRes] = await Promise.all([
                fetch('/.netlify/functions/billing-data'),
                fetch('/.netlify/functions/invoice-list'),
                fetch('/.netlify/functions/billing-information'),
            ]);

            if (!billingRes.ok) {
                const err = await billingRes.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${billingRes.status}`);
            }

            const { subscriptions, paymentHistory, storage } = await billingRes.json();
            const invoicesData  = invoicesRes.ok  ? await invoicesRes.json().catch(() => ({}))  : {};
            const billingInfoData = billingInfoRes.ok ? await billingInfoRes.json().catch(() => ({})) : {};

            _subscriptions = subscriptions || [];
            _billingInfo   = billingInfoData.billingInfo || null;

            _render(_subscriptions, paymentHistory || [], invoicesData.invoices || [], _billingInfo, storage || null);

            // Live AI-credit balance (non-blocking — never fails the billing render)
            _loadAiCreditBalance();

            // If navigated here via notification deep-link
            if (window.location.hash === '#invoice-history') {
                setTimeout(() => {
                    const el = document.getElementById('invoice-history-section');
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }, 300);
            }
        } catch (e) {
            console.error('[billing]', e);
            const msg = document.getElementById('billing-error-msg');
            if (msg) msg.textContent = e.message || 'Unable to load billing data.';
            _showState('error');
        }
    };

    // ── Live AI-credit balance ────────────────────────────────────
    async function _loadAiCreditBalance() {
        const valueEl = document.getElementById('ai-credit-balance-value');
        const heldEl  = document.getElementById('ai-credit-held-note');
        if (!valueEl) return;
        try {
            const res = await fetch('/.netlify/functions/get-ai-credit-balance');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const { balance, held, monthlyCredits } = await res.json();
            const bal = Number(balance) || 0;
            valueEl.textContent = `${bal.toLocaleString()} credit${bal === 1 ? '' : 's'} available`;

            const monthlyEl = document.getElementById('ai-credit-monthly-note');
            const monthlyNum = Number(monthlyCredits) || 0;
            if (monthlyEl) {
                if (monthlyNum > 0) {
                    monthlyEl.textContent = `Your plan includes ${monthlyNum.toLocaleString()} credit${monthlyNum === 1 ? '' : 's'} each month.`;
                    monthlyEl.classList.remove('hidden');
                } else {
                    monthlyEl.classList.add('hidden');
                }
            }

            const heldNum = Number(held) || 0;
            if (heldEl) {
                if (heldNum > 0) {
                    heldEl.textContent = `${heldNum.toLocaleString()} credit${heldNum === 1 ? '' : 's'} reserved by in-progress generations.`;
                    heldEl.classList.remove('hidden');
                } else {
                    heldEl.classList.add('hidden');
                }
            }
        } catch (e) {
            console.warn('[billing] Unable to load AI credit balance:', e);
            valueEl.textContent = 'Balance unavailable';
        }
    }

    // ── Card Modal ────────────────────────────────────────────────
    window._billingOpenCardModal = async function () {
        // Reset modal state
        _setupClientSecret = null;
        _stripe = null;
        _cardNumber = _cardExpiry = _cardCvc = null;

        const modal      = document.getElementById('modal-card-form');
        const loadingEl  = document.getElementById('card-form-loading');
        const fieldsEl   = document.getElementById('card-form-fields');
        const errorEl    = document.getElementById('card-form-error');
        const saveBtn    = document.getElementById('btn-save-card');

        // Show modal in loading state
        modal.classList.remove('hidden');
        loadingEl.classList.remove('hidden');
        fieldsEl.classList.add('hidden');
        errorEl.classList.add('hidden');
        saveBtn.disabled = true;
        document.getElementById('card-holder-name').value = '';
        document.getElementById('card-postal-code').value = '';

        try {
            // 1. Get SetupIntent client secret + publishable key from our backend
            const res  = await fetch('/.netlify/functions/billing-setup-intent', { method: 'POST' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

            _setupClientSecret = data.clientSecret;
            const publishableKey = data.publishableKey;
            if (!publishableKey) throw new Error('Stripe is not configured on this account.');

            // 2. Load Stripe.js lazily (avoid loading on every page)
            if (!window.Stripe) {
                await _loadStripeJs();
            }
            _stripe = window.Stripe(publishableKey);

            // 3. Mount individual Elements for custom styling
            const elementStyle = {
                base: {
                    fontSize: '14px',
                    color: '#111827',
                    fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
                    fontSmoothing: 'antialiased',
                    '::placeholder': { color: '#9ca3af' },
                },
                invalid: { color: '#dc2626', iconColor: '#dc2626' },
            };

            _elements   = _stripe.elements();
            _cardNumber = _elements.create('cardNumber', { style: elementStyle, showIcon: true, disableLink: true });
            _cardExpiry = _elements.create('cardExpiry', { style: elementStyle });
            _cardCvc    = _elements.create('cardCvc',    { style: elementStyle });

            _cardNumber.mount('#stripe-card-number');
            _cardExpiry.mount('#stripe-card-expiry');
            _cardCvc.mount('#stripe-card-cvc');

            // Enable save once card number is valid
            _cardNumber.on('change', e => {
                saveBtn.disabled = !e.complete;
                if (e.error) {
                    errorEl.textContent = e.error.message;
                    errorEl.classList.remove('hidden');
                } else {
                    errorEl.classList.add('hidden');
                }
            });

            // Show fields
            loadingEl.classList.add('hidden');
            fieldsEl.classList.remove('hidden');

        } catch (e) {
            console.error('[billing-card-modal]', e);
            loadingEl.innerHTML = `<p class="text-sm text-red-500">${e.message || 'Failed to load card form.'}</p>`;
        }
    };

    window._billingCloseCardModal = function () {
        document.getElementById('modal-card-form').classList.add('hidden');
        // Unmount Elements to avoid double-mount errors if re-opened
        if (_cardNumber) { try { _cardNumber.unmount(); } catch (_) {} _cardNumber = null; }
        if (_cardExpiry) { try { _cardExpiry.unmount(); } catch (_) {} _cardExpiry = null; }
        if (_cardCvc)    { try { _cardCvc.unmount();    } catch (_) {} _cardCvc    = null; }
        _stripe = null;
        _elements = null;
        _setupClientSecret = null;
    };

    window._billingSaveCard = async function () {
        if (!_stripe || !_setupClientSecret || !_cardNumber) return;

        const saveBtn    = document.getElementById('btn-save-card');
        const errorEl    = document.getElementById('card-form-error');
        const nameEl     = document.getElementById('card-holder-name');
        const postalEl   = document.getElementById('card-postal-code');
        const postalCode = postalEl ? postalEl.value.trim().toUpperCase() : '';

        saveBtn.disabled = true;
        saveBtn.innerHTML = `<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" class="opacity-25"/><path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" class="opacity-75"/></svg> Saving…`;
        errorEl.classList.add('hidden');

        try {
            // Confirm the SetupIntent — Stripe tokenises the card in its iframe,
            // no raw card data touches our servers
            const { setupIntent, error } = await _stripe.confirmCardSetup(_setupClientSecret, {
                payment_method: {
                    card: _cardNumber,
                    billing_details: {
                        name: nameEl.value.trim() || undefined,
                        address: postalCode ? { postal_code: postalCode } : undefined,
                    },
                },
            });

            if (error) throw new Error(error.message);
            if (!setupIntent?.payment_method) throw new Error('Card setup did not complete.');

            // Attach the PaymentMethod to the customer + set as default
            const res  = await fetch('/.netlify/functions/billing-attach-payment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paymentMethodId: setupIntent.payment_method, postalCode }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

            // Update the payment method section in the UI immediately (no full reload)
            if (data.paymentMethod) {
                _updatePaymentMethodUI(data.paymentMethod);
            }

            window._billingCloseCardModal();

        } catch (e) {
            console.error('[billing-save-card]', e);
            errorEl.textContent = e.message || 'Failed to save card. Please try again.';
            errorEl.classList.remove('hidden');
            saveBtn.disabled = false;
            saveBtn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg> Save Card`;
        }
    };

    // ── Cancel Subscription — US-GAP-4.1.1 Exit Survey ───────────
    // Helper: show only the specified step panel
    function _cancelShowStep(n) {
        [1, 2, 3].forEach(i => {
            const el = document.getElementById('cancel-step-' + i);
            if (el) el.classList.toggle('hidden', i !== n);
        });
    }

    window._billingOpenCancelModal = function (stripeSubscriptionId, planName, renewalDate) {
        _cancelTarget = { stripeSubscriptionId, planName, renewalDate };

        // Pre-populate Step 3 message
        const msg     = document.getElementById('cancel-sub-msg');
        const endDate = renewalDate ? _fmtDate(renewalDate) : 'the end of the billing period';
        if (msg) {
            msg.textContent = `"${planName}" will remain active until ${endDate}, then it will not renew. You will lose access to this assistant at that point.`;
        }

        // Reset state
        document.querySelectorAll('input[name="cancel-reason"]').forEach(r => { r.checked = false; });
        const ftEl = document.getElementById('cancel-free-text');
        if (ftEl) ftEl.value = '';
        const errEl = document.getElementById('cancel-sub-error');
        if (errEl) errEl.classList.add('hidden');
        const pauseErrEl = document.getElementById('cancel-pause-error');
        if (pauseErrEl) pauseErrEl.classList.add('hidden');
        const confirmBtn = document.getElementById('btn-confirm-cancel');
        if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Yes, Cancel'; }

        // SC1: always start at Step 1 (exit survey)
        _cancelShowStep(1);
        document.getElementById('modal-cancel-sub').classList.remove('hidden');
    };

    // SC1 → SC3: submit reason (if any) then show pause offer
    window._cancelStep1Next = async function () {
        const selected = document.querySelector('input[name="cancel-reason"]:checked');
        const freeText = (document.getElementById('cancel-free-text')?.value || '').trim();

        if (selected) {
            // SC2: store reason fire-and-forget — don't block the flow
            fetch('/.netlify/functions/cancellation-survey', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason: selected.value, freeText: freeText || undefined }),
            }).catch(() => {});
        }

        // SC3: show pause offer
        _cancelShowStep(2);
    };

    // SC6: skip survey → go straight to Step 3
    window._cancelSkipToStep3 = function () {
        _cancelShowStep(3);
    };

    // SC5: from Step 2, proceed to final confirmation
    window._cancelShowStep3 = function () {
        _cancelShowStep(3);
    };

    // SC4: pause account instead of cancelling
    window._cancelPauseAccount = async function () {
        const btn    = document.getElementById('btn-pause-account');
        const errEl  = document.getElementById('cancel-pause-error');
        if (btn)   { btn.disabled = true; btn.textContent = 'Pausing…'; }
        if (errEl) errEl.classList.add('hidden');

        try {
            const res  = await fetch('/.netlify/functions/cancellation-survey', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'pause' }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

            document.getElementById('modal-cancel-sub').classList.add('hidden');
            _cancelTarget = null;
            await window.initBilling();
        } catch (e) {
            console.error('[cancel-pause]', e);
            if (errEl) { errEl.textContent = e.message || 'Failed to pause. Please try again.'; errEl.classList.remove('hidden'); }
            if (btn)   { btn.disabled = false; btn.textContent = 'Pause My Account'; }
        }
    };

    window._billingCloseCancelModal = function () {
        document.getElementById('modal-cancel-sub').classList.add('hidden');
        _cancelTarget = null;
    };

    window._billingConfirmCancel = async function () {
        if (!_cancelTarget) return;
        const { stripeSubscriptionId } = _cancelTarget;

        const confirmBtn = document.getElementById('btn-confirm-cancel');
        const errEl      = document.getElementById('cancel-sub-error');
        if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Cancelling…'; }
        if (errEl) errEl.classList.add('hidden');

        // If no Stripe subscription ID, direct to support
        if (!stripeSubscriptionId) {
            if (errEl) {
                errEl.textContent = 'Please contact support@bemoreswan.com to cancel this subscription.';
                errEl.classList.remove('hidden');
            }
            if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Yes, Cancel'; }
            return;
        }

        try {
            const res  = await fetch('/.netlify/functions/billing-cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ stripeSubscriptionId }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

            document.getElementById('modal-cancel-sub').classList.add('hidden');
            _cancelTarget = null;
            await window.initBilling();

        } catch (e) {
            console.error('[billing-cancel]', e);
            if (errEl) { errEl.textContent = e.message || 'Failed to cancel. Please try again.'; errEl.classList.remove('hidden'); }
            if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Yes, Cancel'; }
        }
    };

    // ── Receipt Modal ─────────────────────────────────────────────
    window._billingOpenReceiptModal = function (paymentId) {
        const modal     = document.getElementById('modal-receipt');
        const iframe    = document.getElementById('receipt-iframe');
        const loading   = document.getElementById('receipt-loading');
        const tabLink   = document.getElementById('receipt-new-tab-link');
        const url       = `/.netlify/functions/billing-receipt?id=${paymentId}`;

        // Reset
        iframe.src      = 'about:blank';
        iframe.classList.add('opacity-0');
        loading.classList.remove('hidden');
        if (tabLink) tabLink.href = url;

        modal.classList.remove('hidden');

        // Load receipt HTML into iframe
        iframe.onload = function () {
            // about:blank fires onload too — skip it
            if (iframe.src === 'about:blank' || iframe.src === window.location.href) return;
            loading.classList.add('hidden');
            iframe.classList.remove('opacity-0');
        };
        iframe.src = url;
    };

    window._billingCloseReceiptModal = function () {
        const modal  = document.getElementById('modal-receipt');
        const iframe = document.getElementById('receipt-iframe');
        modal.classList.add('hidden');
        iframe.src = 'about:blank';
    };

    // ── Billing Details ───────────────────────────────────────────
    function _renderBillingDetails(info) {
        const emptyEl = document.getElementById('billing-details-empty');
        const infoEl  = document.getElementById('billing-details-info');
        if (!info) {
            emptyEl.classList.remove('hidden');
            infoEl.classList.add('hidden');
            return;
        }
        emptyEl.classList.add('hidden');
        infoEl.classList.remove('hidden');

        document.getElementById('bd-name').textContent    = info.fullName || '—';
        document.getElementById('bd-email').textContent   = info.email || '—';
        document.getElementById('bd-vat').textContent     = info.vatNumber || '—';

        const addrParts = [
            info.addressLine1, info.addressLine2,
            info.city, info.state, info.postalCode, info.country
        ].filter(Boolean);
        document.getElementById('bd-address').textContent = addrParts.join('\n') || '—';
    }

    window._billingDetailsEdit = function () {
        const info = _billingInfo;
        // Populate form with existing data (or blank)
        document.getElementById('bd-input-name').value    = info?.fullName    || '';
        document.getElementById('bd-input-email').value   = info?.email       || '';
        document.getElementById('bd-input-vat').value     = info?.vatNumber   || '';
        document.getElementById('bd-input-addr1').value   = info?.addressLine1 || '';
        document.getElementById('bd-input-addr2').value   = info?.addressLine2 || '';
        document.getElementById('bd-input-city').value    = info?.city        || '';
        document.getElementById('bd-input-postal').value  = info?.postalCode  || '';
        document.getElementById('bd-input-state').value   = info?.state       || '';
        document.getElementById('bd-input-country').value = info?.country     || '';

        document.getElementById('billing-details-display').classList.add('hidden');
        document.getElementById('billing-details-form').classList.remove('hidden');
        document.getElementById('btn-edit-billing-details').classList.add('hidden');
        document.getElementById('bd-form-error').classList.add('hidden');
    };

    window._billingDetailsCancel = function () {
        document.getElementById('billing-details-display').classList.remove('hidden');
        document.getElementById('billing-details-form').classList.add('hidden');
        document.getElementById('btn-edit-billing-details').classList.remove('hidden');
    };

    window._billingDetailsSave = async function () {
        const saveBtn = document.getElementById('btn-save-billing-details');
        const errorEl = document.getElementById('bd-form-error');
        errorEl.classList.add('hidden');

        const fullName = document.getElementById('bd-input-name').value.trim();
        if (!fullName) {
            errorEl.textContent = 'Legal name / company name is required.';
            errorEl.classList.remove('hidden');
            return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';

        try {
            const body = {
                fullName,
                email:        document.getElementById('bd-input-email').value.trim(),
                vatNumber:    document.getElementById('bd-input-vat').value.trim(),
                addressLine1: document.getElementById('bd-input-addr1').value.trim(),
                addressLine2: document.getElementById('bd-input-addr2').value.trim(),
                city:         document.getElementById('bd-input-city').value.trim(),
                postalCode:   document.getElementById('bd-input-postal').value.trim(),
                state:        document.getElementById('bd-input-state').value.trim(),
                country:      document.getElementById('bd-input-country').value.trim(),
            };

            const res  = await fetch('/.netlify/functions/billing-information', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

            _billingInfo = data.billingInfo || body;
            _renderBillingDetails(_billingInfo);
            window._billingDetailsCancel();

        } catch (e) {
            console.error('[billing-details-save]', e);
            errorEl.textContent = e.message || 'Failed to save. Please try again.';
            errorEl.classList.remove('hidden');
        } finally {
            saveBtn.disabled = false;
            saveBtn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg> Save Details`;
        }
    };

    // ── Invoice History ───────────────────────────────────────────
    function _renderInvoiceHistory(userInvoices) {
        const wrap  = document.getElementById('invoice-history-wrap');
        const empty = document.getElementById('invoice-history-empty');
        const tbody = document.getElementById('invoice-history-tbody');

        if (!userInvoices || userInvoices.length === 0) {
            wrap.classList.add('hidden');
            empty.classList.remove('hidden');
            return;
        }
        empty.classList.add('hidden');
        wrap.classList.remove('hidden');

        const statusMeta = {
            paid:     { label: 'Paid',     cls: 'bg-emerald-50 text-emerald-700' },
            void:     { label: 'Void',     cls: 'bg-gray-100 text-gray-500' },
            refunded: { label: 'Refunded', cls: 'bg-amber-50 text-amber-700' },
        };

        tbody.innerHTML = userInvoices.map(inv => {
            const sm       = statusMeta[(inv.status || '').toLowerCase()] || { label: inv.status || '—', cls: 'bg-gray-100 text-gray-500' };
            const currency = (inv.currency || 'GBP').toUpperCase();
            const symbol   = currency === 'GBP' ? '£' : `${currency} `;
            const amount   = inv.total ? `${symbol}${parseFloat(inv.total).toFixed(2)}` : '—';
            const date     = inv.issueDate || inv.createdAt;

            const downloadBtn = `<a href="/.netlify/functions/invoice-pdf?id=${inv.id}" target="_blank" rel="noopener"
                class="inline-flex items-center gap-1.5 px-3 py-1.5 border border-emerald-300 hover:border-emerald-400 text-emerald-700 hover:text-emerald-800 text-xs font-semibold rounded-lg transition bg-white cursor-pointer">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                Invoice
            </a>`;

            return `
            <tr class="hover:bg-gray-50 transition">
              <td class="px-5 py-4 font-mono text-xs text-gray-600 whitespace-nowrap">${_esc(inv.invoiceNumber || '—')}</td>
              <td class="px-5 py-4 text-gray-600 whitespace-nowrap">${_fmtDate(date)}</td>
              <td class="px-5 py-4 font-medium text-gray-900">${_esc(inv.planName || '—')}</td>
              <td class="px-5 py-4 font-bold text-gray-900 whitespace-nowrap">${amount}</td>
              <td class="px-5 py-4"><span class="text-xs font-bold px-2.5 py-1 rounded-full ${sm.cls}">${sm.label}</span></td>
              <td class="px-5 py-4 text-right">${downloadBtn}</td>
            </tr>`;
        }).join('');
    }

    // ── State helpers ─────────────────────────────────────────────
    function _showState(state) {
        document.getElementById('billing-loading').classList.toggle('hidden', state !== 'loading');
        document.getElementById('billing-error').classList.toggle('hidden', state !== 'error');
        document.getElementById('billing-content').classList.toggle('hidden', state !== 'content');
    }

    // ── Main render ───────────────────────────────────────────────
    function _render(subscriptions, paymentHistory, userInvoices, billingInfo, storage) {
        _renderSubscriptions(subscriptions);
        _renderPaymentMethod(subscriptions, paymentHistory);
        _renderBillingDetails(billingInfo);
        _renderStorageGauge(storage);
        _renderInvoiceHistory(userInvoices || []);
        _renderHistory(paymentHistory);

        _showState('content');
    }

    function _fmtBytes(b) {
        if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(1)} GB`;
        if (b >= 1_048_576)     return `${(b / 1_048_576).toFixed(1)} MB`;
        return `${(b / 1024).toFixed(0)} KB`;
    }

    function _renderStorageGauge(storage) {
        const section = document.getElementById('storage-usage-section');
        if (!section || !storage) return;

        const { usedBytes, limitBytes } = storage;
        if (limitBytes === null) return; // unlimited plan — hide gauge

        const pct = Math.min(100, Math.round((usedBytes / limitBytes) * 100));
        const label = document.getElementById('storage-label');
        const pctEl = document.getElementById('storage-pct');
        const bar   = document.getElementById('storage-bar');
        const atLimitEl = document.getElementById('storage-at-limit');

        if (label) label.textContent = `${_fmtBytes(usedBytes)} of ${_fmtBytes(limitBytes)} used`;
        if (pctEl) pctEl.textContent = `${pct}%`;
        if (bar) {
            bar.style.width = `${pct}%`;
            bar.className = `h-3 rounded-full transition-all duration-500 ${pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-400' : 'bg-emerald-500'}`;
        }
        if (atLimitEl) atLimitEl.classList.toggle('hidden', pct < 100);
        section.classList.remove('hidden');
    }

    // ── Subscriptions ─────────────────────────────────────────────
    function _renderSubscriptions(subs) {
        const list  = document.getElementById('subscriptions-list');
        const empty = document.getElementById('subscriptions-empty');

        const active = subs.filter(s =>
            ['active', 'trialing'].includes(s.stripeStatus || '') ||
            ['active', 'cancelling'].includes(s.status)
        );

        if (active.length === 0) { list.innerHTML = ''; empty.classList.remove('hidden'); return; }
        empty.classList.add('hidden');
        list.innerHTML = active.map(_subscriptionCard).join('');
    }

    function _subscriptionCard(sub) {
        const statusMeta = {
            active:       { label: 'Active',            cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
            trialing:     { label: 'Trial',              cls: 'bg-blue-50 text-blue-700 border-blue-200' },
            past_due:     { label: 'Past Due',           cls: 'bg-amber-50 text-amber-700 border-amber-200' },
            cancelling:   { label: 'Cancelling',         cls: 'bg-amber-50 text-amber-700 border-amber-200' },
            downgrading:  { label: 'Downgrade Scheduled', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
            cancelled:    { label: 'Cancelled',          cls: 'bg-gray-100 text-gray-500 border-gray-200' },
        };
        const sm     = statusMeta[sub.stripeStatus || sub.status] || statusMeta['active'];
        const cycle  = sub.billingCycle === 'year' ? 'Annually' : 'Monthly';
        const amount = sub.amountGbp ? `£${parseFloat(sub.amountGbp).toFixed(2)}`
                     : sub.currency  ? `${sub.currency.toUpperCase()} —` : '—';

        const renewalLine = sub.cancelAtPeriodEnd
            ? `<span class="text-amber-600 font-semibold">Cancels on ${_fmtDate(sub.renewalDate)}</span>`
            : sub.renewalDate
                ? `Renews <span class="font-semibold text-gray-800">${_fmtDate(sub.renewalDate)}</span>`
                : `Started <span class="font-semibold text-gray-800">${_fmtDate(sub.startedAt)}</span>`;

        // Show cancel button for any active/trialing plan — Stripe sub ID required for API cancel,
        // but also show it if we only have a local plan (user can contact support fallback)
        // 'cancelling' DB status means billing-cancel.ts already called Stripe but webhook hasn't fired yet
        const isCancelling = sub.cancelAtPeriodEnd || sub.status === 'cancelling';
        const isTerminated = ['cancelled', 'canceled'].includes(sub.stripeStatus || sub.status);
        const showCancel   = !isCancelling && !isTerminated;

        const cancelBtn = showCancel
            ? `<button onclick="window._billingOpenCancelModal('${_esc(sub.stripeSubscriptionId || '')}','${_esc(sub.planName)}','${sub.renewalDate || ''}')"
                 class="inline-flex items-center px-4 py-2 border border-red-200 hover:border-red-300 text-red-600 hover:text-red-700 text-sm font-semibold rounded-xl transition cursor-pointer bg-white hover:bg-red-50">
                 Cancel Subscription
               </button>`
            : isCancelling
                ? `<span class="text-xs font-semibold text-amber-600 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-lg">Cancels at period end</span>`
                : '';

        const isDowngrading = sub.status === 'downgrading';

        // SC6: Cancel Scheduled Downgrade button
        const cancelDowngradeBtn = isDowngrading
            ? `<button onclick="window._cancelScheduledDowngrade()"
                 class="inline-flex items-center px-4 py-2 border border-amber-200 hover:border-amber-400 text-amber-700 text-sm font-semibold rounded-xl transition cursor-pointer bg-white hover:bg-amber-50">
                 Cancel Downgrade
               </button>`
            : '';

        // SC1: Change Plan button — opens upgrade modal
        const changePlanBtn = !isTerminated && !isCancelling && !isDowngrading
            ? `<button onclick="window._openChangePlanModal()"
                 class="inline-flex items-center px-4 py-2 border border-gray-200 hover:border-emerald-400 text-gray-700 hover:text-emerald-700 text-sm font-semibold rounded-xl transition cursor-pointer bg-white hover:bg-emerald-50">
                 Change Plan
               </button>`
            : '';

        return `
        <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <div class="flex items-start justify-between gap-4 flex-wrap">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1 flex-wrap">
                <h3 class="text-base font-extrabold text-gray-900">${_esc(sub.planName)}</h3>
                <span class="text-xs font-bold px-2.5 py-1 rounded-full border ${sm.cls}">${sm.label}</span>
              </div>
              <p class="text-sm text-gray-500">${cycle} billing · ${renewalLine}</p>
            </div>
            <div class="flex items-start gap-3 flex-wrap">
              <div class="text-right shrink-0">
                <p class="text-2xl font-extrabold text-gray-900">${amount}</p>
                <p class="text-xs text-gray-400">per ${_esc(sub.billingCycle || 'month')}</p>
              </div>
              ${cancelDowngradeBtn ? `<div class="flex items-center pt-1">${cancelDowngradeBtn}</div>` : ''}
              ${changePlanBtn ? `<div class="flex items-center pt-1">${changePlanBtn}</div>` : ''}
              ${cancelBtn ? `<div class="flex items-center pt-1">${cancelBtn}</div>` : ''}
            </div>
          </div>
        </div>`;
    }

    // ── Payment Method ────────────────────────────────────────────
    function _renderPaymentMethod(subs, history) {
        const cardEl  = document.getElementById('payment-method-card');
        const emptyEl = document.getElementById('payment-method-empty');

        // 1. Prefer card details from a live Stripe subscription (most current)
        let pm = subs.find(s => s.paymentMethod)?.paymentMethod || null;

        // 2. Fall back to DB-stored card details from the most recent completed payment
        if (!pm && Array.isArray(history)) {
            const recent = history.find(p =>
                p.paymentMethod && typeof p.paymentMethod === 'object' && p.paymentMethod.last4
            );
            if (recent) pm = recent.paymentMethod;
        }

        if (!pm) { cardEl.classList.add('hidden'); emptyEl.classList.remove('hidden'); return; }
        emptyEl.classList.add('hidden');
        cardEl.classList.remove('hidden');
        _applyPaymentMethodToUI(pm);
    }

    function _applyPaymentMethodToUI(pm) {
        const brandBadge = document.getElementById('pm-brand-badge');
        if (brandBadge) brandBadge.innerHTML = _brandBadgeHtml(pm.brand);

        const brandLabel = document.getElementById('pm-brand-label');
        if (brandLabel) brandLabel.textContent = pm.brand || 'Card';

        const last4El = document.getElementById('pm-last4');
        if (last4El) last4El.textContent = pm.last4 || '';

        const expiryEl = document.getElementById('pm-expiry');
        if (expiryEl) expiryEl.textContent = `${String(pm.expMonth).padStart(2, '0')} / ${pm.expYear}`;

        const warnEl = document.getElementById('pm-expiry-warn');
        if (warnEl && pm.expMonth && pm.expYear) {
            const expiryDate = new Date(pm.expYear, pm.expMonth - 1, 1);
            const soon       = new Date(); soon.setDate(soon.getDate() + 60);
            warnEl.classList.toggle('hidden', expiryDate > soon);
        }
    }

    // Called after a card is saved — updates the UI without a full reload
    function _updatePaymentMethodUI(pm) {
        const cardEl  = document.getElementById('payment-method-card');
        const emptyEl = document.getElementById('payment-method-empty');
        emptyEl.classList.add('hidden');
        cardEl.classList.remove('hidden');
        _applyPaymentMethodToUI(pm);
    }

    function _brandBadgeHtml(brand) {
        const b = (brand || '').toLowerCase();
        const badges = {
            visa:       `<span class="text-blue-800 font-extrabold text-sm tracking-widest">VISA</span>`,
            mastercard: `<span class="text-red-600 font-extrabold text-sm">MC</span>`,
            amex:       `<span class="text-blue-500 font-extrabold text-xs tracking-wide">AMEX</span>`,
            discover:   `<span class="text-orange-500 font-extrabold text-xs">DISC</span>`,
        };
        return badges[b] || `<svg class="w-7 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"/></svg>`;
    }

    // ── Payment History ───────────────────────────────────────────
    function _renderHistory(payments) {
        const wrap  = document.getElementById('history-wrap');
        const empty = document.getElementById('history-empty');
        const tbody = document.getElementById('history-tbody');

        if (payments.length === 0) { wrap.classList.add('hidden'); empty.classList.remove('hidden'); return; }
        empty.classList.add('hidden');
        wrap.classList.remove('hidden');

        const statusMeta = {
            completed: { label: 'Paid',     cls: 'bg-emerald-50 text-emerald-700' },
            paid:      { label: 'Paid',     cls: 'bg-emerald-50 text-emerald-700' },
            pending:   { label: 'Pending',  cls: 'bg-amber-50 text-amber-700' },
            failed:    { label: 'Failed',   cls: 'bg-red-50 text-red-700' },
            refunded:  { label: 'Refunded', cls: 'bg-gray-100 text-gray-600' },
        };

        tbody.innerHTML = payments.map(p => {
            const sm       = statusMeta[(p.status || '').toLowerCase()] || { label: p.status || '—', cls: 'bg-gray-100 text-gray-600' };
            const currency = (p.currency || 'GBP').toUpperCase();
            const symbol   = currency === 'GBP' ? '£' : `${currency} `;
            const amount   = p.amount ? `${symbol}${parseFloat(p.amount).toFixed(2)}` : '—';

            let pmCell = '—';
            if (p.paymentMethod && typeof p.paymentMethod === 'object') {
                pmCell = `<div class="flex items-center gap-1.5">${_cardIconSvg(p.paymentMethod.brand)}<span class="capitalize">${_esc(p.paymentMethod.brand)}</span> ···· ${_esc(p.paymentMethod.last4)}</div>`;
            } else if (typeof p.paymentMethod === 'string' && p.paymentMethod) {
                pmCell = _esc(p.paymentMethod);
            }

            // Receipt opens as an in-page modal; Stripe PDF link shown alongside when available.
            const receiptCell = `<div class="flex items-center justify-end gap-3">
                     <button onclick="window._billingOpenReceiptModal(${p.id})"
                         class="inline-flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 hover:border-gray-400 text-gray-700 hover:text-gray-900 text-xs font-semibold rounded-lg transition bg-white cursor-pointer">
                         <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                         Receipt
                     </button>
                     ${p.receiptPdf ? `<a href="${p.receiptPdf}" target="_blank" rel="noopener"
                         class="inline-flex items-center gap-1 text-emerald-600 hover:text-emerald-700 text-xs font-semibold transition">
                         <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                         PDF
                       </a>` : ''}
                   </div>`;

            return `
            <tr class="hover:bg-gray-50 transition">
              <td class="px-5 py-4 text-gray-600 whitespace-nowrap">${_fmtDate(p.date)}</td>
              <td class="px-5 py-4 font-medium text-gray-900">${_esc(p.description || '—')}</td>
              <td class="px-5 py-4 font-bold text-gray-900 whitespace-nowrap">${amount}</td>
              <td class="px-5 py-4 text-gray-600 whitespace-nowrap">${pmCell}</td>
              <td class="px-5 py-4"><span class="text-xs font-bold px-2.5 py-1 rounded-full ${sm.cls}">${sm.label}</span></td>
              <td class="px-5 py-4 text-right">${receiptCell}</td>
            </tr>`;
        }).join('');
    }

    // ── Helpers ───────────────────────────────────────────────────
    function _loadStripeJs() {
        return new Promise((resolve, reject) => {
            if (document.getElementById('stripe-js')) { resolve(); return; }
            const s    = document.createElement('script');
            s.id       = 'stripe-js';
            s.src      = 'https://js.stripe.com/v3/';
            s.onload   = resolve;
            s.onerror  = () => reject(new Error('Failed to load Stripe.js'));
            document.head.appendChild(s);
        });
    }

    function _fmtDate(iso) {
        if (!iso) return '—';
        return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    function _esc(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _cardIconSvg(brand) {
        const colors = { visa: 'text-blue-700', mastercard: 'text-red-600', amex: 'text-blue-500', discover: 'text-orange-600' };
        const cls = colors[(brand || '').toLowerCase()] || 'text-gray-500';
        return `<svg class="w-5 h-5 shrink-0 ${cls}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"/></svg>`;
    }

})();
