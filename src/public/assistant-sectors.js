/**
 * src/public/assistant-sectors.js
 *
 * Sector tabs on the assistant library (assistants.html + assistant-catalogue.html).
 *
 * A master assistant has ONE category — its job function (Marketing & Sales, Operations…). A
 * sector such as Education is a different axis: it lists the assistants that suit that kind of
 * business, and each of them keeps its own function category. Moving the Blog Writing Assistant's
 * category to Education would drop it from Marketing & Sales, so sectors cross-list by roleKey here.
 *
 * A roleKey listed here only shows if master-assistants returns it, so hidden or retired roles stay
 * hidden — no status lives in this file.
 *
 * Usage:
 *   AssistantSectors.matches(assistant, 'Education')   // true if the tab should show it
 */
(function () {
  'use strict';

  var SECTORS = {
    // Schools, nurseries, colleges, tutors and training providers.
    Education: [
      'social_media_manager',      // term news, open days, celebrating pupils' work
      'newsletter_editor',         // parent and alumni newsletters
      'blog_writer',               // school news and articles on the website
      'website_assistant',         // keeping the school or tutoring site current
      'campaign_orchestrator',     // enrolment and open-day campaigns
      'tier1_support_agent',       // admissions and parent FAQs
      'client_onboarding_guide',   // welcoming new pupils, parents or learners
      'review_reputation_manager', // Google reviews for nurseries, tutors and private schools
      'meeting_note_taker',        // governor, staff and parent meetings
      'rfp_proposal_responder',    // grant and funding bids
      'accounts_receivable_clerk', // chasing fees and course invoices
      'inbox_manager',             // the office inbox
      'calendar_coordinator',      // parents' evenings and tutor sessions
      'document_organizer',        // policies, forms and records
    ],
  };

  function matches(assistant, sector) {
    var keys = SECTORS[sector];
    return !!keys && !!assistant && keys.indexOf(assistant.roleKey) !== -1;
  }

  window.AssistantSectors = { SECTORS: SECTORS, matches: matches };
})();
