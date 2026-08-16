/**
 * src/components/assistant-strategy.js
 * Strategy tab — the review surface for Phase 5a of
 * docs/lead-generator-revenue-engine-plan.md §7. Design: docs/strategy-agent-plan.md §6-§7.
 *
 * The Strategy Agent proposes ONE change to ONE field of the sales strategy, with the evidence
 * behind it, and a human decides. Nothing here happens automatically: a proposal is an inert row
 * until someone clicks Apply having read the change (§7.1 — "proposal review, never
 * apply-then-notify").
 *
 * Backed by netlify/functions/strategy-proposals.ts:
 *   • list     → POST { action:'list', assistantId, status? }
 *   • apply    → POST { action:'apply', assistantId, proposalId }
 *   • reject   → POST { action:'reject', assistantId, proposalId, reason, note? }
 *   • rollback → POST { action:'rollback', assistantId, proposalId, force? }
 *
 * ── Written for the person, not for the system ───────────────────────────────
 * This screen shipped speaking its own implementation. It opened with "changes your assistant
 * suggests to how it targets and writes to prospects", labelled each card with an internal field
 * name, and printed the proposed value as a pretty-printed JSON blob in a monospace box. A user's
 * first question — "what IS this tab, and why am I being asked?" — went unanswered, and the second
 * — "what will actually change if I say yes?" — was answered in a data structure.
 *
 * The rules now, and they are the point of the file:
 *   • Every card leads with a SENTENCE about the business, not a field name. "Go after a different
 *     kind of company", not "Target Persona".
 *   • Every card says WHY in the same breath, from the evidence, in the user's own terms: "You
 *     turned down 8 leads for the same reason."
 *   • The value is shown as prose. A JSON object is unpacked into readable lines; the raw structure
 *     stays available behind a disclosure for the person who wants it, and only for them.
 *   • Nothing on the default screen is jargon. "Rollback" is "Undo", "expired" is "Lapsed",
 *     "sample size" is "how much it is going on".
 *
 * ── The empty state is the DEFAULT state ─────────────────────────────────────
 * For months every real Strategy tab will show no proposals, because MIN_SAMPLE will not be met.
 * That is correct behaviour — "no pivot on noise" is the whole safety argument — but a screen that
 * renders a blank card for a quarter reads as broken and generates support tickets. So the empty
 * state here is a first-class screen, and it says what the user can DO to fill it rather than
 * lecturing them about oscillation and statistical confidence.
 * `docs/mockups/revenue-engine-mockup.html#s-strategy` shows only the populated happy path —
 * accurate as design intent, misleading as a build target.
 *
 * ── Rendering notes ──────────────────────────────────────────────────────────
 * Vanilla IIFE assigning window.AssistantStrategy, matching assistant-lead-threads.js. Not React.
 * Styling reuses classes already compiled into style.css (no Tailwind rebuild — a rebuild churns
 * unrelated selectors). Diff additions use green-*, NOT emerald-*: input.css remaps the emerald
 * scale to the brand's neon pink, which lands close enough to the red deletions that the two stop
 * being distinguishable — the one thing a diff has to get right.
 *
 * All server values are escaped on render; treat every one of them as untrusted. That matters more
 * here than on most screens: a proposal's evidence traces back to prospect email arriving through a
 * public webhook (§5.2).
 */
(function () {
  const API = '/.netlify/functions/strategy-proposals';

  let state = {
    assistantId: null,
    gated: false,
    // The workspace is entitled but THIS assistant was switched off in Profile ▸ Operational Setup.
    // Not the same as `gated`: proposals already raised stay listed and decidable, only new ones
    // stop. Surfaced so an empty queue reads as a choice somebody made rather than a broken agent.
    assistantPaused: false,
    proposals: [],
    counts: { pending: 0, applied: 0, rejected: 0, expired: 0 },
    progress: null,
    vocab: null,
    // { at, proposed, clusters, truncated, skipReason } — see lastRunLine().
    lastRun: null,
    statusFilter: 'pending',
    // proposalId currently showing the reject form, if any.
    rejecting: null,
    // proposalId → the value the field holds NOW, when a rollback was refused as `changed_since`.
    conflicts: {},
    busy: null,
    loading: false,
    error: null,
    notice: null,
    // "How this works" — collapsed by default. The explanation has to be ON the page (this tab is
    // unlike anything else in the product), but it must not be the first thing between the user and
    // a decision they are being asked to make.
    helpOpen: false,
    rendered: false,
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const host = () => document.getElementById('strategy-host');

  async function call(action, extra) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ action, assistantId: state.assistantId, ...extra }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(new Error(data.error || 'Request failed'), {
        code: data.code, currentValue: data.currentValue,
      });
    }
    return data;
  }

  // ── Saying what a change IS ────────────────────────────────────────────────
  //
  // Keyed by the tunable field's key (src/config/strategy-proposals.ts TUNABLE_FIELDS). The server
  // already sends `fieldLabel` and `fieldDescription`, and both are written for someone who knows
  // the system — "Target Persona", "the demographics, industries and pain signals it matches
  // against". These are the same five things said as an outcome the user cares about.
  //
  // ⚠️ An unknown key falls back to the server's label rather than to a generic phrase. A new
  // tunable field appearing here as "Change something" would be worse than the jargon.
  const FIELD_PLAIN = {
    targetPersona: {
      headline: 'Go after a different kind of company',
      what: 'which companies your assistant goes looking for',
    },
    discoveryQueryThemes: {
      headline: 'Search for different things',
      what: 'what your assistant types into its searches when hunting for leads',
    },
    outreachPlaybook: {
      headline: 'Write the first email differently',
      what: 'the angle and structure of the opening email your assistant sends',
    },
    objectionPlaybook: {
      headline: 'Answer pushback differently',
      what: 'what your assistant says when a prospect raises an objection',
    },
    leadScoreWeightings: {
      headline: 'Rate leads differently',
      what: 'how your assistant decides whether a lead is hot, warm or cold',
    },
  };

  function plainField(p) {
    return FIELD_PLAIN[p.targetField] || { headline: `Change ${p.fieldLabel}`, what: p.fieldDescription || '' };
  }

  // ── Value rendering ────────────────────────────────────────────────────────

  /** A tunable value as readable text. json fields are pretty-printed; text fields shown as-is. */
  function asText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }

  /**
   * The same value, as something a person reads.
   *
   * Three of the five tunable fields hold prose and come through untouched. The other two hold an
   * object, and a pretty-printed JSON blob is the single most alienating thing this screen used to
   * do — a user being asked to approve a change to how their leads are rated was shown fifteen
   * lines of braces and quoted keys. Unpacked here into "Company size — 10 to 50 staff" lines,
   * with camelCase keys spaced out, and the raw structure kept one disclosure away for anyone who
   * wants to check it.
   *
   * Returns null when there is nothing sensible to unpack, so the caller falls back to the raw text
   * rather than inventing a rendering.
   */
  /**
   * camelCase / snake_case → "Company size".
   *
   * The keys are written by our own config and by the agent's own evidence payload, not by a user,
   * so this is a formatting job rather than a guess. Used by BOTH the value list and the evidence
   * metric chips — the chips were the last place on the default screen still printing a raw
   * identifier ("priorReplyRate") at someone being asked to make a business decision.
   */
  function humanKey(k) {
    return String(k)
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/^./, (c) => c.toUpperCase());
  }

  function plainLines(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'string') return null;                 // prose already; the caller prints it
    if (Array.isArray(v)) {
      const items = v.filter((x) => typeof x === 'string' || typeof x === 'number');
      return items.length === v.length ? items.map((x) => ({ key: null, value: String(x) })) : null;
    }
    if (typeof v !== 'object') return null;
    const entries = Object.entries(v);
    if (!entries.length || entries.length > 24) return null;
    return entries.map(([k, val]) => ({
      key: humanKey(k),
      value: (val === null || val === undefined) ? '—'
        : (typeof val === 'object' ? JSON.stringify(val) : String(val)),
    }));
  }

  function valueHtml(v, tone) {
    const box = tone === 'new'
      ? 'bg-green-50 text-green-800 border-green-100'
      : 'bg-gray-50 text-gray-700 border-gray-200';
    const lines = plainLines(v);
    if (lines) {
      return `<ul class="rounded-lg p-3 border ${box} space-y-1">
        ${lines.map((l) => `<li class="text-xs">${l.key ? `<span class="font-bold">${esc(l.key)}:</span> ` : '• '}${esc(l.value)}</li>`).join('')}
      </ul>`;
    }
    const text = asText(v);
    return `<p class="text-xs rounded-lg p-3 border whitespace-pre-wrap break-words ${box}">${esc(text) || '<em>nothing set</em>'}</p>`;
  }

  /**
   * The before/after pair.
   *
   * Stacked rather than side-by-side: a persona description runs to a paragraph and two columns of
   * that on a laptop is unreadable. The old value is collapsed by default for the same reason — the
   * question a reviewer is answering is "is the NEW one right?", with the old one there to check
   * against, not to read first.
   *
   * A `campaign`-backed field's previous value is a map keyed by campaign id (the campaigns need
   * not have agreed), so it is labelled to say so rather than pretending it was one value.
   */
  function diffBlock(p) {
    const prev = p.previousValue;
    const perCampaign = prev && typeof prev === 'object' && prev.byCampaign;
    const prevValue = perCampaign ? prev.byCampaign : prev;

    return `
      <div class="mt-3 space-y-2">
        <div>
          <p class="text-[11px] font-bold text-gray-500 uppercase tracking-wide mb-1">
            What it would say instead${perCampaign ? ' — on every active campaign' : ''}
          </p>
          ${valueHtml(p.proposedValue, 'new')}
        </div>
        <details>
          <summary class="text-[11px] font-bold text-gray-500 uppercase tracking-wide cursor-pointer hover:text-gray-700">
            Show what it says now${perCampaign ? ' (per campaign)' : ''}
          </summary>
          <div class="mt-1">${valueHtml(prevValue, 'old')}</div>
        </details>
        <details>
          <!-- The escape hatch for the person who wants the actual structure. Deliberately last,
               deliberately shut, and deliberately not the default rendering — this used to BE the
               default rendering, and it is why the tab read as an internal debugging screen. -->
          <summary class="text-[11px] text-gray-400 cursor-pointer hover:text-gray-600">Technical detail</summary>
          <pre class="mt-1 bg-gray-50 text-gray-600 text-[11px] rounded-lg p-3 whitespace-pre-wrap break-words border border-gray-200">${esc(asText(p.proposedValue)) || '<em>empty</em>'}</pre>
        </details>
      </div>`;
  }

  /**
   * Why the assistant is asking — one sentence, in the user's terms.
   *
   * `sampleSize` is labelled by SOURCE, never generically. A user must never be shown "34 outcomes"
   * when the number is edits — the two thresholds mean different things and conflating them
   * overstates the confidence behind the proposal.
   */
  function evidenceBlock(p) {
    const e = (p.evidence && typeof p.evidence === 'object') ? p.evidence : {};
    const n = Number(e.sampleSize);
    // ⚠️ Keyed on the source, with no generic fallback for the unit. This used to be a two-way
    // ternary whose `else` said "closed deals" — so a lead_rejection proposal (8 clicks) presented
    // itself as 8 CLOSED DEALS, the single most confidence-inflating thing this card could say.
    // A new source must name its own unit here, and an unknown one stays deliberately vague.
    const UNITS = {
      edit_pattern: ['email you rewrote before it went out', 'emails you rewrote before they went out'],
      lead_rejection: ['lead you turned down', 'leads you turned down'],
      win_loss: ['deal that closed', 'deals that closed'],
      human: ['setting you saved yourself', 'settings you saved yourself'],
    };
    const bits = [];
    const unit = (UNITS[p.source] || ['thing it noticed', 'things it noticed'])[n === 1 ? 0 : 1];

    if (Number.isFinite(n)) bits.push(`<span class="font-bold text-gray-900">${n}</span> ${esc(unit)}`);
    if (e.editReason) bits.push(`all for the same reason: &ldquo;${esc(String(e.editReason))}&rdquo;`);
    if (e.rejectReason) bits.push(`all turned down as &ldquo;${esc(String(e.rejectReason))}&rdquo;`);
    if (Array.isArray(e.segments) && e.segments.length) {
      bits.push(`in ${e.segments.map((s) => esc(String(s))).join(', ')}`);
    }

    const metrics = (e.metrics && typeof e.metrics === 'object') ? e.metrics : null;

    return `
      <div class="mt-2">
        <p class="text-xs text-gray-600">
          <span class="font-bold text-gray-700">Why:</span>
          ${bits.length ? bits.join(' &middot; ') : 'no supporting detail was recorded.'}
        </p>
        ${metrics ? `<dl class="mt-2 flex flex-wrap gap-1.5">
          ${Object.entries(metrics).map(([k, v]) => `
            <div class="inline-flex items-baseline gap-1.5 bg-white border border-gray-200 rounded-lg px-2 py-0.5">
              <dt class="text-[11px] text-gray-500">${esc(humanKey(k))}</dt>
              <dd class="text-[11px] font-bold text-gray-900">${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</dd>
            </div>`).join('')}
        </dl>` : ''}
      </div>`;
  }

  // ── Proposal card ──────────────────────────────────────────────────────────

  const SOURCE_LABEL = {
    win_loss: 'Spotted in your won &amp; lost deals',
    edit_pattern: 'Spotted in your edits',
    lead_rejection: 'Spotted in the leads you turned down',
    human: 'Saved by you',
  };

  const STATUS_CHIP = {
    pending: 'bg-amber-50 text-amber-700 border-amber-200',
    applied: 'bg-green-50 text-green-700 border-green-200',
    rejected: 'bg-gray-100 text-gray-600 border-gray-200',
    expired: 'bg-gray-100 text-gray-500 border-gray-200',
  };
  // Plain words for the four states. "expired" is a database value; "Lapsed" is what happened.
  const STATUS_LABEL = {
    pending: 'Waiting on you',
    applied: 'In use',
    rejected: 'You said no',
    expired: 'Lapsed',
  };

  function daysUntil(iso) {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return null;
    return Math.ceil((t - Date.now()) / 86400000);
  }

  function rejectForm(p) {
    const reasons = (state.vocab && state.vocab.rejectReasons) || [];
    return `
      <div class="mt-3 border-t border-gray-100 pt-3">
        <label class="block text-xs font-bold text-gray-700 mb-1">Why not?</label>
        <p class="text-[11px] text-gray-500 mb-1.5">Your answer is what stops it suggesting the same thing again.</p>
        <select data-sa-reason="${p.id}" class="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white">
          <option value="">Choose a reason&hellip;</option>
          ${reasons.map((r) => `<option value="${esc(r.key)}">${esc(r.label)}</option>`).join('')}
        </select>
        <p data-sa-effect="${p.id}" class="text-[11px] text-gray-500 mt-1"></p>
        <!-- ⚠️ This used to promise "kept for you, never sent to the model", and that was true until
             priorRejections() began selecting rejectNote (2026-08-07). The note now steers the next
             suggestion for every structured reason. Only "Something else" (other) still withholds
             it — REJECT_REASONS_FED_TO_MODEL excludes that bucket, and its effect line says so.
             If the note ever stops being fed, change this back; never let it over-promise privacy. -->
        <textarea data-sa-note="${p.id}" rows="2" placeholder="Anything to add? (optional — your assistant reads this and takes it into account next time, unless your reason is Something else)"
          class="mt-2 w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5"></textarea>
        <div class="flex gap-2 mt-2">
          <button type="button" data-sa-reject-confirm="${p.id}"
            class="px-3 py-1.5 bg-gray-900 text-white text-xs font-bold rounded-lg hover:bg-gray-800 transition">Say no to this</button>
          <button type="button" data-sa-reject-cancel="${p.id}"
            class="px-3 py-1.5 bg-white border border-gray-200 text-gray-700 text-xs font-bold rounded-lg hover:border-gray-300 transition">Cancel</button>
        </div>
      </div>`;
  }

  function conflictBlock(p) {
    const current = state.conflicts[p.id];
    return `
      <div class="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-3">
        <p class="text-xs font-bold text-amber-900">Someone has changed this since.</p>
        <p class="text-[11px] text-amber-800 mt-1">Undoing now would throw that edit away. Here is what it says today:</p>
        <div class="mt-2">${valueHtml(current, 'old')}</div>
        <div class="flex gap-2 mt-2">
          <button type="button" data-sa-rollback-force="${p.id}"
            class="px-3 py-1.5 bg-red-600 text-white text-xs font-bold rounded-lg hover:bg-red-700 transition">Undo anyway</button>
          <button type="button" data-sa-conflict-dismiss="${p.id}"
            class="px-3 py-1.5 bg-white border border-gray-200 text-gray-700 text-xs font-bold rounded-lg hover:border-gray-300 transition">Keep what it says now</button>
        </div>
      </div>`;
  }

  function proposalCard(p) {
    const busy = state.busy === p.id;
    const expiresIn = p.status === 'pending' ? daysUntil(p.expiresAt) : null;
    const plain = plainField(p);

    return `
      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 mb-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-sm font-bold text-gray-900">${esc(plain.headline)}</p>
            ${plain.what ? `<p class="text-xs text-gray-500 mt-0.5">This changes ${esc(plain.what)}.</p>` : ''}
          </div>
          <span class="shrink-0 px-2 py-0.5 text-[10px] font-black rounded-full border ${STATUS_CHIP[p.status] || STATUS_CHIP.expired}">
            ${esc(STATUS_LABEL[p.status] || p.status)}${p.rolledBackAt ? ' &middot; undone' : ''}
          </span>
        </div>

        <p class="text-[11px] text-gray-400 mt-1">${SOURCE_LABEL[p.source] || esc(p.source)}</p>

        ${evidenceBlock(p)}
        ${diffBlock(p)}

        ${p.status === 'pending' && expiresIn !== null ? `
          <p class="text-[11px] ${expiresIn <= 3 ? 'text-amber-700 font-bold' : 'text-gray-500'} mt-2">
            ${expiresIn <= 0 ? 'This drops off today if you do nothing' : `This drops off in ${expiresIn} day${expiresIn === 1 ? '' : 's'} if you do nothing`}
          </p>` : ''}

        ${p.status === 'rejected' && p.rejectReason ? `
          <p class="text-[11px] text-gray-600 mt-2">You said no: ${esc(p.rejectReason.replace(/_/g, ' '))}${p.decidedByName ? ` (${esc(p.decidedByName)})` : ''}</p>
          ${p.rejectNote ? `<p class="text-[11px] text-gray-500 mt-0.5 italic">&ldquo;${esc(p.rejectNote)}&rdquo;</p>` : ''}` : ''}

        ${state.conflicts[p.id] !== undefined ? conflictBlock(p) : ''}

        ${state.rejecting === p.id ? rejectForm(p) : `
          <div class="flex flex-wrap gap-2 mt-3">
            ${p.status === 'pending' ? `
              <button type="button" data-sa-apply="${p.id}" ${busy ? 'disabled' : ''}
                class="px-3 py-1.5 bg-emerald-700 text-white text-xs font-bold rounded-lg hover:bg-emerald-800 transition disabled:opacity-50">
                ${busy ? 'Applying&hellip;' : 'Yes, make this change'}</button>
              <button type="button" data-sa-reject="${p.id}" ${busy ? 'disabled' : ''}
                class="px-3 py-1.5 bg-white border border-gray-200 text-gray-700 text-xs font-bold rounded-lg hover:border-gray-300 transition disabled:opacity-50">No thanks</button>
            ` : ''}
            ${p.canRollback ? `
              <button type="button" data-sa-rollback="${p.id}" ${busy ? 'disabled' : ''}
                class="px-3 py-1.5 bg-white border border-gray-200 text-gray-700 text-xs font-bold rounded-lg hover:border-gray-300 transition disabled:opacity-50">
                ${busy ? 'Undoing&hellip;' : 'Undo this'}</button>` : ''}
          </div>`}
      </div>`;
  }

  // ── Empty state (§7 — the default state, and it is the one most users will see) ─────────

  function progressRow(label, have, need, why) {
    const pct = need > 0 ? Math.min(100, Math.round((have / need) * 100)) : 0;
    return `
      <div class="mt-3">
        <div class="flex items-baseline justify-between gap-2">
          <p class="text-xs font-bold text-gray-900">${esc(label)}</p>
          <p class="text-xs text-gray-600"><span class="font-bold text-gray-900">${have}</span> of ${need}</p>
        </div>
        <div class="mt-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div class="h-full bg-emerald-600 rounded-full" style="width:${pct}%"></div>
        </div>
        <p class="text-[11px] text-gray-500 mt-1">${esc(why)}</p>
      </div>`;
  }

  /**
   * "Is this thing even running?" — §7.
   *
   * A screen that shows nothing for months is indistinguishable from a broken one, and this strip
   * is the difference. It reports when the agent last looked and what it concluded, so the answer
   * never requires the function logs — which is doubly true now the run is a background job whose
   * HTTP response is only an acknowledgement.
   */
  function lastRunLine() {
    const lr = state.lastRun;
    if (!lr || !lr.at) {
      return `<p class="text-[11px] text-gray-400 mt-4">Your assistant hasn’t had a look yet — it checks once a week.</p>`;
    }
    const when = new Date(lr.at);
    const stamp = isNaN(when.getTime()) ? '' : when.toLocaleString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
    // A halted run must NEVER borrow the wording of a run that finished and found nothing. Both
    // arrive here as zeroes, and reporting "found nothing to learn from" for a run that died would
    // be the strip actively asserting the thing it exists to disprove.
    if (lr.halted) {
      return `
        <p class="text-[11px] text-amber-600 mt-4">
          Last tried ${esc(stamp)} &middot; the check didn’t finish, so nothing was looked at.
        </p>`;
    }
    const outcome = lr.proposed > 0
      ? `came back with ${lr.proposed} suggestion${lr.proposed === 1 ? '' : 's'}`
      : lr.clusters > 0
        ? 'didn’t find anything worth suggesting'
        : 'found nothing to learn from yet';
    return `
      <p class="text-[11px] text-gray-400 mt-4">
        Last looked ${esc(stamp)} &middot; ${esc(outcome)}${lr.truncated ? ' &middot; more to look at next week' : ''}
      </p>`;
  }

  function emptyState() {
    const pr = state.progress;
    return `
      <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
        <p class="text-sm font-bold text-gray-900">Nothing to suggest yet</p>
        <p class="text-xs text-gray-600 mt-1">
          Your assistant only suggests a change once it has seen the same thing happen enough times to be sure it isn’t a fluke.
          Here’s how close it is:
        </p>
        ${pr ? `
          ${progressRow(
            'Emails you rewrote before sending',
            pr.editPattern.have, pr.editPattern.need,
            'Edit a drafted email on the Outreach tab and say why. When you keep making the same kind of change, it learns to write it that way itself.',
          )}
          ${progressRow(
            'Deals you marked won or lost',
            pr.winLoss.have, pr.winLoss.need,
            'Record the outcome on a conversation once a deal is done, either way. Enough of those and it can tell which kind of prospect actually buys.',
          )}
        ` : ''}
        ${lastRunLine()}
      </div>`;
  }

  // ── "How this works" ───────────────────────────────────────────────────────

  function helpPanel() {
    if (!state.helpOpen) return '';
    return `
      <div class="mb-4 bg-white rounded-2xl border border-gray-200 shadow-sm p-4">
        <ol class="text-xs text-gray-600 space-y-2 list-decimal pl-4">
          <li><span class="font-bold text-gray-800">It watches what you do.</span> Every email you rewrite before it goes out, every lead you turn down, every deal you mark won or lost.</li>
          <li><span class="font-bold text-gray-800">Once a week it looks for a pattern.</span> Not one-offs — the same thing happening enough times that it isn’t chance.</li>
          <li><span class="font-bold text-gray-800">It suggests one change, here.</span> Never more than one thing at a time, always with the reason it thinks so.</li>
          <li><span class="font-bold text-gray-800">Nothing happens until you say yes.</span> A suggestion sitting here changes nothing, and you can undo one afterwards.</li>
        </ol>
      </div>`;
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function render() {
    const h = host();
    if (!h) return;

    // The tab should not be reachable when the feature is off, but if it is, say nothing rather
    // than advertising a feature this workspace does not have.
    if (state.gated) { h.innerHTML = ''; return; }

    if (state.loading && !state.proposals.length) {
      h.innerHTML = '<div class="p-8 text-center text-xs text-gray-500">Loading&hellip;</div>';
      return;
    }

    if (state.error) {
      h.innerHTML = `
        <div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 text-center">
          <p class="text-sm font-semibold text-gray-900">${esc(state.error)}</p>
        </div>`;
      return;
    }

    const c = state.counts;
    const filters = [
      ['pending', 'Waiting on you', c.pending || 0],
      ['applied', 'In use', c.applied || 0],
      ['rejected', 'You said no', c.rejected || 0],
      ['expired', 'Lapsed', c.expired || 0],
      ['', 'All', (c.pending || 0) + (c.applied || 0) + (c.rejected || 0) + (c.expired || 0)],
    ];

    h.innerHTML = `
      <div class="mb-4">
        <p class="text-sm text-gray-700">
          <span class="font-bold">Your assistant learns from what you do, and asks before it changes anything.</span>
        </p>
        <p class="text-sm text-gray-600 mt-1">
          When it spots the same thing happening again and again &mdash; the emails you keep rewriting, the leads you keep turning
          down &mdash; it suggests one change here and waits for your answer. Nothing on this tab is live until you say yes.
        </p>
        <button type="button" data-sa-help
          class="mt-2 text-xs font-bold text-emerald-700 hover:text-emerald-800 underline underline-offset-2 cursor-pointer">
          ${state.helpOpen ? 'Hide how this works' : 'How does this work?'}</button>
      </div>
      ${helpPanel()}
      ${state.assistantPaused ? `
      <div class="mb-4 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
        <p class="text-xs text-amber-800">
          <strong>Switched off for this assistant.</strong> It won’t suggest anything new until you turn Strategy Proposals
          back on in Assistant Profile &rsaquo; Operational Setup. Anything already here can still be used or turned down.
        </p>
      </div>` : ''}

      ${state.notice ? `
        <div class="mb-3 bg-green-50 border border-green-200 rounded-lg p-3">
          <p class="text-xs font-bold text-green-800">${esc(state.notice)}</p>
        </div>` : ''}

      <div class="flex flex-wrap items-center gap-2 mb-4">
        ${filters.map(([v, label, n]) => `
          <button type="button" data-sa-status="${v}"
            class="px-2.5 py-1 text-xs font-bold rounded-lg border transition ${(state.statusFilter || '') === v
              ? 'bg-emerald-700 text-white border-emerald-600'
              : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'}">${esc(label)} (${n})</button>`).join('')}
      </div>

      ${state.proposals.length === 0
        ? (state.statusFilter === 'pending' || !state.statusFilter
            ? emptyState()
            : `<div class="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center">
                 <p class="text-sm font-semibold text-gray-900">Nothing here</p>
                 <p class="text-xs text-gray-500 mt-1">No suggestions in this list yet.</p>
               </div>`)
        : state.proposals.map(proposalCard).join('')}
    `;

    bind(h);
  }

  function bind(h) {
    h.querySelector('[data-sa-help]')?.addEventListener('click', () => {
      state.helpOpen = !state.helpOpen;
      render();
    });

    h.querySelectorAll('[data-sa-status]').forEach((b) => b.addEventListener('click', () => {
      state.statusFilter = b.getAttribute('data-sa-status');
      state.rejecting = null;
      load();
    }));

    h.querySelectorAll('[data-sa-apply]').forEach((b) => b.addEventListener('click',
      () => decide('apply', Number(b.getAttribute('data-sa-apply')))));

    h.querySelectorAll('[data-sa-reject]').forEach((b) => b.addEventListener('click', () => {
      state.rejecting = Number(b.getAttribute('data-sa-reject'));
      render();
    }));

    h.querySelectorAll('[data-sa-reject-cancel]').forEach((b) => b.addEventListener('click', () => {
      state.rejecting = null;
      render();
    }));

    // Show what the chosen reason actually DOES to the next run — the thing that makes the choice
    // something other than arbitrary.
    h.querySelectorAll('[data-sa-reason]').forEach((sel) => sel.addEventListener('change', () => {
      const id = sel.getAttribute('data-sa-reason');
      const found = ((state.vocab && state.vocab.rejectReasons) || []).find((r) => r.key === sel.value);
      const out = h.querySelector(`[data-sa-effect="${id}"]`);
      if (out) out.textContent = found ? found.effect : '';
    }));

    h.querySelectorAll('[data-sa-reject-confirm]').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.getAttribute('data-sa-reject-confirm'));
      const sel = h.querySelector(`[data-sa-reason="${id}"]`);
      const note = h.querySelector(`[data-sa-note="${id}"]`);
      if (!sel || !sel.value) {
        state.error = null;
        const out = h.querySelector(`[data-sa-effect="${id}"]`);
        if (out) out.textContent = 'Pick a reason first — it is what your assistant learns from.';
        return;
      }
      decide('reject', id, { reason: sel.value, note: note ? note.value : null });
    }));

    h.querySelectorAll('[data-sa-rollback]').forEach((b) => b.addEventListener('click',
      () => decide('rollback', Number(b.getAttribute('data-sa-rollback')))));

    h.querySelectorAll('[data-sa-rollback-force]').forEach((b) => b.addEventListener('click',
      () => decide('rollback', Number(b.getAttribute('data-sa-rollback-force')), { force: true })));

    h.querySelectorAll('[data-sa-conflict-dismiss]').forEach((b) => b.addEventListener('click', () => {
      delete state.conflicts[Number(b.getAttribute('data-sa-conflict-dismiss'))];
      render();
    }));
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  async function load() {
    state.loading = true;
    state.error = null;
    render();
    try {
      const data = await call('list', { status: state.statusFilter || undefined });
      state.gated = !!data.gated;
      state.assistantPaused = !!data.assistantPaused;
      state.proposals = data.proposals || [];
      state.counts = data.counts || state.counts;
      state.progress = data.progress || null;
      state.vocab = data.vocab || state.vocab;
      state.lastRun = data.lastRun || null;
    } catch (err) {
      // db/strategy-proposals.sql is a MANUAL apply. Name that rather than showing a generic
      // failure, which sends people looking for a bug that isn't there.
      state.error = err.code === 'MIGRATION_PENDING'
        ? 'The Strategy Agent is not set up on this environment yet.'
        : (err.message || 'Could not load your strategy proposals.');
    } finally {
      state.loading = false;
      render();
    }
  }

  async function decide(action, proposalId, extra) {
    if (!Number.isInteger(proposalId)) return;
    state.busy = proposalId;
    state.error = null;
    state.notice = null;
    render();
    try {
      const data = await call(action, { proposalId, ...(extra || {}) });
      delete state.conflicts[proposalId];
      state.rejecting = null;
      state.notice = action === 'apply'
        ? (data.recompiled
            ? 'Done — your assistant is working this way from now on.'
            : 'Done.')
        : action === 'reject' ? 'Noted — it will take that into account next time.'
        : 'Undone. It is back to what it said before.';
      await load();
    } catch (err) {
      if (err.code === 'changed_since') {
        // Not an error — an answer. Surface WHAT it changed to so the user can decide again.
        state.conflicts[proposalId] = err.currentValue;
      } else {
        state.error = err.message || 'That did not work.';
      }
    } finally {
      state.busy = null;
      render();
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  window.AssistantStrategy = {
    /**
     * Resolves the gate, then paints.
     *
     * ⚠️ Unlike the Conversations tab this DOES fetch on init, and the reason is the gate rather
     * than the data. `strategy_agent` is a plan feature checked server-side, and there is no
     * client-side feature map to read — so the only way to know whether the tab should exist is to
     * ask. The `list` action early-returns `{gated:true}` before touching strategy_proposals, so
     * for the orgs where the feature is off (which is all of them by default) this costs one plan
     * lookup and nothing else.
     *
     * The button is hidden with BOTH the class and an inline display, because `hidden` loses to
     * `inline-flex` — the same trap that produced the empty amber dot on the Review Queue tab.
     */
    init({ assistantId }) {
      state.assistantId = assistantId;
      state.rendered = false;
      state.proposals = [];
      state.conflicts = {};
      state.rejecting = null;
      state.notice = null;
      state.helpOpen = false;
      state.statusFilter = 'pending';
      load().then(showTabIfEnabled).catch(showTabIfEnabled);
    },
    /** Data is already loaded by init(); activation only paints. */
    activate() {
      state.rendered = true;
      render();
    },
    refresh: load,
  };

  /**
   * Reveal the tab button only when the workspace actually has the feature.
   *
   * A migration failure leaves `gated` false with an error set — the tab shows and explains itself,
   * which is right: on an environment where the DDL has not been applied, silently hiding the tab
   * would make a deploy problem invisible.
   */
  function showTabIfEnabled() {
    const show = !state.gated;
    // The Operational Setup consent card can't resolve the plan gate itself — this is the only
    // place the answer exists on the client, so hand it over before touching the tab button.
    window._setStrategyAgentEntitled?.(show);
    const btn = document.getElementById('maintab-btn-strategy');
    if (!btn) return;
    btn.classList.toggle('hidden', !show);
    btn.style.display = show ? '' : 'none';
  }
})();
