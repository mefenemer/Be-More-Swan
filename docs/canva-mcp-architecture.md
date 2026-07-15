# Canva Hybrid Architecture — Connect REST (UI) + Canva MCP (AI Assistants)

Companion to [canva-connector-plan.md](./canva-connector-plan.md). That plan covers US1–US3 (connector,
browse, import) over Connect REST — unchanged and still correct. This document covers the pivot:
routing the **Social Media Manager** and **Blog Writer** through Canva's remote MCP server for
**auto-resize** and **brand-template text injection**.

All facts below verified against live Canva/Anthropic sources on 2026-07-15.

---

## 0. Read this first — three findings that change the decision

### 0.1 ⚠️ The capabilities you asked for are gated on the END USER's Canva plan

This is the biggest risk in the epic and it is **not** an architecture problem — it applies
identically whether you go via MCP or Connect REST:

| Capability | Requirement | Verified against |
|---|---|---|
| **Inject text into brand templates** (autofill) | **Canva Enterprise** | *"To use this API, your integration must act on behalf of a user who is a member of a Canva Enterprise organization."* Paid plans get a limited trial during integration development. |
| **Auto-resize designs** | **Canva Pro** or above | *"…must act on behalf of a user that's on a Canva plan with premium features (such as Canva Pro)."* Free plan gets limited trial access with quota restrictions. |
| List/read brand templates | Canva Pro, Teams, or Enterprise | Same shape. |

Canva's MCP tool table states the same gates on the tools themselves: `resize-design` is
"Pro and above"; `autofill-design` and `get-brand-template-dataset` are "**Enterprise only**".

**What this means commercially:** brand-template autofill will work for the subset of BMS tenants
whose connected Canva user sits in a Canva Enterprise org. For everyone else the tool call fails at
Canva regardless of how well we build this. Before investing in either integration path, decide:

1. Is Enterprise-only autofill acceptable as a premium-tier feature?
2. Do we detect the user's plan at connect time and hide/disable the capability, rather than letting
   the assistant attempt it and fail? (Strongly recommended — a silent tool failure inside an
   autonomous drafting run is close to invisible.)

There is no workaround. Design the UX around the gate.

### 0.2 ✅ MCP-from-a-backend is viable — but *not* with our existing Connect token

Two things had to be true for this pivot to work. Both were checked rather than assumed.

**(a) The Messages API can route tool calls to a remote MCP server, server-side.** Anthropic's
**MCP connector** (beta `mcp-client-2025-11-20`) accepts an `mcp_servers` array and makes the
connection from Anthropic's infrastructure — no MCP client library in our functions, no session
management in a 15-minute Netlify budget. It takes a per-request `authorization_token`, which is
exactly the multi-tenant shape we need. Canva's own docs describe the MCP server as intended for
"interactive AI clients, not server-to-server backend operations" — the MCP connector is what makes
the server-to-server path work anyway, because we supply the user's token per request instead of
relying on an interactive consent prompt.

**(b) Which token?** This is the load-bearing question, and the answer is **not the Connect token we
already have**. Probing the MCP server's own metadata:

```
GET https://mcp.canva.com/.well-known/oauth-authorization-server
{"issuer":"https://mcp.canva.com",
 "authorization_endpoint":"https://mcp.canva.com/authorize",
 "token_endpoint":"https://mcp.canva.com/token",
 "registration_endpoint":"https://mcp.canva.com/register",
 "client_id_metadata_document_supported":true,
 "code_challenge_methods_supported":["plain","S256"],
 "grant_types_supported":["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:jwt-bearer"]}
```

`mcp.canva.com` **is its own OAuth issuer** — a different authorization server from Connect
(`www.canva.com/api/oauth/authorize` → `api.canva.com/rest/v1/oauth/token`). Different issuer,
different token endpoint, different audience. A Connect access token is not valid there, and an
unauthenticated call confirms the gate:

```
POST https://mcp.canva.com/mcp  → 401
www-authenticate: Bearer realm="OAuth",
  resource_metadata="https://mcp.canva.com/.well-known/oauth-protected-resource/mcp",
  error="invalid_token", error_description="Missing or invalid access token"
```

**Consequence: the hybrid needs a SECOND OAuth connection per user.** The user connects Canva once
for browse/import (Connect) and again for the AI assistants (MCP). Two consent screens, two token
rows, two refresh lifecycles, two things that can independently expire. That is a real and
permanent UX cost, and §5 is where I'd argue about whether it's worth paying.

The MCP authorization server does advertise `urn:ietf:params:oauth:grant-type:jwt-bearer` and the
ID-JAG grant profile (`urn:ietf:params:oauth:grant-profile:id-jag`) — a cross-domain token-exchange
profile that could in principle mint an MCP token from an existing identity assertion and collapse
the two connections into one. That is enterprise-SSO territory, undocumented for this use case, and
**should not be planned around** until proven. Treat two connections as the design.

The good news: the MCP authorization server advertises the scopes we need —
`design:meta:read`, `design:content:read`, **`design:content:write`**, `folder:read`, `asset:read`,
`brandtemplate:meta:read`, `brandtemplate:content:read`, `brandkit:read`, plus write variants.

### 0.3 ⚠️ The assistants are not tool-calling agents today

`src/lib/ai-gateway.ts` is a thin `Anthropic` wrapper: `{system, messages, maxTokens}` in, `{text}`
out. `GatewayRequest` has no `tools` field; `GatewayResponse` is text-only. Every assistant is a
**single-shot text generator** — e.g. the Social Media Manager asks for caption + hashtags +
imagePrompt as one JSON blob and parses it.

There is no tool-use loop, no `tools` plumbing, and no MCP client anywhere in the repo (`grep` for
`modelcontextprotocol`/`mcp` across `package.json`, `src/`, `netlify/functions/` returns nothing).

"Route the AI Assistant's tool calls through the Canva MCP" therefore presumes a tool-calling agent
that **does not exist yet**. The MCP connector removes the need for an MCP client library, but the
gateway still has to grow tool support and a turn loop. That is the bulk of the build (§3).

---

## 1. Architecture & flow

```
┌── UI path (US1–US3, already built + deployed) ─────────────────────────┐
│  integrations.html → /api/oauth/canva/*  → Connect AS                  │
│    (www.canva.com/api/oauth/authorize → api.canva.com/rest/v1/oauth/token)
│  CanvaBrowser → canva-browse.ts → api.canva.com/rest/v1/designs        │
│  import → canva-import-background.ts → exports → R2 → content_assets   │
└────────────────────────────────────────────────────────────────────────┘

┌── AI path (this document) ─────────────────────────────────────────────┐
│  integrations.html → /api/oauth/canvamcp/*  → MCP AS                   │
│    (mcp.canva.com/authorize → mcp.canva.com/token)   ← SEPARATE issuer │
│                                                                         │
│  assistant run (cron/autopilot)                                        │
│    └─ getFreshAccessToken(org,'canvamcp') → vault                      │
│         └─ ai-gateway.runWithTools({ mcpServers:[{ url, token }] })    │
│              └─ Anthropic Messages API (beta mcp-client-2025-11-20)    │
│                   └── Anthropic ⇄ mcp.canva.com   (server-side)        │
│                        tools: resize-design, autofill-design, …        │
└────────────────────────────────────────────────────────────────────────┘
```

**Our functions never speak MCP.** Anthropic holds the MCP session; we pass a URL and a bearer
token per request. This is what makes the whole thing fit in a Netlify function.

### 1.1 The second OAuth connection (`canvamcp`)

Reuse the existing router wholesale — it is already generic, and Canva Connect just proved the PKCE
path works end to end. Register a distinct provider so the two tokens never collide:

- `src/utils/workspace-integrations.ts` — add `'canvamcp'` to `IntegrationProvider` +
  `INTEGRATION_PROVIDERS` + `PROVIDER_LABELS` (label it "Canva (AI assistants)" so the two cards are
  distinguishable).
- `oauth-integrations.ts` — scopes, authorize branch, token exchange, all against **mcp.canva.com**.

```ts
// SCOPES
canvamcp: 'design:meta:read design:content:read design:content:write folder:read asset:read brandtemplate:meta:read brandtemplate:content:read brandkit:read',

// connect (PKCE — identical mechanics to canva; the verifier already rides in the vault entry)
authUrl = `https://mcp.canva.com/authorize?response_type=code&client_id=${clientId}` +
          `&redirect_uri=${enc(redirectUri)}&scope=${enc(SCOPES.canvamcp)}` +
          `&code_challenge=${codeChallenge}&code_challenge_method=S256&state=${state}`;

// callback
POST https://mcp.canva.com/token
  grant_type=authorization_code&code=…&code_verifier=…&redirect_uri=…&client_id=…
```

`design:content:write` is the scope that unlocks both resize and autofill. Note this **breaks the
read-only posture** the Connect connector deliberately holds (§0.2 of the connector plan). The
`inbound: true` card copy — "assistants pull assets OUT of Canva and never write back" — becomes
false for this second connection. Update the copy; don't let the two cards tell different stories.

**Client identity — use CIMD, not DCR.** The MCP AS advertises
`client_id_metadata_document_supported: true`. With CIMD the `client_id` **is an HTTPS URL** serving
a JSON client-metadata document — no pre-registration, no client secret to store or rotate, and it
works identically on staging and prod as long as each environment serves its own document with its
own `redirect_uris`. Canva's docs call CIMD the recommended approach and mark Dynamic Client
Registration (`/register`) as **deprecated**. Serve something like:

```
https://bemoreswan.com/.well-known/canva-mcp-client.json
{ "client_id": "https://bemoreswan.com/.well-known/canva-mcp-client.json",
  "client_name": "Be More Swan",
  "redirect_uris": ["https://bemoreswan.com/api/oauth/canvamcp/callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"] }
```

Because it is a public client (`token_endpoint_auth_method: none`), **PKCE is the only thing
protecting the code exchange** — the S256 implementation is already verified against the RFC 7636
vector, so reuse it rather than writing a second one.

Add a `canvamcp` branch to `refreshProviderToken()`. The AS advertises `refresh_token`; assume
rotation and treat a missing rotated token as a hard failure, exactly as the Canva branch does.

### 1.2 Calling the MCP connector

Per the Anthropic reference, **two parameters are required together** — `mcp_servers` alone is a
validation error; every declared server must be referenced by exactly one `mcp_toolset`:

```ts
const response = await client.beta.messages.create({
  model: 'claude-opus-4-8',
  max_tokens: 16000,
  betas: ['mcp-client-2025-11-20'],
  thinking: { type: 'adaptive' },
  mcp_servers: [{
    type: 'url',
    name: 'canva',
    url: 'https://mcp.canva.com/mcp',
    authorization_token: mcpAccessToken,   // per-tenant, from the vault
  }],
  tools: [{
    type: 'mcp_toolset',
    mcp_server_name: 'canva',
    // Allowlist: the server exposes ~32 tools; we want a handful.
    // Keeping the surface small cuts token cost and misfires.
    default_config: { enabled: false },
    configs: [
      { name: 'search-designs', enabled: true },
      { name: 'resize-design', enabled: true },
      { name: 'search-brand-templates', enabled: true },
      { name: 'get-brand-template-dataset', enabled: true },
      { name: 'autofill-design', enabled: true },
      { name: 'export-design', enabled: true },
    ],
  }],
  system,
  messages,
});
```

Two caveats on that allowlist: the per-tool `default_config`/`configs` shape on `mcp_toolset` is
documented as empirical rather than guaranteed (the API reference shows only the minimal
`{type, mcp_server_name}` form) — **verify it is honoured before relying on it**, and fall back to
the minimal form plus tight system-prompt scoping if not. And `autofill-design` /
`get-brand-template-dataset` should only be enabled for tenants that pass the Enterprise check
(§0.1) — enabling a tool the user's plan forbids invites a confident-looking failure.

**Availability:** the MCP connector is **beta, first-party Claude API only** — not on Bedrock, not
on Vertex. We call the first-party API directly, so this is fine, but it forecloses a future
provider move for this code path.

### 1.3 The tool-use loop and `pause_turn`

MCP tools execute server-side, so there is no client-side execute-and-return loop — results come
back as content blocks in the same response. The turn still needs handling:

- **`stop_reason: "pause_turn"`** — Anthropic's server-side sampling loop caps at ~10 iterations.
  On pause, append `response.content` as an assistant turn and re-send. **Do not** add a "Continue"
  user message; the API resumes off the trailing `server_tool_use` block. Cap continuations (≈5) so
  a pathological run can't spin.
- **`stop_reason: "refusal"`** — check before reading `content`; `content` may be empty.
- Read results from `mcp_tool_use` / `mcp_tool_result` blocks. A failing MCP tool returns an error
  block, not an exception — branch on it.
- **Large outputs**: an MCP tool returning >100K tokens is auto-offloaded to a sandbox file with a
  truncated preview. Not expected for resize/autofill, but don't assume the result is always inline.

### 1.4 Auth failure semantics

An invalid or expired MCP token surfaces as an MCP auth error inside the turn — **not** as a clean
401 from our own code, and not at gateway-construction time. So:

- Call `getFreshAccessToken(db, orgId, 'canvamcp')` immediately before the Messages call so the
  token is as fresh as possible; never cache one across a long batch.
- On an MCP auth error, mark the `canvamcp` row `'expired'` and raise the existing "Reconnect"
  affordance. The connections UI already renders that state.
- ⚠️ **The refresh race (§1.3 of the connector plan) applies here too and is worse.** Autonomous
  drafting fans out across assistants and posts; concurrent `getFreshAccessToken` calls on a
  rotating single-use token will burn each other and mark the org `expired`. The row-lock fix is a
  **prerequisite**, not a follow-up.

---

## 2. Data model

Almost nothing new.

- **Token**: a second `workspace_integrations` row, `provider='canvamcp'`, vault-encrypted. No schema
  change — the provider column already carries it.
- **Plan gate**: cache the connected user's Canva plan tier at connect time so we can enable/disable
  autofill without probing on every run. Add `canva_plan_tier text` to the org's Canva state (or
  reuse `workspace_integrations.tenantId` for `'enterprise' | 'pro' | 'free'` — a mild reuse, but it
  avoids a migration; prefer a real column if one is being added anyway).
- **Produced assets**: anything the assistant creates via `autofill-design`/`resize-design` should be
  exported and landed in `content_assets` with `provider='canva'` through the **same**
  download-to-R2 path as the UI import (§1.5 of the connector plan) — Canva export URLs expire in
  24h and thumbnails in 15 minutes, so hotlinking breaks either way. One ingest path, not two.
- **Audit**: log each MCP tool call (org, assistant, tool, design id, outcome). An LLM autonomously
  writing to a user's Canva account needs a trail; `src/utils/audit.ts` already exists.

---

## 3. What has to be built in `ai-gateway.ts`

This is the real work, and it is a genuine capability addition rather than a refactor.

Today: `GatewayRequest {system, messages, maxTokens}` → `GatewayResponse {text, model, …}`, via
`client.messages.create`, with 429/503 failover to a fallback model.

Needed — as an **additive** path, not a rewrite (24 assistants depend on the current signature):

```ts
export interface McpServerRef { name: string; url: string; authorizationToken: string; }

export interface ToolGatewayRequest extends GatewayRequest {
  mcpServers?: McpServerRef[];
  toolsets?: { mcpServerName: string; allow?: string[] }[];
  maxContinuations?: number;   // pause_turn guard, default ~5
}

export interface ToolGatewayResponse extends GatewayResponse {
  toolCalls: { tool: string; input: unknown; ok: boolean; error?: string }[];
  stopReason: string;
}

export async function runWithMcpTools(req: ToolGatewayRequest): Promise<ToolGatewayResponse>
```

Notes that matter here:

- Must use **`client.beta.messages.create`** with `betas: ['mcp-client-2025-11-20']` — the existing
  gateway is on the non-beta path.
- **Model**: the gateway defaults to `claude-sonnet-4-6` via `AI_GATEWAY_PRIMARY_MODEL`. For a
  tool-calling path doing multi-step reasoning over a real user's design assets, use
  **`claude-opus-4-8`** with `thinking: {type: 'adaptive'}`. Note Opus 4.8 rejects `temperature`,
  `top_p`, `top_k` and `budget_tokens` with a 400 — if any of that is set anywhere in this path,
  strip it.
- The existing failover swaps models on 429/503. **Swapping models mid-tool-loop is not safe** —
  re-entering a paused turn on a different model is a different conversation. Fail the run and retry
  it whole rather than failing over mid-turn.
- Keep the tool surface small and the system prompt explicit about *when* to use each tool. Recent
  Opus models reach for tools conservatively; prescriptive "call this when…" text in the tool
  description and system prompt measurably lifts should-call rate.

---

## 4. Suggested build order

Each phase is independently verifiable; the first two are cheap and de-risk everything after.

0. **Answer the plan-gate question (§0.1).** No code. If BMS tenants aren't on Canva Enterprise,
   autofill is dead and phases 3–5 shrink to resize only. **Do this before anything else.**
1. **Fix the token-refresh race.** Already tracked; a hard prerequisite for any autonomous MCP work.
2. **`canvamcp` OAuth** — CIMD document, provider registration, PKCE (reuse verbatim), refresh
   branch, second connector card. Ship: users can connect the AI-assistant side. Verify with a
   single manual `initialize` against `mcp.canva.com/mcp` using a real token.
3. **Gateway tool path** — `runWithMcpTools`, `pause_turn` loop, refusal/error handling, audit.
   Verify with the cheapest read-only tool (`search-designs`) before touching any write tool.
4. **Resize** (`resize-design`, Pro gate) — the lower-risk of the two write capabilities and the one
   with a wider addressable base. Export → R2 → `content_assets`.
5. **Autofill** (`autofill-design` + `get-brand-template-dataset`, Enterprise gate) — only for
   tenants that pass the check, with the capability hidden otherwise.

---

## 5. Recommendation — and where I'd push back

**Build it as specified for autofill and the broader editing surface. Reconsider it for resize.**

The hybrid split is coherent, and the MCP connector makes it genuinely workable — that part of the
decision holds up. Two things are worth weighing before committing:

**Where MCP earns its keep.** It exposes tools that Connect REST has no equivalent for — the
editing-transaction trio (`start-editing-transaction` / `perform-editing-operations` /
`commit-editing-transaction`), `generate-design`, `create-design-from-brand-template`. If the roadmap
is "assistants that manipulate designs open-endedly", MCP is the only route and hand-writing REST
wrappers would be a treadmill. Canva maintains the surface; new capabilities arrive free.

**Where it doesn't.** For the two capabilities in this brief specifically, **Connect REST already
has both** — `POST /rest/v1/resizes` and `POST /rest/v1/exports`/`autofills`, same async job shape as
the import pipeline, same plan gates, and we **already hold a working Connect token**. Going via MCP
for these buys nothing and costs: a second OAuth per user (two consent screens, two expiry paths),
a beta API surface, LLM-mediated non-determinism where a deterministic call would do, and token spend
on a tool-loop for what is fundamentally "resize design X to 1:1". Autopilot resize is a *mechanical*
operation the scheduler already knows the parameters for — there is no judgement for a model to add.

**The split I'd actually draw**, if it were mine:

- **Resize → Connect REST.** Deterministic, cheap, no new auth, ships behind the existing connector.
- **Autofill + future editing → MCP.** Genuinely benefits from the model choosing fields and values
  from post context, which is exactly what `get-brand-template-dataset` → `autofill-design` is for.
  And it's Enterprise-gated anyway, so the second-connection cost lands only on tenants who opted
  into a premium capability.

That gets the MCP capability where it adds value while keeping the second OAuth connection off the
critical path for the majority of tenants. If you'd rather keep one mental model — "assistants talk
to Canva via MCP, the UI talks via REST" — that's a legitimate call and §§1–4 build it as specced;
just make it knowing the resize half is paying for consistency rather than capability.

## 6. Open questions

1. **Canva plan tiers of real BMS tenants** — the gate on the entire autofill half (§0.1).
2. **Is `mcp_toolset` per-tool allowlisting honoured?** (§1.2) — affects token cost and misfire rate.
3. **Two Canva cards, or one card with two states?** Two connections is confusing UX; a single
   "Canva" card that provisions both connections behind one button (two sequential consents) may be
   worth the extra flow complexity.
4. **Does ID-JAG (§0.2) collapse the two connections?** Speculative; worth 30 minutes with Canva's
   developer support before accepting the double-connect permanently.
5. **Beta exposure** — `mcp-client-2025-11-20` is beta and first-party-only. Acceptable?
