// Fictional people, companies and texts for the demo dataset. Nothing here refers to a real person or company.

export const EN_FIRST = ['Alice', 'Brian', 'Carla', 'Daniel', 'Elena', 'Felix', 'Grace', 'Henry', 'Irene', 'Jonas', 'Karen', 'Leo', 'Maria', 'Nolan', 'Olivia', 'Peter', 'Quinn', 'Rosa', 'Samuel', 'Tessa', 'Umar', 'Vera', 'Walter', 'Xenia', 'Yusuf', 'Zoe', 'Adrian', 'Beatrice', 'Cameron', 'Dina'] as const;
export const EN_LAST = ['Hartley', 'Ironside', 'Jensen', 'Kowalski', 'Lindqvist', 'Marlowe', 'Nakamura', 'Okafor', 'Petrov', 'Quincy', 'Rasmussen', 'Silva', 'Tanaka', 'Underhill', 'Vasquez', 'Whitaker', 'Yilmaz', 'Zielinski', 'Abbott', 'Brandt', 'Castellano', 'Dumont', 'Eriksen', 'Fairweather', 'Gallagher'] as const;

export const COMPANIES = [
  'Northwind Logistics', 'Bluebird Analytics', 'Cedar & Pine Studio', 'Delta Harbor Foods', 'Evergreen Clinics', 'Fjord Robotics',
  'Granite Peak Energy', 'Helix Biotech Labs', 'Indigo Travel Group', 'Juniper Print House', 'Kestrel Aviation Services', 'Lumen Retail',
  'Maple Row Realty', 'Nimbus Cloud Works', 'Orchard Bank Cooperative', 'Pinecone Education', 'Quartz Mining Supply', 'Redwood Insurance Agency',
  'Saffron Catering', 'Tidewater Shipping', 'Umbra Design Collective', 'Vector Telecom', 'Willow Creek Hotels', 'Zenith Auto Parts',
] as const;

export const GROUPS = [
  { code: 'general', name: 'General', description: 'First-line questions and anything that does not fit another group' },
  { code: 'billing', name: 'Billing', description: 'Invoices, payments, refunds and plan changes' },
  { code: 'integrations', name: 'Integrations', description: 'API keys, webhooks and third-party connectors' },
  { code: 'platform', name: 'Platform', description: 'Performance, outages and data export' },
  { code: 'access', name: 'Access', description: 'Sign-in, permissions and account recovery' },
] as const;

/** Subject fragments: an area and a problem. Combined into subjects. */
export const EN_AREAS = ['the invoice export', 'the webhook endpoint', 'single sign-on', 'the monthly report', 'the mobile app', 'the CSV import', 'two-factor codes', 'the audit log', 'the billing page', 'API rate limits', 'the shared dashboard', 'email notifications'] as const;
export const EN_PROBLEMS = ['fails with a timeout', 'shows the wrong totals', 'stopped working after the update', 'is very slow since Monday', 'returns an unexpected error', 'does not save my changes', 'is missing for part of the team', 'sends duplicates', 'cannot be opened', 'needs to be reconfigured'] as const;
export const EN_DETAILS = [
  'It started yesterday afternoon and affects several people in our team.',
  'We tried clearing the cache and signing in again, but nothing changed.',
  'The same steps worked without problems last week.',
  'Attached is a screenshot of what we see on screen.',
  'This blocks our month-end closing, so we would appreciate a quick answer.',
  'Our administrator confirmed that nothing was changed on our side.',
] as const;

export const EN_COMMENTS = [
  'Thanks for the details. I am looking into it now.',
  'Could you tell me which browser and version you are using?',
  'I can reproduce this on our test account. Checking the logs.',
  'The customer confirmed the workaround works for them.',
  'Internal note: this looks related to last week\'s deployment.',
  'I have asked the platform team to take a look at the timeout.',
  'The customer will send the exported file tomorrow morning.',
  'Fixed on our side. Please ask them to try again and tell us what happens.',
  'No reply from the customer so far, I will follow up on Thursday.',
  'Escalated to the second line because the error code is not documented.',
] as const;

/** The text pools, so callers take them from one place. */
export const TEXTS = { areas: EN_AREAS, problems: EN_PROBLEMS, details: EN_DETAILS, comments: EN_COMMENTS } as const;

export const WAITING_REASONS = ['Waiting for the customer to send the log files', 'Asked the customer to confirm the account owner', 'Requested a screenshot of the error'] as const;
export const REOPEN_REASONS = ['The customer replied: the problem is back', 'The fix did not hold after the next deployment'] as const;
export const RESOLUTIONS = [
  'Restarted the sync job and verified the export with the customer.',
  'Corrected the account settings and confirmed that the invoices are available.',
  'Rotated the API key and updated the webhook endpoint configuration.',
] as const;
export const UNRESOLVED_REASONS = [
  'The customer stopped responding after three reminders over two weeks.',
  'The requested feature is not available on this plan and cannot be added.',
  'The problem could not be reproduced and no logs were provided.',
] as const;

export const ATTACHMENT_NAMES = {
  png: ['screenshot-error', 'dashboard', 'report-preview', 'invoice-page'],
  jpeg: ['photo-of-screen', 'scan-receipt', 'device-label'],
  pdf: ['invoice', 'contract-extract', 'export-report', 'statement'],
  txt: ['server-log', 'request-trace', 'notes', 'config-dump'],
} as const;
