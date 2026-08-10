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

function token(name: string) {
  return { type: 'text', marks: [{ type: 'bold' }], text: `{{${name}}}` };
}

function mixedPara(...parts: Array<string | ReturnType<typeof token>>) {
  return {
    type: 'paragraph',
    content: parts.map((p) =>
      typeof p === 'string' ? { type: 'text', text: p } : p
    ),
  };
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
    ],
    contentJson: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Salary Increment Letter' }] },
        mixedPara('Date: ', token('Effective_Date')),
        mixedPara('Dear ', token('Employee_Name'), ','),
        para(
          'We are pleased to inform you that your compensation has been revised in recognition of your contributions.'
        ),
        mixedPara('Employee ID: ', token('Employee_ID')),
        mixedPara('Designation: ', token('Designation')),
        mixedPara('Department: ', token('Department')),
        mixedPara('Previous CTC: ', token('Old_CTC')),
        mixedPara('Revised CTC: ', token('New_CTC')),
        mixedPara('Increment: ', token('Increment_Percent'), '%'),
        mixedPara('Effective from: ', token('Effective_Date')),
        para('Please treat this letter as confidential.'),
        para('Warm regards,'),
      ],
    },
  },
  {
    type: 'PROMOTION',
    name: 'Promotion Letter',
    fieldTokens: ['Employee_Name', 'Employee_ID', 'Designation', 'Department', 'Effective_Date', 'Manager_Name'],
    contentJson: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Promotion Letter' }] },
        mixedPara('Dear ', token('Employee_Name'), ','),
        para('Congratulations! We are delighted to promote you in recognition of your performance.'),
        mixedPara('New Designation: ', token('Designation')),
        mixedPara('Department: ', token('Department')),
        mixedPara('Effective Date: ', token('Effective_Date')),
        mixedPara('Reporting Manager: ', token('Manager_Name')),
        para('We look forward to your continued success.'),
      ],
    },
  },
  {
    type: 'SALARY_REVISION',
    name: 'Salary Revision Letter',
    fieldTokens: ['Employee_Name', 'Employee_ID', 'Old_CTC', 'New_CTC', 'Effective_Date'],
    contentJson: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Salary Revision' }] },
        mixedPara('Dear ', token('Employee_Name'), ','),
        para('This letter confirms a revision to your compensation structure.'),
        mixedPara('Previous CTC: ', token('Old_CTC')),
        mixedPara('Revised CTC: ', token('New_CTC')),
        mixedPara('Effective Date: ', token('Effective_Date')),
      ],
    },
  },
  {
    type: 'OFFER',
    name: 'Offer Letter',
    fieldTokens: ['Employee_Name', 'Employee_Email', 'Designation', 'Department', 'New_CTC', 'Effective_Date'],
    contentJson: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Offer of Employment' }] },
        mixedPara('Dear ', token('Employee_Name'), ','),
        para('We are pleased to offer you employment with our organization.'),
        mixedPara('Position: ', token('Designation')),
        mixedPara('Department: ', token('Department')),
        mixedPara('CTC: ', token('New_CTC')),
        mixedPara('Start Date: ', token('Effective_Date')),
        para('Please confirm acceptance by replying to this letter.'),
      ],
    },
  },
  {
    type: 'CONFIRMATION',
    name: 'Confirmation Letter',
    fieldTokens: ['Employee_Name', 'Employee_ID', 'Designation', 'Effective_Date'],
    contentJson: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Confirmation of Employment' }] },
        mixedPara('Dear ', token('Employee_Name'), ','),
        para('We are pleased to confirm your employment following successful completion of probation.'),
        mixedPara('Designation: ', token('Designation')),
        mixedPara('Confirmation Date: ', token('Effective_Date')),
      ],
    },
  },
  {
    type: 'WARNING',
    name: 'Warning Letter',
    fieldTokens: ['Employee_Name', 'Employee_ID', 'Designation', 'Effective_Date'],
    contentJson: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Warning Letter' }] },
        mixedPara('Dear ', token('Employee_Name'), ','),
        para(
          'This letter serves as a formal warning regarding conduct/performance that does not meet organizational standards.'
        ),
        mixedPara('Employee ID: ', token('Employee_ID')),
        mixedPara('Date: ', token('Effective_Date')),
        para('Please take corrective action immediately. Further instances may lead to disciplinary measures.'),
      ],
    },
  },
  {
    type: 'SEPARATION',
    name: 'Separation Letter',
    fieldTokens: ['Employee_Name', 'Employee_ID', 'Designation', 'Effective_Date'],
    contentJson: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Separation Letter' }] },
        mixedPara('Dear ', token('Employee_Name'), ','),
        para('This letter confirms the separation of your employment with the organization.'),
        mixedPara('Last Working Day: ', token('Effective_Date')),
        mixedPara('Designation: ', token('Designation')),
        para('We thank you for your service and wish you the best.'),
      ],
    },
  },
];

export function extractFieldTokens(contentJson: unknown): string[] {
  const text = JSON.stringify(contentJson ?? {});
  const matches = text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g);
  const set = new Set<string>();
  for (const m of matches) set.add(m[1]);
  return [...set];
}
