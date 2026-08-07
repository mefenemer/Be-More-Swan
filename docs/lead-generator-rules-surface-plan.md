# Lead Generator: a Rules surface that actually steers

Follow-up to the issue #131 gating. Status: **scoped, not started.**

## Why this exists

The Rules tab used to show a Lead Generator two panels — Assistant Rules and Learned Directives —
that between them steered nothing that assistant does. Issue #131 fixed the *claim*: Learned
Directives is now hidden for records-kind roles, and the Assistant Rules note says plainly that the
rules reach post and blog drafting only.

That was subtractive. It leaves the Lead Generator with a Rules tab containing Strict Rules,
an Assistant Rules card carrying a caveat, and the rejection evidence panel. The levers that
genuinely change who the searches look for are not on it.

This document scopes making that true.

## The trace that justifies the gating (don't re-derive it)

`content_rules` rows reach a model through exactly one path:

```
content_rules → assembleBlueprint() §4 → blueprint-prompt.ts → { process-content-jobs.ts,
                                                                 admin-test-generate-background.ts }
```

`src/utils/blueprint-prompt.ts` has those two callers and no others. Section 4 is additionally read
by `src/utils/blog-generate.ts` and `src/utils/post-quality-review.ts` — again, content only. The
lead pipeline (`netlify/functions/lead-generation.ts`, `process-discovery-jobs.ts`) calls
`getBlueprintVersion()` to *stamp provenance* on rows and never opens the sections.

⚠️ Ungate `_renderRunbookDirectives` only when a records-kind pipeline genuinely reads §4 — not
merely when one starts compiling a blueprint.

## What already works

The Lead Generator has real rules. They are structured, enforced, and live somewhere else.

| Lever | Where it's stored | Where it's enforced | Where it's edited |
|---|---|---|---|
| `excludedDomains` | discovery guardrails, per campaign | `process-discovery-jobs.ts:677` (hard filter) | `assistant-discovery-campaigns.js:392` |
| `negativeKeywords` | discovery guardrails, per campaign | `process-discovery-jobs.ts:679`, and passed into the search at `:178` | same |

And one leg of the rejection → guardrail loop is **already live**:

- `DOMAIN_EXCLUSION_REASONS` is `['competitor', 'not_a_business']` (`src/config/lead-reject-reasons.ts:78`)
- rejecting for one of those returns `canExcludeDomain` (`lead-generation.ts:636`)
- the Review Queue and the Leads tab both offer the exclusion (`assistants.js:1413`,
  `src/components/assistant-data-hub.js:548`)
- accepting writes a guardrail that filters the next run, with **no `strategy_agent` flag involved**

This is worth stating plainly because it is easy to under-sell: "the only consumer is the Strategy
Agent's cluster proposer" is true of the **stored `lead_reject_feedback` rows**, not of the
rejection click. The click already changes targeting for two of the reasons.

## The gap

`LEAD_REJECT_REASONS_FOR_TARGETING` has six members. Two of them have an immediate lever. The other
four — `wrong_industry`, `too_small`, `too_large`, `wrong_geography` — have none. For those, the
only consumer is the Strategy Agent's cluster proposer, which needs `MIN_REJECT_SAMPLE` (8) plus the
burst guard (`MIN_REJECT_CAMPAIGNS` 2 / `MIN_REJECT_SPREAD_DAYS` 2), and is gated on the
`strategy_agent` plan feature, default off.

So a user rejecting fourteen leads for "wrong industry" in one afternoon gets: evidence, correctly
badged "Recorded", and no action they can take from that screen.

## Slices

### Slice 1 — Guardrails get a home on the Rules tab

A "What your searches skip" card on the Rules tab, reading and writing the same guardrails the
Searches UI already edits.

The real decision here is **scope**: guardrails are stored **per campaign**, and the Rules tab is
**per assistant**. Options:

- (a) card lists each campaign's guardrails, editable inline — honest, but repeats the Searches UI
- (b) assistant-level defaults that new campaigns inherit — needs a new storage location and a
  precedence rule against per-campaign values
- (c) read-only summary on Rules, linking through to each campaign

(c) is the cheapest and adds no new concepts; (b) is the one that makes "Rules" mean what a user
expects. **Not decided — see Decisions below.**

### Slice 2 — Extend the post-rejection offer past domain exclusion

For `wrong_industry` / `wrong_geography`, offer to add a negative keyword after the reject, the way
domain exclusion is offered today.

⚠️ This is **not** the same shape as a domain block and must not be built as if it were. Blocking a
domain removes one company; a negative keyword changes what the whole search returns. So:

- the user supplies or confirms the keyword — never inferred silently from the lead
- it must state which campaign it will affect, since guardrails are per campaign
- `too_small` / `too_large` are deliberately excluded: size is a property of the company *today*
  (the same argument that keeps them out of `DOMAIN_EXCLUSION_REASONS`)

Reuse `_rqOfferDomainExclusion` / `offerDomainExclusion` as the pattern; both strips are pinned by
`tests/lead-reject-reasons.test.ts` and the honesty rule applies to any new copy.

### Slice 3 — Make the evidence badges tell the whole truth

`appliedCount` reads `lead_reject_feedback.applied_to_target`, which the Strategy Agent sets. A
domain exclusion accepted from the Review Queue changes targeting but does **not** set it — so a
reason can read "Recorded" when the user has in fact already acted on it.

Fix: set `applied_to_target` when the exclusion offer is accepted, or badge the two paths distinctly.
The second is more honest — "you excluded a domain" and "a search was retargeted" are different
events.

## Decisions needed before starting

1. **Slice 1 scope** — (a), (b) or (c) above. (b) is the only one that makes the Rules tab
   authoritative, and the only one that needs new storage.
2. **Does Slice 2 need `strategy_agent`?** It doesn't today — the domain-exclusion path is
   ungated. Extending it keeps a real feedback loop working on every plan, which may or may not be
   the intended commercial line.
3. **Slice 3 badge wording**, if the two paths stay distinct.

## Out of scope

- Wiring `content_rules` / blueprint §4 into the lead pipeline. Free text is the wrong shape for a
  discovery query, and it would re-create the panel #131 just removed.
- Un-gating Learned Directives for records-kind roles.
- Anything that lets a rejection change targeting without a human accepting it.
