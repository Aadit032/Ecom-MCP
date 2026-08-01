# Ecom Refund Copilot (MCP)

Synthetic **refund investigation and approval** MCP server. Agents look up order / payment / shipment context, evaluate auto-refund eligibility, and either auto-execute a refund or open a manager escalation.

All data is local and synthetic. No real payments, credentials, frontend, or auth.

## Transport

**Streamable HTTP** over Express. MCP endpoint: `/mcp`.

```bash
bun install
bun run start
# → http://0.0.0.0:3000/mcp
# → http://0.0.0.0:3000/health

bun test
```

Optional: `PORT` (default `3000`), `HOST` (default `127.0.0.1`).

Point an MCP client at `http://<host>:<port>/mcp`.

## Product boundary

| Rule | Behavior |
|------|----------|
| Auto-execute | Only when **all** policy checks pass |
| Policy failure | Create a **manager-approval escalation** and **move no money** |
| Elicitation | **Not** used to complete a failed-policy refund mid-call |

### Auto-refund policy

All of the following must hold:

1. Amount ≤ **$150**
2. Amount ≤ remaining paid balance (paid − already refunded)
3. Order age ≤ **30 days**
4. Customer risk **&lt; 70**
5. **Verified carrier exception** on the shipment
6. No completed refund for the same `action` + `amount`
7. Payment captured, **no chargeback/dispute flags**

Otherwise `issue_refund` escalates. Money only moves later via `resolve_escalation` with `approve`.

> **`action` is caller-provided scope.** Duplicate detection matches on `action` + `amount`. It only works if the caller uses the **same, stable `action` key** every time for the same refund reason — e.g. always `full_refund_damaged` for a damaged-goods full refund. If the caller varies the key (timestamps, order IDs, free text), every call looks like a new refund and duplicates slip through.

## Tools

| Tool | Type | Purpose |
|------|------|---------|
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
| `resolve_escalation` | write | Manager approve / reject |

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

## Manual testing

Two ways to poke the server without the unit tests.

### Option A — any MCP client

1. `bun run start`
2. Point an MCP client (Claude Desktop, Cursor, VS Code, `npx @modelcontextprotocol/inspector`) at `http://127.0.0.1:3000/mcp`.
3. Walk the cases below. The server is **stateless**, so each tool call is independent.

### Option B — raw JSON-RPC via curl

The server needs no session handshake; initialize once (optional) and call tools directly:

```bash
bun run start

# initialize (optional but standard)
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# call a tool
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_seed_scenarios","arguments":{}}}'
```

To list available tools: `{"method":"tools/list","params":{}}`.

### Case matrix

Read-only: start with `list_seed_scenarios`, then `check_refund_eligibility` per case. Write: `issue_refund`, then find the escalation with `list_escalations` and close it with `resolve_escalation`.

| # | Order | `amount` | `action` | Expected |
|---|-------|----------|----------|----------|
| 1 | `ord_auto_ok` | 89 | `full_refund_damaged` | auto-executed, all 8 checks pass |
| 2 | `ord_over_cap` | 249 | `full_refund_lost` | escalated (`amount_cap`) |
| 3 | `ord_too_old` | 45 | `full_refund_never_delivered` | escalated (`order_age`) |
| 4 | `ord_high_risk` | 39.98 | `full_refund_wrong_item` | escalated (`customer_risk`, score 82) |
| 5 | `ord_no_exception` | 64 | `full_refund_damaged` | escalated (`carrier_exception`) |
| 6 | `ord_already_refunded` | 79 | `full_refund_damaged` | escalated (`no_duplicate_refund` — same action+amount as seed) |
| 7 | `ord_chargeback` | 120 | `full_refund_damaged` | escalated (`no_chargeback_or_dispute`) |
| 8 | `ord_partial_ok` | 50 | `full_refund_damaged` | auto-executed ($60 left after seed's $40 refund) |

**Duplicate-scope demo** (proves `action` matters):
- `ord_already_refunded`, 79, `full_refund_damaged` → **blocked** (duplicate).
- `ord_already_refunded`, 79, `full_refund_damaged_v2` → passes duplicate check (but still escalates via other guards if any fail — try a clean order for a pure demo).

**Escalation round-trip:**
- Call `issue_refund` on `ord_over_cap` (249) → get `escalation.id` from the result.
- `get_escalation` → shows `failedChecks: ["amount_cap"]`.
- `resolve_escalation` with `decision: "approve"`, `resolvedBy: "mgr_jordan"` → refund completes under manager authority.
- Call `issue_refund` on the same order with the same action+amount again → escalated again as duplicate (proves money only moves once).

## Layout

```
index.ts              # Express + Streamable HTTP
src/
  create-server.ts    # Tool registration
  types.ts            # Domain types + policy constants
  seed.ts             # Synthetic catalog
  store.ts            # In-memory store
  policy.ts           # Eligibility + issue/resolve
  policy.test.ts
```

## Assumptions

- USD amounts, two-decimal rounding.
- `action` is a stable key for duplicate detection **and is supplied by the caller**. Duplicate protection depends on the caller passing the same `action` + `amount` consistently for the same refund reason.
- `riskScore` is assumed to come from an **external risk provider** (e.g. a fraud/risk scoring service keyed on `customerId`). This server does not compute it — it reads the static value from the customer record. In this demo it is hardcoded in the seed data.
- Carrier exceptions must be present and `exceptionVerified: true`.
- Chargeback/dispute flags always force escalation.
- In-memory store resets on process restart.
- Stateless Streamable HTTP per request; domain state is the shared process store.
