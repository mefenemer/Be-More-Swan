// tour.js — Guided platform tour (window.PlatformTour)
//
// On-demand interactive walkthrough started from Help & Support ("Take the Tour")
// or from the setup wizard's completion screen. Dims the workspace behind a
// spotlight cut-out, explains one element per step, and routes between SPA views
// (window.loadView) so the flow never breaks when a step lives on another page.
//
// Deliberately stateless: no server calls, no persistence, and it never mutates
// user data — exiting (Esc, X, or clicking the dimmed background) simply removes
// the overlay and leaves the workspace exactly as it was. The tour always starts
// from step one; the setup wizard remains the single source of truth for
// onboarding progress, so the two never compete (starting the tour collapses an
// open wizard drawer for the duration).
(function () {
  'use strict';

  const Z_INDEX = 95;          // above the wizard drawer (70) and content modals, below the impersonation banner (100)
  const SPOT_PADDING = 8;      // breathing room around the spotlighted element
  const VIEW_WAIT_MS = 5000;   // max wait for a target to appear after a view change

  // Each step: `view` routes there first (omit to stay put); `targets` are tried in
  // order until one is visible (responsive layouts hide some anchors); `sidebar`
  // opens the mobile nav drawer so the anchor is on screen; `center` renders a
  // spotlight-free centered card (the finale).
  const STEPS = [
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
      center: true,
      title: 'You’re ready to glide.',
      copy: 'You’ve got the lay of the land. Time to stop paddling frantically and start gliding — deploy your first assistant and watch the busywork disappear.',
      cta: { label: 'Deploy Your First Assistant', view: 'catalog' },
    },
  ];

  let root = null;             // overlay container (null = tour inactive)
  let spot = null;             // spotlight cut-out div
  let card = null;             // tooltip card
  let stepIndex = 0;
  let currentTarget = null;
  let openedMobileSidebar = false;
  let navToken = 0;            // invalidates in-flight step renders after exit/re-nav

  const reduceMotion = () =>
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function findTarget(step) {
    for (const sel of step.targets || []) {
      const el = document.querySelector(sel);
      if (visible(el)) return el;
    }
    return null;
  }

  function waitForTarget(step, token) {
    return new Promise((resolve) => {
      const started = Date.now();
      (function poll() {
        if (token !== navToken) return resolve(null);
        const el = findTarget(step);
        if (el) return resolve(el);
        if (Date.now() - started > VIEW_WAIT_MS) return resolve(null);
        setTimeout(poll, 100);
      })();
    });
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
    const total = STEPS.length;
    const isFirst = stepIndex === 0;
    const isLast = stepIndex === total - 1;

    const dots = STEPS.map((_, i) =>
      `<span style="width:8px;height:8px;border-radius:9999px;display:inline-block;` +
      `background:${i === stepIndex ? '#059669' : '#d1d5db'};"></span>`
    ).join('');

    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.75rem;">
        <p style="font-size:.7rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#059669;margin:0 0 .35rem;">
          ${isLast ? '🦢 The Swan Effect' : `Step ${stepIndex + 1} of ${total}`}
        </p>
        <button type="button" data-tour-exit aria-label="Skip tour"
          style="background:none;border:none;cursor:pointer;color:#9ca3af;font-size:1.15rem;line-height:1;padding:0;">&times;</button>
      </div>
      <h3 style="font-size:1.05rem;font-weight:800;color:#111827;margin:0 0 .4rem;">${step.title}</h3>
      <p style="font-size:.85rem;color:#4b5563;line-height:1.55;margin:0 0 1rem;">${step.copy}</p>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:.75rem;">
        <span style="display:inline-flex;gap:5px;" aria-hidden="true">${dots}</span>
        <span style="display:inline-flex;gap:.5rem;">
          ${!isFirst ? `<button type="button" data-tour-back
            style="font-size:.8rem;font-weight:700;color:#374151;background:#f3f4f6;border:none;border-radius:.6rem;padding:.5rem .9rem;cursor:pointer;">Back</button>` : ''}
          ${isLast
            ? `<button type="button" data-tour-cta
                style="font-size:.8rem;font-weight:800;color:#fff;background:#059669;border:none;border-radius:.6rem;padding:.5rem 1rem;cursor:pointer;">${step.cta.label}</button>`
            : `<button type="button" data-tour-next
                style="font-size:.8rem;font-weight:800;color:#fff;background:#059669;border:none;border-radius:.6rem;padding:.5rem 1.1rem;cursor:pointer;">Next</button>`}
        </span>
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
    const step = STEPS[stepIndex];
    positionSpotlight(step.center ? null : currentTarget);
    positionCard(step.center ? null : currentTarget, step.placement);
  }

  // ── Step lifecycle ───────────────────────────────────────────────────────────
  async function showStep(index) {
    stepIndex = index;
    const step = STEPS[index];
    const token = ++navToken;

    setMobileSidebar(!!step.sidebar);

    // Route to the step's view first so the anchor exists (AC4). loadView guards
    // and toasts on restricted routes itself; the poll below simply times out then.
    if (step.view && typeof window.loadView === 'function' && window._currentViewKey !== step.view) {
      await window.loadView(step.view);
    }

    const el = step.center ? null : await waitForTarget(step, token);
    if (token !== navToken || !root) return; // user exited or moved on mid-wait
    currentTarget = el;

    if (el) el.scrollIntoView({ block: 'center', behavior: 'auto' });

    renderCard(step);
    positionSpotlight(step.center ? null : el);
    positionCard(step.center ? null : el, step.placement);
  }

  function next() {
    if (stepIndex < STEPS.length - 1) showStep(stepIndex + 1);
  }

  function back() {
    if (stepIndex > 0) showStep(stepIndex - 1);
  }

  function exit() {
    if (!root) return;
    navToken++;
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
    window.SetupWizard?.collapse?.();                  // don't fight the wizard drawer
    build();
    showStep(0);
  }

  window.PlatformTour = { start, exit, get active() { return !!root; } };
})();
