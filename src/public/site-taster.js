/**
 * src/public/site-taster.js — the Mystery Shopper's free website check, as a block a page mounts.
 * docs/mystery-shopper-plan.md §4.7. Lives on the assistant's own public page:
 *   assistant.html?role=mystery_shopper   (mounted after the hero; see assistant.html)
 * It replaced the standalone /mystery-shopper page, which now redirects there (netlify.toml).
 *
 *   window.BmsSiteTaster.mount(host, { ctaHtml, headingTag })
 *     ctaHtml    — the page's own hire / waitlist / get-started button, shown under a result, so the
 *                  taster never disagrees with the page about what the visitor can do next.
 *     headingTag — 'h1' when the taster IS the page (the role is not public yet), else 'h2'.
 *
 * Backend: netlify/functions/site-audit-public.ts (start / status) → run-site-audit-background.ts.
 * A result link from the email (…&r=<runId>&t=<token>) opens straight on the result.
 *
 * ⚠️ Every sentence here is a public claim and must stay true of the code (memory:
 * public-copy-claims-vs-system). Notes beside the three columns say which wording is load-bearing.
 * Server values are escaped; handlers are bound to the mounted host once, never from a render.
 */
(function () {
  const API = '/.netlify/functions/site-audit-public';
  const POLL_MS = 3000;
  const MAX_POLLS = 60;   // ~3 minutes, then say so rather than spin for ever

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u || ''; } };

  function template(headingTag) {
    const H = headingTag === 'h1' ? 'h1' : 'h2';
    return `
    <section id="free-website-check" class="bg-white border-y border-gray-100">
      <div class="max-w-3xl mx-auto px-4 py-16 lg:py-20 text-center">
        <span class="inline-block px-3 py-1 bg-emerald-50 text-emerald-700 rounded-full text-xs font-bold uppercase tracking-wider mb-6 border border-emerald-100">Free website check</span>
        <${H} class="text-4xl md:text-5xl font-extrabold text-gray-900 tracking-tight mb-5">Would a stranger actually buy from your website?</${H}>
        <p class="text-lg text-gray-600 leading-relaxed mb-8">First-time visitors give your homepage five seconds and have zero patience for jargon. Most just leave without a word. The Mystery Shopper shows you your site through a stranger's eyes, revealing what's costing you sales and the single highest-impact change to make first.</p>

        <!-- What the taster returns — keep in step with renderResult() below and site-taster.ts
             buildTasterResult (score, worstFix before/after, failures). -->
        <div class="bg-white border border-gray-200 rounded-2xl p-6 text-left mb-8">
          <p class="text-sm font-bold text-gray-900">Enter your website and email, and in about 30 seconds you'll see:</p>
          <ul class="mt-3 space-y-2 list-disc pl-5">
            <li class="text-sm text-gray-700"><span class="font-bold">Your first-impression score</span> out of 100</li>
            <li class="text-sm text-gray-700"><span class="font-bold">The single most important change</span> — what your page says now, and what to try instead</li>
            <li class="text-sm text-gray-700"><span class="font-bold">What's costing you visitors</span> — the checks your homepage doesn't pass</li>
          </ul>
          <p class="text-sm text-gray-600 mt-4">This is a taste of what you get when you hire the Mystery Shopper: it also compares you side by side with your competitors, writes the replacement wording for every fix, and checks your site again every week to confirm each change went live.</p>
        </div>

        <form data-taster-form class="bg-gray-50 border border-gray-200 rounded-2xl p-6 text-left space-y-4" novalidate>
          <div>
            <label for="taster-url" class="block text-sm font-bold text-gray-800 mb-1">Your website</label>
            <input id="taster-url" name="url" type="text" inputmode="url" autocomplete="url" required placeholder="yourbusiness.co.uk" class="w-full border border-gray-300 rounded-lg px-4 py-3 text-base bg-white">
          </div>
          <div>
            <label for="taster-email" class="block text-sm font-bold text-gray-800 mb-1">Your email</label>
            <input id="taster-email" name="email" type="email" autocomplete="email" required placeholder="you@yourbusiness.co.uk" class="w-full border border-gray-300 rounded-lg px-4 py-3 text-base bg-white">
            <p class="text-xs text-gray-500 mt-1">We email you your result, once. We don't add you to a mailing list or keep your address.</p>
          </div>
          <!-- Honeypot: invisible to people, irresistible to form-filling bots. -->
          <div aria-hidden="true" style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden;">
            <label for="taster-company">Company</label>
            <input id="taster-company" name="company" type="text" tabindex="-1" autocomplete="off">
          </div>
          <button data-taster-submit type="submit" class="btn-primary w-full px-6 py-3 rounded-lg font-bold text-base transition disabled:opacity-50">Check my website</button>
          <p data-taster-error class="hidden text-sm font-semibold text-red-600" role="alert"></p>
        </form>
        <p class="text-xs text-gray-500 mt-3">We only read the one public page you give us, and respect any site that asks crawlers to stay out. We never fill in forms or buy anything.</p>
      </div>
    </section>

    <section data-taster-progress class="hidden max-w-3xl mx-auto px-4 py-12 text-center" aria-live="polite">
      <span class="animate-spin" role="status" aria-label="Checking" style="display:inline-block;box-sizing:border-box;width:32px;height:32px;border-radius:9999px;border:3px solid #eae4d7;border-top-color:#ff007f;"></span>
      <p class="text-base font-bold text-gray-800 mt-4">Reading your homepage like a first-time visitor…</p>
      <p class="text-sm text-gray-500 mt-1">This takes about 30 seconds.</p>
    </section>

    <section data-taster-result class="hidden max-w-3xl mx-auto px-4 py-12" aria-live="polite"></section>

    <section class="max-w-5xl mx-auto px-4 py-16 grid gap-8 md:grid-cols-3">
      <div>
        <h3 class="text-lg font-extrabold text-gray-900 mb-2">Day 1: The Stranger Test</h3>
        <p class="text-sm text-gray-600">Can a first-time visitor tell what you sell and who it is for from your headline alone? Does your main button promise a real outcome, or just mumble "Learn more"? Is your proof backed by hard numbers?</p>
      </div>
      <div>
        <h3 class="text-lg font-extrabold text-gray-900 mb-2">Every Week: Your Eyes on the Market</h3>
        <!-- ⚠️ Public claims, kept true of the code: competitor changes are found by the WEEKLY check
             (site-audit-schedule.ts), so "alerts you when", never "the moment"; and the AI lens is a
             simulation (site-audit-prompts.ts), so "are likely to read", never "read". -->
        <p class="text-sm text-gray-600">Hire the full Mystery Shopper and it goes beyond your homepage. Every week, it compares you against up to three competitors, checks how AI assistants are likely to read your site, and alerts you when a rival changes their headline, pricing, or offer.</p>
      </div>
      <div>
        <h3 class="text-lg font-extrabold text-gray-900 mb-2">Receipts, Not Opinions</h3>
        <!-- ⚠️ "An unchanged page keeps exactly the same grade" is the true form: an unchanged page is
             not re-scored (site-audit.ts runAuditCore → 'unchanged'). A page that changed is re-asked. -->
        <p class="text-sm text-gray-600">Every suggested rewrite quotes your actual page word for word. Scores come from strict, repeatable checks, so an unchanged page keeps exactly the same grade. When you make a change, the next scan confirms it is live and tracks your improvement.</p>
      </div>
    </section>`;
  }

  function mount(root, opts) {
    if (!root) return;
    const o = opts || {};
    const shownAt = Date.now();
    root.innerHTML = template(o.headingTag);
    const $ = (sel) => root.querySelector(sel);

    async function post(payload) {
      const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
      return data;
    }

    function showError(text) {
      const el = $('[data-taster-error]');
      el.textContent = text;
      el.classList.remove('hidden');
    }

    function setBusy(on) {
      $('[data-taster-submit]').disabled = on;
      $('[data-taster-progress]').classList.toggle('hidden', !on);
      if (on) $('[data-taster-result]').classList.add('hidden');
    }

    function renderResult(r) {
      const el = $('[data-taster-result]');
      const score = r.score;
      const fix = r.worstFix;
      el.innerHTML = `
        <div class="bg-white border border-gray-200 rounded-2xl shadow-sm p-6">
          <p class="text-xs font-bold text-gray-500 uppercase tracking-wider">First impression · ${esc(host(r.url))}</p>
          <p class="text-5xl font-black text-gray-900 mt-2">${score === null ? '—' : esc(score)}<span class="text-xl font-bold text-gray-400">/100</span></p>
          <p class="text-base text-gray-700 mt-3">${esc(r.summary)}</p>
          ${fix ? `
            <h3 class="text-sm font-black text-gray-900 mt-6">The one change to make first</h3>
            <p class="text-sm text-gray-700 mt-1">${esc(fix.problem)}</p>
            <div class="grid gap-3 mt-3 md:grid-cols-2">
              <div class="bg-gray-50 rounded-lg p-4"><p class="text-xs font-bold text-gray-500 uppercase">${esc(fix.location || 'On your page')} now</p><p class="text-sm text-gray-800 mt-1 break-words">${esc(fix.currentText)}</p></div>
              <div class="bg-emerald-50 rounded-lg p-4"><p class="text-xs font-bold text-emerald-700 uppercase">Try instead</p><p class="text-sm text-gray-900 mt-1 break-words">${esc(fix.suggestedText)}</p></div>
            </div>
            ${/\[[^\]]+\]/.test(fix.suggestedText) ? '<p class="text-xs text-gray-500 mt-2">Fill in the parts in [square brackets] with your own real details.</p>' : ''}` : ''}
          ${(r.failures || []).length ? `
            <h3 class="text-sm font-black text-gray-900 mt-6">What is costing you visitors</h3>
            <ul class="mt-2 space-y-1 list-disc pl-5">${r.failures.map((f) => `<li class="text-sm text-gray-700">${esc(f)}</li>`).join('')}</ul>` : ''}
        </div>
        ${o.ctaHtml ? `
        <div class="bg-white border border-gray-200 rounded-2xl p-6 mt-6 text-center">
          <p class="text-lg font-extrabold text-gray-900">Want this checked every week?</p>
          <p class="text-sm text-gray-600 mt-1 mb-4">Hire the Mystery Shopper: it compares you with your competitors, writes the replacement wording, and re-checks every week to confirm each fix went live.</p>
          ${o.ctaHtml}
        </div>` : ''}`;
      el.classList.remove('hidden');
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async function poll(runId, token) {
      setBusy(true);
      for (let i = 0; i < MAX_POLLS; i++) {
        let data;
        try { data = await post({ action: 'status', runId, token }); }
        catch (err) { setBusy(false); showError(err.message); return; }
        if (data.status === 'done' && data.result) { setBusy(false); renderResult(data.result); return; }
        if (data.status === 'failed') { setBusy(false); showError(data.error || 'We couldn\'t check that page.'); return; }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      setBusy(false);
      showError('This is taking longer than usual. We will email you the result when it is ready.');
    }

    $('[data-taster-form]').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('[data-taster-error]').classList.add('hidden');
      const url = $('#taster-url').value.trim();
      const email = $('#taster-email').value.trim();
      if (!url) { showError('Enter your website address, e.g. yourbusiness.co.uk'); return; }
      if (!email) { showError('Enter your email address so we can send you your result.'); return; }
      setBusy(true);
      try {
        const data = await post({ action: 'start', url, email, hp: $('#taster-company').value, ms: Date.now() - shownAt });
        await poll(data.runId, data.token);
      } catch (err) {
        setBusy(false);
        showError(err.message);
      }
    });

    // A result link from the email: …&r=<runId>&t=<token>.
    const q = new URLSearchParams(location.search);
    if (q.get('r') && q.get('t')) poll(Number(q.get('r')), q.get('t'));
  }

  window.BmsSiteTaster = { mount };
})();
