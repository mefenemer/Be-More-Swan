/**
 * widget.js — Autonomous Content Engine native BMS blog widget (US 3.1, 5.2, 6.1 badge).
 *
 * Drop-in embed for a customer's own website:
 *   <script async src="https://bemoreswan.com/widget.js"
 *           data-bms-key="wgt_ab12…" data-bms-mount="#bms-blog"></script>
 *
 * Renders inside a Shadow DOM so the customer's CSS and the widget's CSS never collide. Fetches the
 * public, CDN-cacheable payload from /api/widget/:key/* and applies the workspace's theme. On a post
 * with A/B hooks it picks a variant client-side (sticky per visitor via localStorage) and reports
 * anonymous engagement — keeping the payload cacheable (docs §8/§11). Renders the AI Transparency
 * Badge when the workspace enables it (§6.1 / US 6.1 AC2).
 *
 * No dependencies; served as a static asset (cache-busted via ?v= like the app's other JS).
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;
  var key = script.getAttribute('data-bms-key');
  var mountSel = script.getAttribute('data-bms-mount') || '#bms-blog';
  if (!key) { console.error('[bms-widget] missing data-bms-key'); return; }

  // OPTIONAL, opt-in: data-bms-post-url="/blog/{slug}".
  //
  // Without it the widget behaves exactly as it always has — cards open the post in place and route
  // on location.hash. That default must not change: for most customers the widget IS the blog, and
  // silently turning every card into a link off their own site would be a regression they never
  // asked for.
  //
  // With it, cards become real <a href> elements pointing at the customer's own per-post route — the
  // same URL their site_post_path canonicalises to. That is worth having wherever such a route
  // genuinely exists: a real page can be linked, shared, crawled, and MEASURED (the server-rendered
  // permalink carries the engagement beacon; a hash change does not).
  //
  // Validated here rather than trusted: this string becomes an href. A rooted path or an absolute
  // http(s) URL only, and it must carry {slug} — without the placeholder every card would link to
  // the same page, which is precisely the duplicate-content failure resolveCanonical() refuses to
  // create on the server side.
  var postUrlTemplate = script.getAttribute('data-bms-post-url') || '';
  if (postUrlTemplate && !(/^(\/(?!\/)|https?:\/\/)/.test(postUrlTemplate) && postUrlTemplate.indexOf('{slug}') !== -1)) {
    console.error('[bms-widget] ignoring data-bms-post-url: need a rooted path or http(s) URL containing {slug}');
    postUrlTemplate = '';
  }

  function postHref(slug) {
    if (!postUrlTemplate || !slug) return null;
    return postUrlTemplate.replace('{slug}', encodeURIComponent(slug));
  }

  // Resolve API origin from the script src so the widget works on any host.
  var apiBase;
  try { apiBase = new URL(script.src).origin; } catch (e) { apiBase = ''; }
  var API = apiBase + '/api/widget/' + encodeURIComponent(key);

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // A published date a reader recognises, in THEIR locale — this script runs on a customer's site
  // for whoever visits it, so there is no one right format to hard-code. Returns '' rather than
  // "Invalid Date" for anything unparseable, so a bad value costs the line and not the card.
  function formatDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    } catch (e) {
      return d.toISOString().slice(0, 10);
    }
  }

  // Tags come from the post's own metadata, so the widget must not assume they are strings, short,
  // or few. Capped at three: a card is a summary, and a post carrying twelve tags would otherwise
  // push the excerpt out of view on every row in the list.
  var TAG_LIMIT = 3;
  function tagsHtml(tags) {
    if (!tags || !tags.length) return '';
    var out = [];
    for (var i = 0; i < tags.length && out.length < TAG_LIMIT; i++) {
      var t = String(tags[i] == null ? '' : tags[i]).trim();
      if (t) out.push('<li>' + esc(t.slice(0, 40)) + '</li>');
    }
    return out.length ? '<ul class="bms-tags">' + out.join('') + '</ul>' : '';
  }

  // Remove the body's own leading <h1>.
  //
  // The published payload is a render of the post's Markdown, so it ALREADY opens with an <h1>
  // carrying the post title — and this widget rendered its own above it. Every embed showed the
  // headline twice. Worse, during a headline A/B test the reader saw the TESTED headline stacked on
  // top of the original, so dwell and scroll were scored against a variant nobody read in isolation.
  //
  // Anchored to the START: an <h1> used mid-article is the author's and is left alone. Mirrors
  // stripLeadingH1() in src/utils/blog-seo.ts, which does the same job for the server-rendered
  // permalink — keep the two in step.
  function stripLeadingH1(html) {
    return String(html == null ? '' : html).replace(/^\s*<h1[^>]*>[\s\S]*?<\/h1>\s*/i, '');
  }

  function getJSON(url) {
    return fetch(url, { credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function pickVariant(post) {
    var variants = post.hookVariants || [];
    if (!variants.length) return null;
    if (post.abState === 'decided' && post.winningVariant) {
      return variants.filter(function (v) { return v.id === post.winningVariant; })[0] || variants[0];
    }
    // Sticky per visitor per post so engagement is attributed to one variant.
    var lsKey = 'bms_ab_' + key + '_' + post.slug;
    var chosen = null;
    try { chosen = localStorage.getItem(lsKey); } catch (e) {}
    if (!chosen || !variants.some(function (v) { return v.id === chosen; })) {
      chosen = variants[Math.floor(Math.random() * variants.length)].id;
      try { localStorage.setItem(lsKey, chosen); } catch (e) {}
    }
    return variants.filter(function (v) { return v.id === chosen; })[0];
  }

  // Anonymous engagement beacon: dwell time + max scroll depth, for EVERY published post.
  //
  // This used to bail out unless the post had an active headline test (`!variantId ||
  // post.abState === 'decided'`), so the only posts anyone measured were the ones mid-experiment.
  // Reader engagement is a property of the post, not of the experiment — it is now always sent,
  // and `variantId` is passed through only when there genuinely is one, so the A/B side keeps
  // exactly the data it had. See widget-ab-beacon.ts for the two-table split.
  //
  // Still anonymous and still aggregate: no cookies, no identifiers, no raw rows. The localStorage
  // key above is the A/B variant assignment and is unrelated to this.
  function trackEngagement(post, variantId) {
    var start = Date.now();
    var maxScroll = 0;
    // ONE read must send ONE beacon. Both listeners below can fire in a single visit — a reader who
    // switches tab (visibilitychange → hidden) and later closes the page (pagehide) hit flush twice,
    // and `{ once: true }` on each does nothing about that because they are different events. That
    // recorded two views for one read, which inflates blog_engagement_stats.views and therefore
    // DEFLATES the "Average Read Time" KPI, since it divides summed dwell by views.
    var sent = false;
    function onScroll() {
      var h = document.documentElement;
      var pct = (h.scrollTop) / Math.max(1, h.scrollHeight - h.clientHeight);
      maxScroll = Math.max(maxScroll, Math.min(1, pct));
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    function flush() {
      if (sent) return;
      sent = true;
      window.removeEventListener('scroll', onScroll);
      var dwellMs = Date.now() - start;
      var payload = JSON.stringify({
        publicKey: key, slug: post.slug,
        // Absent when this post is not running a headline test, or the test is already decided —
        // the server then records the read against the post and skips the per-variant row.
        variantId: (variantId && post.abState !== 'decided') ? variantId : null,
        dwellMs: dwellMs, scrollPct: Math.round(maxScroll * 100),
        engaged: dwellMs > 15000 || maxScroll > 0.5,
      });
      try {
        if (navigator.sendBeacon) navigator.sendBeacon(apiBase + '/.netlify/functions/widget-ab-beacon', payload);
      } catch (e) {}
    }
    window.addEventListener('pagehide', flush, { once: true });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  // The Google Fonts stylesheet for the chosen family, if any.
  //
  // It goes on the HOST document's <head>, NOT into the shadow root. `@font-face` declared inside a
  // shadow tree is not reliably honoured across browsers (the font registry is document-scoped), so
  // a <link> in here would leave the family unresolved and fall straight back — the exact silent
  // failure this feature exists to fix. The rule that USES the family still lives in the shadow.
  //
  // Best-effort by design: a customer with a strict CSP may block fonts.googleapis.com. That costs
  // them the webfont and nothing else, because the stored stack always ends in a generic family.
  function loadFontStylesheet(theme) {
    var url = theme && theme.fontUrl;
    if (!url || typeof url !== 'string') return;
    // Server-validated on write (save-widget-config validateTheme), re-checked here because this
    // runs on somebody else's page: the config arrives over the network and this is a <link href>.
    if (url.indexOf('https://fonts.googleapis.com/css2?') !== 0) return;
    if (document.querySelector('link[data-bms-font="' + url.replace(/"/g, '') + '"]')) return;
    var pre = document.createElement('link');
    pre.rel = 'preconnect';
    pre.href = 'https://fonts.gstatic.com';
    pre.crossOrigin = 'anonymous';
    document.head.appendChild(pre);
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    link.setAttribute('data-bms-font', url.replace(/"/g, ''));
    document.head.appendChild(link);
  }

  function applyTheme(shadow, theme) {
    theme = theme || {};
    var accent = theme.accent || '#ec4899';
    var font = theme.fontFamily || 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    loadFontStylesheet(theme);
    var base = document.createElement('style');
    base.textContent =
      ':host{all:initial;}' +
      '.bms{font-family:' + font + ';color:#111827;line-height:1.6;max-width:760px;margin:0 auto;}' +
      '.bms a{color:' + accent + ';}' +
      '.bms h1,.bms h2,.bms h3{line-height:1.25;}' +
      '.bms img{max-width:100%;height:auto;border-radius:8px;}' +
      // Inline body media (:::media directives). A video/audio element with no width rule blows out
      // of the column on a narrow customer page, so constrain both the same way as img.
      '.bms video{max-width:100%;height:auto;border-radius:8px;display:block;}' +
      '.bms audio{width:100%;display:block;margin:8px 0;}' +
      '.bms figure{margin:16px 0;}' +
      '.bms figcaption{font-size:13px;color:#6b7280;margin-top:6px;}' +
      // Column layouts. `gap` + minmax(0,1fr) rather than 1fr: a long word or a wide media element
      // in a 1fr track forces the grid wider than its container instead of shrinking.
      '.bms .bms-columns{display:grid;gap:20px;margin:16px 0;' +
        'grid-template-columns:repeat(2,minmax(0,1fr));}' +
      '.bms .bms-columns[data-cols="3"]{grid-template-columns:repeat(3,minmax(0,1fr));}' +
      '.bms .bms-column > :first-child{margin-top:0;}' +
      // Columns are a desktop affordance — on a phone they must stack, or a 3-up grid renders as
      // three unreadable slivers.
      '@media (max-width:640px){.bms .bms-columns,.bms .bms-columns[data-cols="3"]' +
        '{grid-template-columns:minmax(0,1fr);}}' +
      '.bms .bms-hero{width:100%;object-fit:cover;margin:8px 0 16px;}' +
      '.bms .bms-credit{font-size:12px;color:#6b7280;margin:-8px 0 16px;}' +
      '.bms .bms-card{padding:16px 0;border-bottom:1px solid #e5e7eb;cursor:pointer;}' +
      // The linked card form (data-bms-post-url). `.bms a{color:accent}` above would otherwise
      // repaint the whole card — title, excerpt and all — in the accent colour and underline it.
      '.bms a.bms-card{display:block;color:inherit;text-decoration:none;}' +
      '.bms .bms-badge{display:inline-block;margin-top:24px;padding:4px 10px;border-radius:999px;' +
        'background:#f3f4f6;color:#6b7280;font-size:12px;}' +
      '.bms .bms-back{background:none;border:0;color:' + accent + ';cursor:pointer;padding:8px 0;font-size:14px;}' +
      // font:inherit — :host{all:initial} resets the shadow tree, and a <button> left to the UA
      // stylesheet renders in 13px Arial on an otherwise themed page.
      '.bms .bms-more{display:block;width:100%;margin:20px 0 0;padding:10px 16px;font:inherit;' +
        'font-size:14px;border:1px solid #e5e7eb;border-radius:8px;background:none;' +
        'color:' + accent + ';cursor:pointer;}' +
      '.bms .bms-more[disabled]{opacity:.6;cursor:default;}' +
      // The card becomes a row: thumbnail beside the text. `min-width:0` on the text column is
      // load-bearing — a flex item defaults to min-width:auto, so a long unbroken title would
      // refuse to shrink and push the layout wider than the customer's column.
      // ⚠️ `a.bms-card` must be named explicitly. The linked-card rule above sets display:block at
      // specificity (0,2,1); a bare `.bms .bms-card` is (0,2,0) and loses — so on every embed that
      // opts into data-bms-post-url (the common case, and what bemoreswan.com/blog uses) the
      // thumbnail would stack above the text while unlinked embeds got the row.
      '.bms .bms-card,.bms a.bms-card{display:flex;gap:16px;align-items:flex-start;}' +
      '.bms .bms-card-text{min-width:0;flex:1;}' +
      '.bms .bms-card-text > :first-child{margin-top:0;}' +
      // Fixed box + object-fit so portrait and landscape sources line up down the list instead of
      // each card being a different height.
      '.bms .bms-thumb{flex:0 0 auto;width:120px;height:80px;object-fit:cover;border-radius:8px;}' +
      // On a phone the thumbnail beside the text leaves neither enough room.
      '.bms .bms-meta{font-size:13px;color:#6b7280;margin:6px 0 0;}' +
      // list-style:none and padding:0 are not cosmetic here: :host{all:initial} resets the shadow
      // tree, but a <ul> still picks up the UA stylesheet's discs and 40px indent.
      '.bms .bms-tags{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 0;padding:0;list-style:none;}' +
      '.bms .bms-tags li{font-size:12px;line-height:1;padding:5px 9px;border-radius:999px;' +
        'background:#f3f4f6;color:#4b5563;}' +
      '@media (max-width:520px){.bms .bms-card,.bms a.bms-card{display:block;}' +
        '.bms .bms-thumb{width:100%;height:160px;margin-bottom:12px;}}';
    shadow.appendChild(base);
    if (theme.customCss) {
      var custom = document.createElement('style');
      custom.textContent = String(theme.customCss);
      shadow.appendChild(custom);
    }
  }

  function badgeHtml(post, cfgBadge) {
    var show = post.aiAssisted && (post.badgeEnabled != null ? post.badgeEnabled : cfgBadge);
    return show ? '<div class="bms-badge">✦ AI-assisted content</div>' : '';
  }

  ready(function () {
    var mountEl = document.querySelector(mountSel);
    if (!mountEl) { console.error('[bms-widget] mount element not found: ' + mountSel); return; }
    // Reuse a root the host page already attached. blog.html attaches one inline, before first
    // paint, so its crawler-visible list never flashes; calling attachShadow again on the same
    // element throws NotSupportedError and would take the whole widget down. Customer pages do
    // not pre-attach, so for them this is the same single call it always was.
    var shadow = mountEl.shadowRoot
        || (mountEl.attachShadow ? mountEl.attachShadow({ mode: 'open' }) : mountEl);
    // Clear that page's loading placeholder. Matched on our own marker, so anything else a host
    // put in its shadow root is left alone.
    var placeholder = shadow.querySelector && shadow.querySelector('[data-bms-placeholder]');
    if (placeholder && placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
    var view = document.createElement('div');
    view.className = 'bms';
    shadow.appendChild(view);

    var config = { theme: {}, badgeEnabled: true };

    // ── the post list, paged ──────────────────────────────────────────────────
    // The endpoint used to answer with a hard 50 and no way to ask for the rest, so a blog's 51st
    // post simply stopped appearing — no message, no control, the oldest just fell off the end.
    // It now returns a page plus a nextCursor, and this walks it a page at a time.
    var PAGE_SIZE = 12;
    var listState = null;

    function cardHtml(p) {
      var href = postHref(p.slug);
      // The thumbnail is optional and its absence is a normal state, not a failure — a text-only
      // essay gets a text-only card rather than a placeholder box. loading="lazy" because a long
      // blog is exactly where a list of images costs the reader something.
      var thumb = p.imageUrl
        ? '<img class="bms-thumb" src="' + esc(p.imageUrl) + '" alt="' + esc(p.imageAlt || '') + '" loading="lazy">'
        : '';
      // Byline and date on one line, tags under it. Each part is independently optional — a post
      // with no tags must not leave an empty strip, and a missing date must not leave a stray
      // separator, so the dot is built from what is actually present rather than hard-coded.
      var meta = [p.author, formatDate(p.publishedAt)].filter(Boolean).map(esc).join(' · ');
      var metaHtml = meta
        ? '<p class="bms-meta">' + (p.publishedAt ? '<time datetime="' + esc(p.publishedAt) + '">' : '<span>')
          + meta + (p.publishedAt ? '</time>' : '</span>') + '</p>'
        : '';
      var body = thumb + '<div class="bms-card-text">'
        + '<h2>' + esc(p.title) + '</h2>'
        + '<p>' + esc(p.excerpt) + '</p>'
        + metaHtml + tagsHtml(p.tags)
        + '</div>';
      // A real anchor, not a div with a click handler: middle-click, ctrl-click, "copy link
      // address" and a crawler following the list all need an href to exist.
      return href
        ? '<a class="bms-card" href="' + esc(href) + '">' + body + '</a>'
        : '<div class="bms-card" data-slug="' + esc(p.slug) + '">' + body + '</div>';
    }

    function paintList() {
      if (!listState.posts.length) { view.innerHTML = '<p>No posts yet.</p>'; return; }
      var html = listState.posts.map(cardHtml).join('');
      if (listState.cursor) {
        html += '<button class="bms-more" type="button"' + (listState.loading ? ' disabled' : '') + '>' +
          (listState.loading ? 'Loading…' : listState.error ? 'Could not load more — try again' : 'Load more posts') +
          '</button>';
      }
      view.innerHTML = html;
      Array.prototype.forEach.call(view.querySelectorAll('div.bms-card'), function (card) {
        card.addEventListener('click', function () { navigate(card.getAttribute('data-slug')); });
      });
      var more = view.querySelector('.bms-more');
      if (more) more.addEventListener('click', loadMore);
    }

    function loadMore() {
      if (!listState.cursor || listState.loading) return;
      listState.loading = true;
      listState.error = false;
      paintList();
      // Snapshot the state this request belongs to. renderPost() can replace listState while the
      // fetch is in flight (a reader clicks a post, then Back); without this the response would
      // append its page onto whatever list exists by the time it lands.
      var mine = listState;
      getJSON(API + '/posts?limit=' + PAGE_SIZE + '&cursor=' + encodeURIComponent(listState.cursor))
        .then(function (data) {
          mine.posts = mine.posts.concat(data.posts || []);
          mine.cursor = data.nextCursor || null;
        })
        .catch(function () {
          // Keep what is already rendered. Replacing a part-read list with "Unable to load posts."
          // would throw away the posts they came for because page four timed out.
          mine.error = true;
        })
        .finally(function () {
          mine.loading = false;
          if (mine === listState) paintList();
        });
    }

    function renderList() {
      listState = { posts: [], cursor: null, loading: true, error: false };
      var mine = listState;
      getJSON(API + '/posts?limit=' + PAGE_SIZE).then(function (data) {
        mine.posts = data.posts || [];
        mine.cursor = data.nextCursor || null;
        mine.loading = false;
        if (mine === listState) paintList();
      }).catch(function () {
        if (mine === listState) view.innerHTML = '<p>Unable to load posts.</p>';
      });
    }

    function renderPost(slug) {
      getJSON(API + '/posts/' + encodeURIComponent(slug)).then(function (data) {
        var post = data.post;
        var variant = pickVariant(post);
        var payload = post.payload || {};
        // A live headline test wins — that is the whole point of it. Otherwise the post's own
        // title, NOT metaTitle: that one is the SEO string for <title>, routinely tuned with a site
        // suffix, and it reads badly as the heading a human sees.
        var h1 = variant && variant.h1 ? variant.h1 : (post.title || post.metaTitle);
        var intro = variant && variant.intro ? '<p>' + esc(variant.intro) + '</p>' : '';
        var fi = payload.featureImage;
        var hero = (fi && fi.url)
          ? '<img class="bms-hero" src="' + esc(fi.url) + '" alt="' + esc(fi.alt || '') + '">' +
            (fi.attribution ? '<p class="bms-credit">' + esc(fi.attribution) + '</p>' : '')
          : '';
        view.innerHTML =
          '<button class="bms-back">← All posts</button>' +
          hero +
          '<h1>' + esc(h1) + '</h1>' + intro +
          stripLeadingH1(payload.html) +
          badgeHtml(post, config.badgeEnabled);
        view.querySelector('.bms-back').addEventListener('click', function () { navigate(null); });
        trackEngagement(post, variant && variant.id);
      }).catch(function () { view.innerHTML = '<p>Unable to load this post.</p>'; });
    }

    function navigate(slug) {
      if (slug) { location.hash = '#bms/' + slug; renderPost(slug); }
      else { location.hash = ''; renderList(); }
    }

    // Boot: load theme, then route from the hash.
    getJSON(API + '/config').then(function (c) {
      config = c || config;
      applyTheme(shadow, config.theme);
    }).catch(function () { applyTheme(shadow, {}); }).finally(function () {
      var m = (location.hash || '').match(/#bms\/(.+)/);
      if (m) renderPost(decodeURIComponent(m[1])); else renderList();
    });
  });
})();
