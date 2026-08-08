// Legal and policy content.
//
// ============================================================================
// DRAFT — REQUIRES REVIEW BY QUALIFIED COUNSEL BEFORE PUBLICATION.
// ============================================================================
// Every document below is engineering scaffolding, not legal advice. The
// wording is a structurally complete starting point so that the acceptance,
// versioning, linking and indexing machinery can be built and tested; it has
// not been reviewed by a lawyer and it contains bracketed [OWNER: ...] markers
// wherever a factual or jurisdictional decision is required. `draft: true`
// renders a visible review banner on the page and is what the automated tests
// assert on — do not clear it without a counsel sign-off recorded in
// docs/LEGAL-REVIEW.md.
//
// VERSIONING. `version` is part of the acceptance record. Bump it whenever the
// substance changes; acceptances are stored against the version that was shown,
// so a customer who accepted v1 is never retroactively bound to v2. Bumping a
// version is what triggers re-acceptance on the next contractual action.

const POLICIES = [
  {
    slug: 'privacy',
    title: 'Privacy Policy',
    version: '2026-08-08.1',
    effective: '2026-08-08',
    draft: true,
    acceptance: 'notice', // shown, not separately signed
    summary: 'What personal and pet information we collect, why we hold it, how long we keep it, and the rights you have over it.',
    sections: [
      ['Who we are', 'This policy covers the website and booking system operated by [OWNER: registered legal entity name] ("we", "us"). Contact details for privacy questions are published on our contact page and are the same address used for data-rights requests.'],
      ['Information we collect', 'Account details (name, email address, phone number, password — stored only as a salted hash). Pet profiles (name, breed, approximate age and weight, free-text care notes). Documents you upload, which typically include vaccination records and may include veterinary correspondence. Booking history, including dates, services and the amounts charged. Payment references returned by our payment processor — we never receive or store your full card number. Reviews you choose to submit. Newsletter subscription status. Server logs containing IP address, request path and timestamp.'],
      ['Why we hold it', 'To take and fulfil bookings (contractual necessity); to meet animal-care obligations such as confirming vaccination status (legal obligation and legitimate interest in animal welfare); to take payment and keep financial records (contractual and legal obligation); to send you service messages about your own bookings (contractual necessity); and, only where you have separately opted in, to send marketing email (consent).'],
      ['What we never do', 'We do not sell personal information. We do not use your pet documents for any purpose other than the care and admission of your animal. We do not send marketing email to anyone who has not separately opted in.'],
      ['Processors', 'We share the minimum necessary data with: our hosting provider, our managed database provider, our object-storage provider (uploaded documents), our payment processor, and our transactional email provider. [OWNER: confirm the named list in docs/PRIVACY-INVENTORY.md matches the vendors actually in use, and that a data-processing agreement is in place with each.]'],
      ['How long we keep it', 'Account and booking records are retained while your account is open and for [OWNER: retention period — commonly 6–7 years for financial records under applicable tax law] after your last booking. Uploaded pet documents are deleted when you delete the document or the pet, or [OWNER: retention period] after your last booking, whichever is sooner. Server logs are retained for 30 days.'],
      ['Your rights', 'You can view and edit your profile and pet records at any time from your account. Under "My Data" you can download a machine-readable copy of everything we hold about you, sign out other devices, and delete your account. Deleting removes your profile, pets and uploaded documents; bookings you have already paid for are financial records we must keep, and your name, contact details, pet names and messages are erased from them so nothing links them back to you. Both actions ask you to re-enter your password first. Depending on where you live you may have additional rights — including access, correction, deletion, portability, and the right to object to or restrict certain processing — under the GDPR, the CCPA/CPRA, or another state privacy law. [OWNER + COUNSEL: confirm which regimes apply to this business and complete the response-time commitments.]'],
      ['Children', 'This service is not directed at children and we do not knowingly create accounts for anyone under 16. [COUNSEL: confirm the correct age threshold for the applicable jurisdiction.]'],
      ['Cookies and analytics', 'See our Cookie and Analytics Notice.'],
      ['Changes', 'We publish the version and effective date of this policy at the top of the page. Material changes are notified to account holders by email.']
    ]
  },
  {
    slug: 'terms',
    title: 'Terms of Service',
    version: '2026-08-08.1',
    effective: '2026-08-08',
    draft: true,
    acceptance: 'required',
    acceptanceLabel: 'I have read and agree to the Terms of Service and the Privacy Policy',
    summary: 'The terms that govern your use of this website and booking system.',
    sections: [
      ['Agreement', 'By creating an account or submitting a booking request you agree to these terms. If you do not agree, do not use the service.'],
      ['Accounts', 'You are responsible for keeping your login credentials confidential and for activity carried out under your account. Tell us immediately if you believe your account has been accessed by someone else.'],
      ['Booking requests', 'Submitting a booking request does not create a confirmed booking. A booking is confirmed only when we approve it and, where payment is required in advance, when payment has been received. We may decline any request.'],
      ['Accurate information', 'You must give accurate information about your animal, including health, behaviour, and vaccination status. Withholding a known behavioural or medical risk may result in refusal of admission without refund.'],
      ['Acceptable use', 'You may not attempt to access another customer\'s records, probe or disrupt the service, upload malicious files, or submit reviews you know to be false.'],
      ['Content you submit', 'You keep ownership of documents, photographs and reviews you submit. You grant us permission to store and process them for the purposes described in the Privacy Policy. Reviews are moderated before publication and we may decline to publish one.'],
      ['Liability', '[COUNSEL: liability, limitation, indemnity and dispute-resolution clauses must be drafted for the governing jurisdiction. Nothing has been drafted here because a generic clause is worse than none.]'],
      ['Governing law', '[OWNER + COUNSEL: state and country whose law governs, and the venue for disputes.]'],
      ['Changes', 'We may update these terms. The version and effective date are shown at the top of this page, and we will ask you to accept a materially changed version before your next booking.']
    ]
  },
  {
    slug: 'boarding-agreement',
    title: 'Boarding and Service Agreement',
    version: '2026-08-08.1',
    effective: '2026-08-08',
    draft: true,
    acceptance: 'required',
    acceptanceLabel: 'I accept the Boarding and Service Agreement for this booking',
    summary: 'The care agreement between you and us for each stay, including admission requirements and what happens if your animal becomes unwell.',
    sections: [
      ['Scope', 'This agreement applies to each booking and is accepted per booking, not once per account, because the animal, dates and circumstances differ each time.'],
      ['Admission requirements', 'Your animal must be up to date on the vaccinations listed in our Pet Document and Vaccination Record Policy, must be free of contagious illness and external parasites on arrival, and must be able to be handled safely. [OWNER: confirm the exact required vaccination list and any age or spay/neuter requirements.]'],
      ['Behaviour', 'You must disclose any history of aggression, resource guarding, escape attempts, separation distress or bite incidents. We may decline or end a stay where an animal presents a risk to staff or other animals; in that case you or your emergency contact must collect the animal promptly.'],
      ['Feeding and medication', 'Tell us your animal\'s feeding routine and any medication, including dose and timing. We administer routine medication as instructed. [OWNER: state whether injectable medication is accepted.]'],
      ['Health and veterinary care', 'If your animal appears unwell or injured we will attempt to contact you and then your emergency contact. If neither can be reached and treatment is needed, we will act under the Emergency Veterinary Authorization you have given.'],
      ['Collection', 'Animals must be collected within our published opening hours. [OWNER: late-collection charge, and what happens to an uncollected animal after a stated period — this must be drafted to match local abandoned-animal law.]'],
      ['Fees', 'Fees are as quoted at the time of booking. Cancellation and refund terms are in the Cancellation and Refund Policy.'],
      ['Risk', '[COUNSEL: assumption-of-risk, waiver and liability wording for animal boarding must be drafted for the governing jurisdiction and checked against local consumer-protection limits.]']
    ]
  },
  {
    slug: 'cancellation-policy',
    title: 'Cancellation and Refund Policy',
    version: '2026-08-08.1',
    effective: '2026-08-08',
    draft: true,
    acceptance: 'notice',
    summary: 'When you can cancel, what you get back, and how refunds are paid.',
    sections: [
      ['Cancelling', 'You can cancel from your account, or by contacting us, at any time before the stay begins.'],
      ['Refund tiers', 'Cancelling 48 hours or more before the start of the stay: full refund. Cancelling between 24 and 48 hours before: 50% refund. Cancelling less than 24 hours before, or not arriving: no refund. Where a partial refund is rounded, the rounding is applied in your favour. [OWNER + COUNSEL: confirm these tiers are the intended commercial terms and are enforceable locally.]'],
      ['Cancellations by us', 'If we cancel a confirmed booking for any reason other than a breach of the Boarding Agreement by you, you receive a full refund regardless of timing.'],
      ['How refunds are paid', 'Refunds are returned to the original payment method through our payment processor. Processing typically takes 5–10 business days depending on your bank.'],
      ['Shortened stays', 'If you collect your animal early, the unused nights are [OWNER: refundable / non-refundable — decision required].'],
      ['Disputes', 'If you believe a charge or refund is wrong, contact us first. Every booking and payment transition is recorded with a timestamp, so we can reconstruct exactly what happened.']
    ]
  },
  {
    slug: 'payment-terms',
    title: 'Payment and Deposit Terms',
    version: '2026-08-08.1',
    effective: '2026-08-08',
    draft: true,
    acceptance: 'notice',
    summary: 'How and when you pay, what the prices include, and how your card details are handled.',
    sections: [
      ['Prices', 'Every published rate is per dog. Boarding is charged per night, daycare per day, and session-based services at a flat rate. The price you are quoted when you book is the price you pay; we calculate it on our servers, never in your browser.'],
      ['What is quoted', 'Quotes show the unit rate, the number of nights or days, and the number of dogs. [OWNER: confirm whether any sales tax applies to pet boarding in your jurisdiction — the system models a tax line but it is currently zero.]'],
      ['When you pay', 'We ask for payment after we approve your booking request. You will receive a secure payment link by email and can also pay from your account.'],
      ['Deposits', 'No deposit is currently taken. [OWNER: decide whether a deposit is required and, if so, the amount and whether it is refundable.]'],
      ['Card handling', 'Payment is processed by our payment provider. Card numbers are entered on the provider\'s own hosted page and are never sent to, or stored on, our servers. We keep only the provider\'s transaction reference.'],
      ['Failed payments', 'If a payment fails, your booking stays in "awaiting payment" and the dates are not held indefinitely. We will tell you before releasing them.'],
      ['Receipts', 'A receipt is emailed on successful payment and the booking history in your account shows every amount charged and refunded.']
    ]
  },
  {
    slug: 'pet-documents-policy',
    title: 'Pet Document and Vaccination Record Policy',
    version: '2026-08-08.1',
    effective: '2026-08-08',
    draft: true,
    acceptance: 'notice',
    summary: 'What documents we need, how we store them, who can see them, and when they are deleted.',
    sections: [
      ['What we need', 'Current vaccination records for each animal. [OWNER: confirm the exact required vaccinations and any titre-test alternative.]'],
      ['Accepted formats', 'PDF, JPEG, PNG, HEIC and WebP, up to 10 MB per file. We verify the actual file content, not just its name, and reject anything else.'],
      ['Where they are stored', 'Documents are stored in private object storage, never in a publicly reachable directory, under a server-generated name. They are encrypted in transit and at rest by the storage provider.'],
      ['Who can see them', 'You, and staff who need them to admit your animal. Every download is recorded with who fetched it and when.'],
      ['Deleting them', 'You can delete a document from your account at any time. Deleting a pet deletes its documents. [OWNER: confirm the retention period for records we must keep after the last stay for animal-care compliance.]'],
      ['Accuracy', 'You are responsible for the accuracy of what you upload. A record that has expired by the start of the stay is treated as missing.']
    ]
  },
  {
    slug: 'emergency-vet-authorization',
    title: 'Emergency Veterinary Authorization',
    version: '2026-08-08.1',
    effective: '2026-08-08',
    draft: true,
    acceptance: 'required',
    acceptanceLabel: 'I authorise emergency veterinary treatment on the terms above',
    summary: 'Your standing authorisation for us to obtain veterinary treatment if your animal needs it and you cannot be reached.',
    sections: [
      ['Contacting you first', 'If your animal appears unwell or injured we will try to reach you on the number on your booking, and then your named emergency contact.'],
      ['Authorisation', 'If neither of you can be reached and, in the reasonable judgement of our staff or a veterinarian, treatment is needed to prevent suffering or to preserve life, you authorise us to obtain that treatment.'],
      ['Choice of veterinarian', 'We will use your animal\'s own veterinarian where practical and reachable; otherwise the nearest available practice or emergency hospital. [OWNER: name the default practice and out-of-hours emergency hospital.]'],
      ['Cost', 'You are responsible for the cost of veterinary treatment. [OWNER + COUNSEL: state whether a spending cap applies before further attempts to contact you, and how costs are invoiced.]'],
      ['Withdrawing it', 'You may withdraw or vary this authorisation in writing before a stay begins. We may decline a booking if we cannot obtain a workable authorisation.']
    ]
  },
  {
    slug: 'cookies',
    title: 'Cookie and Analytics Notice',
    version: '2026-08-08.1',
    effective: '2026-08-08',
    draft: true,
    acceptance: 'notice',
    summary: 'What this site stores in your browser, why the sign-in cookie exists, and why no analytics or advertising scripts run here.',
    sections: [
      ['Strictly necessary cookies', 'We set one session cookie when you sign in. It holds a session identifier only, is marked HttpOnly and Secure so scripts cannot read it, and is deleted when you sign out. This cookie is required for the site to work and is not used for tracking.'],
      ['Analytics', 'This site currently runs no third-party analytics, advertising or tracking scripts. If that changes, this notice will be updated first and a consent mechanism added before any such script is loaded. [OWNER: tell us before adding any analytics or advertising tag.]'],
      ['Third-party pages', 'Paying takes you to our payment provider\'s own page, which sets its own cookies under its own policy.'],
      ['Controlling cookies', 'You can clear or block cookies in your browser. Blocking the session cookie will prevent sign-in from working.']
    ]
  },
  {
    slug: 'accessibility',
    title: 'Accessibility Statement',
    version: '2026-08-08.1',
    effective: '2026-08-08',
    draft: false,
    acceptance: 'notice',
    summary: 'Our accessibility target, what has been tested, and how to tell us about a barrier.',
    sections: [
      ['Our target', 'We aim to meet WCAG 2.2 Level AA across the public site, the customer account area and the booking and payment flow.'],
      ['What has been tested', 'Automated accessibility checks run in our continuous integration on every change and block a merge on failure. In addition, the booking, sign-in and document-upload paths have been walked through with the keyboard only, checking focus order, focus visibility, modal focus trapping and status announcements.'],
      ['Known limitations', 'Any outstanding barrier is listed in docs/ACCESSIBILITY.md with its status. We would rather publish a known gap than claim conformance we have not verified.'],
      ['Telling us about a problem', 'If something on this site is not usable for you, contact us using the details on our contact page and tell us the page and what happened. We treat accessibility reports as defects, not feature requests.'],
      ['Alternatives', 'If you cannot complete a booking on this site for any reason, contact us and we will take the booking directly.']
    ]
  },
  {
    slug: 'support-policy',
    title: 'Contact and Support Policy',
    version: '2026-08-08.1',
    effective: '2026-08-08',
    draft: true,
    acceptance: 'notice',
    summary: 'How to reach us, how quickly we reply, and what to do out of hours.',
    sections: [
      ['How to reach us', 'Contact details are published on our contact page. We only publish channels we actually monitor.'],
      ['Response times', '[OWNER: state the target response time for email and for booking requests. The site currently tells customers "we aim to respond to booking requests within one business day" — confirm or correct this.]'],
      ['Out of hours', 'Emergencies concerning an animal currently in our care are handled under the Emergency Veterinary Authorization. [OWNER: publish the out-of-hours contact route.]'],
      ['Complaints', 'Tell us what went wrong and what you would like done. [OWNER + COUNSEL: escalation route and any regulator a customer can go to.]']
    ]
  }
];

const BY_SLUG = new Map(POLICIES.map(p => [p.slug, p]));

function getPolicy(slug) {
  return BY_SLUG.get(slug) || null;
}

function listPolicies() {
  return POLICIES;
}

// Policies a customer must actively accept, and when.
const ACCEPTANCE_POINTS = {
  registration: ['terms', 'privacy'],
  booking: ['boarding-agreement', 'emergency-vet-authorization']
};

function requiredForPoint(point) {
  return (ACCEPTANCE_POINTS[point] || []).map(slug => {
    const p = getPolicy(slug);
    return { slug: p.slug, title: p.title, version: p.version, label: p.acceptanceLabel };
  });
}

function currentVersion(slug) {
  const p = getPolicy(slug);
  return p ? p.version : null;
}

module.exports = {
  ACCEPTANCE_POINTS,
  POLICIES,
  currentVersion,
  getPolicy,
  listPolicies,
  requiredForPoint
};
