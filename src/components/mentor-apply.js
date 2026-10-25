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

  /** Apply a stored card (a suggestion's payload, mentor.ts `open`). Throws for a type with nothing to apply. */
  async function applyCard(card) {
    switch (card && card.type) {
      case 'mentor_business_profile': return businessProfile(card.fields);
      case 'mentor_products': return products(card.products);
      case 'setup_field_proposal': return setupAnswer(card.assistantId, card.key, card.value);
      default: throw new Error('This suggestion has nothing to apply here.');
    }
  }

  window.MentorApply = { businessProfile, products, setupAnswer, support, decide, applyCard };
})();
