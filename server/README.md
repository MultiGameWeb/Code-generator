# Get Your Code Now — Backend & Gemini API

This directory contains the independent Node.js and Express backend powered by the official Google Gemini SDK (`@google/genai`) for the **Get Your Code Now** project, fortified with production-grade security hardening, abuse control, and privacy-safe aggregate metrics.

## Getting Started

### 1. Install Dependencies

Navigate into the server folder and install dependencies.

Run: `cd server`

Then: `npm install`

### 2. Configure Environment Variables

Copy `.env.example` to `.env`.

Run: `cp .env.example .env`

Configure these environment variables in `.env`:

`PORT=3000`

`FRONTEND_ORIGIN=http://localhost:3000,https://multigameweb.github.io`

`GEMINI_API_KEY=YOUR_GEMINI_API_KEY`

`METRICS_ADMIN_TOKEN=YOUR_SECURE_METRICS_TOKEN`

> **Important Security Note:** Never commit a real `GEMINI_API_KEY` or `METRICS_ADMIN_TOKEN` to version control. Real secrets belong in Render Environment Variables or your local, git-ignored `.env` file.

### 3. Start Development Server

Run: `npm run dev`

---

## Architecture & Security Features

### Step 4A — Security Hardening & Validation

- **Security Headers (`helmet`):** Secures HTTP response headers.
- **IP-Based Rate Limiting (`express-rate-limit`):** `POST /api/generate` is limited to **20 requests per 15 minutes per IP address**.
- **RateLimit Headers:** Standard RateLimit headers are enabled and legacy X-RateLimit headers are disabled.
- **Strict Language Validation:** Supported languages are Python, JavaScript, TypeScript, HTML, CSS, Java, C, C++, C#, PHP, and SQL.
- **No User Data Storage:** No user profiles, accounts, or prompt histories are stored.

### Step 4B — Request Protection & Abuse Control

- **32kb JSON Body Limit:** Oversized requests are rejected with HTTP 413.
- **Malformed JSON Protection:** Invalid JSON returns HTTP 400.
- **Content-Type Validation:** `/api/generate` requires `application/json` and returns HTTP 415 otherwise.
- **Strict Request Shape Protection:** Only `prompt` and `language` are accepted.
- **45-Second Request Timeout:** Gemini generation uses `AbortController` with the SDK `config.abortSignal` option.
- **Timeout Response:** A timeout returns HTTP 504.
- Client-side abort does not guarantee immediate remote Gemini service cancellation or billing avoidance.

### Step 4C — Privacy-Safe Usage Monitoring & Operational Metrics

- **Aggregate In-Memory Counters Only:** Tracks total requests, successful generations, validation failures, rate-limit rejections, timeouts, upstream errors, and language counts.
- **Zero Prompt Storage:** Prompts are processed transiently and are not stored or persisted.
- **Transient IP Handling:** IP information may be used temporarily by rate-limiting middleware for enforcement, but is not stored in application metrics, databases, files, or persistent storage.
- **Private Admin Metrics:** `GET /api/admin/metrics` requires an `Authorization: Bearer <METRICS_ADMIN_TOKEN>` header.
- **Timing-Safe Token Comparison:** Admin token verification uses `crypto.timingSafeEqual`.
- **Ephemeral Metrics:** Metrics exist only in server memory and reset after a server restart.
- **No Database or External Metrics Storage:** No Redis, Firebase, MongoDB, PostgreSQL, or external analytics service is used.
- **No Frontend Metrics Dashboard:** Metrics remain backend-only.

---

## API Endpoints

### 1. Health Check

**URL:** `/api/health`

**Method:** `GET`

Public availability check.

Example response:

`{"success":true,"service":"Get Your Code Now API"}`

### 2. Generate Code with Gemini

**URL:** `/api/generate`

**Method:** `POST`

The endpoint validates the request, applies rate limiting and security checks, and securely calls gemini-2.5-flash. 

Example request:

`{"prompt":"Create a Python calculator with addition and subtraction","language":"Python"}`

Successful response includes:

- `success`
- `language`
- `code`
- `filename`

### 3. Private Admin Metrics

**URL:** `/api/admin/metrics`

**Method:** `GET`

**Header:** `Authorization: Bearer <METRICS_ADMIN_TOKEN>`

Returns private aggregate in-memory metrics.

Example metrics include:

- `uptimeSeconds`
- `totalGenerationRequests`
- `successfulGenerations`
- `validationFailures`
- `rateLimitedRequests`
- `timeoutRequests`
- `upstreamGenerationErrors`
- `generationsByLanguage`

Unauthorized requests return HTTP 401:

`{"success":false,"error":"Unauthorized."}`
