/**
 * src/components/mentor-apply.js
 * What a click on a Business Mentor card does (docs/business-mentor-plan.md §3.3–3.7, §3.13, §14), in
 * ONE place for the three screens that apply them: the chat (chat-session.js), "Review all" on the
 * Mentor's Overview tab and in Inbox "Needs you" (mentor-review-all.js). Each card calls the endpoint its
 * own screen uses — the same server action, whichever way in:
 *
 *   mentor_business_profile → organisation-profile.ts POST, read-merge-write of only the profile fields
 *   mentor_products         → org-products.ts POST, one per product
 *   mentor_quiet_mode       → update-assistant-context.ts PUT patchContext { quietMode }  (its own card,
 *                             setup-field.ts OWN_CARD_PATCH_KEYS)
 *   mentor_business_stage   → update-assistant-context.ts PUT patchContext { businessStage }
 *   setup_field_proposal    → update-assistant-context.ts PUT patchContext { [key]: value } (checked again
 *                             on the server against the role's questions; active assistants only)
 *   mentor_support_request  → support-tickets.ts POST, or issue-reports.ts POST
 *   decide                  → mentor.ts { action: 'decide' } — accepted after a saved click, or dismissed
 *   strategy_proposal       → mentor.ts strategy_save / strategy_approve / strategy_draft — the Plan tab's
 *                             Save draft, Approve and "Draft it for me" (Phase 2, §4)
 *   mentor_research         → mentor.ts research ("Look this up"); jobStatus polls it (?job=)
 *   mentor_commitments      → mentor.ts commitments_add / commitment_close — the Results tab's Commitments list (Phase 3)
 *   mentor_draft_request    → generate-post.ts, exactly as "Create a Post" on that assistant's Posts tab, with the
 *                             suggestion's id so the draft carries "Requested by" the Mentor (Phase 3)
 *   reviewNow               → mentor.ts review_now — "Review my week now" on the Overview tab
 *
 * Every function resolves to nothing or throws an Error whose message is for the user. After a write it
 * dispatches the `document` event the screen behind listens for. Nothing here is bound to the DOM.
 */
(function () {
  async function json(url, init) {
    const res = await fetch(url, { credentials: 'same-origin', ...init });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `That didn’t work (HTTP ${res.status}).`);
    return data;
  }
  const post = (url, body, method = 'POST') => json(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // Business Information: organisation-profile.ts POST rewrites every field it is sent, so read the
  // current profile NOW and change only the card's fields.
  async function businessProfile(fields) {
    const current = await json('/.netlify/functions/organisation-profile');
    const profile = current.profile || {};
    // Only the profile's own fields: a body carrying allowDomainJoin is treated as the domain-join
    // toggle and returns before the profile is saved.
    const KEEP = ['businessName', 'industry', 'businessDescription', 'websiteUrl', 'outreachPostalAddress', 'socialLinks', 'socialHandles', 'targetAudience'];
    const body = Object.fromEntries(KEEP.map((k) => [k, profile[k] ?? null]));
    Object.assign(body, fields || {});
    await post('/.netlify/functions/organisation-profile', body);
    document.dispatchEvent(new CustomEvent('bizinfo:profileChanged', { detail: fields || {} }));
  }

  // Products & Services: org-products.ts POST, one per product, exactly as the tab's "Add" does.
  async function products(list) {
    let added = 0;
    try {
      for (const p of (Array.isArray(list) ? list : [])) {
        await post('/.netlify/functions/org-products', { kind: p.kind === 'service' ? 'service' : 'product', name: p.name, description: p.description || null });
        added++;
      }
    } catch (err) {
      if (added) document.dispatchEvent(new CustomEvent('bizinfo:productsChanged'));
      throw new Error(added ? `${added} added, then: ${err.message}` : err.message);
    }
    document.dispatchEvent(new CustomEvent('bizinfo:productsChanged'));
  }

  // One set-up answer: only that key is sent, and the server merges it onto the row it reads in the save.
  async function setupAnswer(assistantId, key, value) {
    const id = Number(assistantId);
    await post('/.netlify/functions/update-assistant-context', { assistantId: id, patchContext: { [key]: value } }, 'PUT');
    document.dispatchEvent(new CustomEvent('assistant:settingsChanged', { detail: { assistantId: id, setting: key, value } }));
  }

  async function support(d) {
    if (d.destination === 'issue') {
      await post('/.netlify/functions/issue-reports', { description: `${d.subject}\n\n${d.description}`, sourceLocation: 'Business Mentor chat', sourceUrl: window.location.href });
    } else {
      await post('/.netlify/functions/support-tickets', { subject: d.subject, category: 'Business Mentor', description: d.description });
    }
  }

  async function decide(proposalId, decision, reason) {
    await post('/.netlify/functions/mentor', { action: 'decide', proposalId, decision, reason });
    document.dispatchEvent(new CustomEvent('mentor:changed', { detail: { proposalId, decision } }));
  }

  // Phase 2: the strategy documents and the Mentor's background jobs (mentor.ts). Each repaints an open Plan tab.
  const planChanged = (detail) => document.dispatchEvent(new CustomEvent('mentor:planChanged', { detail }));
  async function strategySave(kind, sections, assumptions) {
    await post('/.netlify/functions/mentor', { action: 'strategy_save', kind, sections: sections || {}, ...(Array.isArray(assumptions) ? { assumptions } : {}) });
    planChanged({ kind, op: 'save' });
  }
  async function strategyApprove(kind, draftId, updatedAt) {
    await post('/.netlify/functions/mentor', { action: 'strategy_approve', kind, draftId, updatedAt });
    planChanged({ kind, op: 'approve' });
  }
  async function strategyDraft(kind, chatSessionId) {
    const { job } = await post('/.netlify/functions/mentor', { action: 'strategy_draft', kind, chatSessionId: chatSessionId || null });
    planChanged({ kind, op: 'draft' });
    return { jobId: job && job.id };
  }
  async function research(question, chatSessionId) {
    const { job } = await post('/.netlify/functions/mentor', { action: 'research', question, chatSessionId: chatSessionId || null });
    planChanged({ op: 'research' });
    return { jobId: job && job.id };
  }
  async function jobStatus(jobId) {
    const { job } = await json(`/.netlify/functions/mentor?job=${encodeURIComponent(jobId)}`);
    if (job && (job.status === 'done' || job.status === 'failed')) planChanged({ op: 'job', jobId });
    return job;
  }

  // Phase 3: commitments (the Results tab's list and the chat card), a post asked of a Social Media assistant,
  // and "Review my week now". Each repaints whatever listens for mentor:commitmentsChanged / mentor:changed.
  async function commitmentsAdd(texts) {
    const r = await post('/.netlify/functions/mentor', { action: 'commitments_add', texts });
    document.dispatchEvent(new CustomEvent('mentor:commitmentsChanged', { detail: { op: 'add' } }));
    return r;
  }
  async function commitmentClose(id, status, missReason, note) {
    const r = await post('/.netlify/functions/mentor', { action: 'commitment_close', id, status, missReason: missReason || undefined, note: note || undefined });
    document.dispatchEvent(new CustomEvent('mentor:commitmentsChanged', { detail: { op: 'close', id, status } }));
    return r;
  }
  async function draftRequest(assistantId, brief, proposalId) {
    const r = await post('/.netlify/functions/generate-post', { assistantId: Number(assistantId), contextPrompt: String(brief || '').slice(0, 500), triggerType: 'on_demand', ...(proposalId ? { mentorProposalId: proposalId } : {}) });
    document.dispatchEvent(new CustomEvent('assistant:postsChanged', { detail: { assistantId: Number(assistantId) } }));
    return { jobId: r && r.jobId };
  }
  async function reviewNow() {
    const r = await post('/.netlify/functions/mentor', { action: 'review_now' });
    document.dispatchEvent(new CustomEvent('mentor:changed', { detail: { op: 'review_now' } }));
    return r;
  }

  /** Apply a stored card (a suggestion's payload, mentor.ts `open`). Throws for a type with nothing to apply. */
  async function applyCard(card) {
    switch (card && card.type) {
      case 'mentor_business_profile': return businessProfile(card.fields);
      case 'mentor_products': return products(card.products);
      case 'setup_field_proposal': return setupAnswer(card.assistantId, card.key, card.value);
      case 'strategy_proposal': if (card.op === 'revise') return strategySave(card.kind, card.sections, card.assumptions); break;
      case 'mentor_draft_request': return draftRequest(card.assistantId, card.brief, card.proposalId);
      default: break;
    }
    throw new Error('This suggestion has nothing to apply here.');
  }

  window.MentorApply = { businessProfile, products, setupAnswer, support, decide, applyCard, strategySave, strategyApprove, strategyDraft, research, jobStatus, commitmentsAdd, commitmentClose, draftRequest, reviewNow };
})();
