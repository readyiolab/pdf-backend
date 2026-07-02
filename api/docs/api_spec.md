# PDF Tools SaaS — API Specification

This documentation details the API endpoints available in the PDF Tools SaaS backend. For database structures and schema layout details, refer to the [dev_guide.md](file:///d:/Arun%20sir%20Projects/PDFPRODUCT/backend/docs/dev_guide.md) file.

## Database & Table Prefixes
All tables in the MySQL database are prefixed with `tbl_` (e.g., `tbl_user`, `tbl_job`, and `tbl_subscription`). These tables are automatically created on API startup.

## Base URL
* Local API Service: `http://localhost:5000`
* All endpoints (except the root `/health`) are prefixed with `/api`.

---

## 1. Health Checks

### Root Health Check
`GET /health`
* **Description**: Checks Postgres database and Redis connectivity.
* **Authentication**: None.
* **Response (200 OK)**:
  ```json
  {
    "status": "UP",
    "services": {
      "database": "UP",
      "redis": "UP"
    },
    "timestamp": "2026-06-30T10:45:00.000Z"
  }
  ```

---

## 2. Authentication

### Register User
`POST /api/auth/register`
* **Request Body**:
  ```json
  {
    "email": "user@example.com",
    "password": "securepassword123",
    "name": "Arun Kumar"
  }
  ```
* **Response (201 Created)**:
  ```json
  {
    "token": "eyJhbGciOiJIUzI1NiIsIn...",
    "user": {
      "id": "cuid_user_id",
      "email": "user@example.com",
      "name": "Arun Kumar",
      "plan": "FREE"
    }
  }
  ```

### Login User
`POST /api/auth/login`
* **Request Body**:
  ```json
  {
    "email": "user@example.com",
    "password": "securepassword123"
  }
  ```
* **Response (200 OK)**:
  ```json
  {
    "token": "eyJhbGciOiJIUzI1NiIsIn...",
    "user": {
      "id": "cuid_user_id",
      "email": "user@example.com",
      "name": "Arun Kumar",
      "plan": "FREE"
    }
  }
  ```

---

## 3. Users Module

### Get My Profile
`GET /api/users/me`
* **Authentication**: Required (`Bearer <token>`).
* **Response (200 OK)**:
  ```json
  {
    "user": {
      "id": "cuid_user_id",
      "email": "user@example.com",
      "name": "Arun Kumar",
      "plan": "FREE",
      "dailyOpsUsed": 0,
      "dailyOpsLimit": 5,
      "dailyOpsRemaining": 5,
      "dailyOpsResetAt": "2026-06-30T10:45:00.000Z",
      "createdAt": "2026-06-30T10:45:00.000Z",
      "jobs": []
    }
  }
  ```

---

## 4. File Upload Module

### Request Pre-signed S3 URL
`POST /api/upload/presign`
* **Authentication**: Required (`Bearer <token>`).
* **Description**: Verifies plan file size limit and generates S3 upload URL. The client must upload the file binary directly to the returned `uploadUrl` via PUT.
* **Request Body**:
  ```json
  {
    "fileName": "report.pdf",
    "contentType": "application/pdf",
    "fileSize": 5242880
  }
  ```
* **Response (200 OK)**:
  ```json
  {
    "uploadUrl": "https://igrowbig.blr1.digitaloceanspaces.com/pdf-saas-uploads/user-user_id/uuid_report.pdf?AWSAccessKeyId=...",
    "fileKey": "pdf-saas-uploads/user-user_id/uuid_report.pdf"
  }
  ```

---

## 5. Jobs Module

### Create Processing Job
`POST /api/jobs`
* **Authentication**: Required (`Bearer <token>`).
* **Description**: Validates user's daily operations count, creates Job record in Postgres, and queues task to BullMQ.
* **Request Body**:
  ```json
  {
    "tool": "merge",
    "inputFiles": [
      "pdf-saas-uploads/user-user_id/uuid_part1.pdf",
      "pdf-saas-uploads/user-user_id/uuid_part2.pdf"
    ],
    "options": {
      "order": [0, 1]
    }
  }
  ```
* **Supported Tools & Payload Options**:
  * `merge`: `options: { "order": [0, 1] }`
  * `split`: `options: { "ranges": ["1-3", "5"] }`
  * `compress`: `options: { "quality": "low" | "medium" | "high" }`
  * `jpgToPdf`: `options: {}`
  * `pdfToJpg`: `options: { "dpi": 150 }`
  * `rotate`: `options: { "angle": 90 | 180 | 270, "pages": [1] }`
  * `watermark`: `options: { "text": "CONFIDENTIAL", "fontSize": 36, "opacity": 0.3, "position": "center" }`
  * `protect`: `options: { "userPassword": "123", "ownerPassword": "456", "permissions": { "print": false } }`
  * `officeConvert`: `options: { "direction": "to-pdf" }`
  * `ocr`: `options: { "languages": ["eng"] }`
* **Response (201 Created)**:
  ```json
  {
    "job": {
      "id": "cuid_job_id",
      "userId": "cuid_user_id",
      "tool": "merge",
      "status": "QUEUED",
      "inputFiles": "[\"pdf-saas-uploads/user-user_id/uuid_part1.pdf\",\"pdf-saas-uploads/user-user_id/uuid_part2.pdf\"]",
      "outputFile": null,
      "errorMessage": null,
      "createdAt": "2026-06-30T10:45:00.000Z",
      "completedAt": null,
      "expiresAt": "2026-06-30T11:45:00.000Z"
    }
  }
  ```

### Get Job Status (Polling)
`GET /api/jobs/:jobId`
* **Authentication**: Required (`Bearer <token>`).
* **Description**: Client polls this endpoint. When status changes from `QUEUED`/`PROCESSING` to `COMPLETED`, `outputFile` contains the result key to download.
* **Response (200 OK)**:
  ```json
  {
    "job": {
      "id": "cuid_job_id",
      "userId": "cuid_user_id",
      "tool": "merge",
      "status": "COMPLETED",
      "inputFiles": [
        "pdf-saas-uploads/user-user_id/uuid_part1.pdf",
        "pdf-saas-uploads/user-user_id/uuid_part2.pdf"
      ],
      "outputFile": "pdf-saas-results/job-cuid_job_id/merged_1719744300000.pdf",
      "errorMessage": null,
      "createdAt": "2026-06-30T10:45:00.000Z",
      "completedAt": "2026-06-30T10:45:05.000Z",
      "expiresAt": "2026-06-30T11:45:00.000Z"
    }
  }
  ```

---

## 6. Billing (Razorpay)

### Initiate Subscription Checkout
`POST /api/billing/checkout`
* **Authentication**: Required (`Bearer <token>`).
* **Request Body**:
  ```json
  {
    "planId": "plan_N1234abc"
  }
  ```
* **Response (200 OK)**:
  ```json
  {
    "subscriptionId": "sub_N9876xyz",
    "status": "created",
    "razorpayKey": "rzp_test_key_id"
  }
  ```

### Check Subscription Status
`GET /api/billing/status`
* **Authentication**: Required (`Bearer <token>`).
* **Response (200 OK)**:
  ```json
  {
    "subscriptionId": "sub_N9876xyz",
    "status": "active"
  }
  ```

---

## 7. Webhooks (Razorpay)

### Razorpay Webhook Event Listener
`POST /api/webhooks/razorpay`
* **Authentication**: Webhook Signature (`x-razorpay-signature` header).
* **Description**: Verifies signature against computed HMAC SHA-256 and updates user plans locally.
* **Response (200 OK)**:
  ```json
  {
    "success": true
  }
  ```
