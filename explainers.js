/* ==========================================================================
   BE MORE SWAN — Jargon Explainers
   --------------------------------------------------------------------------
   A tiny, self-contained "What's this?" helper. Marketing terms (tone of
   voice, content pillars, CTA…) are second nature to a marketeer but opaque
   to the busy founder using the app. This drops a friendly 🦢 info icon next
   to any element that carries a `data-explain="<slug>"` attribute. Click /
   tap (or hover on desktop) pops a plain-English, Swan-flavoured explanation.

   Usage — just add the attribute, no per-call wiring:
     <label data-explain="brand-voice">Brand Voice & Tone:</label>

   The script injects its own CSS (so it never depends on the prebuilt
   Tailwind style.css) and re-scans on DOM changes, so it also covers the
   workspace view partials that are swapped in dynamically by loadView().
   ========================================================================== */
(function () {
  'use strict';
  if (window.BMSExplainers) return; // idempotent — never double-init

  /* ----------------------------------------------------------------------
     GLOSSARY — single source of truth.
     Keep it warm, plain and a little playful. No marketing-speak in the
     explanations themselves; that's the whole point.
     Shape: slug -> { term, emoji, plain, example? }
     ---------------------------------------------------------------------- */
  var GLOSSARY = {
    'brand-voice': {
      term: 'Brand Voice & Tone',
      emoji: '🦢',
      plain: "It's how your brand would sound if it could talk — the personality behind the words. Friendly and cheeky? Calm and expert? Pick the vibe and your assistant keeps every post sounding like you, not a robot.",
      example: 'e.g. "Warm, encouraging, a little playful — never stuffy."'
    },
    'tone-of-voice': {
      term: 'Tone of Voice',
      emoji: '🗣️',
      plain: "The mood and manner of your writing — the difference between “Hey lovely, guess what!” and “Please find our latest update below.” Same facts, very different feeling. This sets which one sounds like you.",
      example: 'e.g. "Chatty and upbeat, like texting a friend."'
    },
    'brand-style': {
      term: 'Brand Style',
      emoji: '🎨',
      plain: "The look-and-feel that makes your stuff recognisably yours — colours, fonts, the kind of photos you use. It's why you can spot a brand's post before you even read the name.",
      example: 'e.g. "Soft pastels, hand-drawn icons, lots of white space."'
    },
    'visual-strategy': {
      term: 'Visual Strategy',
      emoji: '📸',
      plain: "Your plan for how posts should look so they feel like a set, not random snaps. Think consistent colours, a go-to photo style, and templates — so your feed looks intentional and on-brand.",
      example: 'e.g. "Bright product shots on a clean background, bold captions."'
    },
    'target-audience': {
      term: 'Target Audience',
      emoji: '🎯',
      plain: "The specific people you most want to reach — not “everyone”. The clearer the picture (who they are, what keeps them up at night), the better your assistant can write things they actually care about.",
      example: 'e.g. "Time-strapped founders of small service businesses."'
    },
    'content-pillars': {
      term: 'Content Pillars',
      emoji: '🏛️',
      plain: "The handful of core topics you post about again and again. They stop you staring at a blank screen — every idea ladders back to one of your pillars, so your feed stays focused and useful.",
      example: 'e.g. "Behind-the-scenes, customer wins, quick how-to tips."'
    },
    'core-message': {
      term: 'Core Message',
      emoji: '💬',
      plain: "The one idea you want to stick in people's heads. Every post is a different way of saying it. If someone forgot everything else, this is the thing you'd want them to remember.",
      example: 'e.g. "We help busy founders reclaim their time."'
    },
    'cta': {
      term: 'Call-to-Action (CTA)',
      emoji: '👉',
      plain: "The nudge that tells people what to do next. Without one, a great post just… ends. With one, readers know exactly the next step — tap, book, reply, shop.",
      example: 'e.g. "Book a free 15-minute call." / "Comment YES for the guide."'
    },
    'incentive': {
      term: 'The Incentive',
      emoji: '🎁',
      plain: "The little reason to act now instead of “later” (which usually means never). A bonus, a freebie, a deadline — something that makes saying yes today feel like a no-brainer.",
      example: 'e.g. "First month free." / "Only 5 spots this week."'
    },
    'value-proposition': {
      term: 'Value Proposition',
      emoji: '✨',
      plain: "Your one-line answer to “why you, and why should I care?” It names what you do, who it's for, and the good thing they get — in plain words a stranger would instantly get.",
      example: 'e.g. "Done-for-you social posts so founders never miss a week."'
    },
    'guardrails': {
      term: 'Guardrails & Rules',
      emoji: '🛡️',
      plain: "Your hard “always do this / never do that” list. Words to avoid, claims you can't make, topics that are off-limits. Your assistant treats these as non-negotiable, so nothing dodgy slips out.",
      example: 'e.g. "Never promise medical results. Always say \'team\', not \'staff\'."'
    },
    'hashtags-keywords': {
      term: 'Hashtags & Keywords',
      emoji: '#️⃣',
      plain: "The tags and search words that help the right strangers stumble onto your posts. Think of them as little signposts telling the app “show this to people interested in X.”",
      example: 'e.g. "#smallbusinessuk, #founderlife, sustainable skincare"'
    },
    'ai-disclosure': {
      term: 'AI Disclosure',
      emoji: '🤖',
      plain: "A short, honest note letting people know some of this content was made with AI. New rules (like the EU AI Act) ask for it, and being upfront builds trust rather than eroding it.",
      example: 'e.g. "Some content on this account is created with the help of Be More Swan AI."'
    },
    'posting-schedule': {
      term: 'Posting Schedule',
      emoji: '📅',
      plain: "How often and when your posts go out. Showing up regularly beats posting ten times then vanishing — the app (and your audience) reward a steady, predictable rhythm.",
      example: 'e.g. "3 times a week — Mon, Wed, Fri at 9am."'
    },
    'posting-cadence': {
      term: 'Posting Cadence',
      emoji: '🥁',
      plain: "Just a fancy word for your posting rhythm — how frequently content goes out. Consistent beats sporadic every time.",
      example: 'e.g. "A steady 3 posts a week."'
    },
    'draft-horizon': {
      term: 'Draft Horizon',
      emoji: '🔭',
      plain: "How far ahead your assistant prepares posts. A bigger horizon means more content sitting ready for your review — so you're never scrambling on the day.",
      example: 'e.g. "Keep 2 weeks of drafts queued up at all times."'
    },
    'content-calendar': {
      term: 'Content Calendar',
      emoji: '🗓️',
      plain: "A simple map of what's posting, where, and when — so nothing clashes and nothing's forgotten. It turns “what do I post today?” into “it's already planned.”",
      example: 'e.g. "Tips on Monday, a customer story on Thursday."'
    },
    'knowledge-base': {
      term: 'Knowledge Base',
      emoji: '🧠',
      plain: "Your assistant's memory bank — the stories, facts and documents that make it sound like you and not generic. The more real detail you feed it, the more authentic the posts.",
      example: 'e.g. "How you started, your founding story, FAQ answers."'
    },
    'service-offerings': {
      term: 'Service Offerings',
      emoji: '🛒',
      plain: "The actual things people can buy or book from you — courses, calls, packages. Listing them lets your assistant weave them naturally into posts instead of guessing.",
      example: 'e.g. "1:1 coaching (£500/mo), free discovery call, online course."'
    },
    'sales-objections': {
      term: 'Sales Objections',
      emoji: '🤔',
      plain: "The “yeah, but…” reasons people hesitate to buy — too pricey, no time, not sure it works. Jot down how you'd answer each, and your assistant can handle them in replies for you.",
      example: 'e.g. "\'Too expensive\' → break it down to cost-per-day."'
    },
    'facebook-strategy': {
      term: 'Facebook Strategy',
      emoji: '👍',
      plain: "Your game plan for Facebook — what you post, how often, and whether you also want versions tailored for niche Facebook Groups, which often get more engagement than your main Page.",
      example: 'e.g. "Share updates on the Page, plus a friendlier version for local community groups."'
    },
    'instagram-strategy': {
      term: 'Instagram Strategy',
      emoji: '📱',
      plain: "Your simple game plan for Instagram — what you post, how often, and what you want it to achieve (more followers? more sales?). A strategy just means you're posting on purpose, not just hoping.",
      example: 'e.g. "3 reels a week to grow reach, with a monthly offer."'
    },
    'linkedin-strategy': {
      term: 'LinkedIn Strategy',
      emoji: '💼',
      plain: "How you show up on LinkedIn — the work-and-business network. It rewards genuine, useful posts and quietly punishes anything that feels like an ad, so the tactics here are about playing nicely with it.",
      example: 'e.g. "Share a lesson learned each week, keep links out of the post itself."'
    },
    'x-strategy': {
      term: 'X (Twitter) Strategy',
      emoji: '🐦',
      plain: "Your plan for X (formerly Twitter) — a fast, text-first feed. Posts are short, so it's about picking the right mix of quick one-liners and longer “threads” to get your point across.",
      example: 'e.g. "A daily tip, plus one longer thread a week."'
    },
    'content-formats': {
      term: 'Reels, Carousels & Static',
      emoji: '🎞️',
      plain: "The three main kinds of Instagram post. Reels are short videos (great for reaching new people), Carousels are swipeable multi-image posts (great for tips), and Static is a single image. A mix keeps your feed varied.",
      example: 'e.g. "Reels to get discovered, carousels to teach, statics for quick updates."'
    },
    'trending-audio': {
      term: 'Trending Audio',
      emoji: '🎵',
      plain: "The songs and sounds lots of people are using on Reels right now. Instagram pushes posts that ride a trending sound to more viewers — so adding one is a free little boost to your reach.",
      example: 'e.g. "Pair your behind-the-scenes clip with this week\'s viral sound."'
    },
    'link-first-comment': {
      term: 'Link in First Comment',
      emoji: '🔗',
      plain: "A LinkedIn trick: the app shows your post to fewer people if it has an outside link in it. So you leave the link out of the post and drop it in the first comment instead — same link, no penalty.",
      example: 'e.g. "Post the story, then comment \'Full guide here: …\'"'
    },
    'pdf-carousel': {
      term: 'PDF Slider / Carousel',
      emoji: '📑',
      plain: "A swipeable, multi-page post on LinkedIn (it's really a PDF behind the scenes). Brilliant for step-by-step tips or mini-guides people can flick through — they tend to get lots of engagement.",
      example: 'e.g. "A 6-slide \'how to write a great bio\' walkthrough."'
    },
    'media-placeholders': {
      term: 'Media Placeholders',
      emoji: '🖼️',
      plain: "Little reminders left in a draft post that say “add a photo or video here.” Posts with an image or clip get noticed far more, so the assistant flags the best spot for you to pop one in.",
      example: 'e.g. "[add product photo here] before this line."'
    },
    'engagement': {
      term: 'Engagement',
      emoji: '❤️',
      plain: "How much people interact with your posts — likes, comments, shares, saves. It's the difference between people scrolling past and actually stopping to care. The app shows your stuff to more people when engagement is high.",
      example: 'e.g. "50 likes and 12 comments on your tips post."'
    },
    'reach': {
      term: 'Reach',
      emoji: '🌍',
      plain: "The number of different people who saw your post. Reach is about how far you spread — brand-new eyeballs, not the same fans seeing it twice.",
      example: 'e.g. "This reel reached 4,000 people, 3,200 of them new."'
    },
    'impressions': {
      term: 'Impressions',
      emoji: '👀',
      plain: "How many times your post was shown in total — including the same person seeing it more than once. So impressions are usually a bit higher than reach.",
      example: 'e.g. "1,000 people saw it (reach) a total of 1,400 times."'
    },
    'conversion': {
      term: 'Conversion',
      emoji: '🎯',
      plain: "When someone goes from “just looking” to actually doing the thing you wanted — booking, buying, signing up. It's the moment a follower becomes a customer.",
      example: 'e.g. "10 people clicked, 2 booked a call — that’s 2 conversions."'
    },
    'funnel': {
      term: 'The Funnel',
      emoji: '🥋',
      plain: "The journey from “never heard of you” to “happy customer.” It's wide at the top (lots of people discover you) and narrows down as people get more interested, then buy. Different posts help at different stages.",
      example: 'e.g. "A fun reel for discovery, a testimonial to convince, an offer to close."'
    },
    'lead-magnet': {
      term: 'Lead Magnet',
      emoji: '🧲',
      plain: "A handy freebie you give away in exchange for an email — a guide, checklist or template. It “attracts” interested people so you can stay in touch and sell to them later.",
      example: 'e.g. "Free \'5-day social media starter\' checklist."'
    },
    'brand-assets': {
      term: 'Brand Assets',
      emoji: '🖼️',
      plain: "Your reusable brand bits — logo, colours, fonts, photos, templates. Keeping them in one place means every post stays consistent and looks unmistakably yours.",
      example: 'e.g. "Logo files, your pink-and-cream palette, headshot photos."'
    },
    'smart-goals': {
      term: 'SMART Goals',
      emoji: '🎯',
      plain: "Goals that are clear enough to actually hit — Specific, Measurable, with a deadline. “Grow my following” is a wish; “reach 1,000 followers by August” is a SMART goal your assistant can aim at.",
      example: 'e.g. "Get 30 discovery-call bookings by the end of Q3."'
    },
    'review-queue': {
      term: 'Review Queue',
      emoji: '✅',
      plain: "Your inbox of posts the assistant has drafted and is waiting on your thumbs-up. Nothing goes live without you — skim, tweak if needed, and approve.",
      example: 'e.g. "5 posts ready for Monday — approve the batch in one click."'
    },
    'response-formatting': {
      term: 'Response Formatting',
      emoji: '📝',
      plain: "How your assistant lays out what it writes — short paragraphs or long ones, emoji or none, bullet points or plain prose. This is the shape of the message, separate from the tone.",
      example: 'e.g. "Always use short paragraphs; never use technical jargon."'
    },
    'core-business-facts': {
      term: 'Core Business Facts',
      emoji: '📌',
      plain: "The must-get-right details about your business that your assistant should always have straight — what you sell, when you launched, prices, hours. Get these wrong once and it looks careless.",
      example: 'e.g. "Our flagship service is X, launched in 2024."'
    },
    'media-source-manual': {
      term: 'Manual Upload',
      emoji: '📤',
      plain: "Free — pulls from photos and videos you've already uploaded to your content library. This never uses your AI credits.",
    },
    'media-source-stock': {
      term: 'AI Stock Search',
      emoji: '🔍',
      plain: "Free — searches Pexels for a ready-made stock photo or video that fits the post. This never uses your AI credits.",
    },
    'media-source-ai': {
      term: 'AI Generation',
      emoji: '🎨',
      plain: "Uses your AI credits — a generated image typically costs 1 credit and a generated video costs 5 credits. You'll be notified of how many credits you have left, and unused credits roll over month to month.",
    }
  };

  /* ----------------------------------------------------------------------
     Styles — injected once. Plain CSS only (no Tailwind utility classes,
     because style.css is prebuilt and won't compile new ones). Uses the
     remapped brand accent vars where present, with safe hex fallbacks.
     ---------------------------------------------------------------------- */
  var CSS = [
    '.bms-explain-btn{',
    '  display:inline-flex;align-items:center;justify-content:center;',
    '  width:16px;height:16px;margin-left:5px;padding:0;vertical-align:middle;',
    '  border:none;border-radius:9999px;cursor:pointer;line-height:1;',
    '  font-size:11px;font-weight:700;font-family:inherit;',
    '  color:#fff;background:var(--color-emerald-700,#ff007f);',
    '  box-shadow:0 1px 2px rgba(0,0,0,.15);transition:transform .12s ease,filter .12s ease;',
    '  position:relative;top:-1px;',
    '}',
    '.bms-explain-btn:hover{filter:brightness(1.08);transform:scale(1.12);}',
    '.bms-explain-btn:focus-visible{outline:2px solid var(--color-emerald-700,#ff007f);outline-offset:2px;}',
    '.bms-explain-pop{',
    '  position:fixed;z-index:100000;max-width:300px;width:max-content;',
    '  background:#fff;color:var(--color-gray-800,#2d2a23);',
    '  border:1px solid var(--color-emerald-100,#ffd6e8);border-radius:14px;',
    '  box-shadow:0 18px 40px -12px rgba(31,30,27,.28);',
    '  padding:14px 16px;font-family:inherit;font-size:13px;line-height:1.5;',
    '  opacity:0;transform:translateY(4px);transition:opacity .14s ease,transform .14s ease;',
    '  pointer-events:none;',
    '}',
    '.bms-explain-pop.is-open{opacity:1;transform:translateY(0);pointer-events:auto;}',
    '.bms-explain-pop .bms-pop-title{display:flex;align-items:center;gap:6px;',
    '  font-weight:800;font-size:13px;color:var(--color-gray-900,#1f1e1b);margin-bottom:5px;}',
    '.bms-explain-pop .bms-pop-emoji{font-size:15px;}',
    '.bms-explain-pop .bms-pop-body{color:var(--color-gray-700,#444036);}',
    '.bms-explain-pop .bms-pop-eg{display:block;margin-top:8px;padding-top:8px;',
    '  border-top:1px dashed var(--color-emerald-100,#ffd6e8);',
    '  font-style:italic;color:var(--color-gray-500,#787263);font-size:12px;}',
    '.bms-explain-pop .bms-pop-arrow{position:absolute;width:12px;height:12px;',
    '  background:#fff;border-left:1px solid var(--color-emerald-100,#ffd6e8);',
    '  border-top:1px solid var(--color-emerald-100,#ffd6e8);transform:rotate(45deg);}',
    '@media (max-width:480px){.bms-explain-pop{max-width:calc(100vw - 24px);}}',
    '@media (prefers-reduced-motion:reduce){',
    '  .bms-explain-btn,.bms-explain-pop{transition:none;}',
    '}'
  ].join('');

  function injectStyles() {
    if (document.getElementById('bms-explainer-styles')) return;
    var style = document.createElement('style');
    style.id = 'bms-explainer-styles';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ----------------------------------------------------------------------
     Popover singleton — only one open at a time.
     ---------------------------------------------------------------------- */
  var pop = null;
  var arrow = null;
  var activeBtn = null;

  function ensurePop() {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.className = 'bms-explain-pop';
    pop.setAttribute('role', 'tooltip');
    arrow = document.createElement('div');
    arrow.className = 'bms-pop-arrow';
    pop.appendChild(arrow);
    document.body.appendChild(pop);
    return pop;
  }

  function fillPop(entry) {
    // Rebuild content but keep the arrow node.
    pop.querySelectorAll('.bms-pop-content').forEach(function (n) { n.remove(); });
    var wrap = document.createElement('div');
    wrap.className = 'bms-pop-content';

    var title = document.createElement('div');
    title.className = 'bms-pop-title';
    if (entry.emoji) {
      var em = document.createElement('span');
      em.className = 'bms-pop-emoji';
      em.textContent = entry.emoji;
      title.appendChild(em);
    }
    var tName = document.createElement('span');
    tName.textContent = entry.term;
    title.appendChild(tName);
    wrap.appendChild(title);

    var body = document.createElement('div');
    body.className = 'bms-pop-body';
    body.textContent = entry.plain;
    wrap.appendChild(body);

    if (entry.example) {
      var eg = document.createElement('span');
      eg.className = 'bms-pop-eg';
      eg.textContent = entry.example;
      wrap.appendChild(eg);
    }
    pop.appendChild(wrap);
  }

  function positionPop(btn) {
    var r = btn.getBoundingClientRect();
    var pr = pop.getBoundingClientRect();
    var gap = 10;
    var margin = 8;
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;

    // Prefer below the icon; flip above if it would overflow the bottom.
    var below = (r.bottom + gap + pr.height) <= vh;
    var top = below ? (r.bottom + gap) : (r.top - gap - pr.height);

    // Horizontally centre on the icon, clamped to the viewport.
    var left = r.left + r.width / 2 - pr.width / 2;
    left = Math.max(margin, Math.min(left, vw - pr.width - margin));

    pop.style.top = Math.round(top) + 'px';
    pop.style.left = Math.round(left) + 'px';

    // Point the arrow at the icon centre.
    var arrowLeft = r.left + r.width / 2 - left - 6;
    arrowLeft = Math.max(10, Math.min(arrowLeft, pr.width - 22));
    arrow.style.left = Math.round(arrowLeft) + 'px';
    if (below) {
      arrow.style.top = '-6px';
      arrow.style.bottom = '';
      arrow.style.transform = 'rotate(45deg)';
    } else {
      arrow.style.top = '';
      arrow.style.bottom = '-6px';
      arrow.style.transform = 'rotate(225deg)';
    }
  }

  function openPop(btn, entry) {
    ensurePop();
    fillPop(entry);
    pop.style.opacity = '0';
    pop.classList.add('is-open');
    // Measure after content is in, then place.
    positionPop(btn);
    pop.style.opacity = '';
    if (activeBtn && activeBtn !== btn) activeBtn.setAttribute('aria-expanded', 'false');
    activeBtn = btn;
    btn.setAttribute('aria-expanded', 'true');
  }

  function closePop() {
    if (!pop) return;
    pop.classList.remove('is-open');
    if (activeBtn) { activeBtn.setAttribute('aria-expanded', 'false'); activeBtn = null; }
  }

  function isOpenFor(btn) {
    return pop && pop.classList.contains('is-open') && activeBtn === btn;
  }

  /* ----------------------------------------------------------------------
     Scan + render icons.
     ---------------------------------------------------------------------- */
  var hasFinePointer = window.matchMedia
    ? window.matchMedia('(hover:hover) and (pointer:fine)').matches
    : false;

  function makeButton(entry) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bms-explain-btn';
    btn.textContent = 'i';
    btn.setAttribute('aria-label', "What does '" + entry.term + "' mean?");
    btn.setAttribute('aria-expanded', 'false');

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (isOpenFor(btn)) { closePop(); } else { openPop(btn, entry); }
    });

    if (hasFinePointer) {
      btn.addEventListener('mouseenter', function () { openPop(btn, entry); });
      btn.addEventListener('mouseleave', function () {
        // Don't close if the pointer moved onto the bubble.
        setTimeout(function () {
          if (pop && !pop.matches(':hover') && !btn.matches(':hover')) closePop();
        }, 80);
      });
    }
    return btn;
  }

  function scan(root) {
    injectStyles();
    var scope = root && root.querySelectorAll ? root : document;
    var nodes = scope.querySelectorAll('[data-explain]:not([data-explain-ready])');
    nodes.forEach(function (el) {
      var key = el.getAttribute('data-explain');
      var entry = GLOSSARY[key];
      el.setAttribute('data-explain-ready', '1'); // mark even if unknown, so we don't re-check forever
      if (!entry) {
        if (window.console) console.warn('[explainers] no glossary entry for "' + key + '"');
        return;
      }
      el.appendChild(makeButton(entry));
    });
  }

  /* ----------------------------------------------------------------------
     Global close handlers + keep the bubble glued to its icon on scroll.
     ---------------------------------------------------------------------- */
  document.addEventListener('click', function (e) {
    if (!pop || !pop.classList.contains('is-open')) return;
    if (e.target.closest('.bms-explain-pop') || e.target.closest('.bms-explain-btn')) return;
    closePop();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closePop();
  });
  window.addEventListener('scroll', function () {
    if (pop && pop.classList.contains('is-open') && activeBtn) {
      // If the icon scrolled out of view, close; otherwise reposition.
      var r = activeBtn.getBoundingClientRect();
      if (r.bottom < 0 || r.top > document.documentElement.clientHeight) closePop();
      else positionPop(activeBtn);
    }
  }, true);
  window.addEventListener('resize', function () {
    if (pop && pop.classList.contains('is-open') && activeBtn) positionPop(activeBtn);
  });

  /* ----------------------------------------------------------------------
     Re-scan on dynamic content (workspace partials are injected by
     loadView()). Debounced so a burst of mutations costs one scan.
     ---------------------------------------------------------------------- */
  var scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(function () { scanTimer = null; scan(document); }, 120);
  }

  function start() {
    scan(document);
    if (window.MutationObserver) {
      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          if (muts[i].addedNodes && muts[i].addedNodes.length) { scheduleScan(); break; }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  }

  window.BMSExplainers = { scan: scan, GLOSSARY: GLOSSARY };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
