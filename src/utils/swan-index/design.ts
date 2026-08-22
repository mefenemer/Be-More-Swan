// src/utils/swan-index/design.ts
// The Swan Index — design system. Tokens, stylesheet and the chrome every page shares.
//
// ── Where this came from ───────────────────────────────────────────────────────────────────────
// Three references, each contributing a different layer:
//
//   Orchestre Métropolitain  → the editorial spine. Strict monochrome (black / white / #747474,
//     no accent colour anywhere), serif headlines at weight 400 — never bold — and uppercase sans
//     micro-labels. Its news list is a date-led row: DATE · CATEGORY · serif headline · "+".
//     That row is the single most useful thing on any of the three sites for a publication whose
//     name is literally "Index", and it is what INDEX_ROW below reproduces.
//
//   PlayStation Blog → the homepage information architecture. Lead Stories (one oversized
//     post-card--featured) → Trending → Latest → Spotlight, over a four-across card grid, each card
//     carrying image, headline, dek, date and engagement counts. Curated-then-chronological is
//     exactly the two-tier model this publication needs, already proven at scale.
//
//   Balance (michael-aust.com) → the finish. Near-white ground rather than pure white, fluid type,
//     scroll-reveal on first paint, and a marquee that slides on link hover.
//
// ── Two places we deliberately diverge from the references ─────────────────────────────────────
// 1. Balance sets `html { font-size: 1vw }` and then patches it with .zoom-under-80 / .zoom-over-100
//    classes. That ties the whole type scale to viewport WIDTH, which defeats browser text zoom —
//    the class list is there because the technique broke and had to be papered over. We get the same
//    fluidity from clamp() on rem values, where a user's zoom still works.
// 2. No dark mode. All three references are light-only and this is a committed editorial identity,
//    not a UI. `color-scheme: light` is set EXPLICITLY so a dark-mode browser does not auto-invert
//    a page whose colours are the whole point.

/** Google Fonts: Newsreader is the closest freely-licensed face to OM's Calendas Plus — a
 *  high-contrast text serif with real light weights. Inter Tight is Balance's sans, verbatim. */
export const FONT_CSS_URL =
    'https://fonts.googleapis.com/css2' +
    '?family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,400;0,6..72,500;1,6..72,300;1,6..72,400' +
    '&family=Inter+Tight:wght@400;500;600' +
    '&display=swap';

export const FONT_ORIGINS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'] as const;

/** The masthead name, split so the "THE" can be set as a separate typographic register. */
export const MASTHEAD = { article: 'The', name: 'Swan Index' } as const;

export const PUBLICATION_NAME = `${MASTHEAD.article} ${MASTHEAD.name}`;
export const PUBLICATION_TAGLINE = 'Business writing from the people running the businesses.';

/**
 * The "Powered by" line. The magazine builds its own reputation; this is the only sales surface.
 *
 * "Co-written", not "written autonomously". Every piece here is submitted by the person whose name
 * is on the byline and passes a human review before it publishes, so "autonomously" described the
 * drafting tool rather than the article — and on a masthead selling business writing BY operators
 * it read as "nobody wrote this". The EU AI Act Art. 50 disclosure is a separate line
 * (BLOG_AI_NOTICE) and is unchanged; this one is the credit, not the compliance notice.
 */
export const POWERED_BY_HTML =
    'Co-written and published with ' +
    '<a href="https://bemoreswan.com?utm_source=swanindex&utm_medium=referral&utm_campaign=powered_by">Be More Swan</a>.';

export const STYLESHEET = `
:root {
  color-scheme: light;                      /* committed, not a default — see the header note */

  /* ── Depth comes from the gap between these two ─────────────────────────────────────────────
     The first version set --ground to #FCFCFC, one step off pure white, and then put every page on
     it — so nothing was ever ON anything, and the whole site read as one flat sheet with hairlines
     drawn on it. The ground is now a real off-white and the reading column is real paper white,
     which is the oldest depth cue in print: a page lying on a desk. Nothing else changes — no
     gradients, no borders pretending to be edges. */
  --ground:   #F2F2EF;                      /* the desk */
  --paper:    #FFFFFF;                      /* the page */
  --ink:      #0A0A0A;                      /* near-black; #101010 read soft against true paper */
  --muted:    #5C5C5C;                      /* was #747474 — 7.2:1 on paper, and crisper for it */
  --rule:     #E2E2DE;
  --invert:   #000000;
  --invert-ink: #FCFCFC;
  --lift:     0 1px 2px rgba(10, 10, 10, .04), 0 28px 56px -40px rgba(10, 10, 10, .22);

  /* Fluid scale. clamp(min, preferred, max) on rem — zoom-safe, unlike a vw root size. */
  --step--1: clamp(0.78rem, 0.75rem + 0.15vw, 0.86rem);
  --step-0:  clamp(0.95rem, 0.92rem + 0.18vw, 1.05rem);
  --step-1:  clamp(1.15rem, 1.05rem + 0.5vw,  1.45rem);
  --step-2:  clamp(1.45rem, 1.25rem + 1vw,    2.1rem);
  --step-3:  clamp(1.9rem,  1.5rem + 2vw,     3.2rem);
  --step-4:  clamp(2.4rem,  1.6rem + 4vw,     5rem);

  --serif: Newsreader, "Iowan Old Style", Georgia, "Times New Roman", serif;
  --sans:  "Inter Tight", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;

  --gutter: clamp(1.15rem, 4vw, 3.5rem);
  --measure: 40rem;                         /* ~68 characters at --step-1 */
  --max: 82rem;
}

*, *::before, *::after { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: var(--sans);
  font-size: var(--step-0);
  line-height: 1.6;
}

/* ⚠️ No -webkit-font-smoothing: antialiased here, and that is deliberate. It was, and it is what
   made the type look washed out: on macOS it replaces subpixel rendering with greyscale, thinning
   every stem. Dark text on white is exactly the case subpixel AA is best at. Removing it is the
   single largest crispness change on this page. */

/* The reading surface. Full-bleed rather than a centred card: a magazine page is the width of the
   paper, and an inset card with rounded corners would be a UI. */
#main {
  background: var(--paper);
  box-shadow: var(--lift);
}

/* Headlines set with the line breaks a typesetter would choose rather than wherever the box ends. */
.serif, .dek { text-wrap: pretty; }
h1.serif, .lead__title, .article__title, .section__title { text-wrap: balance; }

a { color: inherit; text-decoration: none; }
img { max-width: 100%; height: auto; display: block; }

.wrap { max-width: var(--max); margin: 0 auto; padding-inline: var(--gutter); }

/* ── Typographic registers ───────────────────────────────────────────────────────────────────── */
/* OM sets EVERY heading in the serif at weight 400, including small uppercase section labels. The
   restraint is the effect: nothing on the page is bold, so hierarchy comes from size and space. */
.serif { font-family: var(--serif); font-weight: 400; letter-spacing: -0.011em; }

/* The uppercase sans micro-label: dates, sections, kickers. Letterspaced because uppercase text at
   small sizes sets too tight without it. */
.eyebrow {
  font-family: var(--sans);
  font-size: var(--step--1);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--muted);
}

.dek { font-size: var(--step-1); line-height: 1.45; color: var(--muted); font-weight: 400; }

/* Screen-reader-only. The social icons carry no visible text, so this is the only thing standing
   between a screen reader and a byline that reads "link, link, link". */
.visually-hidden {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0;
}

/* ── Contributor social links ────────────────────────────────────────────────────────────────── */
/* Line-drawn glyphs at the byline's own weight, never brand colours: six saturated logos under a
   headline would be the loudest thing on a page whose entire design is restraint. */
.socials { display: inline-flex; align-items: center; gap: 0.35rem; }
.socials__link {
  display: inline-flex; align-items: center; justify-content: center;
  width: 2rem; height: 2rem; border-radius: 50%; color: var(--muted);
  text-decoration: none; transition: color .18s ease, background-color .18s ease;
}
.socials__link:hover, .socials__link:focus-visible { color: var(--ink); background: var(--rule); }
.socials__link svg { width: 1.15rem; height: 1.15rem; }
.socials--author { margin-left: -0.5rem; }
@media (prefers-reduced-motion: reduce) { .socials__link { transition: none; } }

/* ── Masthead ────────────────────────────────────────────────────────────────────────────────── */
.masthead { border-bottom: 1px solid var(--rule); background: var(--ground); }
.masthead__inner {
  display: flex; align-items: flex-end; justify-content: space-between;
  gap: 2rem; padding-block: clamp(1.5rem, 3vw, 2.75rem);
}
/* Small sans "THE" stacked over a large serif "SWAN INDEX" — the standard newsstand lockup. */
.logo { display: inline-block; line-height: 1; }
.logo__the {
  display: block;
  font-family: var(--sans); font-size: var(--step--1); font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.34em; color: var(--muted);
  margin-bottom: 0.35em; margin-left: 0.16em;
}
.logo__name {
  display: block;
  font-family: var(--serif); font-weight: 400; font-size: var(--step-3);
  letter-spacing: -0.02em; text-transform: uppercase;
}
.masthead__meta { text-align: right; padding-bottom: 0.4rem; margin: 0; }
/* The tagline is a strapline, not information. Below the breakpoint it wraps to three lines beside
   the logo and turns the masthead into a paragraph, so it is dropped rather than shrunk — the
   footer still carries it. */
@media (max-width: 48rem) { .masthead__meta { display: none; } }

/* ── Section nav ─────────────────────────────────────────────────────────────────────────────── */
.nav { border-bottom: 1px solid var(--rule); }
.nav__inner {
  display: flex; gap: clamp(1rem, 3vw, 2.5rem); align-items: center;
  overflow-x: auto; scrollbar-width: none; padding-block: 0.85rem;
}
.nav__inner::-webkit-scrollbar { display: none; }
.nav a {
  white-space: nowrap;
  font-size: var(--step--1); font-weight: 500;
  text-transform: uppercase; letter-spacing: 0.09em; color: var(--muted);
  padding-block: 0.2rem; border-bottom: 1px solid transparent;
  transition: color .18s ease, border-color .18s ease;
}
.nav a:hover, .nav a[aria-current="page"] { color: var(--ink); border-bottom-color: var(--ink); }

/* ── Lead story (PS Blog's post-card--featured) ──────────────────────────────────────────────── */
.lead { padding-block: clamp(2.5rem, 6vw, 5rem); border-bottom: 1px solid var(--rule); }
.lead__grid { display: grid; gap: clamp(1.5rem, 4vw, 3.5rem); grid-template-columns: 1fr; }
@media (min-width: 60rem) { .lead__grid { grid-template-columns: 1.15fr 1fr; align-items: center; } }
.lead__title { font-size: var(--step-4); line-height: 1.02; margin: 0.5rem 0 1rem; }
.lead__figure { order: -1; }
@media (min-width: 60rem) { .lead__figure { order: 0; } }
.lead__figure img { aspect-ratio: 4 / 3; object-fit: cover; width: 100%; }

/* ── Card grid (PS Blog's four-across-grid) ──────────────────────────────────────────────────── */
.section { padding-block: clamp(2.25rem, 5vw, 4rem); border-bottom: 1px solid var(--rule); }
.section__head {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 1rem; margin-bottom: clamp(1.25rem, 3vw, 2.25rem);
}
.section__title { font-size: var(--step-2); margin: 0; }

.cards { display: grid; gap: clamp(1.5rem, 3vw, 2.5rem); grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); }

/* Cards are flex columns of equal height so the byline row lands on one line across the grid.
   Without this the bylines sit wherever each card's dek happens to end, and a four-across grid with
   four different baselines stops reading as a grid at all. */
.card { display: flex; flex-direction: column; height: 100%; }
.card > a { display: flex; flex-direction: column; flex: 1; }
.card__foot { margin-top: auto; padding-top: 0.85rem; display: flex; gap: 0.75rem; flex-wrap: wrap; }

.card__figure { margin: 0 0 1rem; overflow: hidden; background: var(--rule); aspect-ratio: 3 / 2; }
.card__figure img { aspect-ratio: 3 / 2; object-fit: cover; width: 100%; transition: transform .5s cubic-bezier(.2,.7,.3,1); }
.card:hover .card__figure img { transform: scale(1.03); }

/* A card whose post has no hero still RESERVES the image box, so a mixed row stays aligned — one
   card with a photo and one without would otherwise start their headlines at different heights and
   look like a rendering fault. Rendered as a hairline frame rather than a grey fill: an empty grey
   rectangle reads as a broken image, an empty ruled one reads as a deliberate plate. */
.card__figure--empty { background: none; border: 1px solid var(--rule); position: relative; }
.card__figure--empty::after {
  content: attr(data-label);
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--serif); font-size: var(--step-2); color: var(--rule);
  letter-spacing: -0.02em;
}

.card__title { font-size: var(--step-1); line-height: 1.2; margin: 0.4rem 0 0.5rem; }
.card__dek { font-size: var(--step-0); color: var(--muted); margin: 0; }

/* ── Index row (Orchestre Métropolitain's news list) ─────────────────────────────────────────── */
/* The publication's namesake unit: date-led, image-free, one hairline per item, a "+" that slides
   on hover. Dense enough that a hundred pieces stay scannable. */
.index-list { list-style: none; margin: 0; padding: 0; }

/* Mobile: a single stacked column — date and section side by side, then the headline, then the
   affordance. The three-column desktop grid cannot simply reflow to two: the browser fills it
   left-to-right, which strands "READ" on its own row under a date column narrow enough to break
   "18 August 2026" across three lines. Two explicit layouts, not one that degrades. */
.index-row {
  display: grid; grid-template-columns: 1fr; gap: 0.5rem;
  padding-block: clamp(1.1rem, 2.2vw, 1.6rem);
  border-top: 1px solid var(--rule);
}
.index-row__meta { display: flex; flex-direction: row; gap: 0.85rem; flex-wrap: wrap; }
.index-row__plus { justify-self: start; }

@media (min-width: 48rem) {
  .index-row { grid-template-columns: 9rem 1fr auto; gap: 1.5rem; align-items: baseline; }
  .index-row__meta { flex-direction: column; gap: 0.15rem; }
  .index-row__plus { justify-self: end; }
}
.index-row:last-child { border-bottom: 1px solid var(--rule); }
.index-row__title { font-size: var(--step-1); line-height: 1.25; margin: 0; transition: opacity .18s ease; }
.index-row__plus {
  font-family: var(--sans); font-size: var(--step--1); font-weight: 500;
  text-transform: uppercase; letter-spacing: 0.09em; color: var(--muted);
  display: inline-flex; align-items: center; gap: 0.4rem; white-space: nowrap;
}
.index-row__plus::after { content: "→"; transition: transform .22s cubic-bezier(.2,.7,.3,1); }
.index-row:hover .index-row__plus { color: var(--ink); }
.index-row:hover .index-row__plus::after { transform: translateX(0.35rem); }

/* ── Article ─────────────────────────────────────────────────────────────────────────────────── */
.article { padding-block: clamp(2.5rem, 6vw, 5rem); }
.article__head { max-width: var(--measure); margin: 0 auto clamp(2rem, 4vw, 3rem); }
.article__title { font-size: var(--step-3); line-height: 1.08; margin: 0.75rem 0 1rem; }
.article__dek { max-width: 34rem; }
.byline {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem 1rem;
  margin-top: 1.75rem; padding-top: 1.25rem; border-top: 1px solid var(--rule);
  font-size: var(--step--1); color: var(--muted);
}
.byline strong { font-weight: 500; color: var(--ink); }
.byline a { text-decoration: underline; text-underline-offset: 0.2em; text-decoration-thickness: 1px; }
.article__hero { margin: 0 0 clamp(2rem, 5vw, 3.5rem); }
.article__hero img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; }

.prose { max-width: var(--measure); margin: 0 auto; font-family: var(--serif); font-size: var(--step-1); line-height: 1.62; }
.prose > * + * { margin-top: 1.35em; }
.prose h2 { font-size: var(--step-2); font-weight: 400; line-height: 1.2; margin-top: 2em; letter-spacing: -0.015em; }
.prose h3 { font-size: var(--step-1); font-weight: 500; margin-top: 1.8em; }
.prose a { text-decoration: underline; text-underline-offset: 0.18em; text-decoration-thickness: 1px; text-decoration-color: var(--muted); }
.prose a:hover { text-decoration-color: var(--ink); }
.prose blockquote {
  margin-inline: 0; padding-left: 1.5rem; border-left: 2px solid var(--ink);
  font-style: italic; color: var(--muted);
}
.prose figure { margin-inline: 0; }
.prose figcaption { font-family: var(--sans); font-size: var(--step--1); color: var(--muted); margin-top: 0.6rem; }
.prose ul, .prose ol { padding-left: 1.4em; }
.prose li + li { margin-top: 0.45em; }
.prose code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.88em; background: #F0F0F0; padding: 0.12em 0.35em; }
.prose pre { background: #F5F5F5; padding: 1.1rem; overflow-x: auto; font-size: 0.85em; }
.prose pre code { background: none; padding: 0; }
.prose .bms-columns { display: grid; gap: 1.5rem; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); }

/* ── Provenance block ────────────────────────────────────────────────────────────────────────── */
/* Both notices live here, together and above the fold of the footer: where the piece first ran
   (the canonical credit the author is owed) and how it was written (EU AI Act Art. 50). Neither is
   decoration — the first is the promise the syndication network is built on, the second is law. */
.provenance {
  max-width: var(--measure); margin: clamp(2.5rem, 5vw, 4rem) auto 0;
  padding-top: 1.5rem; border-top: 1px solid var(--rule);
  font-size: var(--step--1); color: var(--muted); display: grid; gap: 0.6rem;
}
.provenance a { text-decoration: underline; text-underline-offset: 0.2em; }
.provenance strong { font-weight: 500; color: var(--ink); }

/* ── Author card ─────────────────────────────────────────────────────────────────────────────── */
.author {
  display: grid; gap: clamp(1.25rem, 3vw, 2.5rem); align-items: start;
  padding-block: clamp(2.5rem, 5vw, 4.5rem); border-bottom: 1px solid var(--rule);
}
@media (min-width: 48rem) { .author { grid-template-columns: 7rem 1fr; } }
.author__avatar { width: 7rem; height: 7rem; object-fit: cover; border-radius: 50%; background: var(--rule); }
.author__name { font-size: var(--step-3); margin: 0.35rem 0 0.5rem; line-height: 1.05; }
.author__bio { max-width: 38rem; font-size: var(--step-1); color: var(--muted); margin: 0 0 1.25rem; }
.author__links { display: flex; flex-wrap: wrap; gap: 1.5rem; }

/* ── About ───────────────────────────────────────────────────────────────────────────────────── */
/* Set at the article measure, not the grid width: it is prose, and prose 82rem wide is unreadable
   however handsome the type. Two columns on wide screens would be worse — nobody scrolls back up. */
.about { max-width: var(--measure); }
.about__block + .about__block { margin-top: clamp(2rem, 4vw, 3rem); }
.about__heading { font-size: var(--step-2); margin: 0 0 0.75rem; }
.about p { font-family: var(--serif); font-size: var(--step-1); line-height: 1.6; margin: 0 0 1rem; }
.about p:last-child { margin-bottom: 0; }
.about code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82em;
  background: var(--ground); padding: 0.12em 0.35em;
}
.about__cta {
  max-width: var(--measure); margin: clamp(2.5rem, 5vw, 4rem) 0 0;
  padding-top: 1.5rem; border-top: 1px solid var(--rule);
  font-size: var(--step--1); text-transform: uppercase; letter-spacing: 0.09em; color: var(--muted);
}
.about__cta a { color: var(--ink); text-decoration: underline; text-underline-offset: 0.2em; }

/* ── Footer ──────────────────────────────────────────────────────────────────────────────────── */
.foot { padding-block: clamp(2.5rem, 5vw, 4rem); }
.foot__grid { display: grid; gap: 2rem; grid-template-columns: 1fr; }
@media (min-width: 48rem) { .foot__grid { grid-template-columns: 1.5fr 1fr 1fr; } }
.foot__note { font-size: var(--step--1); color: var(--muted); max-width: 22rem; }
.foot__note a { text-decoration: underline; text-underline-offset: 0.2em; color: var(--ink); }
.foot ul { list-style: none; margin: 0.75rem 0 0; padding: 0; display: grid; gap: 0.5rem; }
.foot li a { font-size: var(--step--1); color: var(--muted); }
.foot li a:hover { color: var(--ink); }
.foot__rule { border-top: 1px solid var(--rule); margin-top: clamp(2rem, 4vw, 3rem); padding-top: 1.25rem; }

.empty { padding-block: clamp(3rem, 8vw, 7rem); text-align: center; color: var(--muted); }
.empty h2 { font-family: var(--serif); font-weight: 400; font-size: var(--step-2); color: var(--ink); margin: 0 0 0.5rem; }

/* ── Motion (Balance) ────────────────────────────────────────────────────────────────────────── */
/* Reveal is opt-IN via the .reveal class and applied by script, never by CSS alone. If the script
   fails to run the content must still be visible — a stylesheet that hides content and waits for
   JavaScript to show it is one error away from a blank page, which is precisely what the reference
   site does. Hence [data-reveal] on <html> as the gate: only set once the observer is wired. */
[data-reveal="on"] .reveal { opacity: 0; transform: translateY(0.9rem); }
[data-reveal="on"] .reveal.is-in { opacity: 1; transform: none; transition: opacity .7s ease, transform .7s cubic-bezier(.2,.7,.3,1); }

@media (prefers-reduced-motion: reduce) {
  [data-reveal="on"] .reveal { opacity: 1; transform: none; }
  *, *::before, *::after { animation-duration: .001ms !important; transition-duration: .001ms !important; }
  .card:hover .card__figure img { transform: none; }
  .index-row:hover .index-row__plus::after { transform: none; }
}

@media print {
  .masthead, .nav, .foot, .section { border: 0; }
  body { background: #fff; }
}
`;

/**
 * The reveal observer. Sets the gate attribute itself, so the hiding rules only ever apply on a
 * page where the code that un-hides is already running.
 */
export const MOTION_SCRIPT = `
(function () {
  var els = document.querySelectorAll('.reveal');
  if (!els.length || !('IntersectionObserver' in window)) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.documentElement.setAttribute('data-reveal', 'on');
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add('is-in');
      io.unobserve(e.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
  els.forEach(function (el, i) { el.style.transitionDelay = Math.min(i, 6) * 55 + 'ms'; io.observe(el); });
})();
`;
