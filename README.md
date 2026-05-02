# MeterFlow API — Backend

**Usage-Based API Billing & Metering Platform**  
Production-grade Node.js/Express/TypeScript backend — 52 source files, zero TypeScript errors.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20, TypeScript 5.4 |
| Framework | Express 4 |
| Database | MongoDB 7 (Mongoose 8) |
| Cache / Queue | Redis (ioredis) + BullMQ |
| Real-time | Socket.io |
| Auth | JWT (access 15m + refresh 7d, rotation) |
| Workers | 5 BullMQ workers (usage, webhook, alert, abuse, email) |
| Scheduling | node-cron (alerts every 5min, invoices monthly) |
| PDF | PDFKit |
| Proxy | axios + opossum circuit breaker |

---

## Quick Start

### 1. Clone & install
```bash
git clone <repo>
cd meterflow
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Fill in MONGO_URI, REDIS_URL, JWT secrets, ENCRYPTION_KEY
```

### 3. Run locally (Docker Compose)
```bash
docker compose up          # starts api + mongo + redis + nginx
```

### 4. Run locally (native)
```bash
# Requires local MongoDB + Redis
npm run dev
```

---

## Project Structure

```
src/
├── config/            # env validation, mongo, redis connections
├── middleware/        # authenticate, RBAC, error handler, logger
├── modules/
│   ├── auth/          # signup, login, JWT, email verify, password reset
│   ├── users/         # User model
│   ├── workspaces/    # Workspace model + member management
│   ├── apis/          # Registered API CRUD + service
│   ├── keys/          # API key generate/revoke/rotate/expire
│   ├── gateway/       # Full proxy pipeline (7 middleware stages)
│   │   └── middleware/  resolveKey → checkExpiry → resolveApi →
│   │                    checkQuota → rateLimit → cacheCheck → proxyForward
│   ├── billing/       # Credit wallet, top-up, invoice PDF generation
│   ├── analytics/     # MongoDB aggregation pipelines, timeseries, geo
│   ├── alerts/        # Smart alert rules (8 types)
│   ├── audit/         # Append-only audit log
│   ├── webhooks/      # HMAC-signed webhook delivery
│   ├── team/          # Workspace member invites + RBAC
│   └── admin/         # Super-admin console + health check
├── workers/           # BullMQ workers (usage, webhook, alert, abuse, email)
├── queues/            # Queue registry + cron scheduler
├── realtime/          # Socket.io workspace rooms + Redis pub/sub bridge
└── utils/             # crypto, JWT helpers, pagination, response helpers
```

---

## API Reference

### Auth
```
POST   /auth/signup               { email, password, name, workspaceName? }
POST   /auth/login                { email, password }
POST   /auth/refresh              cookie: refreshToken
POST   /auth/logout               Bearer token required
GET    /auth/verify-email/:token
POST   /auth/forgot-password      { email }
POST   /auth/reset-password       { token, newPassword }
GET    /auth/me                   Bearer token required
```

### APIs
```
POST   /apis                      Create registered API
GET    /apis                      List APIs (paginated)
GET    /apis/:id                  Get API detail
PUT    /apis/:id                  Update API
DELETE /apis/:id                  Archive API
```

### Keys
```
POST   /keys                      Generate key  → returns rawKey ONCE
GET    /keys                      List keys (?apiId=, ?status=, ?environment=)
GET    /keys/:id                  Key detail
GET    /keys/:id/usage            Quota + usage stats
POST   /keys/:id/revoke           Revoke immediately
POST   /keys/:id/rotate           Rotate (new key issued, old revoked)
PUT    /keys/:id/expire           Set expiry date
```

### Gateway
```
ANY    /gateway/:alias/*          Full proxy pipeline
GET    /gateway/_health           No auth required
```

### Analytics
```
GET    /analytics/overview        Dashboard stats + credit forecast
GET    /analytics/timeseries      ?interval=hour|day&days=7&apiId=
GET    /analytics/endpoints       Top endpoints by volume
GET    /analytics/consumers       Top API keys by usage
GET    /analytics/geo             Geographic breakdown
GET    /analytics/heatmap         Hour×weekday request heatmap
```

### Billing
```
GET    /billing/wallet            Balance + predictive exhaustion
POST   /billing/topup             { credits: number }
GET    /billing/invoices          List invoices (paginated)
GET    /billing/invoices/:id      Invoice detail
GET    /billing/invoices/:id/pdf  Download PDF
```

### Alerts
```
POST   /alerts                    Create alert rule
GET    /alerts                    List rules
PUT    /alerts/:id                Update rule
DELETE /alerts/:id                Delete rule
GET    /alerts/history            Recent triggers
```

### Team
```
GET    /team                      List members
POST   /team/invite               { email, role }
PUT    /team/:userId/role         { role }
DELETE /team/:userId              Remove member
```

### Webhooks
```
POST   /webhooks                  Register endpoint
GET    /webhooks                  List webhooks
DELETE /webhooks/:id              Remove webhook
POST   /webhooks/:id/rotate-secret  Rotate signing secret
```

### Audit
```
GET    /audit                     Audit log (?action=, ?from=, ?to=)
```

### Admin (super_admin only)
```
GET    /admin/stats               Platform-wide metrics
GET    /admin/tenants             All workspaces
GET    /admin/tenants/:id         Tenant detail + usage
POST   /admin/tenants/:id/suspend
POST   /admin/tenants/:id/reactivate
GET    /admin/audit               Platform audit log
GET    /admin/health              Redis + Mongo + memory health
```

---

## Gateway Pipeline

```
Request
  ↓ resolveKey       — hash key, Redis cache lookup, Mongo fallback
  ↓ checkExpiry      — validate not revoked/expired
  ↓ resolveApi       — match alias → registered API, verify workspace
  ↓ checkQuota       — atomic Redis INCR, monthly quota enforcement
  ↓ rateLimit        — sliding window per-key per-minute
  ↓ cacheCheck       — GET-only Redis response cache (X-Cache: HIT/MISS)
  ↓ proxyForward     — circuit-breaker wrapped axios, deduct credits,
                       queue usage log + abuse score (non-blocking)
  ↓ Response
```

---

## Security

- **API keys**: `mf_live_` + 32-byte CSPRNG hex, SHA-256 hash stored only
- **Upstream credentials**: AES-256-GCM encrypted at rest
- **JWT**: RS256 access (15m) + refresh rotation (7d in Redis)
- **Token blacklist**: revoked JTIs stored in Redis until expiry
- **Webhooks**: HMAC-SHA256 signed, `X-MeterFlow-Signature` header
- **Rate limiting on auth routes**: 10 req/min per IP
- **Abuse detection**: brute-force, velocity, bot-timing scoring → auto-suspend
- **Audit log**: append-only, no update/delete endpoints

---

## Workers

| Worker | Queue | Concurrency |
|---|---|---|
| usageLogger | `usage-log` | 20 |
| webhookFirer | `webhooks` | 10 |
| alertEngine | `alerts` | 5 |
| abuseDetector | `abuse` | 10 |
| emailWorker | `email` | 5 |

---

## Deployment (Free Tier)

| Service | Provider | Notes |
|---|---|---|
| Backend API | Render Web Service | Docker image from GHCR |
| Database | MongoDB Atlas M0 | 512MB free |
| Redis | Upstash | 10K cmd/day free |
| CI/CD | GitHub Actions | lint → build → deploy |

---

## Environment Variables

See `.env.example` for all required variables. Validated at startup with Zod — server refuses to start with missing secrets.

---

## Scripts

```bash
npm run dev      # tsx watch (hot reload)
npm run build    # tsc → dist/
npm run start    # node dist/index.js
npm run lint     # tsc --noEmit
```
