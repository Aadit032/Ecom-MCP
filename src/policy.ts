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
  /** Stable action key used for audit / escalation (e.g. "full_refund_damaged"). */
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
 * - no existing completed refund for the same paymentId + amount (idempotency key)
 * - payment captured (or partially refunded with headroom)
 * - no chargeback / dispute flag
 */
export async function checkEligibility(
  store: Store,
  input: EligibilityInput,
  now: Date = new Date(),
): Promise<EligibilityResult> {
  const checks: PolicyCheckResult[] = [];
  const order = await store.getOrder(input.orderId);

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

  const payment = await store.getPaymentByOrder(order.id);
  const customer = await store.getCustomer(order.customerId);
  const shipment = await store.getShipmentByOrder(order.id);
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

  // no_duplicate_refund — unique key is (paymentId, amount)
  if (!payment) {
    checks.push({
      code: "no_duplicate_refund",
      passed: false,
      message: "Cannot check duplicate refunds without a payment.",
    });
  } else {
    const existing = (await store.listRefundsForOrder(order.id)).filter(
      (r) =>
        r.status === "completed" &&
        r.paymentId === payment.id &&
        roundMoney(r.amount) === amount,
    );
    if (existing.length > 0) {
      checks.push({
        code: "no_duplicate_refund",
        passed: false,
        message: `A completed refund already exists for payment '${payment.id}' and amount $${amount.toFixed(2)} (ids: ${existing.map((r) => r.id).join(", ")}).`,
      });
    } else {
      checks.push({
        code: "no_duplicate_refund",
        passed: true,
        message: `No completed refund for payment '${payment.id}' at $${amount.toFixed(2)}.`,
      });
    }
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
 * - Idempotent on (paymentId, amount): concurrent/retry auto-executes return the same refund.
 *
 * Never completes a failed-policy refund via elicitation/confirmation.
 */
export async function issueRefund(
  store: Store,
  input: EligibilityInput & { reason: string },
  now: Date = new Date(),
): Promise<IssueRefundResult> {
  const eligibility = await checkEligibility(store, input, now);

  if (!eligibility.paymentId || !(await store.getOrder(input.orderId))) {
    return {
      outcome: "rejected",
      message: eligibility.summary,
      refund: null,
      escalation: null,
      eligibility,
    };
  }

  if (eligibility.eligibleForAutoRefund) {
    const refund = await store.recordCompletedRefund({
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
  const escalation = await store.createEscalation({
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
 *
 * Stakeholder boundary (execution-time re-check):
 * - An escalation is NOT authorization for the MCP to bypass a failed policy check.
 * - On approve, re-run the full auto-refund policy at execution time.
 * - Money moves via this path only when every policy check passes now.
 * - If checks still fail, leave the escalation pending, move no money, and keep any
 *   true exception refund outside the automated MCP path.
 */
export async function resolveEscalation(
  store: Store,
  input: {
    escalationId: string;
    decision: "approve" | "reject";
    resolvedBy: string;
    note?: string;
  },
  now: Date = new Date(),
): Promise<{
  ok: boolean;
  message: string;
  escalation: Escalation | null;
  refund: Refund | null;
  eligibility: EligibilityResult | null;
}> {
  const escalation = await store.getEscalation(input.escalationId);
  if (!escalation) {
    return {
      ok: false,
      message: `Escalation not found: ${input.escalationId}`,
      escalation: null,
      refund: null,
      eligibility: null,
    };
  }
  if (escalation.status !== "pending") {
    return {
      ok: false,
      message: `Escalation ${escalation.id} is already ${escalation.status}.`,
      escalation,
      refund: null,
      eligibility: null,
    };
  }

  if (input.decision === "reject") {
    const updated = await store.updateEscalation(escalation.id, {
      status: "rejected",
      resolvedAt: store.nowIso(),
      resolvedBy: input.resolvedBy,
      resolutionNote: input.note ?? "Rejected by manager.",
    });
    return {
      ok: true,
      message: `Escalation ${updated.id} rejected. No money moved.`,
      escalation: updated,
      refund: null,
      eligibility: null,
    };
  }

  // Approve → re-check ALL auto-refund policy conditions at execution time.
  const eligibility = await checkEligibility(
    store,
    {
      orderId: escalation.orderId,
      amount: escalation.requestedAmount,
      action: escalation.action,
    },
    now,
  );

  if (!eligibility.eligibleForAutoRefund) {
    const failed = eligibility.failedChecks.map((c) => c.code).join(", ");
    return {
      ok: false,
      message: `Approve blocked for ${escalation.id}: policy still fails at execution time (${failed || "unknown"}). Escalation remains pending; no money moved. Automated path will not complete this refund while checks fail — resolve any exception refund outside this MCP.`,
      escalation,
      refund: null,
      eligibility,
    };
  }

  const payment = await store.getPayment(escalation.paymentId);
  if (!payment || !eligibility.paymentId) {
    return {
      ok: false,
      message: `Payment ${escalation.paymentId} missing; cannot complete refund.`,
      escalation,
      refund: null,
      eligibility,
    };
  }

  const refund = await store.recordCompletedRefund({
    orderId: escalation.orderId,
    paymentId: eligibility.paymentId,
    amount: escalation.requestedAmount,
    action: escalation.action,
    reason: escalation.reason,
    autoApproved: false,
    escalationId: escalation.id,
  });

  const updated = await store.updateEscalation(escalation.id, {
    status: "approved",
    resolvedAt: store.nowIso(),
    resolvedBy: input.resolvedBy,
    resolutionNote:
      input.note ??
      "Approved after policy re-check at execution time; all auto-refund checks passed.",
    resultingRefundId: refund.id,
  });

  return {
    ok: true,
    message: `Escalation ${updated.id} approved after full policy re-check. Refund ${refund.id} completed for $${refund.amount.toFixed(2)}. Money moved.`,
    escalation: updated,
    refund,
    eligibility,
  };
}

function daysBetween(orderDateIso: string, now: Date): number {
  const orderDate = new Date(
    orderDateIso.includes("T") ? orderDateIso : `${orderDateIso}T00:00:00.000Z`,
  );
  const ms = now.getTime() - orderDate.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}
