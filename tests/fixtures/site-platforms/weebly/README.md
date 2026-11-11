# Weebly / Square Online fixtures

SYNTHETIC pages modelled on the markup Weebly (classic, `wsite-*` themes on `editmysite.com`) and
Square Online (`window.__BOOTSTRAP_STATE__`, generator "Square Online") publish. The business
("Kestrel Cycle Repairs", Brindlemoor) and every word, address and picture name are made up; hosts
are `.example`. Used by `tests/site-platform-weebly.test.ts`.

- `classic-home.html` — modern Weebly theme: menu outside `<nav>` (desktop + mobile + dummy copies),
  sub-pages only in the `initPublishedFlyoutMenus` script, logo in `.wsite-logo`, header section
  with a background picture, `div.paragraph` split by `<br><br>` with a list inside, a two-column
  `table.wsite-multicol`, an image with Weebly's default alt "Picture", a gallery (lightbox links to
  `_orig`), a slideshow drawn by `wSlideshow.render`, a Weebly map, a button, a footer with the
  "Powered by Weebly" box and a Cloudflare-protected email address.
- `classic-about.html` — an older theme (`#wsite-content`, `h2.wsite-content-title`, `#footer`).
- `classic-blog.html` — a Weebly blog page: posts, sidebar archives, comment counts, share bar.
- `square-online-home.html` — Square Online: an empty `#app` and the page in the bootstrap JSON
  (banner + text-and-image rows in Quill ops, links by page id, hidden elements, menu in
  `autoNavLinks`, logo in the snapshot).
