// task-costs.js — the task costs on the page, live from Admin → Revenue → Task costs.
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

  function label(kind, fallback) {
    if (!figures) return fallback == null ? '' : fallback;
    if (kind === 'ai_video' && figures.videoPricedBySecond) return plural(figures.videoTasksPerSecond) + ' a second';
    var n = figures.weights && figures.weights[kind];
    if (typeof n !== 'number') return fallback == null ? '' : fallback;
    return n === 0 ? 'no tasks' : plural(n);
  }

  function apply(root) {
    if (!figures) return;
    (root || document).querySelectorAll('[data-task-cost]').forEach(function (el) {
      var text = label(el.getAttribute('data-task-cost'), el.textContent);
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
