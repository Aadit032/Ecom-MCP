/**
 * Zod input/output schemas for MCP tools.
 * Shared so registration and unit tests validate the same contracts.
 */
import { z } from "zod";

// ─── Shared domain shapes ────────────────────────────────────────────────────

export const writeKeyField = z
  .string()
  .min(1)
  .describe(
    "Shared write key from server env WRITE_TOKEN. Required for mutative tools; not needed for read tools.",
  );

export const customerSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  riskScore: z.number(),
});

export const customerSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  riskScore: z.number(),
});

export const orderSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  createdAt: z.string(),
  status: z.enum([
    "pending",
    "paid",
    "shipped",
    "delivered",
    "cancelled",
    "refunded",
  ]),
  currency: z.literal("USD"),
  itemDescription: z.string(),
  quantity: z.number(),
});

export const paymentSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  status: z.enum([
    "authorized",
    "captured",
    "refunded",
    "partially_refunded",
    "failed",
  ]),
  amountPaid: z.number(),
  amountRefunded: z.number(),
  capturedAt: z.string(),
  chargebackFlag: z.boolean(),
  disputeFlag: z.boolean(),
});

export const shipmentSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  carrier: z.string(),
  trackingNumber: z.string(),
  status: z.enum([
    "label_created",
    "in_transit",
    "delivered",
    "exception",
    "returned",
  ]),
  carrierException: z
    .enum(["damaged", "lost", "never_delivered", "wrong_item"])
    .nullable(),
  exceptionVerified: z.boolean(),
  shippedAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
});

export const refundSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  paymentId: z.string(),
  amount: z.number(),
  action: z.string(),
  reason: z.string(),
  status: z.enum(["completed", "pending_manager", "failed"]),
  autoApproved: z.boolean(),
  escalationId: z.string().nullable(),
  createdAt: z.string(),
});

export const policyCheckResultSchema = z.object({
  code: z.enum([
    "amount_cap",
    "not_over_paid",
    "order_age",
    "customer_risk",
    "carrier_exception",
    "no_duplicate_refund",
    "payment_captured",
    "no_chargeback_or_dispute",
  ]),
  passed: z.boolean(),
  message: z.string(),
});

export const escalationSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  paymentId: z.string(),
  requestedAmount: z.number(),
  action: z.string(),
  reason: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
  failedChecks: z.array(policyCheckResultSchema),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolutionNote: z.string().nullable(),
  resultingRefundId: z.string().nullable(),
});

export const eligibilityResultSchema = z.object({
  eligibleForAutoRefund: z.boolean(),
  orderId: z.string(),
  paymentId: z.string(),
  requestedAmount: z.number(),
  action: z.string(),
  checks: z.array(policyCheckResultSchema),
  failedChecks: z.array(policyCheckResultSchema),
  summary: z.string(),
});

export const emptyInput = z.object({}).strict();

// ─── Input schemas ───────────────────────────────────────────────────────────

export const resetSeedDataInput = z.object({
  writeKey: writeKeyField,
});

export const listSeedScenariosInput = emptyInput;

export const listOrdersInput = emptyInput;

export const lookupOrderInput = z.object({
  orderId: z.string().describe("Order ID, e.g. ord_auto_ok"),
});

export const lookupPaymentInput = z.object({
  paymentId: z.string().optional().describe("Payment ID, e.g. pay_auto_ok"),
  orderId: z.string().optional().describe("Order ID if payment ID unknown"),
});

export const lookupShipmentInput = z.object({
  shipmentId: z.string().optional().describe("Shipment ID, e.g. shp_auto_ok"),
  orderId: z.string().optional().describe("Order ID if shipment ID unknown"),
});

export const lookupCustomerInput = z.object({
  customerId: z.string().describe("Customer ID, e.g. cust_low_risk"),
});

export const listRefundsInput = z.object({
  orderId: z.string().describe("Order ID"),
});

export const checkRefundEligibilityInput = z.object({
  orderId: z.string().describe("Order ID to evaluate"),
  amount: z.number().positive().describe("Requested refund amount in USD"),
  action: z
    .string()
    .min(1)
    .describe(
      "Stable action key for audit / escalation, e.g. full_refund_damaged",
    ),
});

export const issueRefundInput = z.object({
  writeKey: writeKeyField,
  orderId: z.string().describe("Order ID"),
  amount: z.number().positive().describe("Refund amount in USD"),
  action: z
    .string()
    .min(1)
    .describe("Stable action key, e.g. full_refund_damaged"),
  reason: z.string().min(1).describe("Human-readable refund reason for audit"),
});

export const listEscalationsInput = z.object({
  status: z
    .enum(["pending", "approved", "rejected"])
    .optional()
    .describe("Optional status filter"),
});

export const getEscalationInput = z.object({
  escalationId: z.string().describe("Escalation ID, e.g. esc_1001"),
});

export const resolveEscalationInput = z.object({
  writeKey: writeKeyField,
  escalationId: z.string().describe("Pending escalation ID"),
  decision: z.enum(["approve", "reject"]),
  resolvedBy: z.string().min(1).describe("Manager identifier, e.g. mgr_jordan"),
  note: z.string().optional().describe("Optional resolution note"),
});

// ─── Output schemas ──────────────────────────────────────────────────────────

export const resetSeedDataOutput = z.object({
  ok: z.boolean(),
  message: z.string(),
  counts: z.object({
    customers: z.number(),
    orders: z.number(),
    payments: z.number(),
    shipments: z.number(),
    refunds: z.number(),
    escalations: z.number(),
  }),
});

export const listSeedScenariosOutput = z.object({
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
});

export const listOrdersOutput = z.object({
  count: z.number(),
  orders: z.array(
    z.object({
      order: orderSchema,
      customer: customerSummarySchema.nullable(),
    }),
  ),
});

export const lookupOrderOutput = z.object({
  order: orderSchema,
  customer: customerSchema.nullable(),
});

export const lookupPaymentOutput = z.object({
  payment: paymentSchema,
  remainingRefundable: z.number(),
});

export const lookupShipmentOutput = z.object({
  shipment: shipmentSchema,
});

export const lookupCustomerOutput = z.object({
  customer: customerSchema,
});

export const listRefundsOutput = z.object({
  orderId: z.string(),
  refunds: z.array(refundSchema),
});

export const checkRefundEligibilityOutput = eligibilityResultSchema;

export const issueRefundOutput = z.object({
  outcome: z.enum(["auto_executed", "escalated", "rejected"]),
  message: z.string(),
  refund: refundSchema.nullable(),
  escalation: escalationSchema.nullable(),
  eligibility: eligibilityResultSchema,
});

export const listEscalationsOutput = z.object({
  escalations: z.array(escalationSchema),
});

export const getEscalationOutput = z.object({
  escalation: escalationSchema,
});

export const resolveEscalationOutput = z.object({
  ok: z.boolean(),
  message: z.string(),
  escalation: escalationSchema.nullable(),
  refund: refundSchema.nullable(),
  eligibility: eligibilityResultSchema.nullable(),
});
