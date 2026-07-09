// tour.js — Guided platform tour (window.PlatformTour)
//
// One on-demand interactive walkthrough, started from Help & Support or from the
// setup wizard's completion screen: a single room-by-room lap of the essentials
// (the user-story flow: command center → team → hiring → integrations) that
// continues straight into the Board Room (tabs, profile, pause/archive), Review
// Queue, Calendar, My Content, Refer a Friend, Help & Support, Feature Requests,
// Report an Issue, the ⌘K command bar, and My Account.
//
// Dims the workspace behind a spotlight cut-out, explains one element per step,
// and routes between SPA views (window.loadView) so the flow never breaks when a
// step lives on another page.
//
// Deliberately stateless: no server calls of its own, no persistence, and it
// never mutates user data — exiting (Esc, X, or clicking the dimmed background)
// removes the overlay and leaves the workspace exactly as it was. The tour always
// starts from its step one; the setup wizard remains the single source of truth
// for onboarding progress, so the two never compete (starting the tour collapses
// an open wizard drawer for the duration).
//
// Steps that can't render for this user are skipped silently in the direction of
// travel: onboarding-locked views (Review Queue / Calendar / My Content before
// the first assistant exists) and the Board Room section when there are no
// assistants yet.
(function () {
  'use strict';

  const Z_INDEX = 95;          // above the wizard drawer (70) and content modals, below the impersonation banner (100)
  const SPOT_PADDING = 8;      // breathing room around the spotlighted element
  const VIEW_WAIT_MS = 5000;   // max wait for a target to appear after a view change

  // ── Step schema ──────────────────────────────────────────────────────────────
  // view      route there first via loadView (omit to stay put)
  // targets   selectors tried in order until one is visible (responsive layouts hide some)
  // closest   expand the found element to this ancestor before spotlighting
  // sidebar   open the mobile nav drawer so the anchor is on screen
  // prepare   async hook run before the target search; return false to skip the step
  // cleanup   hook run when leaving the step (also on exit)
  // center    spotlight-free centered card (finale)
  // cta       finale primary action: { label, view }

  const TOUR_STEPS = [
    {
      view: 'dashboard',
      targets: ['#command-center-hero', '#dash-root'],
      title: 'Your Command Center',
      copy: 'This is your control room. From here you get a bird’s-eye view of everything your digital assistants are handling — hours saved, tasks completed, wins logged — so you never drop a ball.',
      placement: 'bottom',
    },
    {
      targets: ['#nav-assistants'],
      sidebar: true,
      title: 'Meet Your Team',
      copy: 'This is where you build and manage your digital workforce. Think of it as your roster of experts, ready and waiting for your instructions.',
      placement: 'right',
    },
    {
      view: 'assistants',
      targets: ['#route-to-catalog-from-dir', '#directory-assistants-grid'],
      title: 'Automate the Friction',
      copy: 'This is where the magic happens. Hire a new assistant to offload a repetitive chore and let the platform handle the heavy lifting.',
      placement: 'bottom',
    },
    {
      view: 'assistants',
      targets: ['#directory-assistants-grid'],
      title: 'Connecting the Dots',
      copy: 'Be More Swan plays nicely with your existing tools. Open any assistant’s Board Room and use its Connections tab to plug in your favourite apps for seamless, automated pipelines.',
      placement: 'top',
    },
    {
      prepare: ensureAssistantDetail,
      targets: ['#detail-avatar'],
      closest: '.z-10',
      title: 'The Board Room',
      copy: 'Every assistant has its own Board Room. Step inside to review progress, rename your assistant, and see the impact it’s having — this header is its identity and vital signs.',
      placement: 'bottom',
    },
    {
      prepare: ensureAssistantDetail,
      targets: ['nav[aria-label="Assistant sections"]'],
      title: 'Everything In Its Place',
      copy: 'The Board Room is organised into tabs: approve pending work in Review, set measurable Goals, tune Automation, browse the Notebook of rules it has learned, and audit its full Activity history.',
      placement: 'bottom',
    },
    {
      prepare: ensureAssistantDetail,
      targets: ['#btn-assistant-profile'],
      title: 'Shape Your Assistant',
      copy: 'The Assistant Profile is where you define who your assistant is — its persona, skills, strategy and the tools it connects to. Adjust it any time; your assistant adapts instantly.',
      placement: 'bottom',
    },
    {
      prepare: async () => {
        if (!(await ensureAssistantDetail())) return false;
        const btn = document.getElementById('btn-more-actions');
        const menu = document.getElementById('more-actions-menu');
        if (btn && menu && menu.classList.contains('hidden')) btn.click();
        return true;
      },
      cleanup: () => {
        const btn = document.getElementById('btn-more-actions');
        const menu = document.getElementById('more-actions-menu');
        if (menu && !menu.classList.contains('hidden')) {
          menu.classList.add('hidden');
          if (btn) btn.setAttribute('aria-expanded', 'false');
        }
      },
      targets: ['#more-actions-menu', '#btn-more-actions'],
      title: 'Pause or Retire',
      copy: 'Life changes, and your team flexes with it. Pause an assistant while you regroup — it stops working until you say otherwise — or archive it for good once its job is done. Pausing is reversible; archiving is permanent.',
      placement: 'bottom',
    },
    {
      view: 'review-queue',
      targets: ['.rq-col', '#workspace-content h1'],
      closest: '.overflow-x-auto',
      title: 'You Have the Final Say',
      copy: 'Nothing goes out without your approval. Review gathers drafts from every assistant in one place, so you can approve, amend or decline each one — and follow it from review through to posted.',
      placement: 'bottom',
    },
    {
      view: 'calendar',
      targets: ['#cal-title', '#cal-main'],
      closest: '.bg-white',
      title: 'Your Content, On Schedule',
      copy: 'The Calendar lays your scheduled content out across the week or month. Spot the gaps before they become missed opportunities, and filter by platform or assistant.',
      placement: 'bottom',
    },
    {
      view: 'referral',
      targets: ['#nav-referral'],
      sidebar: true,
      title: 'Share the Glide',
      copy: 'Love how this feels? Earn a referral token for every friend who signs up — redeem them for account credit, or save five for a free assistant.',
      placement: 'right',
    },
    {
      view: 'help',
      targets: ['#tab-btn-docs'],
      closest: 'nav',
      title: 'Help, When You Want It',
      copy: 'Stuck on anything? Search the Knowledge Base or raise a Support Ticket right here — and you can restart the tour from this page whenever you like.',
      placement: 'bottom',
    },
    {
      view: 'help',
      targets: ['#tab-btn-features'],
      title: 'Steer the Roadmap',
      copy: 'Got an idea that would make your life easier? Post it in Feature Requests and vote on others — the roadmap is shaped by people like you.',
      placement: 'bottom',
    },
    {
      view: 'help',
      targets: ['#nav-ask-team'],
      title: 'Ask Your Team Anything',
      copy: 'Need help and would rather not wait on a human? Ask here first — press ⌘K anywhere, or click this button. It spans your whole team of assistants, not just one.',
      placement: 'bottom',
    },
    {
      targets: ['#nav-report-issue'],
      title: 'Spotted Something Off?',
      copy: 'Report an Issue sends what you found straight to the team — along with where you were when you found it — so fixes land fast.',
      placement: 'bottom',
    },
    {
      view: 'settings',
      targets: ['#settings-tabs'],
      title: 'Your Account, Your Rules',
      copy: 'My Account holds everything about you and your business in tabs: Profile, Business Information, Notification Preferences, Sounds, My Agreements, Branding & AI Notices, and Billing & Subscription.',
      placement: 'bottom',
    },
    {
      center: true,
      title: 'Nothing left but the gliding.',
      copy: 'That’s the full platform — you now know every room in the house. Put it all to work: deploy an assistant and let it take the busywork off your plate.',
      cta: { label: 'Deploy Your First Assistant', view: 'catalog' },
    },
  ];

  let steps = TOUR_STEPS; // the tour's steps
  let root = null;               // overlay container (null = tour inactive)
  let spot = null;               // spotlight cut-out div
  let card = null;               // tooltip card
  let stepIndex = 0;
  let currentTarget = null;
  let openedMobileSidebar = false;
  let navToken = 0;              // invalidates in-flight step renders after exit/re-nav
  let detailUnavailable = false; // per-run cache: user has no assistant to open

  const reduceMotion = () =>
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── Voice narration: reads each step aloud in a calming British female voice ──
  // Gated by "Narrate the guided tour" (My Account → Sounds); default-on like the
  // other Aurora sound preferences, read from the localStorage cache the settings
  // page keeps in sync with the server (see workspace.html initSoundToggles).
  let narrationVoice = null;
  const FEMALE_BRITISH_HINTS = /female|serena|kate|fiona|martha|amy|emma|hazel|sonia|libby/i;

  function pickNarrationVoice() {
    if (!window.speechSynthesis) return null;
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;
    const british = voices.filter((v) => v.lang === 'en-GB' || v.lang === 'en_GB');
    return (
      british.find((v) => FEMALE_BRITISH_HINTS.test(v.name)) ||
      british[0] ||
      voices.find((v) => /^en/i.test(v.lang) && FEMALE_BRITISH_HINTS.test(v.name)) ||
      null
    );
  }

  if (window.speechSynthesis) {
    narrationVoice = pickNarrationVoice();
    window.speechSynthesis.onvoiceschanged = () => { narrationVoice = pickNarrationVoice(); };
  }

  function narrationEnabled() {
    return localStorage.getItem('bms_tourNarrationEnabled') !== '0';
  }

  function speakStep(step) {
    if (!window.speechSynthesis || !narrationEnabled()) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(`${step.title}. ${step.copy}`);
    if (!narrationVoice) narrationVoice = pickNarrationVoice();
    if (narrationVoice) utterance.voice = narrationVoice;
    utterance.lang = 'en-GB';
    utterance.pitch = 1;
    utterance.rate = 0.95; // slightly slower — calmer, easier to follow alongside the spotlight
    window.speechSynthesis.speak(utterance);
  }

  function stopNarration() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function waitFor(fn, timeoutMs, token) {
    return new Promise((resolve) => {
      const started = Date.now();
      (function poll() {
        if (token !== navToken) return resolve(null);
        const result = fn();
        if (result) return resolve(result);
        if (Date.now() - started > timeoutMs) return resolve(null);
        setTimeout(poll, 100);
      })();
    });
  }

  function findTarget(step) {
    for (const sel of step.targets || []) {
      let el = document.querySelector(sel);
      if (el && step.closest) el = el.closest(step.closest) || el;
      if (visible(el)) return el;
    }
    return null;
  }

  // ── Board Room helper: the detail steps need a real assistant open ──────────
  // Routes to the directory, waits for the grid to finish loading, and clicks the
  // first assistant card (the app's own routing then owns the navigation). Fails
  // fast — and caches the failure for this run — when the user has no assistants.
  async function ensureAssistantDetail() {
    if (window._currentViewKey === 'assistant-detail') return true;
    if (detailUnavailable) return false;
    const token = navToken;

    if (window._currentViewKey !== 'assistants') await window.loadView('assistants');
    if (token !== navToken) return false;

    // Grid ready = the "Gathering your team..." pulse is gone.
    const grid = await waitFor(() => {
      const g = document.getElementById('directory-assistants-grid');
      return g && !g.querySelector('.animate-pulse') ? g : null;
    }, VIEW_WAIT_MS, token);
    if (!grid) { detailUnavailable = true; return false; }

    const cardEl = grid.querySelector('div[onclick*="routeToAssistantDetail"]');
    if (!cardEl) { detailUnavailable = true; return false; }

    cardEl.click();
    const opened = await waitFor(
      () => window._currentViewKey === 'assistant-detail' && document.getElementById('detail-avatar'),
      VIEW_WAIT_MS, token
    );
    return !!opened;
  }

  // ── Mobile sidebar handling: nav anchors live in the off-canvas drawer on phones ──
  function setMobileSidebar(open) {
    const sidebar = document.getElementById('sidebar-container');
    if (!sidebar || window.innerWidth >= 768) return;
    if (open && sidebar.classList.contains('-translate-x-full')) {
      sidebar.classList.remove('-translate-x-full');
      openedMobileSidebar = true;
    } else if (!open && openedMobileSidebar) {
      sidebar.classList.add('-translate-x-full');
      openedMobileSidebar = false;
    }
  }

  // ── DOM scaffolding ──────────────────────────────────────────────────────────
  function build() {
    root = document.createElement('div');
    root.id = 'platform-tour';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Platform tour');
    root.style.cssText = `position:fixed;inset:0;z-index:${Z_INDEX};overflow:hidden;`;

    // The spotlight is a transparent hole; its huge box-shadow is the dim mask.
    spot = document.createElement('div');
    spot.style.cssText =
      'position:fixed;border-radius:14px;pointer-events:none;' +
      'box-shadow:0 0 0 200vmax rgba(15,23,42,0.6);' +
      (reduceMotion() ? '' : 'transition:all .35s cubic-bezier(.4,0,.2,1);');

    card = document.createElement('div');
    card.style.cssText =
      'position:fixed;max-width:22rem;width:calc(100vw - 2rem);' +
      'background:#fff;border-radius:1rem;box-shadow:0 20px 50px rgba(15,23,42,.35);' +
      'padding:1.25rem 1.25rem 1rem;font-family:inherit;' +
      (reduceMotion() ? '' : 'transition:opacity .25s ease, transform .25s ease;');

    // Clicking the dimmed background (anywhere outside the card) exits — AC6.
    root.addEventListener('mousedown', (e) => {
      if (!card.contains(e.target)) exit();
    });

    root.appendChild(spot);
    root.appendChild(card);
    document.body.appendChild(root);

    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
  }

  function onKeydown(e) {
    if (!root) return;
    if (e.key === 'Escape') { e.preventDefault(); exit(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
  }

  // ── Rendering ────────────────────────────────────────────────────────────────
  function renderCard(step) {
    const total = steps.length;
    const isFirst = stepIndex === 0;
    const isLast = stepIndex === total - 1;
    const pct = Math.round(((stepIndex + 1) / total) * 100);

    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.75rem;">
        <p style="font-size:.7rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#059669;margin:0 0 .35rem;">
          ${isLast ? '🦢 The Swan Effect' : `Step ${stepIndex + 1} of ${total}`}
        </p>
        <button type="button" data-tour-exit aria-label="Skip tour"
          style="background:none;border:none;cursor:pointer;color:#9ca3af;font-size:1.15rem;line-height:1;padding:0;">&times;</button>
      </div>
      <h3 style="font-size:1.05rem;font-weight:800;color:#111827;margin:0 0 .4rem;">${step.title}</h3>
      <p style="font-size:.85rem;color:#4b5563;line-height:1.55;margin:0 0 .85rem;">${step.copy}</p>
      <div style="height:4px;border-radius:9999px;background:#e5e7eb;margin-bottom:.85rem;" aria-hidden="true">
        <div style="height:100%;width:${pct}%;border-radius:9999px;background:#059669;${reduceMotion() ? '' : 'transition:width .3s ease;'}"></div>
      </div>
      <div style="display:flex;align-items:center;justify-content:flex-end;gap:.5rem;flex-wrap:wrap;">
        ${!isFirst ? `<button type="button" data-tour-back
          style="font-size:.8rem;font-weight:700;color:#374151;background:#f3f4f6;border:none;border-radius:.6rem;padding:.5rem .9rem;cursor:pointer;">Back</button>` : ''}
        ${isLast
          ? `<button type="button" data-tour-cta
              style="font-size:.8rem;font-weight:800;color:#fff;background:#059669;border:none;border-radius:.6rem;padding:.5rem 1rem;cursor:pointer;">${step.cta.label}</button>`
          : `<button type="button" data-tour-next
              style="font-size:.8rem;font-weight:800;color:#fff;background:#059669;border:none;border-radius:.6rem;padding:.5rem 1.1rem;cursor:pointer;">Next</button>`}
      </div>
      ${isLast ? `<button type="button" data-tour-exit
        style="display:block;margin:.75rem auto 0;background:none;border:none;cursor:pointer;font-size:.75rem;font-weight:600;color:#6b7280;">Maybe later — finish tour</button>` : ''}
    `;

    card.querySelectorAll('[data-tour-exit]').forEach((b) => b.addEventListener('click', exit));
    const backBtn = card.querySelector('[data-tour-back]');
    if (backBtn) backBtn.addEventListener('click', back);
    const nextBtn = card.querySelector('[data-tour-next]');
    if (nextBtn) nextBtn.addEventListener('click', next);
    const ctaBtn = card.querySelector('[data-tour-cta]');
    if (ctaBtn) ctaBtn.addEventListener('click', () => {
      const view = step.cta.view;
      exit();
      if (typeof window.loadView === 'function') window.loadView(view);
    });
    (nextBtn || ctaBtn || backBtn)?.focus({ preventScroll: true });
  }

  function positionSpotlight(el) {
    if (!el) {
      // Finale / missing anchor: shrink the hole to nothing so the whole screen dims.
      spot.style.left = '50vw';
      spot.style.top = '50vh';
      spot.style.width = '0px';
      spot.style.height = '0px';
      return;
    }
    const r = el.getBoundingClientRect();
    spot.style.left = `${r.left - SPOT_PADDING}px`;
    spot.style.top = `${r.top - SPOT_PADDING}px`;
    spot.style.width = `${r.width + SPOT_PADDING * 2}px`;
    spot.style.height = `${r.height + SPOT_PADDING * 2}px`;
  }

  function positionCard(el, placement) {
    const margin = 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;

    if (!el) {
      card.style.left = `${Math.max(margin, (vw - cw) / 2)}px`;
      card.style.top = `${Math.max(margin, (vh - ch) / 2)}px`;
      return;
    }

    const r = el.getBoundingClientRect();
    let left, top;
    switch (placement) {
      case 'right':
        left = r.right + SPOT_PADDING + margin;
        top = r.top;
        break;
      case 'top':
        left = r.left;
        top = r.top - SPOT_PADDING - margin - ch;
        break;
      default: // bottom
        left = r.left;
        top = r.bottom + SPOT_PADDING + margin;
    }
    // Clamp into the viewport; if the preferred side has no room, fall back to
    // whichever vertical side fits.
    if (top + ch > vh - margin) top = r.top - SPOT_PADDING - margin - ch;
    if (top < margin) top = Math.min(r.bottom + SPOT_PADDING + margin, vh - ch - margin);
    left = Math.min(Math.max(left, margin), vw - cw - margin);
    top = Math.min(Math.max(top, margin), vh - ch - margin);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  function reposition() {
    if (!root) return;
    const step = steps[stepIndex];
    positionSpotlight(step.center ? null : currentTarget);
    positionCard(step.center ? null : currentTarget, step.placement);
  }

  // ── Step lifecycle ───────────────────────────────────────────────────────────
  function runCleanup(index) {
    try { steps[index]?.cleanup?.(); } catch { /* never let a hook break the tour */ }
  }

  // Renders step `index`; if it can't render for this user (locked view, missing
  // anchor, no assistants), silently skips onward in the direction of travel.
  async function showStep(index, dir = 1) {
    if (index !== stepIndex) runCleanup(stepIndex);
    stepIndex = index;
    const step = steps[index];
    const token = ++navToken;

    // Onboarding-locked views: pre-check so we skip without the route guard's
    // toast + dashboard redirect (helper exposed by workspace.html).
    if (step.view && typeof window.isViewOnboardingLocked === 'function' &&
        (await window.isViewOnboardingLocked(step.view))) {
      return skipFrom(index, dir);
    }
    if (token !== navToken) return;

    if (step.prepare) {
      let ok = false;
      try { ok = await step.prepare(); } catch { ok = false; }
      if (token !== navToken) return;
      if (!ok) return skipFrom(index, dir);
    }

    setMobileSidebar(!!step.sidebar);

    // Route to the step's view so the anchor exists (AC4).
    if (step.view && typeof window.loadView === 'function' && window._currentViewKey !== step.view) {
      await window.loadView(step.view);
      if (token !== navToken) return;
      if (window._currentViewKey !== step.view) return skipFrom(index, dir); // guard redirected us
    }

    const el = step.center ? null : await waitFor(() => findTarget(step), VIEW_WAIT_MS, token);
    if (token !== navToken || !root) return; // user exited or moved on mid-wait
    if (!el && !step.center) return skipFrom(index, dir);
    currentTarget = el;

    if (el) el.scrollIntoView({ block: 'center', behavior: 'auto' });

    renderCard(step);
    positionSpotlight(step.center ? null : el);
    positionCard(step.center ? null : el, step.placement);
    speakStep(step);
  }

  function skipFrom(index, dir) {
    const nextIndex = index + dir;
    if (nextIndex < 0) return showStep(0, 1);                       // can't go back past the start
    if (nextIndex >= steps.length) return showStep(steps.length - 1, -1);
    return showStep(nextIndex, dir);
  }

  function next() {
    if (stepIndex < steps.length - 1) showStep(stepIndex + 1, 1);
  }

  function back() {
    if (stepIndex > 0) showStep(stepIndex - 1, -1);
  }

  function exit() {
    if (!root) return;
    runCleanup(stepIndex);
    navToken++;
    stopNarration();
    setMobileSidebar(false);
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
    root.remove();
    root = spot = card = currentTarget = null;
  }

  function start() {
    if (typeof window.loadView !== 'function') return; // workspace shell only
    if (root) exit();                                  // restart cleanly from step one
    stepIndex = 0;
    detailUnavailable = false;
    window.SetupWizard?.collapse?.();                  // don't fight the wizard drawer
    build();
    showStep(0, 1);
  }

  window.PlatformTour = { start, exit, get active() { return !!root; } };
})();
