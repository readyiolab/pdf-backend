import { AsyncLocalStorage } from 'async_hooks';

export interface JobStorageContext {
  organizationId: string | null;
  storageBindingId: string | null;
}

export const jobStorageContext = new AsyncLocalStorage<JobStorageContext>();

export function getJobOrganizationId(): string | null {
  return jobStorageContext.getStore()?.organizationId ?? null;
}

export function getJobStorageBindingId(): string | null {
  return jobStorageContext.getStore()?.storageBindingId ?? null;
}
