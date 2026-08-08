import type {
  Customer,
  Escalation,
  Order,
  Payment,
  Refund,
  Shipment,
} from "./types.ts";

/**
 * Synthetic catalog designed to exercise every auto-refund and escalation path.
 *
 * Seed dates are relative to `referenceDate` (default: now) so scenarios stay
 * valid over time. Tests should pass the same clock they use for eligibility.
 */
export function seedData(referenceDate: Date = new Date()): {
  customers: Customer[];
  orders: Order[];
  payments: Payment[];
  shipments: Shipment[];
  refunds: Refund[];
  escalations: Escalation[];
} {
  const daysAgo = (n: number): string => {
    const d = new Date(referenceDate);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };

  const customers: Customer[] = [
    {
      id: "cust_low_risk",
      name: "Ava Chen",
      email: "ava.chen@example.com",
      riskScore: 22,
    },
    {
      id: "cust_mid_risk",
      name: "Ben Ortiz",
      email: "ben.ortiz@example.com",
      riskScore: 55,
    },
    {
      id: "cust_high_risk",
      name: "Casey Nguyen",
      email: "casey.nguyen@example.com",
      riskScore: 82,
    },
  ];

  const orders: Order[] = [
    // Fully auto-eligible: recent, low risk, verified damaged shipment, $89 paid
    {
      id: "ord_auto_ok",
      customerId: "cust_low_risk",
      createdAt: daysAgo(12),
      status: "delivered",
      currency: "USD",
      itemDescription: "Wireless earbuds",
      quantity: 1,
    },
    // Over $150 cap (paid $249) — should escalate even with clean checks
    {
      id: "ord_over_cap",
      customerId: "cust_low_risk",
      createdAt: daysAgo(8),
      status: "delivered",
      currency: "USD",
      itemDescription: "Noise-cancelling headphones",
      quantity: 1,
    },
    // Order older than 30 days
    {
      id: "ord_too_old",
      customerId: "cust_low_risk",
      createdAt: daysAgo(45),
      status: "delivered",
      currency: "USD",
      itemDescription: "USB-C hub",
      quantity: 1,
    },
    // High customer risk
    {
      id: "ord_high_risk",
      customerId: "cust_high_risk",
      createdAt: daysAgo(5),
      status: "delivered",
      currency: "USD",
      itemDescription: "Phone case",
      quantity: 2,
    },
    // No carrier exception (delivered cleanly)
    {
      id: "ord_no_exception",
      customerId: "cust_mid_risk",
      createdAt: daysAgo(10),
      status: "delivered",
      currency: "USD",
      itemDescription: "Desk lamp",
      quantity: 1,
    },
    // Already has a completed refund for same action/amount
    {
      id: "ord_already_refunded",
      customerId: "cust_low_risk",
      createdAt: daysAgo(7),
      status: "refunded",
      currency: "USD",
      itemDescription: "Bluetooth speaker",
      quantity: 1,
    },
    // Chargeback flagged — must escalate
    {
      id: "ord_chargeback",
      customerId: "cust_mid_risk",
      createdAt: daysAgo(14),
      status: "delivered",
      currency: "USD",
      itemDescription: "Fitness tracker",
      quantity: 1,
    },
    // Partial payment headroom: paid $100, already refunded $40 — can auto $50 more
    {
      id: "ord_partial_ok",
      customerId: "cust_low_risk",
      createdAt: daysAgo(9),
      status: "delivered",
      currency: "USD",
      itemDescription: "Keyboard",
      quantity: 1,
    },
  ];

  const payments: Payment[] = [
    {
      id: "pay_auto_ok",
      orderId: "ord_auto_ok",
      status: "captured",
      amountPaid: 89.0,
      amountRefunded: 0,
      capturedAt: daysAgo(12),
      chargebackFlag: false,
      disputeFlag: false,
    },
    {
      id: "pay_over_cap",
      orderId: "ord_over_cap",
      status: "captured",
      amountPaid: 249.0,
      amountRefunded: 0,
      capturedAt: daysAgo(8),
      chargebackFlag: false,
      disputeFlag: false,
    },
    {
      id: "pay_too_old",
      orderId: "ord_too_old",
      status: "captured",
      amountPaid: 45.0,
      amountRefunded: 0,
      capturedAt: daysAgo(45),
      chargebackFlag: false,
      disputeFlag: false,
    },
    {
      id: "pay_high_risk",
      orderId: "ord_high_risk",
      status: "captured",
      amountPaid: 39.98,
      amountRefunded: 0,
      capturedAt: daysAgo(5),
      chargebackFlag: false,
      disputeFlag: false,
    },
    {
      id: "pay_no_exception",
      orderId: "ord_no_exception",
      status: "captured",
      amountPaid: 64.0,
      amountRefunded: 0,
      capturedAt: daysAgo(10),
      chargebackFlag: false,
      disputeFlag: false,
    },
    {
      id: "pay_already_refunded",
      orderId: "ord_already_refunded",
      status: "refunded",
      amountPaid: 79.0,
      amountRefunded: 79.0,
      capturedAt: daysAgo(7),
      chargebackFlag: false,
      disputeFlag: false,
    },
    {
      id: "pay_chargeback",
      orderId: "ord_chargeback",
      status: "captured",
      amountPaid: 120.0,
      amountRefunded: 0,
      capturedAt: daysAgo(14),
      chargebackFlag: true,
      disputeFlag: true,
    },
    {
      id: "pay_partial_ok",
      orderId: "ord_partial_ok",
      status: "partially_refunded",
      amountPaid: 100.0,
      amountRefunded: 40.0,
      capturedAt: daysAgo(9),
      chargebackFlag: false,
      disputeFlag: false,
    },
  ];

  const shipments: Shipment[] = [
    {
      id: "shp_auto_ok",
      orderId: "ord_auto_ok",
      carrier: "UPS",
      trackingNumber: "1Z999AA10123456784",
      status: "exception",
      carrierException: "damaged",
      exceptionVerified: true,
      shippedAt: daysAgo(11),
      deliveredAt: daysAgo(9),
    },
    {
      id: "shp_over_cap",
      orderId: "ord_over_cap",
      carrier: "FedEx",
      trackingNumber: "794612345678",
      status: "exception",
      carrierException: "lost",
      exceptionVerified: true,
      shippedAt: daysAgo(7),
      deliveredAt: null,
    },
    {
      id: "shp_too_old",
      orderId: "ord_too_old",
      carrier: "USPS",
      trackingNumber: "9400111899223344556677",
      status: "exception",
      carrierException: "never_delivered",
      exceptionVerified: true,
      shippedAt: daysAgo(44),
      deliveredAt: null,
    },
    {
      id: "shp_high_risk",
      orderId: "ord_high_risk",
      carrier: "UPS",
      trackingNumber: "1Z999AA10123456785",
      status: "exception",
      carrierException: "wrong_item",
      exceptionVerified: true,
      shippedAt: daysAgo(4),
      deliveredAt: daysAgo(3),
    },
    {
      id: "shp_no_exception",
      orderId: "ord_no_exception",
      carrier: "DHL",
      trackingNumber: "JD014600003712345678",
      status: "delivered",
      carrierException: null,
      exceptionVerified: false,
      shippedAt: daysAgo(9),
      deliveredAt: daysAgo(6),
    },
    {
      id: "shp_already_refunded",
      orderId: "ord_already_refunded",
      carrier: "UPS",
      trackingNumber: "1Z999AA10123456786",
      status: "exception",
      carrierException: "damaged",
      exceptionVerified: true,
      shippedAt: daysAgo(6),
      deliveredAt: daysAgo(5),
    },
    {
      id: "shp_chargeback",
      orderId: "ord_chargeback",
      carrier: "FedEx",
      trackingNumber: "794612345679",
      status: "exception",
      carrierException: "damaged",
      exceptionVerified: true,
      shippedAt: daysAgo(13),
      deliveredAt: daysAgo(11),
    },
    {
      id: "shp_partial_ok",
      orderId: "ord_partial_ok",
      carrier: "UPS",
      trackingNumber: "1Z999AA10123456787",
      status: "exception",
      carrierException: "damaged",
      exceptionVerified: true,
      shippedAt: daysAgo(8),
      deliveredAt: daysAgo(7),
    },
  ];

  const refunds: Refund[] = [
    {
      id: "ref_existing_001",
      orderId: "ord_already_refunded",
      paymentId: "pay_already_refunded",
      amount: 79.0,
      action: "full_refund_damaged",
      reason: "Carrier-verified damage",
      status: "completed",
      autoApproved: true,
      escalationId: null,
      createdAt: `${daysAgo(4)}T15:00:00.000Z`,
    },
    {
      id: "ref_existing_002",
      orderId: "ord_partial_ok",
      paymentId: "pay_partial_ok",
      amount: 40.0,
      action: "partial_missing_keycaps",
      reason: "Missing accessories",
      status: "completed",
      autoApproved: true,
      escalationId: null,
      createdAt: `${daysAgo(6)}T12:00:00.000Z`,
    },
  ];

  const escalations: Escalation[] = [];

  return { customers, orders, payments, shipments, refunds, escalations };
}

/** Human-readable seed scenario guide for README / list tools. */
export const SEED_SCENARIOS = [
  {
    orderId: "ord_auto_ok",
    scenario: "Fully eligible auto-refund ($89, damaged, low risk, recent)",
    expected: "auto_executed",
  },
  {
    orderId: "ord_over_cap",
    scenario: "Refund amount exceeds $150 auto cap",
    expected: "escalated",
  },
  {
    orderId: "ord_too_old",
    scenario: "Order older than 30 days",
    expected: "escalated",
  },
  {
    orderId: "ord_high_risk",
    scenario: "Customer risk score ≥ 70",
    expected: "escalated",
  },
  {
    orderId: "ord_no_exception",
    scenario: "No verified carrier exception",
    expected: "escalated",
  },
  {
    orderId: "ord_already_refunded",
    scenario: "Duplicate refund for same paymentId+amount (idempotency key)",
    expected: "escalated",
  },
  {
    orderId: "ord_chargeback",
    scenario: "Chargeback/dispute flagged on payment",
    expected: "escalated",
  },
  {
    orderId: "ord_partial_ok",
    scenario: "Partial remaining balance within policy ($50 of $60 left)",
    expected: "auto_executed",
  },
] as const;
