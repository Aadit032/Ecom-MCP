/**
 * Zod input schemas for MCP tools.
 * Shared so registration and unit tests validate the same contracts.
 */
import { z } from "zod";

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
      "Stable action key for duplicate detection, e.g. full_refund_damaged",
    ),
});

export const issueRefundInput = z.object({
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
  escalationId: z.string().describe("Pending escalation ID"),
  decision: z.enum(["approve", "reject"]),
  resolvedBy: z.string().min(1).describe("Manager identifier, e.g. mgr_jordan"),
  note: z.string().optional().describe("Optional resolution note"),
});
