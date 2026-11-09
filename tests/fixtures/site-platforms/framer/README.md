# Framer fixtures (synthetic)

Made-up pages modelled on the markup Framer publishes (studied on public Framer template sites,
2026-11-08). No real business's words or pictures; `harbourlane.example` and the
`framerusercontent.com/images/…` ids are invented.

- `home.html` — home page: generator tag, `data-framer-hydrate-v2` breakpoints on `#main`, desktop and
  phone copies (`ssr-variant hidden-*`) of the menu, headings (h1 on desktop, h3 on phones), cards and
  pictures; a menu drawn in plain `div`s (no `<nav>`), buttons as `a > div > h6`, a link inside a
  sentence, a CMS card link, a Framer form, cookie banner, footer and "Made in Framer" badge, colour
  tokens as `--token-<uuid>` on `body`, fonts as `--framer-font-family` presets.
- `about.html` — a menu page with its own breakpoint copies.
- `contact.html` — contact page with a Framer form (`<label><p>Name</p><input></label>`, a `<select>`)
  and the Maps component's iframe (`maps.google.com/maps?q=…&output=embed`).
- `no-hydrate.html` — an older export: `ssr-variant` copies but no breakpoint list on `#main`, only the
  `@media … .hidden-*` rules in `<style>`.
