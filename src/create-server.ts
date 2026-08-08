/**
 * McpServer factory for the Streamable HTTP entry.
 * Tools register against the process-wide Postgres-backed store.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { assertWriteToken } from "./auth.ts";
import { checkEligibility, issueRefund, resolveEscalation } from "./policy.ts";
import { SEED_SCENARIOS } from "./seed.ts";
import { store } from "./store.ts";
import {
  checkRefundEligibilityInput,
  checkRefundEligibilityOutput,
  getEscalationInput,
  getEscalationOutput,
  issueRefundInput,
  issueRefundOutput,
  listEscalationsInput,
  listEscalationsOutput,
  listOrdersInput,
  listOrdersOutput,
  listRefundsInput,
  listRefundsOutput,
  listSeedScenariosInput,
  listSeedScenariosOutput,
  lookupCustomerInput,
  lookupCustomerOutput,
  lookupOrderInput,
  lookupOrderOutput,
  lookupPaymentInput,
  lookupPaymentOutput,
  lookupShipmentInput,
  lookupShipmentOutput,
  resetSeedDataInput,
  resetSeedDataOutput,
  resolveEscalationInput,
  resolveEscalationOutput,
} from "./tool-schemas.ts";
import { POLICY } from "./types.ts";

export const SERVER_NAME = "ecom-refund-copilot";
export const SERVER_VERSION = "1.0.0";

function jsonResult(data: unknown) {
  const text = JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: data as Record<string, unknown>,
  };
}

function errorResult(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

function unauthorized(result: { ok: false; message: string }) {
  return errorResult(result.message);
}

/** Build a fully configured refund-copilot MCP server instance. */
export function createRefundMcpServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // ─── Demo / test utility (write — requires token) ──────────────────────────

  server.registerTool(
    "reset_seed_data",
    {
      title: "Reset seed data",
      description: `Reset the Postgres store to the original synthetic seed catalog.

Use this between MCP client test runs so refunds, escalations, and payment balances match the documented scenarios again — without restarting the server process.

Destructive for demo state only: clears all runtime refunds/escalations and reloads seed customers, orders, payments, shipments, and pre-seeded refunds.

Requires the write secret token (WRITE_TOKEN).`,
      inputSchema: resetSeedDataInput,
      outputSchema: resetSeedDataOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ token }) => {
      const auth = assertWriteToken(token);
      if (!auth.ok) return unauthorized(auth);

      await store.reset();
      const counts = await store.counts();
      const output = {
        ok: true as const,
        message:
          "Store reset to synthetic seed catalog. Seed scenarios match list_seed_scenarios again.",
        counts,
      };
      return jsonResult(output);
    },
  );

  // ─── Read: investigation tools ─────────────────────────────────────────────

  server.registerTool(
    "list_seed_scenarios",
    {
      title: "List seed scenarios",
      description:
        "List synthetic seed orders and the expected issue_refund outcome for each scenario. Use this to discover order IDs while investigating.",
      inputSchema: listSeedScenariosInput,
      outputSchema: listSeedScenariosOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const output = {
        policy: { ...POLICY },
        scenarios: SEED_SCENARIOS.map((s) => ({ ...s })),
      };
      return jsonResult(output);
    },
  );

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description:
        "List all synthetic orders with linked customer summary (name, email, risk). Use when the caller only has a customer name or item description and needs to discover the order ID before lookup_order / eligibility.",
      inputSchema: listOrdersInput,
      outputSchema: listOrdersOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const orders = await Promise.all(
        (await store.listOrders()).map(async (order) => {
          const c = await store.getCustomer(order.customerId);
          return {
            order,
            customer: c
              ? {
                  id: c.id,
                  name: c.name,
                  email: c.email,
                  riskScore: c.riskScore,
                }
              : null,
          };
        }),
      );
      return jsonResult({ count: orders.length, orders });
    },
  );

  server.registerTool(
    "lookup_order",
    {
      title: "Lookup order",
      description:
        "Look up a synthetic order by order ID, including linked customer summary.",
      inputSchema: lookupOrderInput,
      outputSchema: lookupOrderOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ orderId }) => {
      const order = await store.getOrder(orderId);
      if (!order) return errorResult(`Order not found: ${orderId}`);
      const customer = (await store.getCustomer(order.customerId)) ?? null;
      return jsonResult({ order, customer });
    },
  );

  server.registerTool(
    "lookup_payment",
    {
      title: "Lookup payment",
      description:
        "Look up payment by payment ID or order ID. Includes amount paid, amount already refunded, and chargeback/dispute flags.",
      inputSchema: lookupPaymentInput,
      outputSchema: lookupPaymentOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ paymentId, orderId }) => {
      if (!paymentId && !orderId) {
        return errorResult("Provide paymentId or orderId.");
      }
      const payment = paymentId
        ? await store.getPayment(paymentId)
        : await store.getPaymentByOrder(orderId!);
      if (!payment) {
        return errorResult(
          `Payment not found${paymentId ? `: ${paymentId}` : ` for order ${orderId}`}.`,
        );
      }
      const remaining =
        Math.round((payment.amountPaid - payment.amountRefunded) * 100) / 100;
      return jsonResult({ payment, remainingRefundable: remaining });
    },
  );

  server.registerTool(
    "lookup_shipment",
    {
      title: "Lookup shipment",
      description:
        "Look up shipment by shipment ID or order ID. Includes carrier exception type and whether it is verified (required for auto-refund).",
      inputSchema: lookupShipmentInput,
      outputSchema: lookupShipmentOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ shipmentId, orderId }) => {
      if (!shipmentId && !orderId) {
        return errorResult("Provide shipmentId or orderId.");
      }
      const shipment = shipmentId
        ? await store.getShipment(shipmentId)
        : await store.getShipmentByOrder(orderId!);
      if (!shipment) {
        return errorResult(
          `Shipment not found${shipmentId ? `: ${shipmentId}` : ` for order ${orderId}`}.`,
        );
      }
      return jsonResult({ shipment });
    },
  );

  server.registerTool(
    "lookup_customer",
    {
      title: "Lookup customer",
      description:
        "Look up a customer by ID, including risk score used by policy.",
      inputSchema: lookupCustomerInput,
      outputSchema: lookupCustomerOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ customerId }) => {
      const customer = await store.getCustomer(customerId);
      if (!customer) return errorResult(`Customer not found: ${customerId}`);
      return jsonResult({ customer });
    },
  );

  server.registerTool(
    "list_refunds",
    {
      title: "List refunds for order",
      description:
        "List existing refund records for an order (completed or otherwise).",
      inputSchema: listRefundsInput,
      outputSchema: listRefundsOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ orderId }) => {
      if (!(await store.getOrder(orderId)))
        return errorResult(`Order not found: ${orderId}`);
      return jsonResult({
        orderId,
        refunds: await store.listRefundsForOrder(orderId),
      });
    },
  );

  // ─── Eligibility (read-only decision support) ──────────────────────────────

  server.registerTool(
    "check_refund_eligibility",
    {
      title: "Check refund eligibility",
      description: `Evaluate auto-refund policy for an order without side effects or moving money.

Auto-execute requires ALL of:
- amount ≤ $${POLICY.maxAutoRefundUsd}
- amount ≤ remaining paid balance
- order age ≤ ${POLICY.maxOrderAgeDays} days
- customer risk < ${POLICY.maxCustomerRiskExclusive}
- verified carrier exception present
- no completed refund for the same paymentId + amount (idempotency key)
- payment captured with no chargeback/dispute flags

If any check fails, issue_refund will escalate for manager approval instead of refunding.`,
      inputSchema: checkRefundEligibilityInput,
      outputSchema: checkRefundEligibilityOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ orderId, amount, action }) => {
      const eligibility = await checkEligibility(store, {
        orderId,
        amount,
        action,
      });
      return jsonResult(eligibility);
    },
  );

  // ─── Write path: guarded issue_refund ──────────────────────────────────────

  server.registerTool(
    "issue_refund",
    {
      title: "Issue refund (guarded)",
      description: `Attempt a refund under the auto-approval policy.

Requires the write secret token (WRITE_TOKEN).

Behavior:
- If ALL policy checks pass → auto-execute the refund (money moves).
- If ANY policy check fails → create a manager-approval escalation and move NO money.
  Failed checks never complete the refund via mid-call human confirmation/elicitation.
  Escalation is tracking only — it does not authorize a later policy bypass.
- Idempotent on (paymentId, amount): retries return the same completed refund without double-paying.

Use check_refund_eligibility first for investigation. Use resolve_escalation to reject, or to approve only after conditions clear (full policy re-check at execution time).`,
      inputSchema: issueRefundInput,
      outputSchema: issueRefundOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ token, orderId, amount, action, reason }) => {
      const auth = assertWriteToken(token);
      if (!auth.ok) return unauthorized(auth);

      const result = await issueRefund(store, {
        orderId,
        amount,
        action,
        reason,
      });
      return jsonResult(result);
    },
  );

  // ─── Escalation tools ──────────────────────────────────────────────────────

  server.registerTool(
    "list_escalations",
    {
      title: "List escalations",
      description:
        "List manager-approval escalations created when issue_refund could not auto-execute. Optionally filter by status.",
      inputSchema: listEscalationsInput,
      outputSchema: listEscalationsOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status }) => {
      return jsonResult({ escalations: await store.listEscalations(status) });
    },
  );

  server.registerTool(
    "get_escalation",
    {
      title: "Get escalation",
      description:
        "Fetch a single escalation by ID, including failed policy checks.",
      inputSchema: getEscalationInput,
      outputSchema: getEscalationOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ escalationId }) => {
      const escalation = await store.getEscalation(escalationId);
      if (!escalation)
        return errorResult(`Escalation not found: ${escalationId}`);
      return jsonResult({ escalation });
    },
  );

  server.registerTool(
    "resolve_escalation",
    {
      title: "Resolve escalation (manager)",
      description: `Manager decision on a pending escalation.

Requires the write secret token (WRITE_TOKEN).

- reject: close the escalation without moving money.
- approve: re-run the FULL auto-refund policy at execution time. Money moves only if every check passes now (same gates as check_refund_eligibility / issue_refund auto path).

An escalation is NOT authorization to bypass a failed policy check. If checks still fail, the escalation stays pending, no money moves, and any exception refund must be completed outside this automated MCP path.`,
      inputSchema: resolveEscalationInput,
      outputSchema: resolveEscalationOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ token, escalationId, decision, resolvedBy, note }) => {
      const auth = assertWriteToken(token);
      if (!auth.ok) return unauthorized(auth);

      const result = await resolveEscalation(store, {
        escalationId,
        decision,
        resolvedBy,
        note,
      });
      if (!result.ok && !result.escalation) return errorResult(result.message);
      return jsonResult(result);
    },
  );

  return server;
}
