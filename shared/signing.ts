/**
 * Types for the e-signature module.
 *
 * Signing documents are DURABLE: unlike `tbl_job` (which the cleanup sweep
 * deletes after JOB_TTL_MINUTES), a signing document and its S3 objects live
 * until the owner deletes them. Nothing here may be routed through tbl_job.
 */

/** Lifecycle of a signing document. */
export type SignDocumentStatus =
  | 'DRAFT' // being prepared by the owner; not yet sent
  | 'SENT' // out for signature, at least one recipient pending
  | 'COMPLETED' // every recipient finished
  | 'DECLINED' // a recipient refused
  | 'EXPIRED' // passed expiresAt before completion
  | 'VOIDED'; // owner cancelled it

/** Per-recipient progress. */
export type SignRecipientStatus =
  | 'PENDING' // not yet their turn (sequential) or not yet notified
  | 'SENT' // link delivered, awaiting open
  | 'VIEWED' // opened the document
  | 'COMPLETED' // submitted all their required fields
  | 'DECLINED';

/**
 * What a recipient is expected to do. Only SIGNER is assigned fields;
 * VIEWER/CC receive a read-only copy and are auto-completed on delivery.
 */
export type SignRecipientRole = 'SIGNER' | 'APPROVER' | 'VIEWER' | 'CC';

/** How recipients are ordered. */
export type SignFlowType =
  | 'SEQUENTIAL' // strictly one at a time, by signingOrder
  | 'PARALLEL'; // everyone at once

/** Extra identity check before a recipient may open the document. */
export type SignAuthMethod = 'NONE' | 'EMAIL_OTP' | 'SMS_OTP' | 'ACCESS_CODE';

/** Every placeable field kind. */
export type SignFieldType =
  | 'SIGNATURE'
  | 'INITIALS'
  | 'NAME'
  | 'EMAIL'
  | 'COMPANY'
  | 'DATE'
  | 'TEXT'
  | 'NUMBER'
  | 'CHECKBOX'
  | 'RADIO'
  | 'DROPDOWN'
  | 'ATTACHMENT'
  | 'STAMP'
  | 'IMAGE';

export const SIGN_FIELD_TYPES: SignFieldType[] = [
  'SIGNATURE',
  'INITIALS',
  'NAME',
  'EMAIL',
  'COMPANY',
  'DATE',
  'TEXT',
  'NUMBER',
  'CHECKBOX',
  'RADIO',
  'DROPDOWN',
  'ATTACHMENT',
  'STAMP',
  'IMAGE',
];

/**
 * Fields the recipient fills in by hand vs. ones we can prefill from the
 * recipient record. Auto-filled fields still render, but the signing UI does
 * not force the recipient to interact with them.
 */
export const AUTO_FILLED_FIELD_TYPES: SignFieldType[] = ['NAME', 'EMAIL', 'COMPANY', 'DATE'];

/** How a signature image was produced. */
export type SignatureSource = 'DRAWN' | 'TYPED' | 'UPLOADED' | 'SAVED';

/** Actions recorded in the immutable audit trail. */
export type SignAuditAction =
  | 'DOCUMENT_CREATED'
  | 'DOCUMENT_UPDATED'
  | 'DOCUMENT_DELETED'
  | 'RECIPIENT_ADDED'
  | 'RECIPIENT_UPDATED'
  | 'RECIPIENT_REMOVED'
  | 'FIELDS_UPDATED'
  | 'DOCUMENT_SENT'
  | 'EMAIL_SENT'
  | 'EMAIL_BOUNCED'
  | 'REMINDER_SENT'
  | 'DOCUMENT_OPENED'
  | 'AUTH_CHALLENGED'
  | 'AUTH_FAILED'
  | 'AUTH_PASSED'
  | 'FIELD_FILLED'
  | 'SIGNATURE_ADDED'
  | 'RECIPIENT_COMPLETED'
  | 'RECIPIENT_DECLINED'
  | 'DOCUMENT_COMPLETED'
  | 'DOCUMENT_VOIDED'
  | 'DOCUMENT_EXPIRED'
  | 'DOCUMENT_DOWNLOADED';

/**
 * Field geometry is stored as page-relative fractions (0..1) of the page's
 * unrotated MediaBox, NOT as pixels. A viewer at any zoom multiplies by its
 * rendered page size; pdf-lib multiplies by the PDF's point size at
 * finalization. This is what keeps designer placement and the flattened
 * output pixel-identical at any scale.
 */
export interface SignFieldGeometry {
  page: number; // 1-indexed
  x: number; // 0..1 from left edge
  y: number; // 0..1 from TOP edge (screen coords; pdf-lib flips this)
  width: number; // 0..1 of page width
  height: number; // 0..1 of page height
}

/** Per-field appearance + behaviour. Persisted as a JSON column. */
export interface SignFieldConfig {
  placeholder?: string;
  defaultValue?: string;
  /** DROPDOWN / RADIO choices. */
  options?: string[];
  /** Zod-ish validation hints applied in the signing UI and re-checked server-side. */
  validation?: {
    minLength?: number;
    maxLength?: number;
    min?: number;
    max?: number;
    /** Named preset (email/phone/zip) or a raw regex source. */
    pattern?: string;
  };
  font?: {
    family?: string;
    size?: number;
    weight?: 'normal' | 'bold';
    style?: 'normal' | 'italic';
    color?: string; // #rrggbb
    align?: 'left' | 'center' | 'right';
  };
  border?: {
    width?: number;
    color?: string; // #rrggbb
    style?: 'solid' | 'dashed' | 'none';
    radius?: number;
  };
  backgroundColor?: string; // #rrggbb or 'transparent'
  /** DATE fields: how to format the stamped value. */
  dateFormat?: string;
}

export interface SignFieldDTO extends SignFieldGeometry {
  id: string;
  documentId: string;
  recipientId: string | null;
  type: SignFieldType;
  label: string;
  required: boolean;
  locked: boolean;
  config: SignFieldConfig;
  value: string | null;
  filledAt: string | null;
}

export interface SignRecipientDTO {
  id: string;
  documentId: string;
  name: string;
  email: string;
  phone: string | null; // E.164, required for SMS_OTP / WhatsApp delivery
  role: SignRecipientRole;
  color: string; // #rrggbb — drives field tinting in the designer
  signingOrder: number;
  authMethod: SignAuthMethod;
  status: SignRecipientStatus;
  otpVerifiedAt: string | null;
  /** Captured at the moment of signing; mirrors the audit trail for the certificate. */
  ipAddress: string | null;
  deviceInfo: string | null;
  viewedAt: string | null;
  completedAt: string | null;
  declineReason: string | null;
  // signingToken / accessCodeHash / otpHash are never serialised — see toRecipientDTO.
}

export interface SignDocumentDTO {
  id: string;
  ownerId: string;
  title: string;
  message: string | null;
  status: SignDocumentStatus;
  flowType: SignFlowType;
  fileKey: string; // S3 key of the ORIGINAL upload — never overwritten
  fileName: string;
  fileSize: number;
  pageCount: number;
  currentVersion: number;
  /** SHA-256 of the original upload, taken before any modification. */
  originalHash: string | null;
  expiresAt: string | null;
  sentAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  recipients?: SignRecipientDTO[];
  fields?: SignFieldDTO[];
}

/**
 * Recipient palette. Assigned round-robin as recipients are added so each one
 * gets a visually distinct field colour. Chosen to stay legible against both
 * the light and dark viewer backgrounds.
 */
export const RECIPIENT_COLORS = [
  '#2563eb', // blue
  '#db2777', // pink
  '#16a34a', // green
  '#ea580c', // orange
  '#7c3aed', // violet
  '#0891b2', // cyan
  '#ca8a04', // amber
  '#dc2626', // red
] as const;

/** Sensible starting size (as a fraction of the page) for each field type. */
export const DEFAULT_FIELD_SIZE: Record<SignFieldType, { width: number; height: number }> = {
  SIGNATURE: { width: 0.22, height: 0.05 },
  INITIALS: { width: 0.08, height: 0.05 },
  NAME: { width: 0.22, height: 0.03 },
  EMAIL: { width: 0.22, height: 0.03 },
  COMPANY: { width: 0.22, height: 0.03 },
  DATE: { width: 0.14, height: 0.03 },
  TEXT: { width: 0.22, height: 0.03 },
  NUMBER: { width: 0.1, height: 0.03 },
  CHECKBOX: { width: 0.025, height: 0.018 },
  RADIO: { width: 0.025, height: 0.018 },
  DROPDOWN: { width: 0.18, height: 0.03 },
  ATTACHMENT: { width: 0.18, height: 0.04 },
  STAMP: { width: 0.14, height: 0.07 },
  IMAGE: { width: 0.18, height: 0.09 },
};

/** Limits guarding the signing module (independent of PLAN_LIMITS ops/day). */
export const SIGNING_LIMITS = {
  maxRecipientsPerDocument: 50,
  maxFieldsPerDocument: 500,
  maxTitleLength: 200,
  maxMessageLength: 2000,
  /** Signing documents are larger and longer-lived than tool inputs. */
  maxFileSize: 50 * 1024 * 1024,
  /** Default validity of a signing invitation, in days. */
  defaultExpiryDays: 30,
} as const;
