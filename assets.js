window.initBrandAssets = function() {
    const btnFile = document.getElementById('btn-tab-file');
    if (!btnFile) return;

    const btnUrl = document.getElementById('btn-tab-url');
    const zoneFile = document.getElementById('zone-file');
    const zoneUrl = document.getElementById('zone-url');
    const inputUrl = document.getElementById('external-url');
    const inputFile = document.getElementById('file-upload');

    let currentMode = 'file';

    // ── Helpers ───────────────────────────────────────────────────────────────
    const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const fmtBytes = (b) => {
        if (!b) return '';
        if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(1)} MB`;
        return `${Math.max(1, Math.round(b / 1024))} KB`;
    };
    // Literal class strings (so Tailwind's scanner compiles them — no dynamic class names).
    const STATUS_STYLES = {
        confirmed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        active:    'bg-emerald-50 text-emerald-700 border-emerald-200',
        pending:   'bg-amber-50 text-amber-700 border-amber-200',
        failed:    'bg-red-50 text-red-700 border-red-200',
    };
    // Friendly labels for the asset category slugs (mirror the upload dropdown in assets.html).
    const CATEGORY_LABELS = {
        tone_of_voice: 'Tone of Voice / Style',
        logo:          'Brand Logo / Visuals',
        product_info:  'Product Knowledge',
        general:       'General Context',
    };
    const categoryLabel = (slug) => CATEGORY_LABELS[slug] || (slug ? String(slug).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '');
    // Plain-language explanation of each status (tooltip on the pill / Unavailable label).
    const STATUS_HINTS = {
        confirmed: 'Uploaded and ready to use.',
        pending:   "This upload didn't finish, so the file isn't available yet. Remove it and try uploading again.",
        processing:'This upload is still being processed — check back shortly.',
        failed:    'This upload failed. Remove it and try again.',
        default:   'This file is not available to download yet.',
    };
    const FILE_ICON = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16"></path></svg>`;

    // On-brand replacement for the native window.confirm() — styled to match the
    // site's modals (see my-content.html). Returns a Promise<boolean>; only uses
    // Tailwind classes already present in the prebuilt style.css.
    function confirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel' }) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'fixed inset-0 bg-gray-900/60 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 backdrop-blur-sm';
            overlay.innerHTML = `
                <div class="bg-white w-full sm:rounded-2xl sm:max-w-md shadow-2xl flex flex-col overflow-hidden">
                    <div class="p-6">
                        <div class="flex items-start gap-4">
                            <div class="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center shrink-0 text-red-600">
                                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                            </div>
                            <div class="min-w-0">
                                <h3 class="text-lg font-bold text-gray-900">${escHtml(title)}</h3>
                                <p class="text-sm text-gray-500 mt-1">${escHtml(message)}</p>
                            </div>
                        </div>
                    </div>
                    <div class="px-6 py-4 bg-gray-50 border-t border-gray-100 flex justify-end gap-3">
                        <button type="button" data-confirm-cancel class="px-4 py-2.5 bg-white border border-gray-200 hover:bg-gray-100 text-gray-700 text-sm font-bold rounded-xl transition cursor-pointer">${escHtml(cancelLabel)}</button>
                        <button type="button" data-confirm-ok class="px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white text-sm font-bold rounded-xl shadow transition cursor-pointer">${escHtml(confirmLabel)}</button>
                    </div>
                </div>`;

            const close = (result) => {
                document.removeEventListener('keydown', onKey);
                overlay.remove();
                resolve(result);
            };
            const onKey = (e) => { if (e.key === 'Escape') close(false); };

            overlay.querySelector('[data-confirm-cancel]').addEventListener('click', () => close(false));
            overlay.querySelector('[data-confirm-ok]').addEventListener('click', () => close(true));
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
            document.addEventListener('keydown', onKey);

            document.body.appendChild(overlay);
            overlay.querySelector('[data-confirm-ok]').focus();
        });
    }

    // --- TAB TOGGLING ---
    const updateTabs = (mode) => {
        currentMode = mode;
        const activeClass = 'flex-1 py-1.5 text-xs font-bold bg-white text-gray-900 rounded-md shadow-sm transition-all';
        const inactiveClass = 'flex-1 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 transition-all';
        btnFile.className = mode === 'file' ? activeClass : inactiveClass;
        btnUrl.className = mode === 'url' ? activeClass : inactiveClass;
        zoneFile.classList.toggle('hidden', mode !== 'file');
        zoneFile.classList.toggle('block', mode === 'file');
        zoneUrl.classList.toggle('hidden', mode !== 'url');
        zoneUrl.classList.toggle('block', mode === 'url');
    };
    btnFile.addEventListener('click', () => updateTabs('file'));
    btnUrl.addEventListener('click', () => updateTabs('url'));

    // --- DRAG & DROP HANDLING ---
    const dropZone = document.getElementById('drop-zone');
    const fileNameDisplay = document.getElementById('file-name-display');

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, e => { e.preventDefault(); e.stopPropagation(); }, false);
    });
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.add('border-emerald-500', 'bg-emerald-50'), false);
    });
    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.remove('border-emerald-500', 'bg-emerald-50'), false);
    });
    dropZone.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));
    // Click anywhere in the drop zone opens the file picker. The input is sr-only and
    // nested in a <span> (not a <label>), so it isn't triggered on click natively. Guard
    // against the input's own programmatic click bubbling back here (would re-open in a loop).
    dropZone.addEventListener('click', (e) => { if (e.target !== inputFile) inputFile.click(); });
    inputFile.addEventListener('change', function() { handleFiles(this.files); });

    function handleFiles(files) {
        if (files.length > 0) {
            const file = files[0];
            if (file.size > 10 * 1024 * 1024) {
                window.showToast?.('File is too large. Maximum size is 10MB.', { icon: '⚠️' });
                inputFile.value = '';
                return;
            }
            fileNameDisplay.textContent = `Selected: ${file.name}`;
            fileNameDisplay.classList.remove('hidden');
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            inputFile.files = dataTransfer.files;
            // Auto-upload as soon as a file is chosen — no Upload button needed.
            // If no category is picked yet, hold until the category is selected.
            if (document.getElementById('asset-category').value) submitAsset();
            else setAssetStatus('Choose a category above to upload.', 'pending');
        }
    }

    // --- AUTO UPLOAD (no button) ---
    const form = document.getElementById('asset-upload-form');
    const categorySelect = document.getElementById('asset-category');
    const assetStatusEl = document.getElementById('asset-upload-status');
    let _uploading = false;

    function setAssetStatus(msg, kind) {
        if (!assetStatusEl) return;
        if (!msg) { assetStatusEl.classList.add('hidden'); return; }
        assetStatusEl.textContent = msg;
        assetStatusEl.classList.remove('hidden', 'text-emerald-700', 'text-red-600', 'text-gray-400');
        assetStatusEl.classList.add(kind === 'error' ? 'text-red-600' : kind === 'pending' ? 'text-gray-400' : 'text-emerald-700');
    }

    async function submitAsset() {
        if (_uploading) return;
        const category = categorySelect.value;
        if (!category) { setAssetStatus('Select a category first.', 'error'); return; }
        _uploading = true;
        try {
            if (currentMode === 'file') {
                const file = inputFile.files[0];
                if (!file) { setAssetStatus('Choose a file to upload.', 'error'); return; }
                setAssetStatus(`Uploading ${file.name}…`, 'pending');
                await uploadFileToR2(file, category);
            } else {
                const url = inputUrl.value.trim();
                if (!url) { setAssetStatus('Enter a URL first.', 'error'); return; }
                setAssetStatus('Adding URL…', 'pending');
                const payload = new FormData();
                payload.append('category', category);
                payload.append('url', url);
                const response = await fetch('/.netlify/functions/upload-asset', { method: 'POST', body: payload });
                if (!response.ok) throw new Error('Failed to save URL asset.');
            }
            await loadAssets();
            form.reset();
            fileNameDisplay.classList.add('hidden');
            inputFile.value = '';
            updateTabs('file');
            setAssetStatus('Added ✓', 'success');
            setTimeout(() => setAssetStatus(''), 2500);
        } catch (error) {
            console.error('Save failed:', error);
            setAssetStatus(error.message || 'Upload failed. Please try again.', 'error');
        } finally {
            _uploading = false;
        }
    }

    // A category chosen after the file → upload now.
    categorySelect.addEventListener('change', () => {
        if (currentMode === 'file' && inputFile.files && inputFile.files[0]) submitAsset();
    });
    // URL mode: add on Enter.
    inputUrl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitAsset(); }
    });
    // No submit button, but guard against an implicit submit (Enter in a field).
    form.addEventListener('submit', (e) => e.preventDefault());

    // 3-step presigned R2 upload: request → PUT to R2 → confirm.
    async function uploadFileToR2(file, category) {
        const mimeType = file.type || 'application/octet-stream';
        const assetType = mimeType.startsWith('image/') ? 'brand_logo' : 'brand_document';

        // 1. Ask for a presigned PUT URL (org is resolved server-side from the session)
        const reqRes = await fetch('/.netlify/functions/storage-request-upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assetType, category, filename: file.name, mimeType, fileSizeBytes: file.size }),
        });
        if (!reqRes.ok) {
            const err = await reqRes.json().catch(() => ({}));
            throw new Error(err.error === 'storage_quota_exceeded'
                ? 'Storage quota exceeded — remove an asset or upgrade your plan.'
                : (err.error || 'Could not start the upload.'));
        }
        const { uploadUrl, assetId } = await reqRes.json();

        // 2. Upload the bytes straight to R2 via the presigned URL
        const putRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: file });
        if (!putRes.ok) throw new Error('Upload to storage failed. Please try again.');

        // 3. Confirm — verifies the object, counts the bytes, and kicks off AI extraction
        const confRes = await fetch('/.netlify/functions/storage-confirm-upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assetId }),
        });
        if (!confRes.ok) {
            const err = await confRes.json().catch(() => ({}));
            throw new Error(err.error || 'Could not confirm the upload.');
        }
    }

    // ── Listing / display ───────────────────────────────────────────────────
    async function loadAssets() {
        const list = document.getElementById('asset-list');
        if (!list) return;
        try {
            const res = await fetch('/.netlify/functions/get-workspace-assets');
            if (!res.ok) return;
            const { assets } = await res.json();
            renderAssets(assets || []);
        } catch { /* non-fatal */ }
    }

    function renderAssets(assets) {
        const list = document.getElementById('asset-list');
        if (!list) return;
        if (!assets.length) {
            list.innerHTML = '<li class="p-6 text-sm text-gray-400 text-center">No brand assets yet — upload a file or add a URL above.</li>';
            return;
        }
        list.innerHTML = assets.map(a => {
            const styles = STATUS_STYLES[a.status] || 'bg-gray-50 text-gray-600 border-gray-200';
            const catLabel = categoryLabel(a.category);
            const sizeLabel = fmtBytes(a.fileSizeBytes);
            // Download is only valid once the upload is confirmed in storage; a pending/failed
            // upload has no downloadable object, so show a muted hint instead of a 404-ing link.
            let action;
            if (a.isFile) {
                action = a.status === 'confirmed'
                    ? `<button type="button" data-download="${a.id}" class="text-xs font-semibold text-emerald-700 hover:text-emerald-800 underline">Download</button>`
                    : `<span class="text-xs font-medium text-gray-400" title="${escHtml(STATUS_HINTS[a.status] || STATUS_HINTS.default)}">Unavailable</span>`;
            } else {
                action = a.externalUrl ? `<a href="${escHtml(a.externalUrl)}" target="_blank" rel="noopener" class="text-xs font-semibold text-emerald-700 hover:text-emerald-800 underline">Open</a>` : '';
            }
            const statusHint = STATUS_HINTS[a.status] || STATUS_HINTS.default;
            return `<li class="p-6 hover:bg-gray-50 transition-colors flex items-center justify-between gap-4">
                <div class="flex items-center gap-4 min-w-0">
                    <div class="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0 text-gray-500">${FILE_ICON}</div>
                    <div class="truncate">
                        <p class="text-sm font-bold text-gray-900 truncate">${escHtml(a.name)}</p>
                        <p class="text-xs text-gray-400 mt-0.5 flex items-center gap-2 flex-wrap">
                            ${catLabel ? `<span class="inline-flex items-center py-0.5 px-2 rounded-md text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-100">${escHtml(catLabel)}</span>` : ''}
                            ${sizeLabel ? `<span>${escHtml(sizeLabel)}</span>` : ''}
                        </p>
                    </div>
                </div>
                <div class="flex items-center gap-3 shrink-0">
                    ${action}
                    <span class="inline-flex items-center py-1 px-2.5 rounded-md text-xs font-medium border ${styles}" title="${escHtml(statusHint)}">${escHtml(a.status)}</span>
                    <button type="button" data-remove="${a.id}" data-name="${escHtml(a.name)}" class="text-xs font-semibold text-gray-400 hover:text-red-600 transition-colors" title="Remove this asset">Remove</button>
                </div>
            </li>`;
        }).join('');

        list.querySelectorAll('[data-download]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.getAttribute('data-download');
                try {
                    const res = await fetch(`/.netlify/functions/storage-download-url?assetId=${id}`);
                    if (!res.ok) throw new Error();
                    const { downloadUrl } = await res.json();
                    window.open(downloadUrl, '_blank', 'noopener');
                } catch { window.showToast?.('Could not generate a download link.', { icon: '⚠️' }); }
            });
        });

        list.querySelectorAll('[data-remove]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.getAttribute('data-remove');
                const name = btn.getAttribute('data-name') || 'this asset';
                const ok = await confirmDialog({
                    title: 'Remove asset',
                    message: `Remove "${name}" from your library? This can't be undone.`,
                    confirmLabel: 'Remove',
                });
                if (!ok) return;
                btn.disabled = true;
                try {
                    const res = await fetch(`/.netlify/functions/delete-workspace-asset?assetId=${id}`, { method: 'DELETE' });
                    if (!res.ok) throw new Error();
                    await loadAssets();
                } catch { btn.disabled = false; window.showToast?.('Could not remove this asset. Please try again.', { icon: '⚠️' }); }
            });
        });
    }

    // ── Auto-save helpers (no save buttons on this page) ──────────────────────
    const val = (id) => document.getElementById(id)?.value.trim() || '';
    const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
    function setStatus(id, msg, kind) {
        const el = document.getElementById(id);
        if (!el) return;
        if (!msg) { el.textContent = ''; return; }
        el.textContent = msg;
        el.classList.remove('text-emerald-600', 'text-red-600', 'text-gray-400');
        el.classList.add(kind === 'error' ? 'text-red-600' : kind === 'success' ? 'text-emerald-600' : 'text-gray-400');
    }

    // Legal Name defaults to the Business name: when the legal field is blank or
    // still mirrors the previous business name, keep it in step. Returns true if changed.
    let _prevBusinessName = '';
    function syncLegalName(newName) {
        const el = document.getElementById('bd-input-name');
        if (!el) return false;
        const cur = el.value.trim();
        if (!cur || cur === _prevBusinessName) { el.value = newName; return true; }
        return false;
    }

    // ── Business profile (auto-save) ──────────────────────────────────────────
    async function saveBusinessProfile() {
        if (!document.getElementById('bp-input-name')) return;
        const businessName = val('bp-input-name');
        if (!businessName) { setStatus('bp-status', 'Add a business name to save', 'error'); return; }
        setStatus('bp-status', 'Saving…', 'pending');
        try {
            const res = await fetch('/.netlify/functions/organisation-profile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    businessName,
                    industry:            val('bp-input-industry'),
                    websiteUrl:          val('bp-input-website'),
                    socialLinks:         val('bp-input-social'),
                    socialHandles:       collectSocialHandles(),
                    businessDescription: val('bp-input-description'),
                    targetAudience:      val('bp-input-audience'),
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            // Mirror the business name into the legal name (and persist it) if linked.
            const mirrored = syncLegalName(businessName);
            _prevBusinessName = businessName;
            setStatus('bp-status', 'Saved ✓', 'success');
            setTimeout(() => setStatus('bp-status', ''), 2500);
            if (mirrored) saveBilling();
        } catch (e) {
            console.error('[business-profile-save]', e);
            setStatus('bp-status', e.message || 'Save failed', 'error');
        }
    }

    // ── Legal & billing details (auto-save; data stays in billing_information) ──
    async function saveBilling() {
        if (!document.getElementById('bd-input-name')) return;
        const fullName = val('bd-input-name');
        if (!fullName) { setStatus('bd-status', 'Add a legal name to save', 'error'); return; }
        setStatus('bd-status', 'Saving…', 'pending');
        try {
            const res = await fetch('/.netlify/functions/billing-information', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fullName,
                    email:        val('bd-input-email'),
                    vatNumber:    val('bd-input-vat'),
                    addressLine1: val('bd-input-addr1'),
                    addressLine2: val('bd-input-addr2'),
                    city:         val('bd-input-city'),
                    postalCode:   val('bd-input-postal'),
                    state:        val('bd-input-state'),
                    country:      val('bd-input-country'),
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            setStatus('bd-status', 'Saved ✓', 'success');
            setTimeout(() => setStatus('bd-status', ''), 2500);
        } catch (e) {
            console.error('[billing-details-save]', e);
            setStatus('bd-status', e.message || 'Save failed', 'error');
        }
    }

    // ── Social media handles (Business Information is the source of truth) ──────
    // Each input carries data-platform="<slug>". Collect them into a { slug: value }
    // object for organisation-profile; these gate which Connections can be enabled.
    function collectSocialHandles() {
        const out = {};
        document.querySelectorAll('#bp-social-grid input[data-platform]').forEach(el => {
            const v = (el.value || '').trim();
            if (v) out[el.dataset.platform] = v;
        });
        return out;
    }

    function fillSocialHandles(handles) {
        const map = handles || {};
        document.querySelectorAll('#bp-social-grid input[data-platform]').forEach(el => {
            el.value = map[el.dataset.platform] || '';
        });
    }

    // ── Load + wire auto-save ─────────────────────────────────────────────────
    async function initBusinessSections() {
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };

        // Business profile
        if (document.getElementById('bp-input-name')) {
            try {
                const res = await fetch('/.netlify/functions/organisation-profile');
                if (res.ok) {
                    const { profile } = await res.json();
                    if (profile) {
                        set('bp-input-name', profile.businessName);
                        set('bp-input-industry', profile.industry);
                        set('bp-input-website', profile.websiteUrl);
                        set('bp-input-social', profile.socialLinks);
                        fillSocialHandles(profile.socialHandles);
                        set('bp-input-description', profile.businessDescription);
                        set('bp-input-audience', profile.targetAudience);
                        _prevBusinessName = profile.businessName || '';
                    }
                }
            } catch { /* non-fatal */ }
        }

        // Legal & billing details
        if (document.getElementById('bd-input-name')) {
            try {
                const res = await fetch('/.netlify/functions/billing-information');
                if (res.ok) {
                    const { billingInfo: b } = await res.json();
                    if (b) {
                        set('bd-input-name', b.fullName);
                        set('bd-input-email', b.email);
                        set('bd-input-vat', b.vatNumber);
                        set('bd-input-addr1', b.addressLine1);
                        set('bd-input-addr2', b.addressLine2);
                        set('bd-input-city', b.city);
                        set('bd-input-postal', b.postalCode);
                        set('bd-input-state', b.state);
                        set('bd-input-country', b.country);
                    }
                }
            } catch { /* non-fatal */ }
            // Prefill legal name from the business name when none is stored yet.
            const legalEl = document.getElementById('bd-input-name');
            if (legalEl && !legalEl.value.trim() && _prevBusinessName) legalEl.value = _prevBusinessName;
        }

        // Wire debounced auto-save on every field.
        const bpSave = debounce(saveBusinessProfile, 700);
        ['bp-input-name','bp-input-industry','bp-input-website','bp-input-social','bp-input-description','bp-input-audience']
            .forEach(id => document.getElementById(id)?.addEventListener('input', bpSave));
        // Per-platform social handle inputs share the same auto-save.
        document.querySelectorAll('#bp-social-grid input[data-platform]')
            .forEach(el => el.addEventListener('input', bpSave));

        const bdSave = debounce(saveBilling, 700);
        ['bd-input-name','bd-input-email','bd-input-vat','bd-input-addr1','bd-input-addr2','bd-input-city','bd-input-postal','bd-input-state','bd-input-country']
            .forEach(id => document.getElementById(id)?.addEventListener('input', bdSave));
    }

    // Initial load of existing assets + business/billing sections.
    loadAssets();
    initBusinessSections();
};
