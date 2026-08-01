import type {
  Customer,
  Escalation,
  Order,
  Payment,
  Refund,
  Shipment,
} from "./types.ts";
import { seedData } from "./seed.ts";

/**
 * Mutable in-memory store. All data is synthetic and local.
 * Mutating methods are the only way money moves (refunds) or escalations open.
 */
export class Store {
  customers: Map<string, Customer>;
  orders: Map<string, Order>;
  payments: Map<string, Payment>;
  shipments: Map<string, Shipment>;
  refunds: Map<string, Refund>;
  escalations: Map<string, Escalation>;
  private seq: number;

  constructor() {
    this.customers = new Map();
    this.orders = new Map();
    this.payments = new Map();
    this.shipments = new Map();
    this.refunds = new Map();
    this.escalations = new Map();
    this.seq = 1000;
    this.reset();
  }

  /** Reset to the seeded synthetic catalog. Used by tests. */
  reset(): void {
    const data = seedData();
    this.customers = new Map(data.customers.map((c) => [c.id, structuredClone(c)]));
    this.orders = new Map(data.orders.map((o) => [o.id, structuredClone(o)]));
    this.payments = new Map(data.payments.map((p) => [p.id, structuredClone(p)]));
    this.shipments = new Map(data.shipments.map((s) => [s.id, structuredClone(s)]));
    this.refunds = new Map(data.refunds.map((r) => [r.id, structuredClone(r)]));
    this.escalations = new Map(
      data.escalations.map((e) => [e.id, structuredClone(e)]),
    );
    this.seq = 1000;
  }

  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  nowIso(): string {
    return new Date().toISOString();
  }

  getCustomer(id: string): Customer | undefined {
    return this.customers.get(id);
  }

  getOrder(id: string): Order | undefined {
    return this.orders.get(id);
  }

  getPayment(id: string): Payment | undefined {
    return this.payments.get(id);
  }

  getPaymentByOrder(orderId: string): Payment | undefined {
    for (const p of this.payments.values()) {
      if (p.orderId === orderId) return p;
    }
    return undefined;
  }

  getShipment(id: string): Shipment | undefined {
    return this.shipments.get(id);
  }

  getShipmentByOrder(orderId: string): Shipment | undefined {
    for (const s of this.shipments.values()) {
      if (s.orderId === orderId) return s;
    }
    return undefined;
  }

  listOrders(): Order[] {
    return [...this.orders.values()];
  }

  listRefundsForOrder(orderId: string): Refund[] {
    return [...this.refunds.values()].filter((r) => r.orderId === orderId);
  }

  listEscalations(status?: Escalation["status"]): Escalation[] {
    const all = [...this.escalations.values()];
    if (!status) return all;
    return all.filter((e) => e.status === status);
  }

  /**
   * Record a completed refund and update payment state.
   * This is the only path that moves money.
   */
  recordCompletedRefund(input: {
    orderId: string;
    paymentId: string;
    amount: number;
    action: string;
    reason: string;
    autoApproved: boolean;
    escalationId: string | null;
  }): Refund {
    const payment = this.payments.get(input.paymentId);
    if (!payment) {
      throw new Error(`Payment not found: ${input.paymentId}`);
    }

    const refund: Refund = {
      id: this.nextId("ref"),
      orderId: input.orderId,
      paymentId: input.paymentId,
      amount: input.amount,
      action: input.action,
      reason: input.reason,
      status: "completed",
      autoApproved: input.autoApproved,
      escalationId: input.escalationId,
      createdAt: this.nowIso(),
    };

    payment.amountRefunded = roundMoney(payment.amountRefunded + input.amount);
    if (payment.amountRefunded >= payment.amountPaid) {
      payment.status = "refunded";
    } else {
      payment.status = "partially_refunded";
    }

    const order = this.orders.get(input.orderId);
    if (order && payment.amountRefunded >= payment.amountPaid) {
      order.status = "refunded";
    }

    this.refunds.set(refund.id, refund);
    return refund;
  }

  createEscalation(input: {
    orderId: string;
    paymentId: string;
    requestedAmount: number;
    action: string;
    reason: string;
    failedChecks: Escalation["failedChecks"];
  }): Escalation {
    const escalation: Escalation = {
      id: this.nextId("esc"),
      orderId: input.orderId,
      paymentId: input.paymentId,
      requestedAmount: input.requestedAmount,
      action: input.action,
      reason: input.reason,
      status: "pending",
      failedChecks: input.failedChecks,
      createdAt: this.nowIso(),
      resolvedAt: null,
      resolvedBy: null,
      resolutionNote: null,
      resultingRefundId: null,
    };
    this.escalations.set(escalation.id, escalation);
    return escalation;
  }

  getEscalation(id: string): Escalation | undefined {
    return this.escalations.get(id);
  }
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Process-wide default store. Tests should construct their own Store instances. */
export const store = new Store();
