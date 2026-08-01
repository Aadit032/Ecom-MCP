import type { Store } from "./store.ts";
import {
  POLICY,
  type EligibilityResult,
  type Escalation,
  type IssueRefundResult,
  type PolicyCheckResult,
  type Refund,
} from "./types.ts";

export interface EligibilityInput {
  orderId: string;
  amount: number;
  /** Stable action key used for duplicate detection (e.g. "full_refund_damaged"). */
  action: string;
  /** Free-text reason for audit / escalation. */
  reason?: string;
}

/**
 * Evaluate all auto-refund policy checks without side effects.
 *
 * Auto-execute only when ALL pass:
 * - refund ≤ $150
 * - refund ≤ remaining paid amount (paid − already refunded)
 * - order ≤ 30 days old
 * - customer risk < 70
 * - verified carrier exception present
 * - no existing completed refund for the same action + amount
 * - payment captured (or partially refunded with headroom)
 * - no chargeback / dispute flag
 */
export function checkEligibility(
  store: Store,
  input: EligibilityInput,
  now: Date = new Date(),
): EligibilityResult {
  const checks: PolicyCheckResult[] = [];
  const order = store.getOrder(input.orderId);

  if (!order) {
    const missing: PolicyCheckResult = {
      code: "payment_captured",
      passed: false,
      message: `Order not found: ${input.orderId}`,
    };
    return {
      eligibleForAutoRefund: false,
      orderId: input.orderId,
      paymentId: "",
      requestedAmount: input.amount,
      action: input.action,
      checks: [missing],
      failedChecks: [missing],
      summary: `Order ${input.orderId} does not exist.`,
    };
  }

  const payment = store.getPaymentByOrder(order.id);
  const customer = store.getCustomer(order.customerId);
  const shipment = store.getShipmentByOrder(order.id);
  const amount = roundMoney(input.amount);

  // payment_captured
  if (!payment) {
    checks.push({
      code: "payment_captured",
      passed: false,
      message: "No payment found for this order.",
    });
  } else if (payment.status === "failed" || payment.status === "authorized") {
    checks.push({
      code: "payment_captured",
      passed: false,
      message: `Payment status is '${payment.status}'; must be captured before refund.`,
    });
  } else {
    checks.push({
      code: "payment_captured",
      passed: true,
      message: `Payment ${payment.id} is ${payment.status}.`,
    });
  }

  // no_chargeback_or_dispute
  if (!payment) {
    checks.push({
      code: "no_chargeback_or_dispute",
      passed: false,
      message: "Cannot verify chargeback/dispute without a payment.",
    });
  } else if (payment.chargebackFlag || payment.disputeFlag) {
    checks.push({
      code: "no_chargeback_or_dispute",
      passed: false,
      message: `Payment has dispute/chargeback flags (chargeback=${payment.chargebackFlag}, dispute=${payment.disputeFlag}). Must escalate; no auto refund.`,
    });
  } else {
    checks.push({
      code: "no_chargeback_or_dispute",
      passed: true,
      message: "No chargeback or dispute flags on payment.",
    });
  }

  // amount_cap
  if (amount > POLICY.maxAutoRefundUsd) {
    checks.push({
      code: "amount_cap",
      passed: false,
      message: `Requested $${amount.toFixed(2)} exceeds auto-refund cap of $${POLICY.maxAutoRefundUsd}.`,
    });
  } else if (amount <= 0) {
    checks.push({
      code: "amount_cap",
      passed: false,
      message: `Requested amount must be positive (got $${amount.toFixed(2)}).`,
    });
  } else {
    checks.push({
      code: "amount_cap",
      passed: true,
      message: `Requested $${amount.toFixed(2)} is within the $${POLICY.maxAutoRefundUsd} auto-refund cap.`,
    });
  }

  // not_over_paid (remaining balance)
  if (!payment) {
    checks.push({
      code: "not_over_paid",
      passed: false,
      message: "Cannot compare against paid amount without a payment.",
    });
  } else {
    const remaining = roundMoney(payment.amountPaid - payment.amountRefunded);
    if (amount > remaining) {
      checks.push({
        code: "not_over_paid",
        passed: false,
        message: `Requested $${amount.toFixed(2)} exceeds remaining refundable balance $${remaining.toFixed(2)} (paid $${payment.amountPaid.toFixed(2)}, already refunded $${payment.amountRefunded.toFixed(2)}).`,
      });
    } else {
      checks.push({
        code: "not_over_paid",
        passed: true,
        message: `Requested $${amount.toFixed(2)} ≤ remaining refundable $${remaining.toFixed(2)}.`,
      });
    }
  }

  // order_age
  const orderAgeDays = daysBetween(order.createdAt, now);
  if (orderAgeDays > POLICY.maxOrderAgeDays) {
    checks.push({
      code: "order_age",
      passed: false,
      message: `Order is ${orderAgeDays} days old (max ${POLICY.maxOrderAgeDays} for auto-refund).`,
    });
  } else {
    checks.push({
      code: "order_age",
      passed: true,
      message: `Order is ${orderAgeDays} days old (≤ ${POLICY.maxOrderAgeDays}).`,
    });
  }

  // customer_risk
  if (!customer) {
    checks.push({
      code: "customer_risk",
      passed: false,
      message: `Customer ${order.customerId} not found.`,
    });
  } else if (customer.riskScore >= POLICY.maxCustomerRiskExclusive) {
    checks.push({
      code: "customer_risk",
      passed: false,
      message: `Customer risk score ${customer.riskScore} is not below ${POLICY.maxCustomerRiskExclusive}.`,
    });
  } else {
    checks.push({
      code: "customer_risk",
      passed: true,
      message: `Customer risk score ${customer.riskScore} < ${POLICY.maxCustomerRiskExclusive}.`,
    });
  }

  // carrier_exception
  if (!shipment) {
    checks.push({
      code: "carrier_exception",
      passed: false,
      message: "No shipment found for this order; carrier exception cannot be verified.",
    });
  } else if (!shipment.carrierException || !shipment.exceptionVerified) {
    checks.push({
      code: "carrier_exception",
      passed: false,
      message: `No verified carrier exception (exception=${shipment.carrierException ?? "none"}, verified=${shipment.exceptionVerified}).`,
    });
  } else {
    checks.push({
      code: "carrier_exception",
      passed: true,
      message: `Verified carrier exception: ${shipment.carrierException}.`,
    });
  }

  // no_duplicate_refund
  const existing = store
    .listRefundsForOrder(order.id)
    .filter(
      (r) =>
        r.status === "completed" &&
        r.action === input.action &&
        roundMoney(r.amount) === amount,
    );
  if (existing.length > 0) {
    checks.push({
      code: "no_duplicate_refund",
      passed: false,
      message: `A completed refund already exists for action '${input.action}' and amount $${amount.toFixed(2)} (ids: ${existing.map((r) => r.id).join(", ")}).`,
    });
  } else {
    checks.push({
      code: "no_duplicate_refund",
      passed: true,
      message: `No completed refund for action '${input.action}' at $${amount.toFixed(2)}.`,
    });
  }

  const failedChecks = checks.filter((c) => !c.passed);
  const eligibleForAutoRefund = failedChecks.length === 0;
  const paymentId = payment?.id ?? "";

  return {
    eligibleForAutoRefund,
    orderId: order.id,
    paymentId,
    requestedAmount: amount,
    action: input.action,
    checks,
    failedChecks,
    summary: eligibleForAutoRefund
      ? `All policy checks passed. Refund of $${amount.toFixed(2)} for ${order.id} may auto-execute.`
      : `Auto-refund blocked (${failedChecks.length} failed check${failedChecks.length === 1 ? "" : "s"}). Create manager escalation; do not move money.`,
  };
}

/**
 * Guarded write path:
 * - If all policy checks pass → complete refund immediately (money moves).
 * - If any check fails → open a manager-approval escalation and move no money.
 *
 * Never completes a failed-policy refund via elicitation/confirmation.
 */
export function issueRefund(
  store: Store,
  input: EligibilityInput & { reason: string },
  now: Date = new Date(),
): IssueRefundResult {
  const eligibility = checkEligibility(store, input, now);

  if (!eligibility.paymentId || !store.getOrder(input.orderId)) {
    return {
      outcome: "rejected",
      message: eligibility.summary,
      refund: null,
      escalation: null,
      eligibility,
    };
  }

  if (eligibility.eligibleForAutoRefund) {
    const refund = store.recordCompletedRefund({
      orderId: eligibility.orderId,
      paymentId: eligibility.paymentId,
      amount: eligibility.requestedAmount,
      action: input.action,
      reason: input.reason,
      autoApproved: true,
      escalationId: null,
    });
    return {
      outcome: "auto_executed",
      message: `Auto-executed refund ${refund.id} for $${refund.amount.toFixed(2)} on ${refund.orderId}. Money moved.`,
      refund,
      escalation: null,
      eligibility,
    };
  }

  // Policy failure → escalate only. No money moves.
  const escalation = store.createEscalation({
    orderId: eligibility.orderId,
    paymentId: eligibility.paymentId,
    requestedAmount: eligibility.requestedAmount,
    action: input.action,
    reason: input.reason,
    failedChecks: eligibility.failedChecks,
  });

  return {
    outcome: "escalated",
    message: `Policy checks failed. Escalation ${escalation.id} created for manager approval. No money moved.`,
    refund: null,
    escalation,
    eligibility,
  };
}

/**
 * Manager resolution of a pending escalation.
 * Approving is the only way a previously blocked refund may complete.
 */
export function resolveEscalation(
  store: Store,
  input: {
    escalationId: string;
    decision: "approve" | "reject";
    resolvedBy: string;
    note?: string;
  },
): {
  ok: boolean;
  message: string;
  escalation: Escalation | null;
  refund: Refund | null;
} {
  const escalation = store.getEscalation(input.escalationId);
  if (!escalation) {
    return {
      ok: false,
      message: `Escalation not found: ${input.escalationId}`,
      escalation: null,
      refund: null,
    };
  }
  if (escalation.status !== "pending") {
    return {
      ok: false,
      message: `Escalation ${escalation.id} is already ${escalation.status}.`,
      escalation,
      refund: null,
    };
  }

  if (input.decision === "reject") {
    escalation.status = "rejected";
    escalation.resolvedAt = store.nowIso();
    escalation.resolvedBy = input.resolvedBy;
    escalation.resolutionNote = input.note ?? "Rejected by manager.";
    return {
      ok: true,
      message: `Escalation ${escalation.id} rejected. No money moved.`,
      escalation,
      refund: null,
    };
  }

  // Approve → re-validate remaining balance / duplicate before moving money.
  const payment = store.getPayment(escalation.paymentId);
  if (!payment) {
    return {
      ok: false,
      message: `Payment ${escalation.paymentId} missing; cannot approve.`,
      escalation,
      refund: null,
    };
  }

  const remaining = roundMoney(payment.amountPaid - payment.amountRefunded);
  if (escalation.requestedAmount > remaining) {
    escalation.status = "rejected";
    escalation.resolvedAt = store.nowIso();
    escalation.resolvedBy = input.resolvedBy;
    escalation.resolutionNote =
      input.note ??
      `Auto-rejected on approve: requested $${escalation.requestedAmount.toFixed(2)} exceeds remaining $${remaining.toFixed(2)}.`;
    return {
      ok: false,
      message: escalation.resolutionNote,
      escalation,
      refund: null,
    };
  }

  const dupes = store
    .listRefundsForOrder(escalation.orderId)
    .filter(
      (r) =>
        r.status === "completed" &&
        r.action === escalation.action &&
        roundMoney(r.amount) === roundMoney(escalation.requestedAmount),
    );
  if (dupes.length > 0) {
    escalation.status = "rejected";
    escalation.resolvedAt = store.nowIso();
    escalation.resolvedBy = input.resolvedBy;
    escalation.resolutionNote =
      input.note ??
      `Auto-rejected on approve: duplicate completed refund already exists (${dupes[0]!.id}).`;
    return {
      ok: false,
      message: escalation.resolutionNote,
      escalation,
      refund: null,
    };
  }

  const refund = store.recordCompletedRefund({
    orderId: escalation.orderId,
    paymentId: escalation.paymentId,
    amount: escalation.requestedAmount,
    action: escalation.action,
    reason: escalation.reason,
    autoApproved: false,
    escalationId: escalation.id,
  });

  escalation.status = "approved";
  escalation.resolvedAt = store.nowIso();
  escalation.resolvedBy = input.resolvedBy;
  escalation.resolutionNote = input.note ?? "Approved by manager.";
  escalation.resultingRefundId = refund.id;

  return {
    ok: true,
    message: `Escalation ${escalation.id} approved. Refund ${refund.id} completed for $${refund.amount.toFixed(2)}. Money moved under manager authority.`,
    escalation,
    refund,
  };
}

function daysBetween(orderDateIso: string, now: Date): number {
  const orderDate = new Date(orderDateIso.includes("T") ? orderDateIso : `${orderDateIso}T00:00:00.000Z`);
  const ms = now.getTime() - orderDate.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}
