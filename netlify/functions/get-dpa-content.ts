// netlify/functions/get-dpa-content.ts
// US-GDPR-1.2.1: Serve the current DPA text for the acceptance modal.
// GET /.netlify/functions/get-dpa-content[?version=1.0]
//
// Returns { version, effectiveDate, html } — no auth required (public read).
// NOTE: This is a technical template. Legal review is required before publication.

import { Handler } from '@netlify/functions';

export const CURRENT_DPA_VERSION = '1.0';
export const DPA_EFFECTIVE_DATE  = '2024-05-01';

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

const DPA_HTML = `
<h2>Data Processing Agreement (DPA) — Version ${CURRENT_DPA_VERSION}</h2>
<p><strong>Effective date:</strong> ${DPA_EFFECTIVE_DATE}</p>
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
  Version ${CURRENT_DPA_VERSION} — Effective ${DPA_EFFECTIVE_DATE} — Legal review pending publication.
  This document has been drafted as a technical template and requires formal legal review before
  it constitutes a binding agreement.
</p>
`;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const requestedVersion = event.queryStringParameters?.version ?? CURRENT_DPA_VERSION;

    if (requestedVersion !== CURRENT_DPA_VERSION) {
        return { statusCode: 404, body: JSON.stringify({ error: `DPA version '${requestedVersion}' not found.` }) };
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
        body: JSON.stringify({
            version: CURRENT_DPA_VERSION,
            effectiveDate: DPA_EFFECTIVE_DATE,
            html: DPA_HTML.trim(),
        }),
    };
};
