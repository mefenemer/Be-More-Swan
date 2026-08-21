/**
 * src/public/newsletter-findings.js
 *
 * The structural "before you send" findings for one email — the third section of
 * src/utils/deliverability.ts, moved here so the browser and the server run the SAME code.
 *
 * WHY THIS FILE IS PLAIN .js AND UMD-ISH
 * --------------------------------------
 * Same reason as src/public/marked-bms-directives.js. These findings are produced in two places:
 *   · server — src/utils/deliverability.ts re-exports this, and the issue GET returns the result
 *   · browser — newsletter.js recomputes it on every keystroke, so "there are only 0 words of text"
 *               stops being true the moment the author types a word
 * A hand-written second copy in the browser drifts, and the drift is always the same bug: the panel
 * disagrees with the panel you get after a reload, and the user cannot tell which one is lying.
 *
 * ⚠️ THERE IS NO SPAM SCORE HERE AND THERE MUST NEVER BE ONE. A number out of ten implies a model
 * of the receiving filter and nobody outside Google has one; a made-up score gets acted on, and
 * people rewrite good copy to move it. ⚠️ NO TRIGGER-WORD LIST either — "free", "act now" and the
 * rest are folklore from filters retired a decade ago, and a warning about the word "free" makes a
 * tenant rewrite a perfectly good offer for no benefit. tests/deliverability.test.ts stuffs a
 * subject with all of them and asserts nothing is reported.
 *
 * Every finding is NAMED, EXPLAINED, and individually arguable. Nothing here is totalled.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.NewsletterFindings = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var WORDS = function (s) {
    return (String(s == null ? '' : s).trim().match(/\S+/g) || []).length;
  };

  /**
   * @param {{subject?: string, text?: string, html?: string}} issue
   * @returns {{code: string, severity: 'blocker'|'warning'|'note', message: string}[]}
   */
  function contentFindings(issue) {
    var out = [];
    var subject = String((issue && issue.subject) || '');
    var letters = subject.replace(/[^A-Za-z]/g, '');
    var capsRatio = letters ? letters.replace(/[^A-Z]/g, '').length / letters.length : 0;

    if (letters.length >= 8 && capsRatio > 0.6) {
      out.push({
        code: 'subject_shouting',
        severity: 'warning',
        message: 'The subject line is mostly capitals. It reads as shouting to a person and is one of the few surface features filters still weigh.',
      });
    }
    if (/[!?]{2,}/.test(subject)) {
      out.push({
        code: 'subject_punctuation',
        severity: 'warning',
        message: 'The subject line has repeated exclamation or question marks. One is emphasis; three is a pattern filters associate with bulk mail.',
      });
    }
    if (subject.trim().length > 90) {
      out.push({
        code: 'subject_long',
        severity: 'note',
        message: 'The subject line is long enough that most phones will cut it off. It will not hurt delivery, but the end of it will not be read.',
      });
    }
    if (!subject.trim()) {
      out.push({ code: 'subject_missing', severity: 'blocker', message: 'There is no subject line.' });
    }

    var textWords = WORDS(issue && issue.text);
    var html = String((issue && issue.html) || '');
    var images = (html.match(/<img\b/gi) || []).length;
    var links = (html.match(/<a\b[^>]*href=/gi) || []).length;

    if (textWords < 20) {
      out.push({
        code: 'thin_text',
        severity: 'warning',
        message: 'There are only ' + textWords + ' words of text. A message that is almost all pictures, or almost empty, is a shape filters treat with suspicion — and it reads as broken to anyone whose client blocks images.',
      });
    }
    if (images >= 3 && textWords < images * 25) {
      out.push({
        code: 'image_heavy',
        severity: 'note',
        message: 'There is a lot of image compared to text. Anyone whose email client blocks images by default — which is most work accounts — will see very little.',
      });
    }
    if (links >= 10 && links > textWords / 25) {
      out.push({
        code: 'link_dense',
        severity: 'note',
        message: 'There are ' + links + ' links in a fairly short email. Link-heavy messages are more likely to be filtered, and readers click less when given more choices.',
      });
    }
    return out;
  }

  /** blocker → warning → note. The order the panel lists them in, on both sides. */
  function severityRank(f) {
    return f.severity === 'blocker' ? 0 : f.severity === 'warning' ? 1 : 2;
  }

  function sortFindings(list) {
    return (list || []).slice().sort(function (a, b) { return severityRank(a) - severityRank(b); });
  }

  return {
    contentFindings: contentFindings,
    severityRank: severityRank,
    sortFindings: sortFindings,
    countWords: WORDS,
  };
}));
