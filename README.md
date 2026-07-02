# PDF Tools SaaS Backend

A production-grade, scalable PDF tools SaaS API and Worker architecture built with Node.js, Express, TypeScript, MySQL (raw connection pool), Redis, and BullMQ.

## Folder Structure

- `api/` — Express API service handling auth, jobs orchestration, billing, and upload presigning.
- `worker/` — Standalone worker queue listener that handles heavy and light PDF processing tasks.
- `shared/` — Shared TypeScript type definitions and limit constraints used by both services.

## Setup Instructions

### 1. Prerequisites
- Node.js (v18+ recommended)
- Docker & Docker Compose (for Redis)
- Local MySQL instance

### 2. Copy Environment Files
Create `.env` files in both the `api/` and `worker/` folders, as well as the root folder:
```bash
# Copy root env template
cp .env.example .env
```
Ensure that `DB_HOST`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` are properly configured in all `.env` files.

*Note:* Update the database credentials, Redis url, and S3 credentials in the respective `.env` files.

### 3. Setup Local MySQL and Start Redis
1. Ensure your local MySQL server is running (with host, user, and password configured in your `.env` files).
2. Create the target database in MySQL:
   ```sql
   CREATE DATABASE pdf_saas;
   ```
3. Run the following command in the root directory to spin up Redis (for BullMQ queues):
   ```bash
   docker compose up -d
   ```

### 4. Install Dependencies
Since npm workspaces are configured, running this command at the root will install dependencies for all modules:
```bash
npm install
```

### 5. Start the Services in Development Mode
Run the following command at the root to start both the API and worker services simultaneously:
```bash
npm run dev
```

- API will run on http://localhost:5000 (Health check: http://localhost:5000/health)
- Worker health check will run on http://localhost:5001 (Health check: http://localhost:5001/health)

*Note: Database tables (User, Job, Subscription) are automatically verified and created on startup.*
