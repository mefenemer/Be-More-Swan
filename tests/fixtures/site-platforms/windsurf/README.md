# Windsurf fixtures (SYNTHETIC)

Every business, word, address and picture path here is invented. None is a real site's page.
The shapes follow what Windsurf's Cascade writes and what Windsurf App Deploys serve from Netlify at
`<name>.windsurf.build`. The HTML holds no comments, because a comment that names the platform would
fool detection.

| File | Shape |
| --- | --- |
| `vite-shell.html` | Vite + React `index.html` before JavaScript runs, with the `og:url` and canonical Cascade often adds (`*.windsurf.build`) |
| `vite-shell-bare.html` | The plain Vite `index.html`: nothing in it names the host (the usual case, and undetectable from HTML) |
| `vite-rendered.html` | The same site after headless Chrome ran it: Tailwind, lucide SVG icons, framer-motion inline opacity, `bg-[url()]` hero, logo link in the header |
| `next-export.html` | Next.js app-router static export: words in the HTML, pictures through `/_next/image?url=…` |
| `static-html.html` | One-page HTML + Tailwind CDN with `#anchor` menu, stylesheet linked absolutely on `*.windsurf.build` |
| `mentions-windsurf.html` | A blog post that talks about Windsurf and Codeium and links to a `*.windsurf.build` demo: must NOT be read as Windsurf |
