# Enterprise BYOC (Bring Your Own Cloud)

Storage-first BYOC: Enterprise customers keep **files** in their own bucket.
Auth, jobs, signing metadata, and billing stay on our MySQL.

## Who configures what

| App | Who | What |
|-----|-----|------|
| **vite-app** (`/settings/cloud`) | Enterprise **customer** (org owner) | Enter AWS/R2/Azure/GCS/MinIO credentials, Test (incl. CORS), Save |
| **Admin** | Platform operator | List orgs, BYOC health, suspend, license — **never** raw customer keys |

## Architecture: versioned storage bindings

Each Save creates an **immutable** row in `tbl_org_storage_binding`. Objects record
`storageBindingId` on `tbl_job`, `tbl_sign_document`, versions, and templates.
Switching providers does **not** orphan old files — reads resolve through the
binding that wrote them, not the org's current config.

`tbl_org_storage_config` holds the active pointer + health (`CONNECTED` / `ERROR` /
`UNCONFIGURED`), `corsVerifiedAt`, `consecutiveFailures`.

## Provision an Enterprise org

1. Customer registers in vite-app.
2. In Admin → Organizations → **Provision ENTERPRISE** (or `POST /api/admin/organizations`).
3. They open **Settings → Cloud storage**, connect a bucket, **Test**, apply CORS if prompted, **Save**.
4. New uploads go to `org-{orgId}/…` in **their** bucket under the active binding.

## Platform admin access

- Sign in via Admin app → `POST /api/admin/login` (JWT `aud=platform-admin`, shorter TTL).
- Role: `tbl_user.isPlatformAdmin = 1` **or** email in `PLATFORM_ADMIN_EMAILS`.
- Optional: `PLATFORM_ADMIN_IP_ALLOWLIST`.
- CORS: include Admin origin (`http://localhost:5175`) in `CORS_ORIGINS`.

## Secrets encryption + rotation

```bash
openssl rand -base64 32
```

Set `INFRA_CREDENTIALS_KEY` on **API and worker**. Ciphertext is prefixed `v1:`.

To rotate without downtime:

1. Generate a new key.
2. Move current → `INFRA_CREDENTIALS_KEY_PREVIOUS`.
3. Set new value as `INFRA_CREDENTIALS_KEY`.
4. Restart API + worker. Decrypt tries current then previous; reads lazily re-encrypt.

## CORS (required for browser uploads)

The browser PUTs directly to the customer's bucket. Without CORS, uploads fail.

**Test connection** returns `{ reachable, canWrite, corsOk, requiredCorsConfig }`.
Save is blocked until `corsOk` is true. The Settings UI shows a copy-paste config.

Example S3 / R2 / MinIO:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://pdf.zuvigo.com"],
      "AllowedMethods": ["GET", "PUT", "HEAD"],
      "AllowedHeaders": ["Content-Type", "Content-Length", "Authorization", "x-amz-*"],
      "ExposeHeaders": ["ETag", "Content-Length"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

Azure: set equivalent CORS rules on the **storage account** (see UI for JSON).

## IAM / permissions (customer)

Least privilege on a dedicated bucket (or prefix):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListBucket",
        "s3:GetBucketCors"
      ],
      "Resource": [
        "arn:aws:s3:::YOUR_BUCKET",
        "arn:aws:s3:::YOUR_BUCKET/*"
      ]
    }
  ]
}
```

No `s3:ListAllMyBuckets` / account-wide admin.

## Endpoint SSRF guard

Customer endpoints are validated before client construction:

- `https` required in production (unless `BYOC_ALLOW_INSECURE_ENDPOINTS=true` for MinIO)
- DNS resolution; reject private / link-local / CGNAT IPs
- R2 / GCS / AWS hostname shape checks

## Health monitoring

Worker maintenance job `byoc-health` (~15 min) probes active bindings, updates
`status` / `lastHealthyAt` / `lastError` / `consecutiveFailures`, and writes
`STORAGE_HEALTH_ERROR` audit on CONNECTED → ERROR.

Terminal auth errors flip ERROR immediately (API + worker); timeouts need 3
consecutive failures. A per-org circuit breaker fails fast for ~60s.

On CONNECTED → ERROR the worker publishes Redis `byoc:storage-health-alert`;
the API emails the org owner with a deep link to `/settings/cloud`.

Provider caches on API and worker invalidate via Redis pub/sub
(`byoc:storage-cache-invalidate`) so credential changes take effect immediately.

## Suspension policy

- **Writes / owner reads:** blocked when org is `SUSPENDED`.
- **Recipient signing links:** still served (`getStorageForOrg(..., 'recipient_read')`)
  so third parties are not stranded mid-ceremony.

## Provider switch / rotate credentials

Customer re-enters keys → Save creates a **new binding**. Old objects keep the
old binding. Disconnect BYOC (`PLATFORM`) retires the active binding; historical
objects remain readable via their stored `storageBindingId` until purged.

### Runbook: rotate INFRA_CREDENTIALS_KEY

1. `openssl rand -base64 32` → new key
2. API + worker: set `INFRA_CREDENTIALS_KEY_PREVIOUS` = current value
3. Set `INFRA_CREDENTIALS_KEY` = new key; rolling restart
4. Traffic decrypts with current then previous; reads lazily re-encrypt to `v1:`
5. After all bindings re-encrypted (or wait > max offline window), clear PREVIOUS

### Runbook: provider switch

1. Customer Tests + Saves new provider (CORS must pass)
2. New uploads use new `storageBindingId`
3. Old jobs/signing docs still resolve via prior binding — no bulk migration

### Integration tests

```bash
docker compose -f docker-compose.byoc-test.yml up -d
cd api && BYOC_INTEGRATION=1 npm test
```

## Related APIs

**Customer** (`/api/enterprise/*`): organization, storage get/put/test/delete, audit  
**Admin** (`/api/admin/*`): login, dashboard, organizations CRUD-ish, audit  

Admin responses never include `encryptedCredentials` — only `hasSecret`.
