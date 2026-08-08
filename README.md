# Ecom Refund Copilot (MCP)

## Why this exists

In online commerce, refund decisions often depend on engineering: ops needs order, payment, shipment, and risk data that only shows up in dashboards, logs, or ad-hoc queries. That slows the team down and keeps refund judgment tightly coupled to enggineers.

This MCP server flips that. Operations (or an AI agent acting for them) can **look up the same context themselves**, run a **policy eligibility check**, and either **auto-issue a safe refund** or **escalate to a manager** — without waiting on eng for every case. The policy layer is the guardrail: amount caps, balance checks, age, risk, carrier exceptions, duplicates, and dispute flags stop bad refunds from moving money even when a caller asks for them.

All domain data is **synthetic** and stored in **Postgres** (Prisma ORM). No real payments or payment-processor credentials. Write tools require a shared secret token.

## Layout

```
index.ts              # Express + Streamable HTTP
prisma/
  schema.prisma       # Postgres models + refund idempotency unique
  migrations/         # Prisma migrations
scripts/
  seed.ts             # Load synthetic catalog into Postgres
src/
  create-server.ts    # Tool registration
  tool-schemas.ts     # Shared Zod input schemas
  types.ts            # Domain types + policy constants
  seed.ts             # Synthetic catalog (source of truth)
  store.ts            # Prisma-backed async store
  policy.ts           # Eligibility + issue/resolve
  auth.ts             # Write-token guardrail
  db.ts               # Prisma client singleton
  policy.test.ts      # Unit tests
docker-compose.yml    # Local Postgres
.env.example          # DATABASE_URL + WRITE_TOKEN
```

## Setup

```bash
# 1. Install deps
bun install   # or: npm install

# 2. Start Postgres (Docker)
docker compose up -d

# 3. Env
cp .env.example .env
# WRITE_TOKEN is already a sample secret in .env after first setup;
# generate your own: openssl rand -hex 24

# 4. Migrate + seed
bun run db:migrate
bun run db:seed

# 5. Run server
bun run start
# → http://localhost:3000/mcp
# → http://localhost:3000/health
```

| Env | Purpose |
|-----|---------|
| `DATABASE_URL` | Postgres connection (default matches `docker-compose.yml`) |
| `WRITE_TOKEN` | Secret required by write tools |
| `PORT` | HTTP port (default `3000`) |
| `HOST` | Bind host (default `0.0.0.0`) |

Scripts: `db:generate`, `db:migrate`, `db:seed`, `db:reset`, `test`, `start`.

## Testing

### 1. Unit tests (`bun test`)

Requires Postgres up and migrations applied (`DATABASE_URL` from `.env`). Each test resets the seed catalog.

```bash
docker compose up -d
bun run db:migrate
bun test
```

Source: `src/policy.test.ts` — eligibility, issue/resolve paths, store status flips, idempotency, write-token checks, `reset` seed restore.

### 2. MCP client (manual / interactive)

1. Start the server (`bun run start`).
2. Connect an MCP client to Streamable HTTP at `https://ecom-mcp.onrender.com/mcp`.
3. Confirm tools appear.
4. Use prompts from **[TEST_QUESTIONS.md](./TEST_QUESTIONS.md)**.

Suggested flow:

1. **`list_orders`** or **`list_seed_scenarios`** to discover order IDs.
2. **`lookup_*`** / **`check_refund_eligibility`** (public, no writeKey).
3. **`issue_refund`** with `writeKey` + args — expect `auto_executed` or `escalated`.
4. If escalated: **`resolve_escalation`** with `writeKey` (`reject`, or `approve` only when full re-check can pass).
5. Between runs: **`reset_seed_data`** with `writeKey` reloads the seed catalog.

#### Different order cases

| # | Order | `amount` | `action` | Expected |
|---|-------|----------|----------|----------|
| 1 | `ord_auto_ok` | 89 | `full_refund_damaged` | `auto_executed` |
| 2 | `ord_over_cap` | 249 | `full_refund_lost` | `escalated` (`amount_cap`) |
| 3 | `ord_too_old` | 45 | `full_refund_never_delivered` | `escalated` (`order_age`) |
| 4 | `ord_high_risk` | 39.98 | `full_refund_wrong_item` | `escalated` (`customer_risk`) |
| 5 | `ord_no_exception` | 64 | `full_refund_damaged` | `escalated` (`carrier_exception`) |
| 6 | `ord_already_refunded` | 79 | `full_refund_damaged` | `escalated` (`no_duplicate_refund`) |
| 7 | `ord_chargeback` | 120 | `full_refund_damaged` | `escalated` (`no_chargeback_or_dispute`) |
| 8 | `ord_partial_ok` | 50 | `full_refund_damaged` | `auto_executed` |

**Escalation round-trip**

1. `issue_refund` on `ord_over_cap` (amount `249`, with `writeKey`) → note `escalation.id`.
2. `get_escalation` → `failedChecks` includes `amount_cap`.
3. `resolve_escalation` `approve` → **blocked** (re-check still fails); stays **pending**; no money moved.
4. `resolve_escalation` `reject` on another pending case → closed; no money moved.

## Tools

| Tool | Type | Auth | Purpose |
|------|------|------|---------|
| `reset_seed_data` | write | `writeKey` | Reload synthetic seed catalog |
| `list_orders` | read | public | All orders + linked customer |
| `list_seed_scenarios` | read | public | Seed order IDs + expected outcomes |
| `lookup_order` | read | public | Order + customer |
| `lookup_payment` | read | public | Payment, balance, dispute flags |
| `lookup_shipment` | read | public | Shipment + carrier exception |
| `lookup_customer` | read | public | Customer risk score |
| `list_refunds` | read | public | Refunds for an order |
| `check_refund_eligibility` | read | public | Policy report (no side effects) |
| `issue_refund` | write | `writeKey` | Auto-execute **or** escalate |
| `list_escalations` | read | public | Escalations |
| `get_escalation` | read | public | Escalation detail |
| `resolve_escalation` | write | `writeKey` | Manager reject, or approve with **full re-check** |

### Auto-refund policy

All of the following must hold:

1. Amount ≤ **$150**
2. Amount ≤ remaining paid balance (paid − already refunded)
3. Order age ≤ **30 days**
4. Customer risk **&lt; 70**
5. **Verified carrier exception** on the shipment
6. No completed refund for the same **`paymentId` + `amount`** (idempotency key)
7. Payment captured, **no chargeback/dispute flags**

Otherwise `issue_refund` escalates and **moves no money**.

### Idempotency

Completed refunds are unique on **`(paymentId, amount)`** (DB constraint + policy check). A retry of the same payment and amount does not double-pay; `recordCompletedRefund` returns the existing refund row.

### Write guardrails

`reset_seed_data`, `issue_refund`, and `resolve_escalation` require a `writeKey` argument matching `WRITE_TOKEN`. Read tools stay public.

### Manager resolution (`resolve_escalation`)

- **`reject`** — close the escalation; no money moved.
- **`approve`** — re-run the **full** auto-refund policy at execution time. Money moves **only** if every check passes now.
- An escalation is **not** authorization to bypass a failed check.

## Assumptions / scope notes

- USD amounts, two-decimal rounding.
- Idempotency key is **`paymentId` + refund amount** (not `action`).
- `action` remains a stable audit/escalation label supplied by the caller.
- `riskScore` is static seed data (stand-in for an external risk provider).
- Manager approve never overrides policy.
- Domain state is durable in Postgres and shared across process restarts; use `reset_seed_data` (or `bun run db:seed`) to restore the catalog.
- Stateless Streamable HTTP per request; domain state lives in Postgres.
