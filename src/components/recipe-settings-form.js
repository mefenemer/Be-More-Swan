/**
 * src/components/recipe-settings-form.js
 * The settings a recipe really needs, as pickers filled from the connected tool — for the recipes that
 * declare them (src/config/recipe-settings.ts → integration-scenarios.ts sends them as `settings`).
 * Used by both settings forms: an assistant's Connections tab (assistant-integrations.js) and the
 * workspace Integrations page (integrations.html), so the two can never ask different things.
 *
 *   RecipeSettingsForm.render(container, scenario, currentMappings)  → draws the pickers, loads choices
 *   RecipeSettingsForm.collect(container, scenario) → { fieldMappings } | { error }
 *
 * A Jira project is picked, never typed, so its key is always the real (upper-case) one; the server
 * upper-cases and checks it again on save (cleanRecipeSettings).
 */
(function () {
  'use strict';
  const OPTIONS_API = '/api/integrations/options';
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const MAIN_SLACK = ''; // empty = the workspace's main channel (sync-action.ts pickSlackChannel)

  function fieldHtml(d, current) {
    const id = 'rs-' + d.key;
    const saved = current[d.key] || '';
    const savedLabel = current[d.key + 'Label'] || saved;
    // Until the list arrives, show what is saved so a slow tool never blanks the setting.
    const first = d.picker === 'slack_channels' && !saved
      ? '<option value="">Your main channel</option>'
      : saved ? '<option value="' + esc(saved) + '" selected>' + esc(savedLabel) + '</option>' : '<option value="">Loading…</option>';
    return '<div data-rs-field="' + esc(d.key) + '" data-rs-picker="' + esc(d.picker) + '">' +
      '<label for="' + id + '" class="block text-sm font-bold text-gray-700 mb-1">' + esc(d.label) + (d.required ? '' : ' <span class="font-normal text-gray-500">(optional)</span>') + '</label>' +
      '<select id="' + id + '" data-rs-select class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700">' + first + '</select>' +
      '<p data-rs-help class="text-xs text-gray-500 mt-1">' + esc(d.help || '') + '</p>' +
    '</div>';
  }

  async function loadChoices(field, d, current) {
    const select = field.querySelector('[data-rs-select]');
    const help = field.querySelector('[data-rs-help]');
    try {
      const res = await fetch(OPTIONS_API + '?picker=' + encodeURIComponent(d.picker), { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Couldn’t load the list.');
      const options = Array.isArray(data.options) ? data.options : [];
      const saved = current[d.key] || '';
      let html = '';
      let list = options;
      if (d.picker === 'slack_channels') {
        // One entry for the main channel, named, instead of "Your main channel" AND "#all-… (main channel)".
        const main = options.find((o) => o.main);
        const mainName = main ? String(main.label).replace(/ \(main channel\)$/, '') : '';
        html += '<option value="' + MAIN_SLACK + '"' + (saved && !(main && String(main.value) === String(saved)) ? '' : ' selected') + '>Your main channel' + (mainName ? ' (' + esc(mainName) + ')' : '') + '</option>';
        list = options.filter((o) => !o.main);
      } else if (!saved) html += '<option value="" selected disabled>Choose…</option>';
      html += list.map((o) => '<option value="' + esc(o.value) + '"' + (String(o.value) === String(saved) ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('');
      // A saved value the tool no longer lists (deleted, or no access) stays visible, flagged.
      if (saved && !options.some((o) => String(o.value) === String(saved))) {
        html += '<option value="' + esc(saved) + '" selected>' + esc((current[d.key + 'Label'] || saved) + ' — not found any more') + '</option>';
      }
      select.innerHTML = html;
      if (!options.length && d.picker !== 'slack_channels') {
        help.textContent = d.picker === 'jira_projects'
          ? 'No Jira projects found on the connected site. Create one in Jira, then open this again.'
          : 'No Asana projects found. Create one in Asana, then open this again.';
        help.className = 'text-xs text-amber-800 mt-1';
      }
    } catch (err) {
      select.innerHTML = '<option value="">Couldn’t load the list</option>';
      help.textContent = (err && err.message) || 'Couldn’t load the list. Close this and try again.';
      help.className = 'text-xs text-red-600 mt-1';
    }
  }

  function render(container, scenario, currentMappings) {
    const defs = Array.isArray(scenario && scenario.settings) ? scenario.settings : [];
    const current = currentMappings || {};
    container.innerHTML = defs.map((d) => fieldHtml(d, current)).join('');
    defs.forEach((d) => {
      const field = container.querySelector('[data-rs-field="' + d.key + '"]');
      if (field) loadChoices(field, d, current);
    });
  }

  function collect(container, scenario) {
    const defs = Array.isArray(scenario && scenario.settings) ? scenario.settings : [];
    const fieldMappings = {};
    for (const d of defs) {
      const select = container.querySelector('[data-rs-field="' + d.key + '"] [data-rs-select]');
      const value = select ? String(select.value || '').trim() : '';
      if (d.required && !value) return { error: 'Choose the ' + d.label + ' first.' };
      if (value) {
        fieldMappings[d.key] = d.picker === 'jira_projects' ? value.toUpperCase() : value;
        const opt = select.options[select.selectedIndex];
        if (opt) fieldMappings[d.key + 'Label'] = opt.textContent.replace(/ — not found any more$/, '').replace(/ \(main channel\)$/, '');
      }
    }
    return { fieldMappings };
  }

  window.RecipeSettingsForm = { render, collect };
})();
