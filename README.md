# Ecom Refund Copilot (MCP)

Synthetic **refund investigation and approval** MCP server. Agents look up order / payment / shipment context, evaluate auto-refund eligibility, and either auto-execute a refund or open a manager escalation.

All data is local and synthetic. No real payments, credentials, frontend, or auth.

## Transport

**Streamable HTTP** over Express. MCP endpoint: `/mcp`.

```bash
bun install
bun run start
# → http://localhost:3000/mcp
# → http://localhost:3000/health
```

Optional: `PORT` (default `3000`), `HOST` (default `0.0.0.0`).

## Testing

Two supported ways to verify behavior. Prefer unit tests for policy coverage; use an MCP client for end-to-end tool walks.

### 1. Unit tests (`bun test`)

Runs policy eligibility, `issue_refund` auto/escalate/reject paths, store status flips, boundary cases, and manager resolve guards.

```bash
bun test
```

Source: `src/policy.test.ts`.

### 2. MCP client (manual / interactive)

1. Start the server:

   ```bash
   bun run start
   ```

2. Connect an MCP client to the Streamable HTTP endpoint:

   | Client | How |
   |--------|-----|
   | **MCP Inspector** | `npx @modelcontextprotocol/inspector` → transport **Streamable HTTP** → URL `http://localhost:3000/mcp` |
   | **Claude Desktop / Cursor / VS Code** | Add a remote MCP server pointing at `http://localhost:3000/mcp` (exact config keys vary by client) |

3. Confirm tools appear (`list_seed_scenarios`, `lookup_*`, `check_refund_eligibility`, `issue_refund`, etc.).

4. Ask natural-language prompts from **[TEST_QUESTIONS.md](./TEST_QUESTIONS.md)** (questions + expected results for AI-client review). Suggested flow:

   1. Call **`list_seed_scenarios`** to see order IDs and expected outcomes.
   2. For a case, **`lookup_order`** / **`lookup_payment`** / **`lookup_shipment`** as needed.
   3. **`check_refund_eligibility`** (read-only) with `orderId`, `amount`, `action`.
   4. **`issue_refund`** with the same args plus `reason` — expect `auto_executed` or `escalated`.
   5. If escalated: **`list_escalations`** or **`get_escalation`**, then **`resolve_escalation`** (`reject`, or `approve` only when conditions can pass a full re-check).

Domain state is **in-process and shared** across tool calls for the life of the server process. Call **`reset_seed_data`** between test runs to restore the seed catalog without restarting (or restart the server).

#### Case matrix (MCP client)

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

1. `issue_refund` on `ord_over_cap` (amount `249`) → note `escalation.id` in the result.
2. `get_escalation` → `failedChecks` includes `amount_cap`.
3. `resolve_escalation` with `decision: "approve"`, `resolvedBy: "mgr_jordan"` → **blocked**: full policy re-check still fails (`amount_cap`); escalation stays **pending**; **no money moved**. Escalation is not a policy override.
4. `resolve_escalation` with `decision: "reject"` on another pending case (e.g. `ord_too_old`) → closed; no money moved.
5. Optional: after an underlying condition clears (e.g. risk score refreshed below 70), `approve` re-checks and may complete only if **all** gates pass.

## Tools

| Tool | Type | Purpose |
|------|------|---------|
| `reset_seed_data` | write | Reload synthetic seed catalog (demo/test reset) |
| `list_seed_scenarios` | read | Seed order IDs + expected outcomes |
| `lookup_order` | read | Order + customer |
| `lookup_payment` | read | Payment, balance, dispute flags |
| `lookup_shipment` | read | Shipment + carrier exception |
| `lookup_customer` | read | Customer risk score |
| `list_refunds` | read | Refunds for an order |
| `check_refund_eligibility` | read | Policy report (no side effects) |
| `issue_refund` | write | Auto-execute **or** escalate |
| `list_escalations` | read | Escalations |
| `get_escalation` | read | Escalation detail |
| `resolve_escalation` | write | Manager reject, or approve with **full policy re-check** (no bypass) |

## Seed scenarios

| Order ID | Scenario | Expected |
|----------|----------|----------|
| `ord_auto_ok` | $89 damaged, low risk, recent | `auto_executed` |
| `ord_over_cap` | $249 over $150 cap | `escalated` |
| `ord_too_old` | &gt; 30 days old | `escalated` |
| `ord_high_risk` | Risk score 82 | `escalated` |
| `ord_no_exception` | No carrier exception | `escalated` |
| `ord_already_refunded` | Duplicate action+amount | `escalated` |
| `ord_chargeback` | Chargeback flagged | `escalated` |
| `ord_partial_ok` | $50 of $60 remaining | `auto_executed` |

### Auto-refund policy

All of the following must hold:

1. Amount ≤ **$150**
2. Amount ≤ remaining paid balance (paid − already refunded)
3. Order age ≤ **30 days**
4. Customer risk **&lt; 70**
5. **Verified carrier exception** on the shipment
6. No completed refund for the same `action` + `amount`
7. Payment captured, **no chargeback/dispute flags**

Otherwise `issue_refund` escalates and **moves no money**.

### Manager resolution (`resolve_escalation`)

- **`reject`** — close the escalation; no money moved.
- **`approve`** — re-run the **full** auto-refund policy at execution time (same gates as above). Money moves **only** if every check passes now.
- An escalation is **not** authorization to bypass a failed check (amount cap, risk, age, chargeback, etc.). If checks still fail, the escalation stays **pending**, no money moves, and any true exception refund is completed **outside** this automated MCP path.

> **`action` is caller-provided scope.** Duplicate detection matches on `action` + `amount`. Use the same stable key for the same refund reason (e.g. always `full_refund_damaged`). If the key changes every call, duplicates will not be blocked.

## Layout

```
index.ts              # Express + Streamable HTTP
src/
  create-server.ts    # Tool registration
  tool-schemas.ts     # Shared Zod input schemas
  types.ts            # Domain types + policy constants
  seed.ts             # Synthetic catalog
  store.ts            # In-memory store
  policy.ts           # Eligibility + issue/resolve
  policy.test.ts      # Unit tests
```

## Assumptions

- USD amounts, two-decimal rounding.
- `action` is a stable key for duplicate detection **and is supplied by the caller**. Duplicate protection depends on the caller passing the same `action` + `amount` consistently for the same refund reason.
- `riskScore` is assumed to come from an **external risk provider** (e.g. a fraud/risk scoring service keyed on `customerId`). This server does not compute it — it reads the static value from the customer record. In this demo it is hardcoded in the seed data.
- Carrier exceptions must be present and `exceptionVerified: true`.
- Chargeback/dispute flags always force escalation (and block approve-time completion until flags clear).
- Manager approve never overrides policy; it only succeeds when a full re-check would allow auto-refund.
- In-memory store resets on process restart.
- Stateless Streamable HTTP per request; domain state is the shared process store.
