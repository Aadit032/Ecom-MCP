/**
 * McpServer factory for the Streamable HTTP entry.
 * Tools register against the process-wide synthetic store.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { checkEligibility, issueRefund, resolveEscalation } from "./policy.ts";
import { SEED_SCENARIOS } from "./seed.ts";
import { store } from "./store.ts";
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

/** Build a fully configured refund-copilot MCP server instance. */
export function createRefundMcpServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // ─── Read: investigation tools ─────────────────────────────────────────────

  server.registerTool("list_seed_scenarios",
    {
      title: "List seed scenarios",
      description: "List synthetic seed orders and the expected issue_refund outcome for each scenario. Use this to discover order IDs while investigating.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      outputSchema: z.object({
        policy: z.object({
          maxAutoRefundUsd: z.number(),
          maxOrderAgeDays: z.number(),
          maxCustomerRiskExclusive: z.number(),
        }),
        scenarios: z.array(
          z.object({
            orderId: z.string(),
            scenario: z.string(),
            expected: z.string(),
          }),
        ),
      }),
    },
    async () => {
      const output = {
        policy: { ...POLICY },
        scenarios: SEED_SCENARIOS.map((s) => ({ ...s })),
      };
      return jsonResult(output);
    },
  );

  server.registerTool("lookup_order",
    {
      title: "Lookup order",
      description:"Look up a synthetic order by order ID, including linked customer summary.",
      inputSchema: z.object({
        orderId: z.string().describe("Order ID, e.g. ord_auto_ok"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ orderId }) => {
      const order = store.getOrder(orderId);
      if (!order) return errorResult(`Order not found: ${orderId}`);
      const customer = store.getCustomer(order.customerId) ?? null;
      return jsonResult({ order, customer });
    },
  );

  server.registerTool("lookup_payment",
    {
      title: "Lookup payment",
      description:
        "Look up payment by payment ID or order ID. Includes amount paid, amount already refunded, and chargeback/dispute flags.",
      inputSchema: z.object({
        paymentId: z
          .string()
          .optional()
          .describe("Payment ID, e.g. pay_auto_ok"),
        orderId: z
          .string()
          .optional()
          .describe("Order ID if payment ID unknown"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ paymentId, orderId }) => {
      if (!paymentId && !orderId) {
        return errorResult("Provide paymentId or orderId.");
      }
      const payment = paymentId
        ? store.getPayment(paymentId)
        : store.getPaymentByOrder(orderId!);
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

  server.registerTool("lookup_shipment",
    {
      title: "Lookup shipment",
      description:
        "Look up shipment by shipment ID or order ID. Includes carrier exception type and whether it is verified (required for auto-refund).",
      inputSchema: z.object({
        shipmentId: z
          .string()
          .optional()
          .describe("Shipment ID, e.g. shp_auto_ok"),
        orderId: z
          .string()
          .optional()
          .describe("Order ID if shipment ID unknown"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ shipmentId, orderId }) => {
      if (!shipmentId && !orderId) {
        return errorResult("Provide shipmentId or orderId.");
      }
      const shipment = shipmentId
        ? store.getShipment(shipmentId)
        : store.getShipmentByOrder(orderId!);
      if (!shipment) {
        return errorResult(
          `Shipment not found${shipmentId ? `: ${shipmentId}` : ` for order ${orderId}`}.`,
        );
      }
      return jsonResult({ shipment });
    },
  );

  server.registerTool("lookup_customer",
    {
      title: "Lookup customer",
      description:
        "Look up a customer by ID, including risk score used by policy.",
      inputSchema: z.object({
        customerId: z.string().describe("Customer ID, e.g. cust_low_risk"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ customerId }) => {
      const customer = store.getCustomer(customerId);
      if (!customer) return errorResult(`Customer not found: ${customerId}`);
      return jsonResult({ customer });
    },
  );

  server.registerTool("list_refunds",
    {
      title: "List refunds for order",
      description:
        "List existing refund records for an order (completed or otherwise).",
      inputSchema: z.object({
        orderId: z.string().describe("Order ID"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ orderId }) => {
      if (!store.getOrder(orderId))
        return errorResult(`Order not found: ${orderId}`);
      return jsonResult({
        orderId,
        refunds: store.listRefundsForOrder(orderId),
      });
    },
  );

  // ─── Eligibility (read-only decision support) ──────────────────────────────

  server.registerTool("check_refund_eligibility",
    {
      title: "Check refund eligibility",
      description: `Evaluate auto-refund policy for an order without side effects or moving money.

Auto-execute requires ALL of:
- amount ≤ $${POLICY.maxAutoRefundUsd}
- amount ≤ remaining paid balance
- order age ≤ ${POLICY.maxOrderAgeDays} days
- customer risk < ${POLICY.maxCustomerRiskExclusive}
- verified carrier exception present
- no completed refund for the same action + amount
- payment captured with no chargeback/dispute flags

If any check fails, issue_refund will escalate for manager approval instead of refunding.`,
      inputSchema: z.object({
        orderId: z.string().describe("Order ID to evaluate"),
        amount: z.number().positive().describe("Requested refund amount in USD"),
        action: z
          .string()
          .min(1)
          .describe(
            "Stable action key for duplicate detection, e.g. full_refund_damaged",
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ orderId, amount, action }) => {
      const eligibility = checkEligibility(store, { orderId, amount, action });
      return jsonResult(eligibility);
    },
  );

  // ─── Write path: guarded issue_refund ──────────────────────────────────────

  server.registerTool("issue_refund",
    {
      title: "Issue refund (guarded)",
      description: `Attempt a refund under the auto-approval policy.

Behavior:
- If ALL policy checks pass → auto-execute the refund (money moves).
- If ANY policy check fails → create a manager-approval escalation and move NO money.
  Failed checks never complete the refund via mid-call human confirmation/elicitation.

Use check_refund_eligibility first for investigation. Use resolve_escalation after a manager reviews a pending escalation.`,
      inputSchema: z.object({
        orderId: z.string().describe("Order ID"),
        amount: z.number().positive().describe("Refund amount in USD"),
        action: z
          .string()
          .min(1)
          .describe("Stable action key, e.g. full_refund_damaged"),
        reason: z
          .string()
          .min(1)
          .describe("Human-readable refund reason for audit"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ orderId, amount, action, reason }) => {
      const result = issueRefund(store, { orderId, amount, action, reason });
      return jsonResult(result);
    },
  );

  // ─── Escalation tools ──────────────────────────────────────────────────────

  server.registerTool("list_escalations",
    {
      title: "List escalations",
      description:
        "List manager-approval escalations created when issue_refund could not auto-execute. Optionally filter by status.",
      inputSchema: z.object({
        status: z
          .enum(["pending", "approved", "rejected"])
          .optional()
          .describe("Optional status filter"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status }) => {
      return jsonResult({ escalations: store.listEscalations(status) });
    },
  );

  server.registerTool("get_escalation",
    {
      title: "Get escalation",
      description:
        "Fetch a single escalation by ID, including failed policy checks.",
      inputSchema: z.object({
        escalationId: z.string().describe("Escalation ID, e.g. esc_1001"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ escalationId }) => {
      const escalation = store.getEscalation(escalationId);
      if (!escalation)
        return errorResult(`Escalation not found: ${escalationId}`);
      return jsonResult({ escalation });
    },
  );

  server.registerTool("resolve_escalation",
    {
      title: "Resolve escalation (manager)",
      description: `Manager decision on a pending escalation.
      
      - approve: complete the refund under manager authority (money moves), subject to remaining balance and duplicate guards.
      - reject: close the escalation without moving money.

      This is the only path that may complete a refund that failed auto-policy checks.`,
      inputSchema: z.object({
        escalationId: z.string().describe("Pending escalation ID"),
        decision: z.enum(["approve", "reject"]),
        resolvedBy: z
          .string()
          .min(1)
          .describe("Manager identifier, e.g. mgr_jordan"),
        note: z.string().optional().describe("Optional resolution note"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ escalationId, decision, resolvedBy, note }) => {
      const result = resolveEscalation(store, {
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
