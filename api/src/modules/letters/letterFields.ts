/** System field tokens used across Letter Studio mapping, validation, and PDF render. */
export const SYSTEM_FIELDS = [
  'Employee_ID',
  'Employee_Name',
  'Employee_Email',
  'Designation',
  'Department',
  'Old_CTC',
  'New_CTC',
  'Increment_Percent',
  'Effective_Date',
  'PDF_Password',
  'Manager_Name',
] as const;

export type SystemField = (typeof SYSTEM_FIELDS)[number];

export const LETTER_TYPES = [
  'INCREMENT',
  'PROMOTION',
  'SALARY_REVISION',
  'OFFER',
  'CONFIRMATION',
  'WARNING',
  'SEPARATION',
] as const;

export type LetterType = (typeof LETTER_TYPES)[number];

export const REQUIRED_FIELDS_BY_TYPE: Partial<Record<LetterType, SystemField[]>> = {
  INCREMENT: ['Employee_ID', 'Employee_Name', 'New_CTC', 'Effective_Date'],
  PROMOTION: ['Employee_ID', 'Employee_Name', 'Designation', 'Effective_Date'],
  SALARY_REVISION: ['Employee_ID', 'Employee_Name', 'New_CTC', 'Effective_Date'],
  OFFER: ['Employee_ID', 'Employee_Name', 'Employee_Email', 'Designation', 'Effective_Date'],
  CONFIRMATION: ['Employee_ID', 'Employee_Name', 'Effective_Date'],
  WARNING: ['Employee_ID', 'Employee_Name'],
  SEPARATION: ['Employee_ID', 'Employee_Name', 'Effective_Date'],
};

function para(text: string) {
  return {
    type: 'paragraph',
    content: [{ type: 'text', text }],
  };
}

function emptyPara() {
  return { type: 'paragraph' };
}

function token(name: string) {
  return { type: 'text', marks: [{ type: 'bold' }], text: `{{${name}}}` };
}

function mixedPara(...parts: Array<string | ReturnType<typeof token>>) {
  return {
    type: 'paragraph',
    content: parts.map((p) => (typeof p === 'string' ? { type: 'text', text: p } : p)),
  };
}

function title(text: string) {
  return {
    type: 'heading',
    attrs: { level: 2, textAlign: 'center' },
    content: [{ type: 'text', marks: [{ type: 'bold' }], text }],
  };
}

function closingBlock() {
  return [
    emptyPara(),
    para('Warm regards,'),
    emptyPara(),
    mixedPara(token('Manager_Name')),
  ];
}

/** TipTap-compatible starter documents with field tokens already inserted. */
export const STARTER_TEMPLATES: Array<{
  type: LetterType;
  name: string;
  fieldTokens: SystemField[];
  contentJson: Record<string, unknown>;
}> = [
  {
    type: 'INCREMENT',
    name: 'Salary Increment Letter',
    fieldTokens: [
      'Employee_Name',
      'Employee_ID',
      'Designation',
      'Department',
      'Old_CTC',
      'New_CTC',
      'Increment_Percent',
      'Effective_Date',
      'Manager_Name',
    ],
    contentJson: {
      type: 'doc',
      content: [
        title('Salary Increment Letter'),
        emptyPara(),
        mixedPara('Date: ', token('Effective_Date')),
        emptyPara(),
        para('To,'),
        mixedPara('Mr./Ms. ', token('Employee_Name')),
        mixedPara('Employee ID: ', token('Employee_ID')),
        mixedPara('Designation: ', token('Designation')),
        mixedPara('Department: ', token('Department')),
        emptyPara(),
        mixedPara('Dear ', token('Employee_Name'), ','),
        emptyPara(),
        para(
          'We are pleased to inform you that your performance and contributions over the past review period have been recognized. Accordingly, your compensation has been revised.'
        ),
        emptyPara(),
        mixedPara('Previous CTC: ', token('Old_CTC')),
        mixedPara('Revised CTC: ', token('New_CTC')),
        mixedPara('Increment: ', token('Increment_Percent'), '%'),
        mixedPara('Effective from: ', token('Effective_Date')),
        emptyPara(),
        para(
          'We appreciate your dedication and look forward to your continued contributions to the team. Please treat this communication as confidential.'
        ),
        ...closingBlock(),
      ],
    },
  },
  {
    type: 'PROMOTION',
    name: 'Promotion Letter',
    fieldTokens: [
      'Employee_Name',
      'Employee_ID',
      'Designation',
      'Department',
      'Effective_Date',
      'Manager_Name',
      'New_CTC',
    ],
    contentJson: {
      type: 'doc',
      content: [
        title('Promotion Letter'),
        emptyPara(),
        mixedPara('Date: ', token('Effective_Date')),
        emptyPara(),
        mixedPara('Dear ', token('Employee_Name'), ','),
        emptyPara(),
        para(
          'Congratulations. In recognition of your performance, leadership, and commitment, we are pleased to confirm your promotion.'
        ),
        emptyPara(),
        mixedPara('Employee ID: ', token('Employee_ID')),
        mixedPara('New designation: ', token('Designation')),
        mixedPara('Department: ', token('Department')),
        mixedPara('Effective date: ', token('Effective_Date')),
        mixedPara('Reporting manager: ', token('Manager_Name')),
        emptyPara(),
        para(
          'We are confident you will continue to set a high standard in your new role. Please reach out to Human Resources if you have any questions.'
        ),
        ...closingBlock(),
      ],
    },
  },
  {
    type: 'SALARY_REVISION',
    name: 'Salary Revision Letter',
    fieldTokens: [
      'Employee_Name',
      'Employee_ID',
      'Old_CTC',
      'New_CTC',
      'Effective_Date',
      'Manager_Name',
    ],
    contentJson: {
      type: 'doc',
      content: [
        title('Salary Revision Letter'),
        emptyPara(),
        mixedPara('Date: ', token('Effective_Date')),
        emptyPara(),
        mixedPara('Dear ', token('Employee_Name'), ','),
        emptyPara(),
        para(
          'This letter confirms a revision to your compensation structure as part of our periodic review process.'
        ),
        emptyPara(),
        mixedPara('Employee ID: ', token('Employee_ID')),
        mixedPara('Previous CTC: ', token('Old_CTC')),
        mixedPara('Revised CTC: ', token('New_CTC')),
        mixedPara('Effective date: ', token('Effective_Date')),
        emptyPara(),
        para(
          'All other terms and conditions of your employment remain unchanged. Please contact HR for any clarifications.'
        ),
        ...closingBlock(),
      ],
    },
  },
  {
    type: 'OFFER',
    name: 'Offer Letter',
    fieldTokens: [
      'Employee_Name',
      'Employee_Email',
      'Designation',
      'Department',
      'New_CTC',
      'Effective_Date',
      'Manager_Name',
    ],
    contentJson: {
      type: 'doc',
      content: [
        title('Offer of Employment'),
        emptyPara(),
        mixedPara('Date: ', token('Effective_Date')),
        emptyPara(),
        mixedPara('Dear ', token('Employee_Name'), ','),
        emptyPara(),
        para(
          'We are delighted to offer you employment with our organization. We believe your skills and experience will be a valuable addition to our team.'
        ),
        emptyPara(),
        mixedPara('Position: ', token('Designation')),
        mixedPara('Department: ', token('Department')),
        mixedPara('Annual CTC: ', token('New_CTC')),
        mixedPara('Proposed start date: ', token('Effective_Date')),
        mixedPara('Email on file: ', token('Employee_Email')),
        emptyPara(),
        para(
          'This offer is contingent upon completion of our standard joining formalities. Please confirm your acceptance by replying to this letter.'
        ),
        ...closingBlock(),
      ],
    },
  },
  {
    type: 'CONFIRMATION',
    name: 'Confirmation Letter',
    fieldTokens: [
      'Employee_Name',
      'Employee_ID',
      'Designation',
      'Effective_Date',
      'Manager_Name',
    ],
    contentJson: {
      type: 'doc',
      content: [
        title('Confirmation of Employment'),
        emptyPara(),
        mixedPara('Date: ', token('Effective_Date')),
        emptyPara(),
        mixedPara('Dear ', token('Employee_Name'), ','),
        emptyPara(),
        para(
          'We are pleased to confirm your employment following the successful completion of your probationary period.'
        ),
        emptyPara(),
        mixedPara('Employee ID: ', token('Employee_ID')),
        mixedPara('Designation: ', token('Designation')),
        mixedPara('Confirmation date: ', token('Effective_Date')),
        emptyPara(),
        para(
          'We look forward to your continued association with the organization and wish you every success ahead.'
        ),
        ...closingBlock(),
      ],
    },
  },
  {
    type: 'WARNING',
    name: 'Warning Letter',
    fieldTokens: [
      'Employee_Name',
      'Employee_ID',
      'Designation',
      'Effective_Date',
      'Manager_Name',
    ],
    contentJson: {
      type: 'doc',
      content: [
        title('Warning Letter'),
        emptyPara(),
        mixedPara('Date: ', token('Effective_Date')),
        emptyPara(),
        mixedPara('Dear ', token('Employee_Name'), ','),
        emptyPara(),
        para(
          'This letter serves as a formal warning regarding conduct or performance that does not meet the standards expected by the organization.'
        ),
        emptyPara(),
        mixedPara('Employee ID: ', token('Employee_ID')),
        mixedPara('Designation: ', token('Designation')),
        emptyPara(),
        para(
          'You are advised to take immediate corrective action. Further instances may result in additional disciplinary measures, up to and including termination, in accordance with company policy.'
        ),
        emptyPara(),
        para('Please acknowledge receipt of this letter.'),
        ...closingBlock(),
      ],
    },
  },
  {
    type: 'SEPARATION',
    name: 'Separation Letter',
    fieldTokens: [
      'Employee_Name',
      'Employee_ID',
      'Designation',
      'Effective_Date',
      'Manager_Name',
    ],
    contentJson: {
      type: 'doc',
      content: [
        title('Separation Letter'),
        emptyPara(),
        mixedPara('Date: ', token('Effective_Date')),
        emptyPara(),
        mixedPara('Dear ', token('Employee_Name'), ','),
        emptyPara(),
        para(
          'This letter confirms the separation of your employment with the organization. We thank you for your service and contributions during your tenure.'
        ),
        emptyPara(),
        mixedPara('Employee ID: ', token('Employee_ID')),
        mixedPara('Designation: ', token('Designation')),
        mixedPara('Last working day: ', token('Effective_Date')),
        emptyPara(),
        para(
          'Human Resources will share details regarding final settlement, return of company property, and other exit formalities separately. We wish you the very best in your future endeavors.'
        ),
        ...closingBlock(),
      ],
    },
  },
];

/** Canonical starter names — used when refreshing system templates. */
export const STARTER_TEMPLATE_NAMES = STARTER_TEMPLATES.map((s) => s.name);

export function extractFieldTokens(contentJson: unknown): string[] {
  const text = JSON.stringify(contentJson ?? {});
  const matches = text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g);
  const set = new Set<string>();
  for (const m of matches) set.add(m[1]);
  return [...set];
}
