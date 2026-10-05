import type { PolicyDocument } from '../models/document.model';
import type { QuestionLog } from '../models/question-log.model';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** An ISO timestamp a number of days and hours before the app loads. */
function ago(days: number, hours = 0): string {
  return new Date(Date.now() - days * DAY - hours * HOUR).toISOString();
}

/** Placeholder inventory shown while document management is unbuilt. */
export const MOCK_DOCUMENTS: PolicyDocument[] = [
  {
    id: 'doc-handbook',
    title: 'Employee Handbook 2026',
    category: 'Policies',
    status: 'indexed',
    sizeLabel: '2.4 MB',
    sectionCount: 18,
    uploadedAt: ago(12, 0),
    updatedAt: ago(2, 3),
    updatedBy: 'Ama Konadu',
  },
  {
    id: 'doc-leave',
    title: 'Annual Leave & Time Off',
    category: 'People',
    status: 'indexed',
    sizeLabel: '860 KB',
    sectionCount: 9,
    uploadedAt: ago(16, 0),
    updatedAt: ago(4),
    updatedBy: 'Kwame Osei',
  },
  {
    id: 'doc-remote',
    title: 'Remote Work Policy',
    category: 'People',
    status: 'processing',
    sizeLabel: '540 KB',
    sectionCount: 6,
    uploadedAt: ago(21, 0),
    updatedAt: ago(0, 2),
    updatedBy: 'Ama Konadu',
  },
  {
    id: 'doc-it',
    title: 'IT Equipment & VPN Guide',
    category: 'Technology',
    status: 'indexed',
    sizeLabel: '1.1 MB',
    sectionCount: 12,
    uploadedAt: ago(25, 0),
    updatedAt: ago(9),
    updatedBy: 'Yaw Boateng',
  },
  {
    id: 'doc-security',
    title: 'Security & Compliance Standards',
    category: 'Security',
    status: 'indexed',
    sizeLabel: '1.8 MB',
    sectionCount: 21,
    uploadedAt: ago(31, 0),
    updatedAt: ago(14),
    updatedBy: 'Efua Danso',
  },
  {
    id: 'doc-payroll',
    title: 'Payroll & Compensation Policy',
    category: 'Finance',
    status: 'failed',
    sizeLabel: '720 KB',
    sectionCount: 0,
    uploadedAt: ago(40, 0),
    updatedAt: ago(1, 5),
    updatedBy: 'Kwame Osei',
  },
  {
    id: 'doc-onboarding',
    title: 'Onboarding Checklist',
    category: 'People',
    status: 'indexed',
    sizeLabel: '310 KB',
    sectionCount: 5,
    uploadedAt: ago(58, 0),
    updatedAt: ago(21),
    updatedBy: 'Ama Konadu',
  },
];

/** Placeholder question history shown while question logs are unbuilt. */
export const MOCK_QUESTION_LOGS: QuestionLog[] = [
  {
    id: 'q-1042',
    question: 'How many annual leave days do I get?',
    askedBy: 'Ama Konadu',
    askedByInitials: 'AK',
    createdAt: ago(0, 1),
    outcome: 'answered',
    answer:
      'Full-time staff get 25 days of annual leave a year, plus the public holidays. It accrues monthly rather than being granted up front, so the balance in your first months is lower than 25 days.',
    sources: [
      {
        document: 'Employee Handbook 2026',
        section: 'Section 4.2',
        snippet:
          'Full-time employees are entitled to twenty-five (25) working days of paid annual leave per calendar year, accruing at 2.08 days per completed month of service.',
        score: 0.81,
      },
      {
        document: 'Annual Leave & Time Off',
        section: 'Entitlement',
        snippet: 'Public holidays are additional to annual leave and are not deducted from your balance.',
        score: 0.63,
      },
    ],
    durationMs: 2400,
  },
  {
    id: 'q-1041',
    question: 'What is the VPN setup for a new laptop?',
    askedBy: 'Yaw Boateng',
    askedByInitials: 'YB',
    createdAt: ago(0, 4),
    outcome: 'answered',
    answer:
      'Install GlobalProtect from the Self Service portal, sign in with your work email, and the profile is pushed to you automatically. If the portal does not offer it, IT has to enrol the device first.',
    sources: [
      {
        document: 'IT Equipment & VPN Guide',
        section: 'Getting connected',
        snippet:
          'Open Self Service, install GlobalProtect, and sign in with your company email. The configuration profile is delivered on first successful sign-in.',
        score: 0.88,
      },
    ],
    durationMs: 1900,
  },
  {
    id: 'q-1040',
    question: 'Can you tell me my remaining leave balance?',
    askedBy: 'Efua Danso',
    askedByInitials: 'ED',
    createdAt: ago(1, 2),
    outcome: 'not-found',
    answer:
      'I could not find anything about individual leave balances. The handbook explains how leave accrues but no record of your own balance is in the documents I can read.',
    // Deliberately not empty: these are the near-misses, and the gap between
    // them and the threshold is the reason this was a miss.
    sources: [
      {
        document: 'Annual Leave & Time Off',
        section: 'Entitlement',
        snippet: 'Accrual is calculated from your start date and your contracted hours.',
        score: 0.34,
      },
      {
        document: 'Employee Handbook 2026',
        section: 'Section 4.4',
        snippet: 'Carry-over of up to five unused days is permitted into the next year.',
        score: 0.29,
      },
    ],
    durationMs: 40,
  },
  {
    id: 'q-1039',
    question: 'What is the expense claim limit?',
    askedBy: 'Kwame Osei',
    askedByInitials: 'KO',
    createdAt: ago(1, 6),
    outcome: 'not-found',
    answer:
      'I could not find an expense claim limit in the documents I can read. The security standards cover what is reimbursable but not a ceiling.',
    sources: [
      {
        document: 'Security & Compliance Standards',
        section: 'Reimbursable spend',
        snippet: 'Claims must be supported by a receipt and submitted within thirty days.',
        score: 0.31,
      },
    ],
    durationMs: 38,
  },
  {
    id: 'q-1038',
    question: 'When does the performance review cycle run?',
    askedBy: 'Ama Konadu',
    askedByInitials: 'AK',
    createdAt: ago(2, 1),
    outcome: 'answered',
    answer:
      'The cycle runs January to December, with mid-year check-ins in June and the final review submitted by 15 January. Your manager writes the review; you get to read it before it is filed.',
    sources: [
      {
        document: 'Employee Handbook 2026',
        section: 'Section 7.1',
        snippet:
          'The review period is the calendar year. A mid-year check-in is held in June and the completed review is filed by 15 January of the following year.',
        score: 0.86,
      },
      {
        document: 'Employee Handbook 2026',
        section: 'Section 7.3',
        snippet: 'Employees receive a copy of their written review on request.',
        score: 0.58,
      },
      {
        document: 'Annual Leave & Time Off',
        section: 'Review leave',
        snippet: 'Leave taken in December is carried into the next review period if it is approved.',
        score: 0.41,
      },
    ],
    durationMs: 3100,
  },
  {
    id: 'q-1037',
    question: 'How do I report a security incident?',
    askedBy: 'Yaw Boateng',
    askedByInitials: 'YB',
    createdAt: ago(3, 3),
    outcome: 'failed',
    // No answer was ever produced, so the asker saw an error rather than a
    // partial answer. Recording that difference is the reason `failed` exists
    // alongside `not-found`.
    answer: null,
    sources: [],
    durationMs: 90000,
  },
];
