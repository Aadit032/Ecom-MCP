/** Domain types for the synthetic ecommerce refund copilot. */

export type PaymentStatus = "authorized" | "captured" | "refunded" | "partially_refunded" | "failed";
export type OrderStatus = "pending" | "paid" | "shipped" | "delivered" | "cancelled" | "refunded";
export type ShipmentStatus = "label_created" | "in_transit" | "delivered" | "exception" | "returned";
export type CarrierExceptionType =
  | "damaged"
  | "lost"
  | "never_delivered"
  | "wrong_item"
  | null;
export type EscalationStatus = "pending" | "approved" | "rejected";
export type RefundStatus = "completed" | "pending_manager" | "failed";

export interface Customer {
  id: string;
  name: string;
  email: string;
  /** 0–100. Auto-refund requires riskScore < 70. */
  riskScore: number;
}

export interface Order {
  id: string;
  customerId: string;
  /** ISO date string (YYYY-MM-DD) of order placement. */
  createdAt: string;
  status: OrderStatus;
  /** Line items total in USD cents for clarity in seed; exposed as dollars in API. */
  currency: "USD";
  itemDescription: string;
  quantity: number;
}

export interface Payment {
  id: string;
  orderId: string;
  status: PaymentStatus;
  /** Amount actually captured from the customer, in USD. */
  amountPaid: number;
  /** Amount already refunded on this payment, in USD. */
  amountRefunded: number;
  capturedAt: string;
  chargebackFlag: boolean;
  disputeFlag: boolean;
}

export interface Shipment {
  id: string;
  orderId: string;
  carrier: string;
  trackingNumber: string;
  status: ShipmentStatus;
  /** Verified carrier exception that can justify a refund path. */
  carrierException: CarrierExceptionType;
  exceptionVerified: boolean;
  shippedAt: string | null;
  deliveredAt: string | null;
}

export interface Refund {
  id: string;
  orderId: string;
  paymentId: string;
  amount: number;
  /** Audit/escalation label. Idempotency uses (paymentId, amount), not action. */
  action: string;
  reason: string;
  status: RefundStatus;
  autoApproved: boolean;
  escalationId: string | null;
  createdAt: string;
}

export interface Escalation {
  id: string;
  orderId: string;
  paymentId: string;
  requestedAmount: number;
  action: string;
  reason: string;
  status: EscalationStatus;
  failedChecks: PolicyCheckResult[];
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  resultingRefundId: string | null;
}

export type PolicyCheckCode =
  | "amount_cap"
  | "not_over_paid"
  | "order_age"
  | "customer_risk"
  | "carrier_exception"
  | "no_duplicate_refund"
  | "payment_captured"
  | "no_chargeback_or_dispute";

export interface PolicyCheckResult {
  code: PolicyCheckCode;
  passed: boolean;
  message: string;
}

export interface EligibilityResult {
  eligibleForAutoRefund: boolean;
  orderId: string;
  paymentId: string;
  requestedAmount: number;
  action: string;
  checks: PolicyCheckResult[];
  failedChecks: PolicyCheckResult[];
  summary: string;
}

export interface IssueRefundResult {
  outcome: "auto_executed" | "escalated" | "rejected";
  message: string;
  refund: Refund | null;
  escalation: Escalation | null;
  eligibility: EligibilityResult;
}

/** Policy constants from the product boundary. */
export const POLICY = {
  /** Auto-execute only when refund is at most this many USD. */
  maxAutoRefundUsd: 150,
  /** Auto-execute only when order is no more than this many days old. */
  maxOrderAgeDays: 30,
  /** Auto-execute only when customer risk is strictly below this. */
  maxCustomerRiskExclusive: 70,
} as const;
