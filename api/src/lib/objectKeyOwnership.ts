/**
 * Shared object-key tenancy checks.
 * Upload shapes (from upload.service + getStorageForUser):
 *   org:  org-{organizationId}/uploads/...
 *   user: pdf-saas-uploads/user-{userId}/...
 * Letter spreadsheet keys reuse the same upload prefixes.
 */

export function isOwnedUploadKey(
  fileKey: string,
  userId: string,
  organizationId: string | null
): boolean {
  if (!fileKey || fileKey.includes('..') || fileKey.startsWith('/')) return false;
  if (organizationId && fileKey.startsWith(`org-${organizationId}/`)) return true;
  return fileKey.startsWith(`pdf-saas-uploads/user-${userId}/`);
}
