# MCP Client Test Questions

Connect your AI client to the Streamable HTTP endpoint (`http://localhost:3000/mcp` after `bun run start`). Ask these naturally; the agent should call MCP tools. Before a full pass, call **`reset_seed_data`** (or restart the server) so seed state is clean.

**Policy (auto-refund needs all of these):** amount ≤ $150 · amount ≤ remaining balance · order ≤ 30 days · customer risk &lt; 70 · verified carrier exception · no duplicate action+amount · payment captured · no chargeback/dispute.

---

## Discovery & investigation

### 0. Reset seed data (between runs)

**Ask:** Reset the synthetic seed data so all scenarios match the original catalog.

**Expect:** Store reloaded; counts for customers/orders/payments/shipments; escalations cleared (except none in seed); pre-seeded refunds restored (e.g. on `ord_already_refunded`, `ord_partial_ok`).

### 1. List scenarios

**Ask:** List the seed refund scenarios and the auto-refund policy limits.

**Expect:** Policy `150` / `30` / `70`. Eight orders; `ord_auto_ok` and `ord_partial_ok` expected auto; the rest escalate.

### 2. Look up a clean order

**Ask:** Investigate order `ord_auto_ok` — customer, payment, and shipment.

**Expect:** Ava Chen (`cust_low_risk`, risk ~22), $89 paid / $0 refunded, verified **damaged** exception.

### 3. Look up high-risk customer

**Ask:** Who is the customer on `ord_high_risk`, and what is their risk score?

**Expect:** Casey Nguyen, **riskScore: 82** (above auto threshold).

### 4. Look up chargeback payment

**Ask:** Check the payment on `ord_chargeback`. Any chargeback or dispute flags?

**Expect:** ~$120 paid; **chargeback and/or dispute flag true**.

### 5. Look up shipment without exception

**Ask:** Does `ord_no_exception` have a verified carrier exception?

**Expect:** No verified exception — reason auto-refund fails for that order.

### 6. List existing refunds

**Ask:** What refunds already exist for `ord_already_refunded` and `ord_partial_ok`?

**Expect:** `ord_already_refunded`: completed $79 (`full_refund_damaged`). `ord_partial_ok`: completed $40 (`partial_missing_keycaps`); ~$60 of $100 remains.

### 7. Not found

**Ask:** Look up order `ord_does_not_exist`.

**Expect:** Error / not found — no invented order data.

---

## Eligibility (read-only)

### 8. Eligible — auto path

**Ask:** Check eligibility for `ord_auto_ok`, amount 89, action `full_refund_damaged`. Do not issue yet.

**Expect:** `eligibleForAutoRefund: true`; no refund created.

### 9. Ineligible — over cap

**Ask:** Is `ord_over_cap` eligible for a $249 auto-refund (`full_refund_lost`)?

**Expect:** Not eligible; failed check **`amount_cap`**.

### 10. Ineligible — order age

**Ask:** Check eligibility for `ord_too_old`, $45, `full_refund_never_delivered`.

**Expect:** Not eligible; failed check **`order_age`**.

### 11. Ineligible — high risk / no exception / chargeback

**Ask:** Check eligibility (no issue) for:
- `ord_high_risk` $39.98 `full_refund_wrong_item`
- `ord_no_exception` $64 `full_refund_damaged`
- `ord_chargeback` $120 `full_refund_damaged`

**Expect:** All not eligible. Failures: **`customer_risk`**, **`carrier_exception`**, **`no_chargeback_or_dispute`**.

### 12. Ineligible — duplicate

**Ask:** Check eligibility for `ord_already_refunded`, $79, `full_refund_damaged`.

**Expect:** Not eligible; failed check **`no_duplicate_refund`**.

### 13. Eligible — partial remaining

**Ask:** Check eligibility for `ord_partial_ok`, $50, `full_refund_damaged`.

**Expect:** Eligible (remaining balance supports $50).

### 14. Edge — over remaining balance

**Ask:** Check eligibility for `ord_partial_ok` for **$70** with action `full_refund_damaged` (only ~$60 remains).

**Expect:** Not eligible; failed check **`not_over_paid`** (or equivalent remaining-balance failure).

---

## Issue refund & escalation

### 15. Auto-execute happy path

**Ask:** Issue a $89 refund for `ord_auto_ok`, action `full_refund_damaged`, reason “Damaged earbuds”.

**Expect:** Outcome **`auto_executed`**; completed refund; money moved.

### 16. Escalate — over cap

**Ask:** Issue a $249 refund for `ord_over_cap`, action `full_refund_lost`, reason “Lost package”.

**Expect:** Outcome **`escalated`**; **`amount_cap`** in failed checks; pending escalation; no money moved. Note `escalation.id`.

### 17. Escalate — another policy fail

**Ask:** Issue a refund for `ord_chargeback`, $120, `full_refund_damaged`, reason “Customer request despite chargeback”.

**Expect:** **`escalated`** with **`no_chargeback_or_dispute`**; no money moved.

### 18. List and inspect escalations

**Ask:** List pending escalations and show detail for the `ord_over_cap` one.

**Expect:** Pending entry with `requestedAmount: 249` and failed check **`amount_cap`**.

### 19. Manager approve does **not** bypass policy

**Ask:** Approve the pending escalation for `ord_over_cap` as manager `mgr_jordan`.

**Expect:** **Blocked** — full policy re-check at execution time still fails (`amount_cap`). Escalation remains **pending**; **no money moved**. Escalation is not authorization to override the cap. Exception refunds (if any) stay outside the automated MCP path.

### 20. Manager reject

**Setup:** On a clean server (or after creating a new pending escalation, e.g. issue on `ord_too_old` $45).

**Ask:** Reject that pending escalation as manager `mgr_sam` with note “Outside policy; deny.”

**Expect:** Escalation **rejected**; **no money moved**.

### 21. Over-cap still not auto-payable after blocked approve

**Setup:** After Q16 + Q19 (over-cap escalated; approve attempted and blocked).

**Ask:** Issue the same refund again for `ord_over_cap` ($249, `full_refund_lost`).

**Expect:** Still **not** auto-executed; escalates again (or remains blocked by policy). Money has not moved from the prior approve attempt.

### 22. Approve succeeds only when conditions clear

**Setup:** Fresh server. Issue a refund that escalates only on risk (e.g. fixture-style high risk that can be lowered — or use client tools if your demo environment can refresh risk). For unit-level behavior: risk fails → escalate → risk drops below 70 → approve.

**Ask (conceptual):** After risk is below 70 and all other gates pass, approve the pending escalation.

**Expect:** Full re-check passes → escalation **approved** → refund completes → money moved. If any gate still fails, same as Q19 (blocked, pending, no money).

---

## Optional end-to-end prompt

### 23. Full agent flow

**Ask:** Customer on `ord_auto_ok` wants a full refund for damaged earbuds. Investigate, check policy, and only issue if auto-eligible.

**Expect:** Lookups → eligibility true → `auto_executed` (or a clear “safe to auto-refund” recommendation if they stop short of issue).
