import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { assertWriteToken } from "./auth.ts";
import { prisma } from "./db.ts";
import { Store } from "./store.ts";
import {
  checkEligibility,
  issueRefund,
  resolveEscalation,
} from "./policy.ts";
import { POLICY } from "./types.ts";
import type { Customer, Order, Payment, Shipment } from "./types.ts";

/** Fixed evaluation clock so age math is deterministic. */
const NOW = new Date("2026-07-31T12:00:00.000Z");

function daysAgoIso(days: number, now: Date = NOW): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Install a minimal order graph for edge-case isolation. */
async function installFixture(
  store: Store,
  opts: {
    orderId: string;
    customer?: Partial<Customer>;
    payment?: Partial<Payment> | null;
    shipment?: Partial<Shipment> | null;
    orderAgeDays?: number;
  },
): Promise<void> {
  const orderId = opts.orderId;
  const customerId = opts.customer?.id ?? "cust_test";

  const customer: Customer = {
    id: customerId,
    name: "Fixture Customer",
    email: "fixture@example.com",
    riskScore: 20,
    ...opts.customer,
  };
  await store.upsertCustomer(customer);

  const order: Order = {
    id: orderId,
    customerId,
    createdAt: daysAgoIso(opts.orderAgeDays ?? 5),
    status: "delivered",
    currency: "USD",
    itemDescription: "Fixture item",
    quantity: 1,
  };
  await store.upsertOrder(order);

  if (opts.payment !== null && opts.payment !== undefined) {
    const payment: Payment = {
      id: `pay_${orderId}`,
      orderId,
      status: "captured",
      amountPaid: 100,
      amountRefunded: 0,
      capturedAt: daysAgoIso(opts.orderAgeDays ?? 5),
      chargebackFlag: false,
      disputeFlag: false,
      ...opts.payment,
    };
    await store.upsertPayment(payment);
  } else if (opts.payment === undefined) {
    const payment: Payment = {
      id: `pay_${orderId}`,
      orderId,
      status: "captured",
      amountPaid: 100,
      amountRefunded: 0,
      capturedAt: daysAgoIso(opts.orderAgeDays ?? 5),
      chargebackFlag: false,
      disputeFlag: false,
    };
    await store.upsertPayment(payment);
  }

  if (opts.shipment !== null && opts.shipment !== undefined) {
    const shipment: Shipment = {
      id: `shp_${orderId}`,
      orderId,
      carrier: "UPS",
      trackingNumber: "1ZFIX",
      status: "exception",
      carrierException: "damaged",
      exceptionVerified: true,
      shippedAt: daysAgoIso((opts.orderAgeDays ?? 5) - 1),
      deliveredAt: daysAgoIso((opts.orderAgeDays ?? 5) - 2),
      ...opts.shipment,
    };
    await store.upsertShipment(shipment);
  } else if (opts.shipment === undefined) {
    const shipment: Shipment = {
      id: `shp_${orderId}`,
      orderId,
      carrier: "UPS",
      trackingNumber: "1ZFIX",
      status: "exception",
      carrierException: "damaged",
      exceptionVerified: true,
      shippedAt: daysAgoIso((opts.orderAgeDays ?? 5) - 1),
      deliveredAt: daysAgoIso((opts.orderAgeDays ?? 5) - 2),
    };
    await store.upsertShipment(shipment);
  }
}

function failedCodes(result: { failedChecks: { code: string }[] }): string[] {
  return result.failedChecks.map((c) => c.code);
}

/** Fresh store seeded relative to the fixed evaluation clock (see NOW). */
async function freshStore(): Promise<Store> {
  const store = new Store();
  await store.reset(NOW);
  return store;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("checkEligibility — seed scenarios", () => {
  let store: Store;

  beforeEach(async () => {
    store = await freshStore();
  });

  test("ord_auto_ok is eligible for full auto refund", async () => {
    const result = await checkEligibility(
      store,
      { orderId: "ord_auto_ok", amount: 89, action: "full_refund_damaged" },
      NOW,
    );
    expect(result.eligibleForAutoRefund).toBe(true);
    expect(result.failedChecks).toHaveLength(0);
  });

  test("amount over $150 fails amount_cap", async () => {
    const result = await checkEligibility(
      store,
      { orderId: "ord_over_cap", amount: 249, action: "full_refund_lost" },
      NOW,
    );
    expect(result.eligibleForAutoRefund).toBe(false);
    expect(failedCodes(result)).toContain("amount_cap");
  });

  test("order older than 30 days fails order_age", async () => {
    const result = await checkEligibility(
      store,
      {
        orderId: "ord_too_old",
        amount: 45,
        action: "full_refund_never_delivered",
      },
      NOW,
    );
    expect(result.eligibleForAutoRefund).toBe(false);
    expect(failedCodes(result)).toContain("order_age");
  });

  test("high risk customer fails customer_risk", async () => {
    const result = await checkEligibility(
      store,
      {
        orderId: "ord_high_risk",
        amount: 39.98,
        action: "full_refund_wrong_item",
      },
      NOW,
    );
    expect(result.eligibleForAutoRefund).toBe(false);
    expect(failedCodes(result)).toContain("customer_risk");
  });

  test("missing carrier exception fails carrier_exception", async () => {
    const result = await checkEligibility(
      store,
      { orderId: "ord_no_exception", amount: 64, action: "full_refund_damaged" },
      NOW,
    );
    expect(result.eligibleForAutoRefund).toBe(false);
    expect(failedCodes(result)).toContain("carrier_exception");
  });

  test("duplicate paymentId+amount fails no_duplicate_refund", async () => {
    const result = await checkEligibility(
      store,
      {
        orderId: "ord_already_refunded",
        amount: 79,
        action: "full_refund_damaged",
      },
      NOW,
    );
    expect(result.eligibleForAutoRefund).toBe(false);
    expect(failedCodes(result)).toContain("no_duplicate_refund");
  });

  test("chargeback flag fails no_chargeback_or_dispute", async () => {
    const result = await checkEligibility(
      store,
      {
        orderId: "ord_chargeback",
        amount: 120,
        action: "full_refund_damaged",
      },
      NOW,
    );
    expect(result.eligibleForAutoRefund).toBe(false);
    expect(failedCodes(result)).toContain("no_chargeback_or_dispute");
  });

  test("amount greater than remaining paid balance fails not_over_paid", async () => {
    const result = await checkEligibility(
      store,
      { orderId: "ord_partial_ok", amount: 70, action: "full_refund_damaged" },
      NOW,
    );
    expect(result.eligibleForAutoRefund).toBe(false);
    expect(failedCodes(result)).toContain("not_over_paid");
  });

  test("partial remaining within policy is eligible", async () => {
    const result = await checkEligibility(
      store,
      {
        orderId: "ord_partial_ok",
        amount: 50,
        action: "full_refund_damaged",
      },
      NOW,
    );
    expect(result.eligibleForAutoRefund).toBe(true);
  });
});

describe("checkEligibility — missing graph nodes", () => {
  let store: Store;

  beforeEach(async () => {
    store = await freshStore();
  });

  test("unknown order is not eligible", async () => {
    const result = await checkEligibility(
      store,
      { orderId: "ord_missing", amount: 10, action: "x" },
      NOW,
    );
    expect(result.eligibleForAutoRefund).toBe(false);
    expect(result.paymentId).toBe("");
    expect(result.summary).toContain("does not exist");
  });

  test("missing payment fails payment_captured and related checks", async () => {
    await installFixture(store, { orderId: "ord_no_pay", payment: null });
    const result = await checkEligibility(
      store,
      { orderId: "ord_no_pay", amount: 25, action: "refund" },
      NOW,
    );
    expect(result.eligibleForAutoRefund).toBe(false);
    expect(failedCodes(result)).toContain("payment_captured");
    expect(failedCodes(result)).toContain("not_over_paid");
    expect(failedCodes(result)).toContain("no_chargeback_or_dispute");
    expect(result.paymentId).toBe("");
  });

  test("missing shipment fails carrier_exception", async () => {
    await installFixture(store, {
      orderId: "ord_no_ship",
      shipment: null,
    });
    const result = await checkEligibility(
      store,
      { orderId: "ord_no_ship", amount: 25, action: "refund" },
      NOW,
    );
    expect(result.eligibleForAutoRefund).toBe(false);
    expect(failedCodes(result)).toContain("carrier_exception");
    expect(
      result.failedChecks.find((c) => c.code === "carrier_exception")!.message,
    ).toContain("No shipment found");
  });

  test("unverified carrier exception fails carrier_exception", async () => {
    await installFixture(store, {
      orderId: "ord_unverified_exc",
      shipment: {
        carrierException: "damaged",
        exceptionVerified: false,
      },
    });
    const result = await checkEligibility(
      store,
      { orderId: "ord_unverified_exc", amount: 25, action: "refund" },
      NOW,
    );
    expect(result.eligibleForAutoRefund).toBe(false);
    expect(failedCodes(result)).toContain("carrier_exception");
  });

  test("null exception with verified=true still fails carrier_exception", async () => {
    await installFixture(store, {
      orderId: "ord_null_exc",
      shipment: {
        carrierException: null,
        exceptionVerified: true,
        status: "delivered",
      },
    });
    const result = await checkEligibility(
      store,
      { orderId: "ord_null_exc", amount: 25, action: "refund" },
      NOW,
    );
    expect(failedCodes(result)).toContain("carrier_exception");
  });
});

describe("checkEligibility — payment status", () => {
  let store: Store;

  beforeEach(async () => {
    store = await freshStore();
  });

  test("authorized payment fails payment_captured", async () => {
    await installFixture(store, {
      orderId: "ord_auth_only",
      payment: { status: "authorized", amountPaid: 50, amountRefunded: 0 },
    });
    const result = await checkEligibility(
      store,
      { orderId: "ord_auth_only", amount: 25, action: "refund" },
      NOW,
    );
    expect(failedCodes(result)).toContain("payment_captured");
    expect(
      result.failedChecks.find((c) => c.code === "payment_captured")!.message,
    ).toContain("authorized");
  });

  test("failed payment fails payment_captured", async () => {
    await installFixture(store, {
      orderId: "ord_pay_failed",
      payment: { status: "failed", amountPaid: 0, amountRefunded: 0 },
    });
    const result = await checkEligibility(
      store,
      { orderId: "ord_pay_failed", amount: 10, action: "refund" },
      NOW,
    );
    expect(failedCodes(result)).toContain("payment_captured");
    expect(
      result.failedChecks.find((c) => c.code === "payment_captured")!.message,
    ).toContain("failed");
  });

  test("partially_refunded with headroom can pass payment_captured", async () => {
    await installFixture(store, {
      orderId: "ord_partial_status",
      payment: {
        status: "partially_refunded",
        amountPaid: 100,
        amountRefunded: 40,
      },
    });
    const result = await checkEligibility(
      store,
      { orderId: "ord_partial_status", amount: 50, action: "more" },
      NOW,
    );
    expect(
      result.checks.find((c) => c.code === "payment_captured")!.passed,
    ).toBe(true);
    expect(result.eligibleForAutoRefund).toBe(true);
  });
});

describe("checkEligibility — amount_cap edge values", () => {
  let store: Store;

  beforeEach(async () => {
    store = await freshStore();
    await installFixture(store, {
      orderId: "ord_cap",
      payment: { amountPaid: 200, amountRefunded: 0 },
    });
  });

  test("amount <= 0 fails amount_cap", async () => {
    const zero = await checkEligibility(
      store,
      { orderId: "ord_cap", amount: 0, action: "z" },
      NOW,
    );
    expect(failedCodes(zero)).toContain("amount_cap");
    expect(
      zero.failedChecks.find((c) => c.code === "amount_cap")!.message,
    ).toContain("must be positive");

    const negative = await checkEligibility(
      store,
      { orderId: "ord_cap", amount: -5, action: "z" },
      NOW,
    );
    expect(failedCodes(negative)).toContain("amount_cap");
  });

  test("exactly $150 passes amount_cap (inclusive boundary)", async () => {
    const result = await checkEligibility(
      store,
      { orderId: "ord_cap", amount: POLICY.maxAutoRefundUsd, action: "cap" },
      NOW,
    );
    expect(
      result.checks.find((c) => c.code === "amount_cap")!.passed,
    ).toBe(true);
    expect(result.eligibleForAutoRefund).toBe(true);
  });

  test("$150.01 fails amount_cap", async () => {
    const result = await checkEligibility(
      store,
      {
        orderId: "ord_cap",
        amount: POLICY.maxAutoRefundUsd + 0.01,
        action: "cap",
      },
      NOW,
    );
    expect(failedCodes(result)).toContain("amount_cap");
  });
});

describe("checkEligibility — order age and risk boundaries", () => {
  let store: Store;

  beforeEach(async () => {
    store = await freshStore();
  });

  test("exactly 30 days old passes order_age (inclusive)", async () => {
    await installFixture(store, {
      orderId: "ord_age_30",
      orderAgeDays: POLICY.maxOrderAgeDays,
    });
    const result = await checkEligibility(
      store,
      { orderId: "ord_age_30", amount: 20, action: "a" },
      NOW,
    );
    expect(result.checks.find((c) => c.code === "order_age")!.passed).toBe(
      true,
    );
    expect(result.eligibleForAutoRefund).toBe(true);
  });

  test("31 days old fails order_age", async () => {
    await installFixture(store, {
      orderId: "ord_age_31",
      orderAgeDays: POLICY.maxOrderAgeDays + 1,
    });
    const result = await checkEligibility(
      store,
      { orderId: "ord_age_31", amount: 20, action: "a" },
      NOW,
    );
    expect(failedCodes(result)).toContain("order_age");
  });

  test("injected now clock changes age outcome", async () => {
    await installFixture(store, {
      orderId: "ord_clock",
      orderAgeDays: 10,
    });
    const young = await checkEligibility(
      store,
      { orderId: "ord_clock", amount: 20, action: "a" },
      NOW,
    );
    expect(young.checks.find((c) => c.code === "order_age")!.passed).toBe(
      true,
    );

    const later = new Date(NOW);
    later.setUTCDate(later.getUTCDate() + 40);
    const old = await checkEligibility(
      store,
      { orderId: "ord_clock", amount: 20, action: "a" },
      later,
    );
    expect(failedCodes(old)).toContain("order_age");
  });

  test("risk exactly 70 fails customer_risk (exclusive threshold)", async () => {
    await installFixture(store, {
      orderId: "ord_risk_70",
      customer: { id: "cust_70", riskScore: POLICY.maxCustomerRiskExclusive },
    });
    const result = await checkEligibility(
      store,
      { orderId: "ord_risk_70", amount: 20, action: "a" },
      NOW,
    );
    expect(failedCodes(result)).toContain("customer_risk");
  });

  test("risk 69 passes customer_risk", async () => {
    await installFixture(store, {
      orderId: "ord_risk_69",
      customer: {
        id: "cust_69",
        riskScore: POLICY.maxCustomerRiskExclusive - 1,
      },
    });
    const result = await checkEligibility(
      store,
      { orderId: "ord_risk_69", amount: 20, action: "a" },
      NOW,
    );
    expect(
      result.checks.find((c) => c.code === "customer_risk")!.passed,
    ).toBe(true);
    expect(result.eligibleForAutoRefund).toBe(true);
  });

  test("amount equal to remaining balance passes not_over_paid", async () => {
    await installFixture(store, {
      orderId: "ord_exact_bal",
      payment: { amountPaid: 80, amountRefunded: 30 },
    });
    const result = await checkEligibility(
      store,
      { orderId: "ord_exact_bal", amount: 50, action: "exact" },
      NOW,
    );
    expect(
      result.checks.find((c) => c.code === "not_over_paid")!.passed,
    ).toBe(true);
    expect(result.eligibleForAutoRefund).toBe(true);
  });

  test("disputeFlag alone fails no_chargeback_or_dispute", async () => {
    await installFixture(store, {
      orderId: "ord_dispute_only",
      payment: { disputeFlag: true, chargebackFlag: false },
    });
    const result = await checkEligibility(
      store,
      { orderId: "ord_dispute_only", amount: 20, action: "a" },
      NOW,
    );
    expect(failedCodes(result)).toContain("no_chargeback_or_dispute");
  });
});

describe("issueRefund write path", () => {
  let store: Store;

  beforeEach(async () => {
    store = await freshStore();
  });

  test("auto-executes when all checks pass and moves money", async () => {
    const before = (await store.getPaymentByOrder("ord_auto_ok"))!;
    expect(before.amountRefunded).toBe(0);

    const result = await issueRefund(
      store,
      {
        orderId: "ord_auto_ok",
        amount: 89,
        action: "full_refund_damaged",
        reason: "Damaged earbuds",
      },
      NOW,
    );

    expect(result.outcome).toBe("auto_executed");
    expect(result.refund).not.toBeNull();
    expect(result.escalation).toBeNull();
    expect(result.refund!.autoApproved).toBe(true);

    const after = (await store.getPaymentByOrder("ord_auto_ok"))!;
    expect(after.amountRefunded).toBe(89);
    expect(after.status).toBe("refunded");
    expect((await store.getOrder("ord_auto_ok"))!.status).toBe("refunded");
  });

  test("idempotent: same paymentId+amount does not double-pay", async () => {
    const first = await issueRefund(
      store,
      {
        orderId: "ord_auto_ok",
        amount: 89,
        action: "full_refund_damaged",
        reason: "Damaged earbuds",
      },
      NOW,
    );
    expect(first.outcome).toBe("auto_executed");
    const refundId = first.refund!.id;

    // Second call is blocked by policy (duplicate) and escalates — money stays at 89.
    // Direct store path: recordCompletedRefund is idempotent if race past check.
    const again = await store.recordCompletedRefund({
      orderId: "ord_auto_ok",
      paymentId: "pay_auto_ok",
      amount: 89,
      action: "full_refund_damaged",
      reason: "retry",
      autoApproved: true,
      escalationId: null,
    });
    expect(again.id).toBe(refundId);
    expect((await store.getPaymentByOrder("ord_auto_ok"))!.amountRefunded).toBe(
      89,
    );

    const refunds = await store.listRefundsForOrder("ord_auto_ok");
    expect(refunds.filter((r) => r.amount === 89)).toHaveLength(1);
  });

  test("nonexistent order is rejected (no refund, no escalation)", async () => {
    const result = await issueRefund(
      store,
      {
        orderId: "ord_does_not_exist",
        amount: 25,
        action: "x",
        reason: "ghost order",
      },
      NOW,
    );
    expect(result.outcome).toBe("rejected");
    expect(result.refund).toBeNull();
    expect(result.escalation).toBeNull();
    expect(await store.listEscalations()).toHaveLength(0);
  });

  test("order with no payment is rejected (cannot escalate without paymentId)", async () => {
    await installFixture(store, { orderId: "ord_reject_nopay", payment: null });
    const result = await issueRefund(
      store,
      {
        orderId: "ord_reject_nopay",
        amount: 25,
        action: "x",
        reason: "no pay",
      },
      NOW,
    );
    expect(result.outcome).toBe("rejected");
    expect(result.refund).toBeNull();
    expect(result.escalation).toBeNull();
  });

  test("policy failure creates escalation and does not move money", async () => {
    const before = (await store.getPaymentByOrder("ord_over_cap"))!;
    const refundedBefore = before.amountRefunded;

    const result = await issueRefund(
      store,
      {
        orderId: "ord_over_cap",
        amount: 249,
        action: "full_refund_lost",
        reason: "Package lost in transit",
      },
      NOW,
    );

    expect(result.outcome).toBe("escalated");
    expect(result.refund).toBeNull();
    expect(result.escalation).not.toBeNull();
    expect(result.escalation!.status).toBe("pending");
    expect(result.escalation!.failedChecks.length).toBeGreaterThan(0);
    expect(failedCodes(result.eligibility)).toContain("amount_cap");

    const after = (await store.getPaymentByOrder("ord_over_cap"))!;
    expect(after.amountRefunded).toBe(refundedBefore);
  });

  test("chargeback issue escalates with no money movement", async () => {
    const result = await issueRefund(
      store,
      {
        orderId: "ord_chargeback",
        amount: 120,
        action: "full_refund_damaged",
        reason: "Customer request despite chargeback",
      },
      NOW,
    );
    expect(result.outcome).toBe("escalated");
    expect(result.refund).toBeNull();
    expect(failedCodes(result.eligibility)).toContain(
      "no_chargeback_or_dispute",
    );
    expect(
      (await store.getPaymentByOrder("ord_chargeback"))!.amountRefunded,
    ).toBe(0);
  });

  test("zero amount escalates (policy fail) rather than auto-executing", async () => {
    await installFixture(store, { orderId: "ord_zero" });
    const result = await issueRefund(
      store,
      {
        orderId: "ord_zero",
        amount: 0,
        action: "zero",
        reason: "bad amount",
      },
      NOW,
    );
    expect(result.outcome).toBe("escalated");
    expect(result.refund).toBeNull();
    expect((await store.getPaymentByOrder("ord_zero"))!.amountRefunded).toBe(0);
  });

  test("high risk escalates with no money movement", async () => {
    const result = await issueRefund(
      store,
      {
        orderId: "ord_high_risk",
        amount: 39.98,
        action: "full_refund_wrong_item",
        reason: "Wrong item shipped",
      },
      NOW,
    );
    expect(result.outcome).toBe("escalated");
    expect(
      (await store.getPaymentByOrder("ord_high_risk"))!.amountRefunded,
    ).toBe(0);
    expect(await store.listEscalations("pending")).toHaveLength(1);
  });

  test("duplicate refund escalates without double-paying", async () => {
    const result = await issueRefund(
      store,
      {
        orderId: "ord_already_refunded",
        amount: 79,
        action: "full_refund_damaged",
        reason: "Retry of completed refund",
      },
      NOW,
    );
    expect(result.outcome).toBe("escalated");
    expect(
      (await store.getPaymentByOrder("ord_already_refunded"))!.amountRefunded,
    ).toBe(79);
  });

  test("partial refund marks payment partially_refunded and leaves order not fully refunded", async () => {
    await installFixture(store, {
      orderId: "ord_partial_move",
      payment: { amountPaid: 100, amountRefunded: 0, status: "captured" },
    });

    const result = await issueRefund(
      store,
      {
        orderId: "ord_partial_move",
        amount: 40,
        action: "partial",
        reason: "Partial credit",
      },
      NOW,
    );

    expect(result.outcome).toBe("auto_executed");
    const payment = (await store.getPaymentByOrder("ord_partial_move"))!;
    expect(payment.amountRefunded).toBe(40);
    expect(payment.status).toBe("partially_refunded");
    expect((await store.getOrder("ord_partial_move"))!.status).toBe("delivered");
  });

  test("full remaining refund flips payment and order to refunded", async () => {
    await installFixture(store, {
      orderId: "ord_full_flip",
      payment: {
        amountPaid: 100,
        amountRefunded: 40,
        status: "partially_refunded",
      },
    });

    const result = await issueRefund(
      store,
      {
        orderId: "ord_full_flip",
        amount: 60,
        action: "rest",
        reason: "Remainder",
      },
      NOW,
    );

    expect(result.outcome).toBe("auto_executed");
    const payment = (await store.getPaymentByOrder("ord_full_flip"))!;
    expect(payment.amountRefunded).toBe(100);
    expect(payment.status).toBe("refunded");
    expect((await store.getOrder("ord_full_flip"))!.status).toBe("refunded");
  });

  test("authorized payment escalates (payment exists) and moves no money", async () => {
    await installFixture(store, {
      orderId: "ord_auth_issue",
      payment: { status: "authorized", amountPaid: 50 },
    });
    const result = await issueRefund(
      store,
      {
        orderId: "ord_auth_issue",
        amount: 20,
        action: "a",
        reason: "too early",
      },
      NOW,
    );
    expect(result.outcome).toBe("escalated");
    expect(
      (await store.getPaymentByOrder("ord_auth_issue"))!.amountRefunded,
    ).toBe(0);
  });

  test("exactly $150 auto-executes when other checks pass", async () => {
    await installFixture(store, {
      orderId: "ord_150",
      payment: { amountPaid: 200, amountRefunded: 0 },
    });
    const result = await issueRefund(
      store,
      {
        orderId: "ord_150",
        amount: 150,
        action: "cap",
        reason: "boundary",
      },
      NOW,
    );
    expect(result.outcome).toBe("auto_executed");
    expect((await store.getPaymentByOrder("ord_150"))!.amountRefunded).toBe(
      150,
    );
    expect((await store.getPaymentByOrder("ord_150"))!.status).toBe(
      "partially_refunded",
    );
  });

  test("same payment different amount is not treated as duplicate", async () => {
    // ord_already_refunded has completed refund @ $79 for pay_already_refunded
    // A different amount should not hit no_duplicate_refund — but remaining is 0
    const result = await checkEligibility(
      store,
      {
        orderId: "ord_already_refunded",
        amount: 10,
        action: "full_refund_damaged",
      },
      NOW,
    );
    expect(failedCodes(result)).not.toContain("no_duplicate_refund");
    expect(failedCodes(result)).toContain("not_over_paid");
  });
});

describe("resolveEscalation", () => {
  let store: Store;

  beforeEach(async () => {
    store = await freshStore();
  });

  test("approve does not bypass still-failing policy (amount_cap) — no money moved", async () => {
    const issued = await issueRefund(
      store,
      {
        orderId: "ord_over_cap",
        amount: 249,
        action: "full_refund_lost",
        reason: "Lost package",
      },
      NOW,
    );
    expect(issued.outcome).toBe("escalated");
    const escId = issued.escalation!.id;
    const refundedBefore = (await store.getPaymentByOrder("ord_over_cap"))!
      .amountRefunded;

    const resolved = await resolveEscalation(
      store,
      {
        escalationId: escId,
        decision: "approve",
        resolvedBy: "mgr_jordan",
        note: "Want to refund despite cap",
      },
      NOW,
    );

    expect(resolved.ok).toBe(false);
    expect(resolved.refund).toBeNull();
    expect(resolved.eligibility).not.toBeNull();
    expect(failedCodes(resolved.eligibility!)).toContain("amount_cap");
    expect((await store.getEscalation(escId))!.status).toBe("pending");
    expect(
      (await store.getPaymentByOrder("ord_over_cap"))!.amountRefunded,
    ).toBe(refundedBefore);
    expect(resolved.message.toLowerCase()).toContain("policy still fails");
  });

  test("over-cap still not auto-payable after blocked approve (re-issue escalates)", async () => {
    const first = await issueRefund(
      store,
      {
        orderId: "ord_over_cap",
        amount: 249,
        action: "full_refund_lost",
        reason: "Lost package",
      },
      NOW,
    );
    expect(first.outcome).toBe("escalated");
    const escId = first.escalation!.id;

    const blocked = await resolveEscalation(
      store,
      {
        escalationId: escId,
        decision: "approve",
        resolvedBy: "mgr_jordan",
        note: "Attempt override",
      },
      NOW,
    );
    expect(blocked.ok).toBe(false);
    expect((await store.getEscalation(escId))!.status).toBe("pending");
    expect(
      (await store.getPaymentByOrder("ord_over_cap"))!.amountRefunded,
    ).toBe(0);

    const second = await issueRefund(
      store,
      {
        orderId: "ord_over_cap",
        amount: 249,
        action: "full_refund_lost",
        reason: "Lost package retry",
      },
      NOW,
    );
    expect(second.outcome).toBe("escalated");
    expect(second.refund).toBeNull();
    expect(failedCodes(second.eligibility)).toContain("amount_cap");
    expect(
      (await store.getPaymentByOrder("ord_over_cap"))!.amountRefunded,
    ).toBe(0);
  });

  test("approve completes refund only after full policy re-check passes", async () => {
    await installFixture(store, {
      orderId: "ord_risk_then_clear",
      payment: { amountPaid: 80, amountRefunded: 0 },
      customer: { id: "cust_risk_clear", riskScore: 90 },
    });

    const issued = await issueRefund(
      store,
      {
        orderId: "ord_risk_then_clear",
        amount: 50,
        action: "full_refund_damaged",
        reason: "Damaged; high risk at open",
      },
      NOW,
    );
    expect(issued.outcome).toBe("escalated");
    const escId = issued.escalation!.id;

    await store.updateCustomerRisk("cust_risk_clear", 20);

    const resolved = await resolveEscalation(
      store,
      {
        escalationId: escId,
        decision: "approve",
        resolvedBy: "mgr_jordan",
        note: "Risk refreshed; conditions clear",
      },
      NOW,
    );

    expect(resolved.ok).toBe(true);
    expect(resolved.refund).not.toBeNull();
    expect(resolved.refund!.autoApproved).toBe(false);
    expect(resolved.refund!.escalationId).toBe(escId);
    expect(resolved.eligibility!.eligibleForAutoRefund).toBe(true);
    expect(
      (await store.getPaymentByOrder("ord_risk_then_clear"))!.amountRefunded,
    ).toBe(50);
    expect((await store.getEscalation(escId))!.status).toBe("approved");
  });

  test("manager reject leaves money unmoved", async () => {
    const issued = await issueRefund(
      store,
      {
        orderId: "ord_too_old",
        amount: 45,
        action: "full_refund_never_delivered",
        reason: "Never arrived",
      },
      NOW,
    );
    expect(issued.outcome).toBe("escalated");
    const escId = issued.escalation!.id;

    const resolved = await resolveEscalation(
      store,
      {
        escalationId: escId,
        decision: "reject",
        resolvedBy: "mgr_sam",
        note: "Outside policy; deny.",
      },
      NOW,
    );

    expect(resolved.ok).toBe(true);
    expect(resolved.refund).toBeNull();
    expect(resolved.eligibility).toBeNull();
    expect((await store.getPaymentByOrder("ord_too_old"))!.amountRefunded).toBe(
      0,
    );
    expect((await store.getEscalation(escId))!.status).toBe("rejected");
  });

  test("nonexistent escalation returns ok=false", async () => {
    const resolved = await resolveEscalation(store, {
      escalationId: "esc_does_not_exist",
      decision: "approve",
      resolvedBy: "mgr_x",
    });
    expect(resolved.ok).toBe(false);
    expect(resolved.escalation).toBeNull();
    expect(resolved.refund).toBeNull();
    expect(resolved.eligibility).toBeNull();
    expect(resolved.message).toContain("not found");
  });

  test("cannot resolve the same escalation twice after reject", async () => {
    const issued = await issueRefund(
      store,
      {
        orderId: "ord_too_old",
        amount: 45,
        action: "full_refund_never_delivered",
        reason: "Never arrived",
      },
      NOW,
    );
    const escId = issued.escalation!.id;

    await resolveEscalation(store, {
      escalationId: escId,
      decision: "reject",
      resolvedBy: "mgr_a",
    });

    const second = await resolveEscalation(store, {
      escalationId: escId,
      decision: "approve",
      resolvedBy: "mgr_b",
    });
    expect(second.ok).toBe(false);
    expect((await store.getPaymentByOrder("ord_too_old"))!.amountRefunded).toBe(
      0,
    );
  });

  test("approve blocked (not auto-closed) when remaining balance insufficient while pending", async () => {
    await installFixture(store, {
      orderId: "ord_race_balance",
      payment: { amountPaid: 100, amountRefunded: 0 },
      customer: { id: "cust_race", riskScore: 90 },
    });

    const issued = await issueRefund(
      store,
      {
        orderId: "ord_race_balance",
        amount: 80,
        action: "race",
        reason: "high risk",
      },
      NOW,
    );
    expect(issued.outcome).toBe("escalated");
    const escId = issued.escalation!.id;

    await store.recordCompletedRefund({
      orderId: "ord_race_balance",
      paymentId: `pay_ord_race_balance`,
      amount: 50,
      action: "other_action",
      reason: "intervening refund",
      autoApproved: true,
      escalationId: null,
    });

    await store.updateCustomerRisk("cust_race", 10);

    const resolved = await resolveEscalation(
      store,
      {
        escalationId: escId,
        decision: "approve",
        resolvedBy: "mgr_race",
      },
      NOW,
    );

    expect(resolved.ok).toBe(false);
    expect(resolved.refund).toBeNull();
    expect((await store.getEscalation(escId))!.status).toBe("pending");
    expect(failedCodes(resolved.eligibility!)).toContain("not_over_paid");
    expect(
      (await store.getPaymentByOrder("ord_race_balance"))!.amountRefunded,
    ).toBe(50);
  });

  test("approve blocked when a duplicate refund appeared while pending", async () => {
    await installFixture(store, {
      orderId: "ord_race_dupe",
      payment: { amountPaid: 100, amountRefunded: 0 },
      customer: { id: "cust_dupe", riskScore: 95 },
    });

    const issued = await issueRefund(
      store,
      {
        orderId: "ord_race_dupe",
        amount: 40,
        action: "same_action",
        reason: "escalate first",
      },
      NOW,
    );
    expect(issued.outcome).toBe("escalated");
    const escId = issued.escalation!.id;

    await store.recordCompletedRefund({
      orderId: "ord_race_dupe",
      paymentId: "pay_ord_race_dupe",
      amount: 40,
      action: "same_action",
      reason: "parallel auto path",
      autoApproved: true,
      escalationId: null,
    });

    await store.updateCustomerRisk("cust_dupe", 10);

    const resolved = await resolveEscalation(
      store,
      {
        escalationId: escId,
        decision: "approve",
        resolvedBy: "mgr_dupe",
      },
      NOW,
    );

    expect(resolved.ok).toBe(false);
    expect(resolved.refund).toBeNull();
    expect((await store.getEscalation(escId))!.status).toBe("pending");
    expect(failedCodes(resolved.eligibility!)).toContain("no_duplicate_refund");
    expect(
      (await store.getPaymentByOrder("ord_race_dupe"))!.amountRefunded,
    ).toBe(40);
  });

  test("approve still blocked for chargeback even if manager approves", async () => {
    const issued = await issueRefund(
      store,
      {
        orderId: "ord_chargeback",
        amount: 120,
        action: "full_refund_damaged",
        reason: "Despite chargeback",
      },
      NOW,
    );
    expect(issued.outcome).toBe("escalated");
    const escId = issued.escalation!.id;

    const resolved = await resolveEscalation(
      store,
      {
        escalationId: escId,
        decision: "approve",
        resolvedBy: "mgr_override",
      },
      NOW,
    );

    expect(resolved.ok).toBe(false);
    expect(resolved.refund).toBeNull();
    expect(failedCodes(resolved.eligibility!)).toContain(
      "no_chargeback_or_dispute",
    );
    expect(
      (await store.getPaymentByOrder("ord_chargeback"))!.amountRefunded,
    ).toBe(0);
    expect((await store.getEscalation(escId))!.status).toBe("pending");
  });
});

describe("assertWriteToken", () => {
  const original = process.env.WRITE_TOKEN;

  test("rejects when WRITE_TOKEN env is missing", () => {
    delete process.env.WRITE_TOKEN;
    const result = assertWriteToken("anything");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("not configured");
    process.env.WRITE_TOKEN = original;
  });

  test("rejects missing token", () => {
    process.env.WRITE_TOKEN = "secret-test-token-abc";
    expect(assertWriteToken(undefined).ok).toBe(false);
    expect(assertWriteToken("").ok).toBe(false);
    process.env.WRITE_TOKEN = original;
  });

  test("rejects wrong token", () => {
    process.env.WRITE_TOKEN = "secret-test-token-abc";
    const result = assertWriteToken("wrong");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("invalid");
    process.env.WRITE_TOKEN = original;
  });

  test("accepts matching token", () => {
    process.env.WRITE_TOKEN = "secret-test-token-abc";
    expect(assertWriteToken("secret-test-token-abc").ok).toBe(true);
    process.env.WRITE_TOKEN = original;
  });
});

describe("store.reset seed catalog", () => {
  test("reset restores seed counts and pre-seeded refunds", async () => {
    const store = await freshStore();
    await issueRefund(
      store,
      {
        orderId: "ord_auto_ok",
        amount: 89,
        action: "full_refund_damaged",
        reason: "temp",
      },
      NOW,
    );
    expect(
      (await store.getPaymentByOrder("ord_auto_ok"))!.amountRefunded,
    ).toBe(89);

    await store.reset(NOW);
    const counts = await store.counts();
    expect(counts.customers).toBe(3);
    expect(counts.orders).toBe(8);
    expect(counts.payments).toBe(8);
    expect(counts.shipments).toBe(8);
    expect(counts.refunds).toBe(2);
    expect(counts.escalations).toBe(0);
    expect(
      (await store.getPaymentByOrder("ord_auto_ok"))!.amountRefunded,
    ).toBe(0);
    expect(
      (await store.getPaymentByOrder("ord_already_refunded"))!.amountRefunded,
    ).toBe(79);
  });
});
