# Claude Artifacts in Be More Swan — REVIEW (feature request #43)

2026-11-15. **Owner decision 2026-11-15: "Quiz first"** — go on interactive tools, quiz first, in the Form Builder
(not a new assistant), no free-form generated code. **Phase 1 (Quiz) built** on branch `feat/fr43-quiz` (§8).
Still open: plan placement (decision 3) — Phase 1 ships on every plan, like forms.

The ask: *"Consider how we can incorporate Claude Artifacts into Be More Swan, whether as a dedicated new assistant
or whether the creation of these artifacts falls under an existing assistant. Will it add value? Will users want to
buy a subscription? Is it disruptive?"*

---

## 1. Short answer

- **We can't plug real Claude Artifacts in.** Artifacts are a claude.ai feature: each page belongs to the person's own
  Claude account and is hosted by Anthropic. I know of no way to make them for *our* customers, on *our* domain, under
  *our* bill. The realistic route is our own version of the idea, built on the Claude API we already use.
- **The idea worth taking is narrower than "Artifacts": interactive tools that win customers** — a price
  estimator, a "which package is right for you?" quiz, a "how much could you save?" calculator, a checklist. For a
  small business these are lead magnets: the visitor gets an answer, the business gets an email and a warm lead.
- **No new assistant, and not free-form AI code.** Put it in what we have: a new **quiz / calculator form type** in
  the Form Builder (Email Marketing Assistant), shown as a section by the Website Assistant and linked by the Social
  Assistant. The AI writes a *definition* (questions, scores, formula, results); our own code runs it — the same
  "definition is the truth" rule as forms and websites.
- **Subscriptions:** nobody will pay us for a generic "make me an app" box — Claude, ChatGPT, Gemini and Lovable-type
  tools already do that for about the price of one of our plans. People *will* value tools that already know their
  prices, brand and products and drop leads straight into Audience and Lead Generator. That makes it a **reason to
  stay and upgrade**, not a product on its own.
- **Disruptive?** Mildly, if done this way: a working quote calculator for a micro business, made in a chat in two
  minutes, connected to their email list and lead board, is uncommon. Quiz/calculator builders (Outgrow, involve.me,
  Typeform's calculators) are separate paid tools that know nothing about the business.

## 2. What real Artifacts are, and why copying them as-is is wrong for us

Artifacts are self-contained web pages (HTML + JavaScript) that Claude writes and hosts: tools, dashboards, games,
documents. Each runs on its own isolated web address so its code can't reach anything else.

Copying that — "the AI writes JavaScript and we publish it" — clashes with how we've built the product:

| Our rule today | Where | What free-form AI code would break |
| --- | --- | --- |
| Hosted sites run **no JavaScript**; the security policy forbids scripts and only lets forms post to us or Stripe | `netlify/functions/site-serve.ts:15`, CSP at `:50` | A script on a customer's page can send a visitor's details anywhere, or be used to build a phishing page on our domain |
| Styling is a closed set of checked values, never free CSS | `src/utils/form-definition.ts`, `validateFormTheme` (see `docs/form-builder-plan.md` §0) | Generated code is the opposite: anything goes |
| Interactive steps work with no script: "every step a page, every choice a link" | booking steps, `site-serve.ts:234` | — (this is the pattern a quiz/calculator can reuse) |

Free-form generated apps would also bring: a support load ("my calculator gives the wrong number"), apps that
break silently when browsers change, abuse risk on our domain, and an expensive model call per edit.

## 3. What fits the product (and where)

| Tool | What the visitor gets | What the business gets | Built from |
| --- | --- | --- | --- |
| **Quiz** ("Which treatment suits you?", "Is your website losing customers?") | A result page with advice and a recommended product | Email, answers, a tag/segment per result, a follow-up email flow | Form Builder: add scored answers + result pages to the form definition |
| **Price estimator** ("Rough cost of your kitchen") | An estimate range | A qualified lead with the job size | `org_products` prices (already structured: fixed / from / on request) + a small formula in the definition |
| **Savings / ROI calculator** | A number and a chart image | Lead + what they typed | Same formula engine |
| **Checklist / scorecard** | A score and a printable list | Lead + score | Quiz with scores |

Where it lives:
- **Email Marketing Assistant ▸ Form Builder** owns the definition, the submissions and the follow-up flows
  (`audience_forms`, `/f/<slug>`, `subscribe.js`) — no second submission path to secure.
- **Website Assistant** adds a "Quiz / calculator" section that shows it (server-rendered, step by step, no script).
- **Social / Blog Assistants** can suggest and link it ("Take the 30-second quiz").
- **Lead Generator** sees a quiz/calculator lead with its answers.
- Every capability in GUI **and** chat (owner rule): "make me a quiz that recommends one of my three packages" →
  draft card → edit → publish.

## 4. Would it sell subscriptions?

- **On its own: no.** A generic artifact maker is commodity; anyone with a Claude or ChatGPT subscription can make
  one. A separate "Artifacts Assistant" would be compared with those and lose.
- **As part of the team: yes, as retention and an upgrade reason.** The value is the joined-up result: built from
  their own prices and brand, published on their own site, leads into Audience, follow-up email written for them.
- Pricing options: all plans get quizzes; calculators (or more than N live tools) on the higher tier. Generation is
  one model call per draft, so cost is low next to video or images; meter it as a task like other background work.

## 5. Is it disruptive?

Honest view: **incremental, not disruptive.** It strengthens our existing story ("a team that wins you customers")
rather than opening a new market. What makes it better than the separate quiz-builder tools: no setup, already on-brand,
already connected. What makes it worse: fewer templates and question types at first.

## 6. Suggested plan (if the owner says go)

- **Phase 0 — check demand (no build).** Look at whether any beta user has asked for quizzes or calculators; add a
  "Coming soon" line only after a decision (public copy must match the system).
- **Phase 1 — Quiz.** Scored answers + 2–5 result pages in the form definition; result → tag → follow-up flow;
  chat draft card; Website section rendered step by step with no script. Proof tests: definition validation,
  scoring, result routing, no-script render.
- **Phase 2 — Price estimator / calculator.** A small, safe formula language (numbers, + − × ÷, min/max, product
  prices by id), checked on save; never `eval`.
- **Phase 3 — only if asked for.** Free-form AI-built mini-apps, on a separate sandboxed domain, with review
  before publish. Not recommended now.

## 7. Decisions for the owner

1. Go / no-go on "interactive tools" (quiz first), or park FR#43 as On Hold?
2. Agree it lives in the Form Builder + Website section, **not** a new assistant?
3. Plan placement: quizzes on every plan, calculators on the higher tier — or all plans?
4. Rule out free-form generated code (Phase 3) for now?

## 8. Phase 1 — what was built (2026-11-15)

- **Definition** (`src/utils/form-definition.ts`): optional `quiz: { results[2–5] }` (title, body, tag, button
  label + http(s) link); each choice may carry `scores: { <resultId>: points }` (whole, 1–10, only towards
  results that exist). Purpose `quiz`. `quizResultFor()` — most points wins, ties and no points go to the first
  result. `validateAnswers()` adds the result's tag to the form's tags and keeps `quiz_result` on the submission.
  `publicDefinition()` strips the points, so a visitor's browser never sees them.
- **Public endpoint** (`audience-public.ts`): the subscribe reply carries `result` (words only, never the tag) on
  every success after validation, and a result replaces the redirect.
- **Embed / hosted page** (`subscribe.js`): draws the result (escaped; link only if http(s)).
- **Website** (signup section, no script): `/_sent?…&r=<id>` — the page reads the result's words from the stored
  form; an unknown id is ignored. `renderSiteNotice` gains an optional onward button.
- **Builder** (`form-builder.js`): a **Quiz** tab — make it a quiz, write 2–5 results, pick which result each
  multiple-choice / dropdown answer points to. Explainers added. Forms list shows how many got each result.
- **Chat**: the Email Marketing Assistant can draft a quiz (`QUIZZES` block in its prompt); the draft card lists
  the results and how many answers point to each.
- **No database change** — the definition and submission answers are existing jsonb columns.
- Proof: `tests/form-quiz.test.ts` (13 checks) — fails on staging before, passes after.
- Not in Phase 1: one-question-at-a-time steps, scored bands ("score 0–5 / 6–10"), Lead Generator view of quiz
  answers, Social Assistant suggesting the quiz link.
