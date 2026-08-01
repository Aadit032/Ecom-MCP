import { describe, expect, test, beforeEach } from "bun:test";
import { Store } from "./store.ts";
import {
  checkEligibility,
  issueRefund,
  resolveEscalation,
} from "./policy.ts";

describe("checkEligibility", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store();
  });

  test("ord_auto_ok is eligible for full auto refund", () => {
    const result = checkEligibility(store, {
      orderId: "ord_auto_ok",
      amount: 89,
      action: "full_refund_damaged",
    });
    expect(result.eligibleForAutoRefund).toBe(true);
    expect(result.failedChecks).toHaveLength(0);
  });

  test("amount over $150 fails amount_cap", () => {
    const result = checkEligibility(store, {
      orderId: "ord_over_cap",
      amount: 249,
      action: "full_refund_lost",
    });
    expect(result.eligibleForAutoRefund).toBe(false);
    expect(result.failedChecks.some((c) => c.code === "amount_cap")).toBe(true);
  });

  test("order older than 30 days fails order_age", () => {
    const result = checkEligibility(store, {
      orderId: "ord_too_old",
      amount: 45,
      action: "full_refund_never_delivered",
    });
    expect(result.eligibleForAutoRefund).toBe(false);
    expect(result.failedChecks.some((c) => c.code === "order_age")).toBe(true);
  });

  test("high risk customer fails customer_risk", () => {
    const result = checkEligibility(store, {
      orderId: "ord_high_risk",
      amount: 39.98,
      action: "full_refund_wrong_item",
    });
    expect(result.eligibleForAutoRefund).toBe(false);
    expect(result.failedChecks.some((c) => c.code === "customer_risk")).toBe(
      true,
    );
  });

  test("missing carrier exception fails carrier_exception", () => {
    const result = checkEligibility(store, {
      orderId: "ord_no_exception",
      amount: 64,
      action: "goodwill_refund",
    });
    expect(result.eligibleForAutoRefund).toBe(false);
    expect(
      result.failedChecks.some((c) => c.code === "carrier_exception"),
    ).toBe(true);
  });

  test("duplicate action+amount fails no_duplicate_refund", () => {
    const result = checkEligibility(store, {
      orderId: "ord_already_refunded",
      amount: 79,
      action: "full_refund_damaged",
    });
    expect(result.eligibleForAutoRefund).toBe(false);
    expect(
      result.failedChecks.some((c) => c.code === "no_duplicate_refund"),
    ).toBe(true);
  });

  test("chargeback flag fails no_chargeback_or_dispute", () => {
    const result = checkEligibility(store, {
      orderId: "ord_chargeback",
      amount: 120,
      action: "full_refund_damaged",
    });
    expect(result.eligibleForAutoRefund).toBe(false);
    expect(
      result.failedChecks.some((c) => c.code === "no_chargeback_or_dispute"),
    ).toBe(true);
  });

  test("amount greater than remaining paid balance fails not_over_paid", () => {
    const result = checkEligibility(store, {
      orderId: "ord_partial_ok",
      amount: 70,
      action: "additional_refund",
    });
    expect(result.eligibleForAutoRefund).toBe(false);
    expect(result.failedChecks.some((c) => c.code === "not_over_paid")).toBe(
      true,
    );
  });

  test("partial remaining within policy is eligible", () => {
    const result = checkEligibility(store, {
      orderId: "ord_partial_ok",
      amount: 50,
      action: "balance_refund_damaged",
    });
    expect(result.eligibleForAutoRefund).toBe(true);
  });

  test("unknown order is not eligible", () => {
    const result = checkEligibility(store, {
      orderId: "ord_missing",
      amount: 10,
      action: "x",
    });
    expect(result.eligibleForAutoRefund).toBe(false);
  });
});

describe("issueRefund write path", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store();
  });

  test("auto-executes when all checks pass and moves money", () => {
    const before = store.getPaymentByOrder("ord_auto_ok")!;
    expect(before.amountRefunded).toBe(0);

    const result = issueRefund(store, {
      orderId: "ord_auto_ok",
      amount: 89,
      action: "full_refund_damaged",
      reason: "Carrier-verified damage",
    });

    expect(result.outcome).toBe("auto_executed");
    expect(result.refund).not.toBeNull();
    expect(result.escalation).toBeNull();
    expect(result.refund!.autoApproved).toBe(true);

    const after = store.getPaymentByOrder("ord_auto_ok")!;
    expect(after.amountRefunded).toBe(89);
    expect(after.status).toBe("refunded");
  });

  test("policy failure creates escalation and does not move money", () => {
    const before = store.getPaymentByOrder("ord_over_cap")!;
    const refundedBefore = before.amountRefunded;

    const result = issueRefund(store, {
      orderId: "ord_over_cap",
      amount: 249,
      action: "full_refund_lost",
      reason: "Package lost in transit",
    });

    expect(result.outcome).toBe("escalated");
    expect(result.refund).toBeNull();
    expect(result.escalation).not.toBeNull();
    expect(result.escalation!.status).toBe("pending");
    expect(result.escalation!.failedChecks.length).toBeGreaterThan(0);

    const after = store.getPaymentByOrder("ord_over_cap")!;
    expect(after.amountRefunded).toBe(refundedBefore);
  });

  test("high risk escalates with no money movement", () => {
    const result = issueRefund(store, {
      orderId: "ord_high_risk",
      amount: 39.98,
      action: "full_refund_wrong_item",
      reason: "Wrong item shipped",
    });
    expect(result.outcome).toBe("escalated");
    expect(store.getPaymentByOrder("ord_high_risk")!.amountRefunded).toBe(0);
    expect(store.listEscalations("pending")).toHaveLength(1);
  });

  test("duplicate refund escalates without double-paying", () => {
    const result = issueRefund(store, {
      orderId: "ord_already_refunded",
      amount: 79,
      action: "full_refund_damaged",
      reason: "Retry of completed refund",
    });
    expect(result.outcome).toBe("escalated");
    expect(store.getPaymentByOrder("ord_already_refunded")!.amountRefunded).toBe(
      79,
    );
  });
});

describe("resolveEscalation", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store();
  });

  test("manager approve completes refund after policy escalation", () => {
    const issued = issueRefund(store, {
      orderId: "ord_over_cap",
      amount: 249,
      action: "full_refund_lost",
      reason: "Lost package",
    });
    expect(issued.outcome).toBe("escalated");
    const escId = issued.escalation!.id;

    const resolved = resolveEscalation(store, {
      escalationId: escId,
      decision: "approve",
      resolvedBy: "mgr_jordan",
      note: "Verified with carrier claims team",
    });

    expect(resolved.ok).toBe(true);
    expect(resolved.refund).not.toBeNull();
    expect(resolved.refund!.autoApproved).toBe(false);
    expect(resolved.refund!.escalationId).toBe(escId);
    expect(store.getPaymentByOrder("ord_over_cap")!.amountRefunded).toBe(249);
    expect(store.getEscalation(escId)!.status).toBe("approved");
  });

  test("manager reject leaves money unmoved", () => {
    const issued = issueRefund(store, {
      orderId: "ord_no_exception",
      amount: 64,
      action: "goodwill_refund",
      reason: "Customer requested goodwill",
    });
    const escId = issued.escalation!.id;

    const resolved = resolveEscalation(store, {
      escalationId: escId,
      decision: "reject",
      resolvedBy: "mgr_sam",
      note: "No exception; deny goodwill",
    });

    expect(resolved.ok).toBe(true);
    expect(resolved.refund).toBeNull();
    expect(store.getPaymentByOrder("ord_no_exception")!.amountRefunded).toBe(0);
    expect(store.getEscalation(escId)!.status).toBe("rejected");
  });

  test("cannot resolve the same escalation twice", () => {
    const issued = issueRefund(store, {
      orderId: "ord_too_old",
      amount: 45,
      action: "full_refund_never_delivered",
      reason: "Never arrived",
    });
    const escId = issued.escalation!.id;

    resolveEscalation(store, {
      escalationId: escId,
      decision: "reject",
      resolvedBy: "mgr_a",
    });

    const second = resolveEscalation(store, {
      escalationId: escId,
      decision: "approve",
      resolvedBy: "mgr_b",
    });
    expect(second.ok).toBe(false);
    expect(store.getPaymentByOrder("ord_too_old")!.amountRefunded).toBe(0);
  });
});
