# MCP Client Test Questions

Connect your AI client to the Streamable HTTP endpoint (`https://ecom-mcp.onrender.com/mcp` after `bun run start`). Ask these naturally; the agent should call MCP tools. Before a full pass, call **`reset_seed_data`** (with the write `token` from `WRITE_TOKEN` / `.env`) so seed state is clean.

**Write tools** (`reset_seed_data`, `issue_refund`, `resolve_escalation`) require the secret **`token`**. Read tools are public.

**Adding a token:** set `WRITE_TOKEN` in `.env` on the server (`openssl rand -hex 24`), then pass the same value as the **`token`** argument in every write-tool call from your client. The server rejects write calls whose token doesn't match.

**Policy (auto-refund needs all of these):** amount ≤ $150 · amount ≤ remaining balance · order ≤ 30 days · customer risk &lt; 70 · verified carrier exception · no duplicate paymentId+amount · payment captured · no chargeback/dispute.

---

## Discovery & investigation

### 0. Reset seed data (between runs)

**Ask:** Reset the synthetic seed data so all scenarios match the original catalog. Here is the token: `<INSERT_TOKEN_HERE>`.

**Expect:** Store reloaded; counts for customers/orders/payments/shipments; escalations cleared (except none in seed); pre-seeded refunds restored (e.g. on `ord_already_refunded`, `ord_partial_ok`).

### 1. List scenarios

**Ask:** List the seed refund scenarios and the auto-refund policy limits.

**Expect:** Policy `150` / `30` / `70`. Eight orders; `ord_auto_ok` and `ord_partial_ok` expected auto; the rest escalate.

### 1b. List all orders (discover by customer name)

**Ask:** List all orders and their customers so I can find Ava Chen’s wireless earbuds order.

**Expect:** Every order with customer name/id/risk; Ava Chen on `ord_auto_ok` (wireless earbuds), `ord_over_cap`, etc. Use this when prompts only give a customer name.

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

**Ask:** Issue a $89 refund for `ord_auto_ok`, action `full_refund_damaged`, reason “Damaged earbuds”. Here is the token: `<INSERT_TOKEN_HERE>`.

**Expect:** Outcome **`auto_executed`**; completed refund; money moved.

### 16. Escalate — over cap

**Ask:** Issue a $249 refund for `ord_over_cap`, action `full_refund_lost`, reason “Lost package”. Here is the token: `<INSERT_TOKEN_HERE>`.

**Expect:** Outcome **`escalated`**; **`amount_cap`** in failed checks; pending escalation; no money moved. Note `escalation.id`.

### 17. Escalate — another policy fail

**Ask:** Issue a refund for `ord_chargeback`, $120, `full_refund_damaged`, reason “Customer request despite chargeback”. Here is the token: `<INSERT_TOKEN_HERE>`.

**Expect:** **`escalated`** with **`no_chargeback_or_dispute`**; no money moved.

### 18. List and inspect escalations

**Ask:** List pending escalations and show detail for the `ord_over_cap` one.

**Expect:** Pending entry with `requestedAmount: 249` and failed check **`amount_cap`**.

### 19. Manager approve does **not** bypass policy

**Ask:** Approve the pending escalation for `ord_over_cap` as manager `mgr_jordan`. Here is the token: `<INSERT_TOKEN_HERE>`.

**Expect:** **Blocked** — full policy re-check at execution time still fails (`amount_cap`). Escalation remains **pending**; **no money moved**. Escalation is not authorization to override the cap. Exception refunds (if any) stay outside the automated MCP path.

### 20. Manager reject

**Setup:** On a clean server (or after creating a new pending escalation, e.g. issue on `ord_too_old` $45).

**Ask:** Reject that pending escalation as manager `mgr_sam` with note “Outside policy; deny.” Here is the token: `<INSERT_TOKEN_HERE>`.

**Expect:** Escalation **rejected**; **no money moved**.

### 21. Over-cap still not auto-payable after blocked approve

**Setup:** After Q16 + Q19 (over-cap escalated; approve attempted and blocked).

**Ask:** Issue the same refund again for `ord_over_cap` ($249, `full_refund_lost`). Here is the token: `<INSERT_TOKEN_HERE>`.

**Expect:** Still **not** auto-executed; escalates again (or remains blocked by policy). Money has not moved from the prior approve attempt.

### 22. Approve succeeds only when conditions clear

**Setup:** Fresh server. Issue a refund that escalates only on risk (e.g. fixture-style high risk that can be lowered — or use client tools if your demo environment can refresh risk). For unit-level behavior: risk fails → escalate → risk drops below 70 → approve.

**Ask (conceptual):** After risk is below 70 and all other gates pass, approve the pending escalation. Here is the token: `<INSERT_TOKEN_HERE>`.

**Expect:** Full re-check passes → escalation **approved** → refund completes → money moved. If any gate still fails, same as Q19 (blocked, pending, no money).

---

## End-to-end prompts (paste into an AI client)

These are **full commerce-ops workflows**. Paste one prompt as-is after connecting to the MCP server. Prefer **`reset_seed_data`** first so seed state is clean. The agent should discover orders via tools (e.g. **`list_orders`** by customer name, `list_seed_scenarios`, lookups) — you do not need to name tool APIs in the prompt.

---

### 23. Happy path — damaged item, auto-refund works

**Paste:**

> I'm on commerce ops. Customer Ava Chen says her wireless earbuds arrived damaged and she wants a full refund. Here is the token: `<INSERT_TOKEN_HERE>`.
> Find her order in the catalog, pull order / payment / shipment / risk context, check whether we can auto-refund, and if policy allows, issue the refund with a clear reason.  
> Summarize what you found, which policy checks passed, and whether money moved.

**Expect:** Finds `ord_auto_ok` (~$89, low risk, verified **damaged**). Eligibility passes → **`auto_executed`**; completed refund; money moved.

---

### 24. Over cap — headphones too expensive for auto-refund

**Paste:**

> Customer Ava Chen ordered noise-cancelling headphones that the carrier marked lost. She wants a full refund of what she paid. Here is the token: `<INSERT_TOKEN_HERE>`.
> Look up the order and payment, check auto-refund eligibility, and attempt the refund if appropriate.  
> If it cannot auto-approve, open/show the escalation and explain which policy gate failed. Do not invent a bypass.

**Expect:** Finds `ord_over_cap` (~$249). Eligibility fails **`amount_cap`** → **`escalated`**; pending escalation; **no money moved**. Agent should explain the $150 auto cap.

---

### 25. High risk — do not auto-refund

**Paste:**

> Casey Nguyen contacted support: both phone cases were the wrong item and they want a full refund (~$40). Here is the token: `<INSERT_TOKEN_HERE>`.
> Investigate the customer and order, run eligibility, and only issue if auto-eligible. If risk or another gate blocks us, escalate and tell me why in plain language for the manager queue.

**Expect:** Finds `ord_high_risk`. Risk **82** → fails **`customer_risk`** → **`escalated`**; no money moved. Agent should surface risk score vs threshold (&lt; 70).

---

### 26. Chargeback already open — must escalate

**Paste:**

> Ben Ortiz wants a refund on a fitness tracker because it showed up damaged. Before we pay anything, check payment dispute/chargeback status and full eligibility.  
> If auto-refund is blocked, escalate with a clear reason and confirm that no money left the account.

**Expect:** Finds `ord_chargeback` (~$120). Fails **`no_chargeback_or_dispute`** (and/or related flags) → **`escalated`**; **no money moved**.

---

### 27. No carrier exception — delivered clean, customer claims damage

**Paste:**

> Customer Ben Ortiz claims their desk lamp arrived damaged and wants a full refund.  
> Pull shipment evidence. If there is no verified carrier exception, do not auto-refund — check eligibility, escalate if needed, and explain what evidence is missing for ops.

**Expect:** Finds `ord_no_exception`. Fails **`carrier_exception`** → **`escalated`**; no money moved. Agent should note missing/unverified exception.

---

### 28. Manager queue after escalation (reject path)

**Setup:** Run Q24 (or any escalate prompt) first so a pending escalation exists. Or include reset + issue in one go.

**Paste:**

> Act as commerce ops end-to-end:  
> 1) Reset seed data.  
> 2) Customer wants a full refund on lost noise-cancelling headphones (Ava Chen / high-value order) — investigate, try refund, expect escalation on amount cap.  
> 3) List pending escalations and open the one for that order.  
> 4) As manager `mgr_jordan`, try to **approve** it — report whether money moved.  
> 5) Then **reject** a different pending case if one exists (or reject this one after showing approve was blocked), with note “Outside auto policy; handle offline if needed.”  
> Walk me through the full ticket like a real ops handoff.

**Expect:**
1. Seed reset.  
2. `ord_over_cap` → **`escalated`** (`amount_cap`); no money.  
3. Escalation detail shows failed checks.  
4. **Approve blocked** — re-check still fails; stays **pending**; no money.  
5. **Reject** closes another (or same if you reject after) without money movement. Escalation is not a policy override.

---