// netlify/functions/get-dpa-content.ts
// US-GDPR-1.2.1: Serve the current DPA text for the acceptance modal.
// GET /.netlify/functions/get-dpa-content[?version=1.1]
//
// Returns { version, currentVersion, effectiveDate, versions, html } — no auth required (public read).
// Rendered by dpa.html; every version ever accepted stays readable.

import { Handler } from '@netlify/functions';
import { withLambda } from '@netlify/aws-lambda-compat';

// The version every acceptance is recorded against lives in accept-dpa.ts (CURRENT_DPA_VERSION),
// which the gates import; this module only holds the TEXT of each version, so a customer who
// accepted an earlier one can still read exactly what they agreed to.
import { CURRENT_DPA_VERSION } from './accept-dpa';

export const DPA_EFFECTIVE_DATES: Record<string, string> = {
    '1.0': '2024-05-01',
    '1.1': '2026-10-12',
    '1.2': '2026-11-27',
};
export const DPA_EFFECTIVE_DATE = DPA_EFFECTIVE_DATES[CURRENT_DPA_VERSION];

// SPECIAL_CATEGORY_CLAUSE is exported so admin-api can auto-append it to
// masterAssistant system prompts per US-GDPR-1.2.1 SC3.
export const SPECIAL_CATEGORY_CLAUSE =
    'IMPORTANT — DATA PROTECTION RULE: If any message from a user contains health information, ' +
    'financial account credentials, biometric data, racial or ethnic origin, political opinions, ' +
    'religious or philosophical beliefs, trade union membership, genetic data, or criminal offence ' +
    'records about any person (including themselves or third parties), do not process, store, act ' +
    'on, or repeat that information. Respond with exactly: "I cannot process sensitive personal ' +
    'information. Please remove it and resend your message." Do not attempt to answer the ' +
    'underlying question using that data.';

const DPA_1_0_HTML = `
<h2>Data Processing Agreement (DPA) — Version 1.0</h2>
<p><strong>Effective date:</strong> 2024-05-01 (superseded by version 1.1 on 2026-10-12)</p>
<p>
  This Data Processing Agreement ("Agreement") is entered into between <strong>Be More Swan Ltd</strong>
  ("Processor") and the organisation accepting this agreement ("Controller"). It supplements and forms
  part of the Be More Swan Terms of Service. Capitalised terms not defined here have the meanings given
  in the Terms of Service or in Regulation (EU) 2016/679 (GDPR).
</p>

<h3>1. Subject Matter and Duration</h3>
<p>
  The Processor will process personal data on behalf of the Controller solely for the purpose of
  providing the Be More Swan platform services described in the Terms of Service. Processing will
  continue for the duration of the subscription and cease on termination or expiry.
</p>

<h3>2. Article 28(3)(a) — Processing only on documented instructions</h3>
<p>
  The Processor will process personal data only on the documented instructions of the Controller,
  including with regard to transfers of personal data to a third country, unless required to do so
  by Union or Member State law. The Processor will inform the Controller of any such legal
  requirement before processing, unless that law prohibits such information on grounds of public
  interest.
</p>

<h3>3. Article 28(3)(b) — Confidentiality</h3>
<p>
  The Processor ensures that persons authorised to process personal data have committed themselves
  to confidentiality or are under an appropriate statutory obligation of confidentiality. This
  obligation applies to all Be More Swan Ltd employees, contractors, and sub-processors who have
  access to Controller personal data.
</p>

<h3>4. Article 28(3)(c) — Security</h3>
<p>
  The Processor will implement appropriate technical and organisational measures to ensure a level
  of security appropriate to the risk, including encryption of personal data in transit and at rest,
  ongoing confidentiality, integrity, availability, and resilience of processing systems, regular
  testing of security measures, and timely restoration of availability following a physical or
  technical incident.
</p>

<h3>5. Article 28(3)(d) — Sub-processors</h3>
<p>
  The Processor will not engage another processor (sub-processor) without prior specific or general
  written authorisation from the Controller. Where general written authorisation is relied on, the
  Processor will provide the Controller with at least <strong>14 calendar days' written notice</strong>
  before adding or replacing any sub-processor, giving the Controller sufficient time to object.
  The Processor will impose the same data protection obligations on any sub-processor by contract.
  The Processor remains fully liable to the Controller for the performance of a sub-processor's
  obligations.
</p>
<p>
  Current sub-processors: Neon Technologies Inc. (database hosting), OpenAI Ireland Ltd (AI model
  inference), Stripe Inc. (payment processing), Resend Inc. (transactional email).
</p>

<h3>6. Article 28(3)(e) — Assistance with data subject rights</h3>
<p>
  The Processor will assist the Controller in fulfilling its obligation to respond to requests from
  data subjects exercising their rights under Chapter III of the GDPR (access, rectification,
  erasure, restriction, portability, and objection). Requests received directly by the Processor
  from data subjects will be forwarded to the Controller without delay.
</p>

<h3>7. Article 28(3)(f) — Deletion or return of data on termination</h3>
<p>
  At the choice of the Controller, on termination or expiry of the agreement the Processor will
  delete or return all personal data to the Controller and delete existing copies. This obligation
  explicitly includes AI context windows, cached prompts, and vector embeddings. The Controller may
  request a data export at any time via the Subject Access Request workflow.
  Deletion will be completed within <strong>30 days</strong> of termination.
</p>

<h3>8. Article 28(3)(h) — Audit rights</h3>
<p>
  The Processor will make available all information necessary to demonstrate compliance with this
  Agreement and will allow for and contribute to audits and inspections conducted by the Controller
  or an auditor mandated by the Controller. Standard audit requests will be fulfilled by means of a
  written questionnaire within 15 business days. Full on-site audits are available by arrangement
  for Enterprise tier customers.
</p>

<h3>9. Article 28(9) — Breach notification</h3>
<p>
  In the event of a personal data breach affecting Controller data, the Processor will notify the
  Controller <strong>within 24 hours</strong> of becoming aware of the breach, providing sufficient
  information to allow the Controller to fulfil its own notification obligations under Articles 33
  and 34 of the GDPR.
</p>

<h3>10. Special Category Data Prohibition</h3>
<p>
  The Controller must not, and must ensure that its users do not, submit <strong>Special Category
  personal data</strong> through the Be More Swan platform. Special Category data means personal data
  revealing racial or ethnic origin, political opinions, religious or philosophical beliefs, trade
  union membership, genetic data, biometric data processed to uniquely identify a person, data
  concerning health, a person's sex life or sexual orientation, and data relating to criminal
  convictions and offences (Article 9 and 10 GDPR).
</p>
<p>
  Submitting Special Category data through the platform is a material breach of this Agreement and
  may result in immediate suspension of the Controller's account without notice.
</p>

<h3>11. Governing Law</h3>
<p>
  This Agreement is governed by the laws of England and Wales. The parties submit to the exclusive
  jurisdiction of the courts of England and Wales.
</p>

<p style="font-size:0.8rem;color:#6b7280;margin-top:2rem;">
  Version 1.0 — Effective 2024-05-01 — Superseded by version 1.1 on 2026-10-12.
  This document has been drafted as a technical template and requires formal legal review before
  it constitutes a binding agreement.
</p>
`;

// Version 1.1 (12 October 2026). What changed from 1.0, and why:
//   - written for UK GDPR + the Data Protection Act 2018 (1.0 cited EU GDPR only);
//   - the sub-processor list points at ONE public register (trust.html#sub-processors) instead of an
//     inline list that had drifted to 4 of 16 providers;
//   - the Article 28(3) letters are right, and the missing (f) — help with security, breach,
//     DPIA and prior consultation — is there;
//   - Annex 1 (details of processing) and Annex 2 (security measures), which Article 28(3) requires;
//   - an international transfers clause (UK IDTA / UK Addendum / UK Extension to the DPF);
//   - breach notice: without undue delay and within 48 hours (1.0 promised 24);
//   - the "not binding, legal review pending" footer is gone.
// ⚠️ Change this text → bump CURRENT_DPA_VERSION in accept-dpa.ts, add the date above, keep the old
// text here, and update the "What changed" list in workspace.html's #modal-dpa-required.
const DPA_1_1_HTML = `
<h2>Data Processing Agreement — Version 1.1</h2>
<p><strong>Effective date:</strong> 12 October 2026. Replaces version 1.0. Superseded by version 1.2 on 27 November 2026.</p>
<p>
  This Data Processing Agreement ("Agreement") is between <strong>Be More Swan Ltd</strong> ("we", the
  "Processor") and the organisation that accepts it ("you", the "Controller"). It forms part of the
  Be More Swan Terms of Service. "Data Protection Law" means the UK GDPR, the Data Protection Act 2018
  and the Privacy and Electronic Communications Regulations 2003 and, where they apply to your
  processing, Regulation (EU) 2016/679 (the "EU GDPR") and the laws implementing it. Terms such as
  "personal data", "processing", "controller", "processor", "data subject" and "personal data breach"
  have the meanings given in Data Protection Law. If this Agreement and the Terms of Service conflict
  on the protection of personal data, this Agreement wins.
</p>

<h3>1. Scope and roles</h3>
<p>
  This Agreement covers the personal data you, your team and your assistants put into or connect to
  your Be More Swan workspace ("Customer Personal Data"), which we process as your processor. It does
  not cover the data we handle as a controller in our own right — your own account, login and billing
  details, and the data we need to run and secure the platform — which our Privacy Policy describes.
  The details of the processing (its subject matter, duration, nature and purpose, and the types of
  personal data and categories of data subjects) are set out in Annex 1.
</p>

<h3>2. Processing only on your instructions — Article 28(3)(a)</h3>
<p>
  We process Customer Personal Data only on your documented instructions, including on transfers
  outside the UK. Your instructions are this Agreement, the Terms of Service, and what you or your
  users tell the platform and your assistants to do through it. If the law requires us to process it
  in some other way, we will tell you first unless that law forbids it. If we believe an instruction
  breaks Data Protection Law, we will tell you and may decline to follow it.
</p>

<h3>3. Confidentiality — Article 28(3)(b)</h3>
<p>
  Everyone we authorise to process Customer Personal Data — our employees, contractors and
  sub-processors — is bound by a duty of confidentiality, by contract or by law, and has access only to
  what their role needs.
</p>

<h3>4. Security — Article 28(3)(c) and Article 32</h3>
<p>
  We take appropriate technical and organisational measures to protect Customer Personal Data,
  taking into account the state of the art, the cost of implementation, and the nature, scope,
  context, purposes and risks of the processing. The measures in place are summarised in Annex 2. We
  may improve them over time but will not reduce the overall level of protection.
</p>

<h3>5. Sub-processors — Article 28(2) and 28(3)(d)</h3>
<p>
  You give us general written authorisation to use sub-processors. The current list, with each
  provider's purpose and location, is published at
  <a href="https://bemoreswan.com/trust.html#sub-processors">bemoreswan.com/trust.html#sub-processors</a>.
  We will tell you at least <strong>14 days</strong> before we add or replace a sub-processor that will
  process Customer Personal Data, by email to your workspace owner and by updating that list. You may
  object on reasonable data-protection grounds by writing to
  <a href="mailto:privacy@bemoreswan.com">privacy@bemoreswan.com</a> within that period. We will then
  work with you in good faith on an alternative; if none is found, you may end the affected Services
  without any early-termination charge. We put each sub-processor under a written contract with data
  protection obligations no less protective than this Agreement, and we remain liable to you for its
  performance of them.
</p>
<p>
  Platforms you choose to connect and instruct us to send data to — for example your social media
  accounts, your mailbox, your blog or your CRM — are not our sub-processors. They act under your own
  agreement with them.
</p>

<h3>6. Data subject rights — Article 28(3)(e)</h3>
<p>
  Taking into account the nature of the processing, we will help you, by appropriate technical and
  organisational measures and so far as possible, to respond to people exercising their rights of
  access, rectification, erasure, restriction, portability and objection. The workspace lets you
  view, correct, export and delete the contacts it holds. If a data subject contacts us directly about
  Customer Personal Data, we will pass the request to you without undue delay and will not answer it
  ourselves unless you ask us to.
</p>

<h3>7. Help with your other obligations — Article 28(3)(f)</h3>
<p>
  Taking into account the nature of the processing and the information available to us, we will help
  you meet your obligations under Articles 32 to 36 of the UK GDPR: keeping the processing secure,
  notifying personal data breaches, carrying out data protection impact assessments, and consulting
  the Information Commissioner before high-risk processing.
</p>

<h3>8. Personal data breaches — Article 33(2)</h3>
<p>
  We will notify you of a personal data breach affecting Customer Personal Data
  <strong>without undue delay, and in any event within 48 hours</strong> of becoming aware of it. We
  will tell you, as far as we then know it, what happened, the categories and approximate number of
  people and records concerned, the likely consequences, and what we have done or propose to do, and
  we will add to this as we learn more. Notifying you is not an admission of fault.
</p>

<h3>9. Deletion or return at the end — Article 28(3)(g)</h3>
<p>
  While your subscription runs you can export your workspace data at any time from My Account. When
  it ends, you may ask us within 30 days to return Customer Personal Data in a commonly used,
  machine-readable format. We then delete it — including assistant memory, cached prompts and search
  indexes built from it — within <strong>30 days</strong>, unless the law requires us to keep it.
  Copies held in backups are deleted as those backups expire in their normal cycle and are not used
  in the meantime.
</p>

<h3>10. Information and audits — Article 28(3)(h)</h3>
<p>
  We will make available the information you reasonably need to show that we meet Article 28, and
  will allow for and contribute to audits, including inspections, by you or an auditor you appoint who
  is bound by confidentiality. We will normally meet this with a written security questionnaire,
  answered within 15 business days. An on-site audit is available by arrangement on an Enterprise
  agreement, on reasonable notice, during business hours, no more than once a year unless a breach or
  a regulator requires it. Each party bears its own costs.
</p>

<h3>11. Transfers outside the UK</h3>
<p>
  Some sub-processors process data outside the UK, chiefly in the United States. We transfer Customer
  Personal Data only where the transfer is lawful under Chapter V of the UK GDPR: to a country covered
  by UK adequacy regulations (including, for certified US organisations, the UK Extension to the EU–US
  Data Privacy Framework), or under the UK International Data Transfer Agreement or the UK Addendum to
  the EU Standard Contractual Clauses, with a transfer risk assessment where one is required. Where the
  EU GDPR applies to your processing, the equivalent EU safeguards apply.
</p>

<h3>12. Your responsibilities</h3>
<p>
  You are responsible for having a lawful basis for the personal data you put into the platform or ask
  your assistants to collect and use — including leads, contacts and email audiences — for giving
  people the information Data Protection Law requires, and for any consent your marketing needs under
  the Privacy and Electronic Communications Regulations.
</p>

<h3>13. Special category data</h3>
<p>
  The platform is not designed for special category or criminal offence data (Articles 9 and 10 of the
  UK GDPR) — data about health, racial or ethnic origin, political opinions, religious or philosophical
  beliefs, trade union membership, genetic or biometric data, sex life or sexual orientation, or
  criminal convictions. You must not put it into the platform, and our assistants are instructed not
  to use it. If it is put in deliberately and repeatedly, we may suspend the account concerned.
</p>

<h3>14. Liability, duration and changes</h3>
<p>
  Each party's liability under this Agreement is subject to the limitations in the Terms of Service,
  except where the law does not allow them to apply. This Agreement lasts as long as we process
  Customer Personal Data for you. If we change it, we will tell your workspace owner and record which
  version your organisation accepted; earlier versions remain available at
  <a href="https://bemoreswan.com/dpa.html">bemoreswan.com/dpa.html</a>.
</p>

<h3>15. Governing law</h3>
<p>
  This Agreement is governed by the law of England and Wales, and the courts of England and Wales have
  exclusive jurisdiction.
</p>

<h3>Annex 1 — Details of the processing</h3>
<p><strong>Subject matter and duration.</strong> Providing the Be More Swan platform and the AI assistants
  you hire, for as long as your subscription lasts and the deletion period in clause 9 after it.</p>
<p><strong>Nature and purpose.</strong> Storing and organising your workspace data; drafting content,
  emails, outreach and reports with AI models; researching and qualifying business leads you ask for;
  sending emails and publishing posts you approve; reading data from the accounts you connect; and
  measuring how your content and emails perform — in each case to provide the Services to you.</p>
<p><strong>Categories of data subjects</strong> (depending on which assistants and connections you use):
  your staff and other users you invite; your customers, prospects and business leads; your email
  audience and subscribers; people who reply to, follow or engage with your content; meeting
  participants; and people named in the content and documents you provide.</p>
<p><strong>Types of personal data:</strong> names; business contact details such as email address,
  phone number, job title and company; public professional and social media profile details;
  correspondence and replies; email engagement data (opens, clicks, unsubscribes) and consent
  records; notes, transcripts and documents you provide; and the content you create and publish.</p>
<p><strong>Special category data:</strong> none intended — see clause 13.</p>

<h3>Annex 2 — Security measures</h3>
<ul>
  <li>Encryption in transit (TLS) and at rest (AES-256 database storage).</li>
  <li>Connected-account credentials and API keys encrypted at application level with AES-256-GCM, and
    never logged or returned to the browser.</li>
  <li>Each organisation's data separated by database row-level security, tested automatically before
    each release.</li>
  <li>Staff access to a customer workspace only for support, requiring a super-admin role, limited to
    15 minutes, recorded with a reason in an append-only audit log, and blocked from payments,
    passwords and account deletion.</li>
  <li>Audit logs, agreement acceptances and erasure records that cannot be altered or deleted.</li>
  <li>Automatic deletion of data that is no longer needed, on the schedules in our Privacy Policy.</li>
  <li>Sub-processors assessed before use and bound by written data protection terms.</li>
  <li>Regular security testing, including penetration testing.</li>
</ul>
`;

// 1.2 (27 November 2026): clause 5 names Recall.ai and AssemblyAI as SPECIFICALLY authorised by accepting this version
// (Note Taker meeting bot only; legal review 2026-11-25), clause 13 adds the Email Assistant and Note Taker
// special-category paragraphs, Annexes 1 and 2 describe both features (docs/note-taker-bot-legal.md §4).
const DPA_1_2_HTML = `
<h2>Data Processing Agreement — Version 1.2</h2>
<p><strong>Effective date:</strong> 27 November 2026. Replaces version 1.1.</p>
<p><em>What changed from 1.1:</em> clause 5 names the two sub-processors you authorise by accepting this version, for the Note Taker's meeting feature only (Recall.ai and AssemblyAI); clause 13 adds how we handle sensitive information that can turn up in meetings the Note Taker joins and in mailboxes connected to the Email Assistant; Annexes 1 and 2 describe both features.</p>
<p>
  This Data Processing Agreement ("Agreement") is between <strong>Be More Swan Ltd</strong> ("we", the
  "Processor") and the organisation that accepts it ("you", the "Controller"). It forms part of the
  Be More Swan Terms of Service. "Data Protection Law" means the UK GDPR, the Data Protection Act 2018
  and the Privacy and Electronic Communications Regulations 2003 and, where they apply to your
  processing, Regulation (EU) 2016/679 (the "EU GDPR") and the laws implementing it. Terms such as
  "personal data", "processing", "controller", "processor", "data subject" and "personal data breach"
  have the meanings given in Data Protection Law. If this Agreement and the Terms of Service conflict
  on the protection of personal data, this Agreement wins.
</p>

<h3>1. Scope and roles</h3>
<p>
  This Agreement covers the personal data you, your team and your assistants put into or connect to
  your Be More Swan workspace ("Customer Personal Data"), which we process as your processor. It does
  not cover the data we handle as a controller in our own right — your own account, login and billing
  details, and the data we need to run and secure the platform — which our Privacy Policy describes.
  The details of the processing (its subject matter, duration, nature and purpose, and the types of
  personal data and categories of data subjects) are set out in Annex 1.
</p>

<h3>2. Processing only on your instructions — Article 28(3)(a)</h3>
<p>
  We process Customer Personal Data only on your documented instructions, including on transfers
  outside the UK. Your instructions are this Agreement, the Terms of Service, and what you or your
  users tell the platform and your assistants to do through it. If the law requires us to process it
  in some other way, we will tell you first unless that law forbids it. If we believe an instruction
  breaks Data Protection Law, we will tell you and may decline to follow it.
</p>

<h3>3. Confidentiality — Article 28(3)(b)</h3>
<p>
  Everyone we authorise to process Customer Personal Data — our employees, contractors and
  sub-processors — is bound by a duty of confidentiality, by contract or by law, and has access only to
  what their role needs.
</p>

<h3>4. Security — Article 28(3)(c) and Article 32</h3>
<p>
  We take appropriate technical and organisational measures to protect Customer Personal Data,
  taking into account the state of the art, the cost of implementation, and the nature, scope,
  context, purposes and risks of the processing. The measures in place are summarised in Annex 2. We
  may improve them over time but will not reduce the overall level of protection.
</p>

<h3>5. Sub-processors — Article 28(2) and 28(3)(d)</h3>
<p>
  You give us general written authorisation to use sub-processors. The current list, with each
  provider's purpose and location, is published at
  <a href="https://bemoreswan.com/trust.html#sub-processors">bemoreswan.com/trust.html#sub-processors</a>.
  We will tell you at least <strong>14 days</strong> before we add or replace a sub-processor that will
  process Customer Personal Data, by email to your workspace owner and by updating that list. You may
  object on reasonable data-protection grounds by writing to
  <a href="mailto:privacy@bemoreswan.com">privacy@bemoreswan.com</a> within that period. We will then
  work with you in good faith on an alternative; if none is found, you may end the affected Services
  without any early-termination charge. We put each sub-processor under a written contract with data
  protection obligations no less protective than this Agreement, and we remain liable to you for its
  performance of them.
</p>
<p>
  <strong>Sub-processors you authorise by accepting this version.</strong> By accepting version 1.2 of
  this Agreement you give us specific written authorisation to use the following sub-processors for the
  Note Taker meeting feature only: <strong>Recall.ai (Hyperdoc Inc.)</strong>, which joins the online
  meetings you send the Note Taker to, records them only to make a transcript, and deletes the
  recording; and <strong>AssemblyAI, Inc.</strong>, Recall.ai's sub-processor, which turns the meeting
  audio into text. For UK and EU workspaces, recordings and transcripts are made and stored in the EU
  (Frankfurt); for US workspaces, in the US. Recall.ai support staff in the US may access data when
  needed, under the safeguards in clause 11. These sub-processors receive Customer Personal Data only
  when you or your users send the Note Taker to a meeting. The notice period in the paragraph above does
  not apply to them, because you authorise them specifically here. Where a sub-processor tells us of a
  change to its own sub-processors, we will pass that notice on to you promptly, and in any event within
  2 business days, even if it gives us less than 14 days.
</p>
<p>
  Platforms you choose to connect and instruct us to send data to — for example your social media
  accounts, your mailbox, your blog or your CRM — are not our sub-processors. They act under your own
  agreement with them.
</p>

<h3>6. Data subject rights — Article 28(3)(e)</h3>
<p>
  Taking into account the nature of the processing, we will help you, by appropriate technical and
  organisational measures and so far as possible, to respond to people exercising their rights of
  access, rectification, erasure, restriction, portability and objection. The workspace lets you
  view, correct, export and delete the contacts it holds. If a data subject contacts us directly about
  Customer Personal Data, we will pass the request to you without undue delay and will not answer it
  ourselves unless you ask us to.
</p>

<h3>7. Help with your other obligations — Article 28(3)(f)</h3>
<p>
  Taking into account the nature of the processing and the information available to us, we will help
  you meet your obligations under Articles 32 to 36 of the UK GDPR: keeping the processing secure,
  notifying personal data breaches, carrying out data protection impact assessments, and consulting
  the Information Commissioner before high-risk processing.
</p>

<h3>8. Personal data breaches — Article 33(2)</h3>
<p>
  We will notify you of a personal data breach affecting Customer Personal Data
  <strong>without undue delay, and in any event within 48 hours</strong> of becoming aware of it. We
  will tell you, as far as we then know it, what happened, the categories and approximate number of
  people and records concerned, the likely consequences, and what we have done or propose to do, and
  we will add to this as we learn more. Notifying you is not an admission of fault.
</p>

<h3>9. Deletion or return at the end — Article 28(3)(g)</h3>
<p>
  While your subscription runs you can export your workspace data at any time from My Account. When
  it ends, you may ask us within 30 days to return Customer Personal Data in a commonly used,
  machine-readable format. We then delete it — including assistant memory, cached prompts and search
  indexes built from it — within <strong>30 days</strong>, unless the law requires us to keep it.
  Copies held in backups are deleted as those backups expire in their normal cycle and are not used
  in the meantime.
</p>

<h3>10. Information and audits — Article 28(3)(h)</h3>
<p>
  We will make available the information you reasonably need to show that we meet Article 28, and
  will allow for and contribute to audits, including inspections, by you or an auditor you appoint who
  is bound by confidentiality. We will normally meet this with a written security questionnaire,
  answered within 15 business days. An on-site audit is available by arrangement on an Enterprise
  agreement, on reasonable notice, during business hours, no more than once a year unless a breach or
  a regulator requires it. Each party bears its own costs.
</p>

<h3>11. Transfers outside the UK</h3>
<p>
  Some sub-processors process data outside the UK, chiefly in the United States. We transfer Customer
  Personal Data only where the transfer is lawful under Chapter V of the UK GDPR: to a country covered
  by UK adequacy regulations (including, for certified US organisations, the UK Extension to the EU–US
  Data Privacy Framework), or under the UK International Data Transfer Agreement or the UK Addendum to
  the EU Standard Contractual Clauses, with a transfer risk assessment where one is required. Where the
  EU GDPR applies to your processing, the equivalent EU safeguards apply.
</p>

<h3>12. Your responsibilities</h3>
<p>
  You are responsible for having a lawful basis for the personal data you put into the platform or ask
  your assistants to collect and use — including leads, contacts and email audiences — for giving
  people the information Data Protection Law requires, and for any consent your marketing needs under
  the Privacy and Electronic Communications Regulations.
</p>

<h3>13. Special category data</h3>
<p>
  The platform is not designed for special category or criminal offence data (Articles 9 and 10 of the
  UK GDPR) — data about health, racial or ethnic origin, political opinions, religious or philosophical
  beliefs, trade union membership, genetic or biometric data, sex life or sexual orientation, or
  criminal convictions. You must not put it into the platform, and our assistants are instructed not
  to use it. If it is put in deliberately and repeatedly, we may suspend the account concerned.
</p>
<p>
  <strong>Connected mailboxes.</strong> Emails in a mailbox you connect to the Email Assistant may contain
  special category or criminal offence data that you did not choose to send us. The first paragraph of
  this clause does not apply to that data. We process it only to sort the email, summarise it and draft
  the reply you ask for; we do not store email bodies; we instruct our assistants never to infer, record
  or label a special category; and senders you mark as private are never sent to an AI model. You remain
  responsible for having a lawful basis, and a condition under Article 9 where one is needed, for
  processing the emails you receive.
</p>
<p>
  <strong>Meetings the Note Taker joins.</strong> What people say in a meeting you send the Note Taker to
  may include special category or criminal offence data. The first paragraph of this clause does not
  apply to that data. We process it only to make the transcript and write the minutes you asked for; the
  recording and transcript are deleted at our provider as soon as the minutes are written, and we do not
  keep the transcript ourselves; and we instruct our assistants never to infer, record or label a special category in the minutes. Do not
  send the Note Taker to meetings whose purpose is to discuss special category data (for example a
  medical consultation or a disciplinary hearing) unless you have a lawful basis and an Article 9
  condition for it. You are responsible for telling the people in the meeting that it is being recorded
  and transcribed, and for getting any consent the law requires.
</p>

<h3>14. Liability, duration and changes</h3>
<p>
  Each party's liability under this Agreement is subject to the limitations in the Terms of Service,
  except where the law does not allow them to apply. This Agreement lasts as long as we process
  Customer Personal Data for you. If we change it, we will tell your workspace owner and record which
  version your organisation accepted; earlier versions remain available at
  <a href="https://bemoreswan.com/dpa.html">bemoreswan.com/dpa.html</a>.
</p>

<h3>15. Governing law</h3>
<p>
  This Agreement is governed by the law of England and Wales, and the courts of England and Wales have
  exclusive jurisdiction.
</p>

<h3>Annex 1 — Details of the processing</h3>
<p><strong>Subject matter and duration.</strong> Providing the Be More Swan platform and the AI assistants
  you hire, for as long as your subscription lasts and the deletion period in clause 9 after it.</p>
<p><strong>Nature and purpose.</strong> Storing and organising your workspace data; drafting content,
  emails, outreach and reports with AI models; researching and qualifying business leads you ask for;
  sending emails and publishing posts you approve; reading data from the accounts you connect;
  reading, sorting, summarising and drafting replies to the emails in mailboxes you or your users
  connect to the Email Assistant, and moving, labelling or sending them when you approve it; sending a
  meeting bot, when you ask, into online meetings to record them only long enough to make a transcript,
  and writing minutes from that transcript; and
  measuring how your content and emails perform — in each case to provide the Services to you.</p>
<p><strong>Categories of data subjects</strong> (depending on which assistants and connections you use):
  your staff and other users you invite; your customers, prospects and business leads; your email
  audience and subscribers; people who reply to, follow or engage with your content; meeting
  participants; people who email you or your users at a mailbox connected to the Email Assistant, and
  people named in those emails; people taking part in meetings you send the Note Taker to, and people
  named in them; and people named in the content and documents you provide.</p>
<p><strong>Types of personal data:</strong> names; business contact details such as email address,
  phone number, job title and company; public professional and social media profile details;
  correspondence and replies; email engagement data (opens, clicks, unsubscribes) and consent
  records; notes, transcripts and documents you provide; email headers (sender, recipients, subject,
  date) and the content of emails in mailboxes connected to the Email Assistant, which is read but not
  stored, and the summaries and categories we derive from them; meeting audio and video and transcripts of
  what was said with each speaker's display name, kept only until the minutes are written, and meeting
  titles, times and participant display names; and the content you create and publish.</p>
<p><strong>Special category data:</strong> none intended, except as incidentally contained in emails read
  by the Email Assistant or in meetings the Note Taker joins — see clause 13.</p>

<h3>Annex 2 — Security measures</h3>
<ul>
  <li>Encryption in transit (TLS) and at rest (AES-256 database storage).</li>
  <li>Connected-account credentials and API keys encrypted at application level with AES-256-GCM, and
    never logged or returned to the browser.</li>
  <li>Each organisation's data separated by database row-level security, tested automatically before
    each release.</li>
  <li>Staff access to a customer workspace only for support, requiring a super-admin role, limited to
    15 minutes, recorded with a reason in an append-only audit log, and blocked from payments,
    passwords and account deletion.</li>
  <li>Audit logs, agreement acceptances and erasure records that cannot be altered or deleted.</li>
  <li>Automatic deletion of data that is no longer needed, on the schedules in our Privacy Policy.</li>
  <li>Sub-processors assessed before use and bound by written data protection terms.</li>
  <li>Regular security testing, including penetration testing.</li>
  <li>Email Assistant: mailbox access tokens encrypted with a separate key per mailbox; email bodies and
    attachments not stored; email text excluded from logs; mailbox data deleted at once when a mailbox
    is disconnected.</li>
  <li>Note Taker meetings: recordings and transcripts deleted at our provider as soon as the minutes are
    written (and by the provider after 48 hours at the latest); the transcript is not stored by us; meeting
    text excluded from logs; UK and EU workspaces' meetings recorded, transcribed and stored in the EU; our provider's
    support access from outside the EU limited to staff who need it, with multi-factor sign-in, under
    standard contractual clauses.</li>
</ul>
`;

const DPA_TEXT: Record<string, string> = { '1.0': DPA_1_0_HTML, '1.1': DPA_1_1_HTML, '1.2': DPA_1_2_HTML };
export const DPA_VERSIONS = Object.keys(DPA_TEXT);

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const requestedVersion = event.queryStringParameters?.version ?? CURRENT_DPA_VERSION;
    const html = DPA_TEXT[requestedVersion];
    if (!html) {
        return { statusCode: 404, body: JSON.stringify({ error: `DPA version '${requestedVersion}' not found.` }) };
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
        body: JSON.stringify({
            version: requestedVersion,
            currentVersion: CURRENT_DPA_VERSION,
            effectiveDate: DPA_EFFECTIVE_DATES[requestedVersion],
            versions: DPA_VERSIONS.map((v) => ({ version: v, effectiveDate: DPA_EFFECTIVE_DATES[v] })),
            html: html.trim(),
        }),
    };
});
