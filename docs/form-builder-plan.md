# Form Builder — architecture plan (Email Marketing Assistant)

Status: **BUILT**, 2026-10-01, with the recommended decisions (D1 vanilla JS, D2 a linked campaign
replaces the welcome sequence by default, D3 a form *registers* a purchase — no payment trigger,
D4 global `/f/<slug>`, D5 builder on the Audience page with a link from the Email Studio).
It EXTENDS the existing audience sign-up form (`audience_forms`, `subscribe.js`, `/s/<key>`).

Where it landed: `src/utils/form-definition.ts` (schema + the one gate), `db/form-builder.sql`,
`subscribe.js` (the one renderer — embed, hosted page, previews), `netlify/functions/audience-public.ts`
(`/f/<slug>`, validated answers, submissions, tags, enrolment), `netlify/functions/audience-forms.ts`
(`save`, `checkSlug`, ownership checks, stats), `src/components/form-builder.js` (Mode B),
`src/utils/form-chat-draft.ts` + the `newsletter_editor` prompt + `renderAudienceFormDraftCard` (Mode A),
`newsletter-sequences.ts` (form-triggered campaigns by `sequenceId`). Phase 5 shipped as per-form
sign-up / subscribed / 30-day counts; page-view analytics were NOT built (they need an anonymous write
on every view). Tests: `form-definition`, `form-builder`, `audience-hosted-page`.

---

## 0. Read this first — where the brief and the codebase differ

| The brief says | The codebase is | What this plan does |
| --- | --- | --- |
| React components | **Vanilla JS** — IIFE modules on `window.*`, views swapped by `workspace.html`'s router. No React, no bundler for app code. | Gives the same component breakdown as vanilla modules (`window.FormBuilder`, `window.BmsForm`). Introducing React for one screen would mean a build pipeline and a second UI idiom; not recommended. **Decision D1.** |
| A new `Forms` table | `audience_forms` **already exists** and is live: public key, allowed origins, segment, double opt-in, hosted page, fields, theme, consent text, success/redirect. | Extends `audience_forms` with one versioned `definition` jsonb, a `slug` and a `sequence_id`. No second forms table — two would mean two submission paths to secure. |
| A `Campaigns` table | Email campaigns are `newsletter_sequences` (+ `_steps`, `_enrolments`). `trigger_event` is CHECK-limited to `'subscribed'`, and a unique index allows **one** per assistant. ("Campaigns" is also the Campaign Orchestrator's paid-ads table — not this.) | Adds a second trigger, `'form'`, and lets many form-triggered sequences exist. |
| "Post-Purchase onboarding flow" triggered by a form | A form submission is not a purchase. Nothing here takes payment. | A form can start any email campaign, including one *named* post-purchase (e.g. a "register your product" form). A true purchase trigger needs a payment/Stripe event — out of scope. **Decision D3.** |
| `bemoreswan.com/f/custom-form-id` | Hosted pages live at `/s/<public_key>` (random, rotatable). | Adds `/f/<slug>` (human-chosen) alongside `/s/<key>`; old links keep working. |
| Heavily customisable styling | Values are interpolated into a `<style>` block **on the customer's own website**. `validateFormTheme` exists precisely because `red; } body{display:none}` is CSS injection. | Styling is a closed set of validated tokens (hex colours, enums). Never free-form CSS. |

---

## 1. The form definition — one JSON schema for chat, GUI and renderer

Stored in `audience_forms.definition`. The chat (Mode A) emits it, the GUI (Mode B) edits it, the
server normalises it (`normaliseFormDefinition`, below), and one renderer draws it on all three
surfaces (embed, hosted page, builder preview).

```ts
// src/config/form-definition.ts
export const FORM_DEFINITION_VERSION = 1;

export type FieldType = 'email' | 'text' | 'textarea' | 'phone' | 'select' | 'radio' | 'checkbox';

/** Where an answer lands in the Audience. */
export type FieldTarget =
  | { kind: 'contact'; column: 'email' | 'first_name' | 'last_name' | 'company' | 'phone' }
  | { kind: 'custom'; key: string }        // audience_contacts.custom_fields[key]; def in audience_custom_fields
  | { kind: 'tag' };                       // checkbox/select → applies the chosen option(s) as audience tags

export interface FormField {
  id: string;                  // stable, 'f_<nanoid>' — survives reordering and relabelling
  type: FieldType;
  label: string;               // ≤ 80
  placeholder?: string;        // ≤ 120
  help?: string;               // ≤ 200
  required: boolean;           // email is always required
  options?: { value: string; label: string }[];   // select/radio/checkbox only, 2–20
  target: FieldTarget;
}

export interface FormStyle {
  accent: string;              // #rrggbb — button, focus ring
  background: string;          // #rrggbb — card
  text: string;                // #rrggbb
  pageBackground?: string;     // #rrggbb — hosted page only
  font: 'inherit' | 'system' | 'serif' | 'rounded' | 'mono';   // 'inherit' = the host site's font (embed only)
  radius: 'none' | 'small' | 'large';
  layout: 'stacked' | 'inline';                                // inline = email + button on one row
  logo: { assetId: string } | null;                            // an uploaded image; served via the media proxy
  useBrandKit: boolean;        // true → accent/text/logo follow the org brand kit until edited
}

export interface FormDefinition {
  version: 1;
  name: string;                                 // internal
  purpose: 'newsletter' | 'lead_magnet' | 'waitlist' | 'event' | 'enquiry' | 'onboarding' | 'custom';
  content: {
    headline: string;                           // ≤ 120
    intro: string;                              // ≤ 600
    buttonLabel: string;                        // ≤ 40
    successMessage: string;                     // ≤ 300
    redirectUrl: string | null;                 // http(s) only
  };
  fields: FormField[];                          // 1–12, exactly one type:'email'
  consent: { text: string; requireCheckbox: boolean };
  style: FormStyle;
  delivery: {
    embed: { enabled: boolean; allowedOrigins: string[] | null };   // null = any origin (existing semantics)
    hosted: { enabled: boolean; slug: string | null };              // /f/<slug>
  };
  audience: {
    doubleOptIn: boolean;
    segmentId: number | null;                   // existing behaviour: confirmed → added to segment
    tags: string[];                             // applied to every submission
  };
  /** The email campaign a submission starts. null = the org's welcome sequence (today's behaviour). */
  campaign: { sequenceId: number | null; skipWelcome: boolean };
}
```

Example (what the chat emits for a lead magnet):

```json
{
  "version": 1,
  "name": "Pricing guide download",
  "purpose": "lead_magnet",
  "content": {
    "headline": "Get the 2026 pricing guide",
    "intro": "Five ways small studios price their work — free, straight to your inbox.",
    "buttonLabel": "Send me the guide",
    "successMessage": "Check your inbox — the guide is on its way once you confirm.",
    "redirectUrl": null
  },
  "fields": [
    { "id": "f_email", "type": "email", "label": "Email", "required": true, "target": { "kind": "contact", "column": "email" } },
    { "id": "f_first", "type": "text", "label": "First name", "required": false, "target": { "kind": "contact", "column": "first_name" } },
    { "id": "f_size", "type": "select", "label": "Team size", "required": false,
      "options": [ { "value": "solo", "label": "Just me" }, { "value": "2_10", "label": "2–10" }, { "value": "11_plus", "label": "11+" } ],
      "target": { "kind": "custom", "key": "team_size" } }
  ],
  "consent": { "text": "By signing up you agree to receive emails from Acme Studio. Unsubscribe any time.", "requireCheckbox": false },
  "style": { "accent": "#0d9488", "background": "#ffffff", "text": "#111827", "font": "system", "radius": "small",
             "layout": "stacked", "logo": null, "useBrandKit": true },
  "delivery": { "embed": { "enabled": true, "allowedOrigins": null }, "hosted": { "enabled": true, "slug": "pricing-guide" } },
  "audience": { "doubleOptIn": true, "segmentId": null, "tags": ["pricing-guide"] },
  "campaign": { "sequenceId": null, "skipWelcome": false }
}
```

### `normaliseFormDefinition(raw, ctx)` — the one gate

`src/utils/form-definition.ts`, called by the chat route (before the card is stored), the GUI save,
and the public render. Same role `campaignDraftFromUiElement` plays for campaigns:

- Colours: `/^#[0-9a-f]{6}$/i` or fall back to the brand kit. Enums: unknown → default. Never free CSS.
- Text: length-capped, stored raw, **escaped at render** (labels reach the customer's site).
- Fields: 1–12; exactly one `email`, forced `required`; `id`s unique; options 2–20 each ≤ 80;
  `target.custom.key` must match `^[a-z][a-z0-9_]{0,39}$` (the existing `audience_custom_fields` CHECK);
  two fields may not write the same target.
- `slug`: `^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$`, not in a reserved list (`admin`, `login`, `api`,
  `bemoreswan`, …), unique across ALL orgs (it is a public namespace). Taken → returned as a warning,
  not silently changed.
- `redirectUrl`: existing `validateRedirectUrl` (http/https only — it becomes a navigation).
- `segmentId` / `sequenceId`: must belong to the org (`ctx.organisationId`), else nulled with a
  warning. **The chat never sets these** (it cannot see the org's data) — see §3.
- Returns `{ definition, warnings[] }`, like the campaign normaliser.

---

## 2. Database (Drizzle) — extend, don't duplicate

```ts
// db/schema.ts — audience_forms gains three columns (all nullable; existing rows keep working)
export const audienceForms = pgTable("audience_forms", {
  // …existing columns unchanged…
  definition: jsonb("definition"),            // FormDefinition v1. NULL = legacy row → renderer reads the old columns
  slug: text("slug"),                         // /f/<slug>; NULL = no vanity URL
  sequenceId: integer("sequence_id").references(() => newsletterSequences.id, { onDelete: "set null" }),
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),  // who built it
}, (t) => [
  // …existing…
  uniqueIndex("audience_forms_slug_uidx").on(sql`lower(${t.slug})`).where(sql`${t.slug} IS NOT NULL`),
  index("audience_forms_sequence_idx").on(t.sequenceId),
]);

// newsletter_sequences — a second trigger, and many of them
//   trigger_event CHECK: ('subscribed')  →  ('subscribed', 'form')
//   unique (assistant_id, trigger_event)  →  unique (assistant_id) WHERE trigger_event = 'subscribed'
//   (still ONE welcome sequence; any number of form-triggered ones)

// NEW — what each submission said, for consent evidence and "which form did they come from"
export const audienceFormSubmissions = pgTable("audience_form_submissions", {
  id: serial("id").primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  formId: integer("form_id").references(() => audienceForms.id, { onDelete: "set null" }),
  contactId: integer("contact_id").references(() => audienceContacts.id, { onDelete: "cascade" }),
  definitionHash: text("definition_hash").notNull(),   // sha256 of the definition rendered — "what did the form ask"
  consentText: text("consent_text").notNull(),         // the exact sentence shown
  answers: jsonb("answers").notNull().default({}),     // { fieldId: value } — ONLY fields that are not contact columns
  pageUrl: text("page_url"),
  surface: text("surface").notNull(),                  // 'embed' | 'hosted'
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("audience_form_submissions_form_idx").on(t.formId, t.createdAt),
  check("audience_form_submissions_surface_check", sql`${t.surface} IN ('embed','hosted')`),
]);
```

**Relationships:** `audience_forms 1—N audience_form_submissions N—1 audience_contacts`;
`audience_forms N—1 newsletter_sequences` (many forms may start the same campaign).

**Migration** `db/form-builder.sql` — idempotent, `ADD COLUMN IF NOT EXISTS`. ⚠️ Constraint changes
must be written DROP-IF-EXISTS **then** ADD in a way that survives a re-run (see the
`migration-drop-then-add-constraint-trap` note — a half-applied file silently skips the rest).
⚠️ `db.select()` on `audienceForms` names every column, so **apply before deploying** code that
selects the new ones, or `audience-public.ts` 500s for every visitor of every form.

### Submission flow (server — `audience-public.ts`)

```
POST /api/audience/subscribe { key | slug, answers: { fieldId: value }, hp, ms, url }
  1. Existing gates unchanged: rate limits, honeypot, MIN_FILL_MS, originAllowed, identical error bodies.
  2. definition = normaliseFormDefinition(form.definition ?? legacyToDefinition(form))
  3. Validate answers against the definition (required, type, option ∈ options). Unknown ids dropped.
  4. Upsert audience_contacts (contact columns) + merge custom_fields; create missing
     audience_custom_fields defs (type 'text') for custom targets; apply tags (definition.audience.tags
     + 'tag' targets).
  5. Insert audience_form_submissions.
  6. doubleOptIn ? send confirmation (existing) : mark subscribed and go to 7.
On confirm (or immediately when single opt-in):
  7. segment assignment (existing)
  8. enrol:  form.sequenceId (enabled)  → enrolInSequence(form.sequenceId)
             and unless definition.campaign.skipWelcome → enrolInWelcomeSequence (existing)
```

`enrolInWelcomeSequence` generalises to `enrolInSequence(db, { sequenceId, … })`; the welcome path
becomes a lookup + call. Consent is still re-checked per send by the sequence worker — unchanged.

---

## 3. Mode A — the chat (system prompt section)

Added to the `newsletter_editor` route in `chat-orchestrator.ts`, beside the email-campaign section.
Emits a new card type, `audience_form_draft`, normalised by `normaliseFormDefinition` before it is
stored (the same contract as the campaign card: the card is an OFFER, Save is what writes).

```text
SIGN-UP FORMS — you also design the forms people fill in to join this business's audience: a
newsletter sign-up, a free download, a waitlist, an event registration, an enquiry, or a "register
your purchase" form. Each form can be pasted into their website, given its own page on Be More Swan
to share from a social bio, or both. Every answer lands in their Audience.

HOW TO BUILD ONE — never output a form in your first reply unless they have already told you all of this.

STEP 1 — SCOPE, in ONE reply and at most four short questions, whatever you do not already know:
  • PURPOSE — what someone gets for filling it in (the newsletter, a guide, a place on a waitlist).
  • WHAT TO ASK — the fewest questions that serve the purpose. Email always. Every extra field costs
    sign-ups: suggest at most three more, and say why each earns its place.
  • WHERE IT LIVES — their website, its own page to share, or both. For its own page, suggest a short
    address ending (e.g. "pricing-guide").
  • LOOK — their brand colours, or "match my brand" (their brand kit is used automatically).
If they have given you enough, go straight to Step 2.

STEP 2 — PROPOSE THE FORM as an "audience_form_draft". In "reply", say in one sentence what it asks
and why, and invite changes. They can keep it or bin it with the buttons; saving opens it in the form
builder, where they can drag fields, pick colours and link it to an email campaign.

STEP 3 — REVISE. When they ask for a change, return the WHOLE form with only that changed. The form on
screen is the "[ON SCREEN …]" block at the end of your earlier reply; start from it.

RULES
  • Ask only for what the purpose needs. Never ask for a date of birth, address, payment details or
    anything sensitive (health, religion, ethnicity, politics) — this form cannot protect them. If they
    insist, say so and leave it out.
  • Field types you may use: email, text, textarea, phone, select, radio, checkbox. A select/radio/
    checkbox needs 2–20 options.
  • Every answer must land somewhere: a contact detail (first_name, last_name, company, phone), a
    custom field (a short snake_case key you choose, e.g. "team_size"), or a tag.
  • Consent: always include a plain sentence saying what they will receive and that they can
    unsubscribe at any time. Keep double opt-in ON unless they ask otherwise.
  • Colours are #rrggbb only. Never invent a URL; a redirect only if they gave you one.
  • You CANNOT see their segments or email campaigns, so you never choose one. Say that they link the
    form to a campaign in the form builder after saving — and that, unlinked, new sign-ups get their
    welcome sequence (if they have one switched on).
  • Never say a form is live, published or collecting sign-ups. Saving makes a draft; they publish it.

JSON — the uiElement for a form:
{ "type": "audience_form_draft", "form": <FormDefinition with campaign.sequenceId and audience.segmentId null> }
```

Card (`renderAudienceFormDraftCard`, `disruptive-ui-registry.js`): a live preview via the shared
renderer (§4), a summary of fields and where each answer goes, warnings from the normaliser, and
**Save as draft** / **Discard**. Save → `POST /audience-forms { action: 'create', definition, status: 'draft' }`
→ the card offers "Open in the form builder".

---

## 4. UI architecture — vanilla modules (the "component" tree)

```
subscribe.js  (public, ES5, served to customers' sites)
└─ window.BmsForm.render(definition, mountEl, { surface, onSubmit })     ← THE renderer, one copy
   ├─ ShadowRoot (style isolation on the host site — existing pattern)
   ├─ StyleSheet(definition.style)        tokens → CSS custom properties, all pre-validated
   ├─ Header (logo, headline, intro)
   ├─ Field × N   (EmailField, TextField, TextareaField, PhoneField, SelectField, RadioGroup, CheckboxGroup)
   ├─ Consent (sentence | required checkbox)
   ├─ Honeypot + timing (existing)
   └─ Result  (success message | redirect | error — identical bodies, existing rule)

GET /f/:slug, /s/:key  (audience-public.ts)
└─ minimal HTML shell + <script src="/subscribe.js"> + the definition inlined as JSON
   → the SAME renderer, surface: 'hosted' (page background, centred card, logo)

audience.js → Forms list (existing modal) → "Edit" opens:
form-builder.js   window.FormBuilder.mount(host, { definition, segments, sequences, brandKit, onSave })
├─ Toolbar          name · status (draft/live) · Save · Preview desktop|mobile
├─ FieldPalette     click or drag a field type into the list
├─ FieldList        drag to reorder (pointer events) + ↑/↓ buttons (keyboard, screen readers)
├─ FieldInspector   label, placeholder, required, options editor, "saves to" (contact / custom / tag)
├─ StylePanel       <input type="color"> ×3 + brand-kit swatches + "match my brand", font, corners,
│                   layout, logo upload (newsletter-media path)
├─ ContentPanel     headline, intro, button label, success message, redirect
├─ DeliveryPanel    embed snippet + allowed sites · hosted page on/off + /f/<slug> (availability check)
├─ AudiencePanel    double opt-in · segment ▾ · tags · email campaign ▾ (form-triggered sequences + "Create one")
└─ LivePreview      BmsForm.render(currentDefinition, …, { surface: 'preview' }) — re-rendered on change

disruptive-ui-registry.js
└─ renderAudienceFormDraftCard        preview (BmsForm) + summary + Save/Discard  (Mode A)
```

Conventions this follows (from past incidents): handlers bound once at mount with delegation, never
from a render path; never repaint the field list under an active drag; modals mounted outside
`.admin-view`-style hidden ancestors; every class used must already exist in the prebuilt
`style.css` (or be added in a Tailwind rebuild, which churns unrelated classes — do it deliberately).

The Email Studio gets a **Sign-up forms** link (and the email campaign builder's "Who is in it?"
gains **"People who fill in a form"** → creates a `'form'`-triggered sequence and offers to link a form).

---

## 5. Security & compliance checklist

- CSS injection: tokens only (§1). Labels/options/text escaped in the renderer; never `innerHTML` raw.
- Public write path: existing rate limits, honeypot, min-fill, origin allow-list, uniform error bodies.
- Answers validated server-side against the definition — the client is never trusted for `required`
  or option values.
- Slugs: public namespace — reserved words, uniqueness, and a report path; a tenant can put another
  brand's name on a page we host. (Same impersonation risk the hosted page already carries.)
- Logo: R2 is private — serve through the existing newsletter media proxy, not a raw R2 URL.
- Fonts: no third-party font loads on customers' sites (Google Fonts leaks visitor IPs — an EU
  compliance issue). System stacks only; `inherit` uses the host site's own font.
- Sensitive fields refused (prompt + a denylist on custom keys/labels is advisory only; the prompt rule
  is the real control for Mode A — Mode B users can still add a free-text field).
- Consent evidence: `audience_form_submissions.consentText` + `definitionHash` per submission.
- Retention: add `audience_form_submissions` to `content-retention.ts`.

---

## 6. Build phases

| Phase | Scope | Notes |
| --- | --- | --- |
| 1 | `form-definition.ts` (types + normaliser + `legacyToDefinition`), migration, `BmsForm` renderer in `subscribe.js`, hosted page on the renderer, `/f/<slug>`, submission validation + custom fields + tags + submissions table | Existing forms keep working unchanged (definition NULL → legacy). Tests: normaliser, CSS-injection cases, legacy parity. |
| 2 | GUI builder (`form-builder.js`) in Audience → Forms; Email Studio link | Live preview via the renderer. |
| 3 | Campaign linkage: `'form'` trigger, `enrolInSequence`, Studio builder + chat campaign option, campaign dropdown in the builder | Updates `AUTOMATIC_TRIGGERS` + the prompt line (a test pins them to the DB check). |
| 4 | Mode A: prompt section, `audience_form_draft` card, normaliser in the chat route | Same Save/Discard contract as the campaign card. |
| 5 | Form analytics (views, submissions, confirm rate) on the form and the assistant Overview | Views need a beacon on render. |

---

## 7. Decisions needed before building

- **D1 — React?** Recommended: no; vanilla modules as above, matching the rest of the workspace.
- **D2 — A linked form and the welcome sequence:** send BOTH (default `skipWelcome: false`), or does a
  linked campaign REPLACE the welcome sequence? Recommended: replace by default for linked forms —
  two series starting the same day reads as spam.
- **D3 — "Post-purchase":** accept that a form starts it (someone registers a purchase), or is a real
  purchase trigger (Stripe/Shopify order) wanted? The latter is a separate integration.
- **D4 — Slug namespace:** global `/f/<slug>` (short, first-come) or org-scoped `/f/<org>/<slug>`
  (no squatting, longer)? Recommended: global with a reserved list, since bios want short links.
- **D5 — Where the builder lives:** Audience → Forms (org-wide, where forms are today) with a link from
  the Email Studio — or inside the Email Studio? Recommended: Audience, since forms feed every assistant
  that sends.
