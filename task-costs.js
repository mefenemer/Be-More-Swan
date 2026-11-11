// task-costs.js — the task costs on the page, live from Admin → Money → Task costs.
//
//   <span data-task-cost="ai_music">20 tasks</span>     filled in when the figures arrive
//   window.TaskCosts.label('site_audit', '1 task')      for text a script writes
//
// The text already in the page, and the fallback passed to label(), is what shows if the figures can't
// be fetched, and what search engines read.
(function () {
  'use strict';

  var figures = null;
  try { figures = JSON.parse(sessionStorage.getItem('bms_task_costs') || 'null'); } catch (e) { /* private window */ }

  function plural(n) { return n + (n === 1 ? ' task' : ' tasks'); }

  // Worded as formatCost() / taskCostLabel() in src/config/task-weights.ts, so a page and the server agree.
  function label(kind, fallback) {
    if (!figures) return fallback == null ? '' : fallback;
    if (kind === 'ai_video' && figures.videoPricedBySecond) return plural(figures.videoTasksPerSecond) + ' a second';
    if (kind === 'ai_video_per_second' && typeof figures.videoTasksPerSecond === 'number') return plural(figures.videoTasksPerSecond) + ' a second';
    if (kind === 'chat_messages_per_task' && typeof figures.chatMessagesPerTask === 'number') return 'every ' + figures.chatMessagesPerTask + (figures.chatMessagesPerTask === 1 ? ' message' : ' messages');
    var n = figures.weights && figures.weights[kind];
    if (typeof n !== 'number') return fallback == null ? '' : fallback;
    return n === 0 ? 'no tasks' : plural(n);
  }

  function apply(root) {
    if (!figures) return;
    // Hand-written JSON-LD says {{tasks.<key>}} (it can hold no span). The deploy build fills it
    // (scripts/seo/task-costs.mjs); this covers a page served without that step.
    if (!root) document.querySelectorAll('script[type="application/ld+json"]').forEach(function (s) {
      if (s.textContent.indexOf('{{') === -1) return;
      s.textContent = s.textContent.replace(/\{\{\s*tasks\.([a-z_]+)\s*\}\}/g, function (tok, k) { return label(k, tok); });
    });
    (root || document).querySelectorAll('[data-task-cost]').forEach(function (el) {
      // <span data-task-cost="ai_video_per_second" data-task-seconds="5">20 tasks</span>: a clip of that length.
      var secs = Number(el.getAttribute('data-task-seconds'));
      var text = secs > 0 && typeof figures.videoTasksPerSecond === 'number'
        ? plural(Math.ceil(secs) * figures.videoTasksPerSecond)
        : label(el.getAttribute('data-task-cost'), el.textContent);
      if (el.textContent !== text) el.textContent = text;
    });
  }

  var ready = fetch('/.netlify/functions/task-costs')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) return;
      figures = d;
      try { sessionStorage.setItem('bms_task_costs', JSON.stringify(d)); } catch (e) { /* private window */ }
      apply();
    })
    .catch(function () { /* the page keeps the text it has */ });

  window.TaskCosts = { label: label, apply: apply, ready: ready };
  // Short form for scripts: `${window.taskCost('site_audit')}`. Most work is 1 task, so that is the fallback.
  window.taskCost = function (kind, fallback) { return label(kind, fallback || '1 task'); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { apply(); });
  else apply();
})();
