/**
 * Postgres-backed store via Prisma.
 * Domain methods mirror the former in-memory Store API but are async.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "./db.ts";
import { seedData } from "./seed.ts";
import type {
  Customer,
  Escalation,
  Order,
  Payment,
  PolicyCheckResult,
  Refund,
  Shipment,
} from "./types.ts";

function money(n: Prisma.Decimal | number | string): number {
  return roundMoney(Number(n));
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

function toCustomer(row: {
  id: string;
  name: string;
  email: string;
  riskScore: number;
}): Customer {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    riskScore: row.riskScore,
  };
}

function toOrder(row: {
  id: string;
  customerId: string;
  createdAt: string;
  status: string;
  currency: string;
  itemDescription: string;
  quantity: number;
}): Order {
  return {
    id: row.id,
    customerId: row.customerId,
    createdAt: row.createdAt,
    status: row.status as Order["status"],
    currency: "USD",
    itemDescription: row.itemDescription,
    quantity: row.quantity,
  };
}

function toPayment(row: {
  id: string;
  orderId: string;
  status: string;
  amountPaid: Prisma.Decimal;
  amountRefunded: Prisma.Decimal;
  capturedAt: string;
  chargebackFlag: boolean;
  disputeFlag: boolean;
}): Payment {
  return {
    id: row.id,
    orderId: row.orderId,
    status: row.status as Payment["status"],
    amountPaid: money(row.amountPaid),
    amountRefunded: money(row.amountRefunded),
    capturedAt: row.capturedAt,
    chargebackFlag: row.chargebackFlag,
    disputeFlag: row.disputeFlag,
  };
}

function toShipment(row: {
  id: string;
  orderId: string;
  carrier: string;
  trackingNumber: string;
  status: string;
  carrierException: string | null;
  exceptionVerified: boolean;
  shippedAt: string | null;
  deliveredAt: string | null;
}): Shipment {
  return {
    id: row.id,
    orderId: row.orderId,
    carrier: row.carrier,
    trackingNumber: row.trackingNumber,
    status: row.status as Shipment["status"],
    carrierException: row.carrierException as Shipment["carrierException"],
    exceptionVerified: row.exceptionVerified,
    shippedAt: row.shippedAt,
    deliveredAt: row.deliveredAt,
  };
}

function toRefund(row: {
  id: string;
  orderId: string;
  paymentId: string;
  amount: Prisma.Decimal;
  action: string;
  reason: string;
  status: string;
  autoApproved: boolean;
  escalationId: string | null;
  createdAt: string;
}): Refund {
  return {
    id: row.id,
    orderId: row.orderId,
    paymentId: row.paymentId,
    amount: money(row.amount),
    action: row.action,
    reason: row.reason,
    status: row.status as Refund["status"],
    autoApproved: row.autoApproved,
    escalationId: row.escalationId,
    createdAt: row.createdAt,
  };
}

function toEscalation(row: {
  id: string;
  orderId: string;
  paymentId: string;
  requestedAmount: Prisma.Decimal;
  action: string;
  reason: string;
  status: string;
  failedChecks: Prisma.JsonValue;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  resultingRefundId: string | null;
}): Escalation {
  return {
    id: row.id,
    orderId: row.orderId,
    paymentId: row.paymentId,
    requestedAmount: money(row.requestedAmount),
    action: row.action,
    reason: row.reason,
    status: row.status as Escalation["status"],
    failedChecks: (row.failedChecks as unknown as PolicyCheckResult[]) ?? [],
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
    resolutionNote: row.resolutionNote,
    resultingRefundId: row.resultingRefundId,
  };
}

export class Store {
  constructor(private readonly db = prisma) {}

  nowIso(): string {
    return new Date().toISOString();
  }

  /**
   * Allocate sequential IDs (ref_1001, esc_1001, …) via IdCounter table.
   */
  async nextId(prefix: string): Promise<string> {
    const counter = await this.db.idCounter.upsert({
      where: { name: prefix },
      create: { name: prefix, value: 1001 },
      update: { value: { increment: 1 } },
    });
    return `${prefix}_${counter.value}`;
  }

  /**
   * Wipe domain tables and reload the synthetic seed catalog.
   * Used by tests and the reset_seed_data MCP tool.
   */
  async reset(referenceDate: Date = new Date()): Promise<void> {
    // Order matters for FKs (or use cascade deleteMany from parents).
    await this.db.$transaction([
      this.db.refund.deleteMany(),
      this.db.escalation.deleteMany(),
      this.db.shipment.deleteMany(),
      this.db.payment.deleteMany(),
      this.db.order.deleteMany(),
      this.db.customer.deleteMany(),
      this.db.idCounter.deleteMany(),
    ]);

    await this.db.idCounter.createMany({
      data: [
        { name: "ref", value: 1000 },
        { name: "esc", value: 1000 },
      ],
    });

    const data = seedData(referenceDate);

    await this.db.customer.createMany({
      data: data.customers.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        riskScore: c.riskScore,
      })),
    });

    await this.db.order.createMany({
      data: data.orders.map((o) => ({
        id: o.id,
        customerId: o.customerId,
        createdAt: o.createdAt,
        status: o.status,
        currency: o.currency,
        itemDescription: o.itemDescription,
        quantity: o.quantity,
      })),
    });

    await this.db.payment.createMany({
      data: data.payments.map((p) => ({
        id: p.id,
        orderId: p.orderId,
        status: p.status,
        amountPaid: p.amountPaid,
        amountRefunded: p.amountRefunded,
        capturedAt: p.capturedAt,
        chargebackFlag: p.chargebackFlag,
        disputeFlag: p.disputeFlag,
      })),
    });

    await this.db.shipment.createMany({
      data: data.shipments.map((s) => ({
        id: s.id,
        orderId: s.orderId,
        carrier: s.carrier,
        trackingNumber: s.trackingNumber,
        status: s.status,
        carrierException: s.carrierException,
        exceptionVerified: s.exceptionVerified,
        shippedAt: s.shippedAt,
        deliveredAt: s.deliveredAt,
      })),
    });

    if (data.refunds.length > 0) {
      await this.db.refund.createMany({
        data: data.refunds.map((r) => ({
          id: r.id,
          orderId: r.orderId,
          paymentId: r.paymentId,
          amount: r.amount,
          action: r.action,
          reason: r.reason,
          status: r.status,
          autoApproved: r.autoApproved,
          escalationId: r.escalationId,
          createdAt: r.createdAt,
        })),
      });
    }

    if (data.escalations.length > 0) {
      await this.db.escalation.createMany({
        data: data.escalations.map((e) => ({
          id: e.id,
          orderId: e.orderId,
          paymentId: e.paymentId,
          requestedAmount: e.requestedAmount,
          action: e.action,
          reason: e.reason,
          status: e.status,
          failedChecks: e.failedChecks as unknown as Prisma.InputJsonValue,
          createdAt: e.createdAt,
          resolvedAt: e.resolvedAt,
          resolvedBy: e.resolvedBy,
          resolutionNote: e.resolutionNote,
          resultingRefundId: e.resultingRefundId,
        })),
      });
    }
  }

  async counts(): Promise<{
    customers: number;
    orders: number;
    payments: number;
    shipments: number;
    refunds: number;
    escalations: number;
  }> {
    const [customers, orders, payments, shipments, refunds, escalations] =
      await Promise.all([
        this.db.customer.count(),
        this.db.order.count(),
        this.db.payment.count(),
        this.db.shipment.count(),
        this.db.refund.count(),
        this.db.escalation.count(),
      ]);
    return { customers, orders, payments, shipments, refunds, escalations };
  }

  async getCustomer(id: string): Promise<Customer | undefined> {
    const row = await this.db.customer.findUnique({ where: { id } });
    return row ? toCustomer(row) : undefined;
  }

  async getOrder(id: string): Promise<Order | undefined> {
    const row = await this.db.order.findUnique({ where: { id } });
    return row ? toOrder(row) : undefined;
  }

  async getPayment(id: string): Promise<Payment | undefined> {
    const row = await this.db.payment.findUnique({ where: { id } });
    return row ? toPayment(row) : undefined;
  }

  async getPaymentByOrder(orderId: string): Promise<Payment | undefined> {
    const row = await this.db.payment.findFirst({ where: { orderId } });
    return row ? toPayment(row) : undefined;
  }

  async getShipment(id: string): Promise<Shipment | undefined> {
    const row = await this.db.shipment.findUnique({ where: { id } });
    return row ? toShipment(row) : undefined;
  }

  async getShipmentByOrder(orderId: string): Promise<Shipment | undefined> {
    const row = await this.db.shipment.findFirst({ where: { orderId } });
    return row ? toShipment(row) : undefined;
  }

  async listOrders(): Promise<Order[]> {
    const rows = await this.db.order.findMany({ orderBy: { id: "asc" } });
    return rows.map(toOrder);
  }

  async listRefundsForOrder(orderId: string): Promise<Refund[]> {
    const rows = await this.db.refund.findMany({
      where: { orderId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toRefund);
  }

  async listEscalations(status?: Escalation["status"]): Promise<Escalation[]> {
    const rows = await this.db.escalation.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toEscalation);
  }

  async getEscalation(id: string): Promise<Escalation | undefined> {
    const row = await this.db.escalation.findUnique({ where: { id } });
    return row ? toEscalation(row) : undefined;
  }

  /**
   * Record a completed refund and update payment/order state.
   * Unique on (paymentId, amount): if a refund already exists, return it
   * without moving money again (idempotent).
   */
  async recordCompletedRefund(input: {
    orderId: string;
    paymentId: string;
    amount: number;
    action: string;
    reason: string;
    autoApproved: boolean;
    escalationId: string | null;
  }): Promise<Refund> {
    const amount = roundMoney(input.amount);

    const existing = await this.db.refund.findUnique({
      where: {
        paymentId_amount: {
          paymentId: input.paymentId,
          amount,
        },
      },
    });
    if (existing) {
      return toRefund(existing);
    }

    try {
      return await this.db.$transaction(async (tx: any) => {
        const payment = await tx.payment.findUnique({
          where: { id: input.paymentId },
        });
        if (!payment) {
          throw new Error(`Payment not found: ${input.paymentId}`);
        }

        const counter = await tx.idCounter.upsert({
          where: { name: "ref" },
          create: { name: "ref", value: 1001 },
          update: { value: { increment: 1 } },
        });
        const id = `ref_${counter.value}`;

        const refund = await tx.refund.create({
          data: {
            id,
            orderId: input.orderId,
            paymentId: input.paymentId,
            amount,
            action: input.action,
            reason: input.reason,
            status: "completed",
            autoApproved: input.autoApproved,
            escalationId: input.escalationId,
            createdAt: this.nowIso(),
          },
        });

        const amountRefunded = roundMoney(money(payment.amountRefunded) + amount);
        const amountPaid = money(payment.amountPaid);
        const paymentStatus = amountRefunded >= amountPaid ? "refunded" : "partially_refunded";

        await tx.payment.update({
          where: { id: input.paymentId },
          data: {
            amountRefunded,
            status: paymentStatus,
          },
        });

        if (amountRefunded >= amountPaid) {
          await tx.order.update({
            where: { id: input.orderId },
            data: { status: "refunded" },
          });
        }

        return toRefund(refund);
      });
    } catch (err) {
      // Concurrent create race → return the winner's row.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        const again = await this.db.refund.findUnique({
          where: {
            paymentId_amount: {
              paymentId: input.paymentId,
              amount,
            },
          },
        });
        if (again) return toRefund(again);
      }
      throw err;
    }
  }

  async createEscalation(input: {
    orderId: string;
    paymentId: string;
    requestedAmount: number;
    action: string;
    reason: string;
    failedChecks: Escalation["failedChecks"];
  }): Promise<Escalation> {
    const id = await this.nextId("esc");
    const row = await this.db.escalation.create({
      data: {
        id,
        orderId: input.orderId,
        paymentId: input.paymentId,
        requestedAmount: roundMoney(input.requestedAmount),
        action: input.action,
        reason: input.reason,
        status: "pending",
        failedChecks: input.failedChecks as unknown as Prisma.InputJsonValue,
        createdAt: this.nowIso(),
        resolvedAt: null,
        resolvedBy: null,
        resolutionNote: null,
        resultingRefundId: null,
      },
    });
    return toEscalation(row);
  }

  async updateEscalation(
    id: string,
    patch: {
      status?: Escalation["status"];
      resolvedAt?: string | null;
      resolvedBy?: string | null;
      resolutionNote?: string | null;
      resultingRefundId?: string | null;
    },
  ): Promise<Escalation> {
    const row = await this.db.escalation.update({
      where: { id },
      data: {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.resolvedAt !== undefined
          ? { resolvedAt: patch.resolvedAt }
          : {}),
        ...(patch.resolvedBy !== undefined
          ? { resolvedBy: patch.resolvedBy }
          : {}),
        ...(patch.resolutionNote !== undefined
          ? { resolutionNote: patch.resolutionNote }
          : {}),
        ...(patch.resultingRefundId !== undefined
          ? { resultingRefundId: patch.resultingRefundId }
          : {}),
      },
    });
    return toEscalation(row);
  }

  // ─── Test / fixture helpers ──────────────────────────────────────────────

  async upsertCustomer(customer: Customer): Promise<Customer> {
    const row = await this.db.customer.upsert({
      where: { id: customer.id },
      create: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        riskScore: customer.riskScore,
      },
      update: {
        name: customer.name,
        email: customer.email,
        riskScore: customer.riskScore,
      },
    });
    return toCustomer(row);
  }

  async upsertOrder(order: Order): Promise<Order> {
    const row = await this.db.order.upsert({
      where: { id: order.id },
      create: {
        id: order.id,
        customerId: order.customerId,
        createdAt: order.createdAt,
        status: order.status,
        currency: order.currency,
        itemDescription: order.itemDescription,
        quantity: order.quantity,
      },
      update: {
        customerId: order.customerId,
        createdAt: order.createdAt,
        status: order.status,
        currency: order.currency,
        itemDescription: order.itemDescription,
        quantity: order.quantity,
      },
    });
    return toOrder(row);
  }

  async upsertPayment(payment: Payment): Promise<Payment> {
    const row = await this.db.payment.upsert({
      where: { id: payment.id },
      create: {
        id: payment.id,
        orderId: payment.orderId,
        status: payment.status,
        amountPaid: payment.amountPaid,
        amountRefunded: payment.amountRefunded,
        capturedAt: payment.capturedAt,
        chargebackFlag: payment.chargebackFlag,
        disputeFlag: payment.disputeFlag,
      },
      update: {
        orderId: payment.orderId,
        status: payment.status,
        amountPaid: payment.amountPaid,
        amountRefunded: payment.amountRefunded,
        capturedAt: payment.capturedAt,
        chargebackFlag: payment.chargebackFlag,
        disputeFlag: payment.disputeFlag,
      },
    });
    return toPayment(row);
  }

  async upsertShipment(shipment: Shipment): Promise<Shipment> {
    const row = await this.db.shipment.upsert({
      where: { id: shipment.id },
      create: {
        id: shipment.id,
        orderId: shipment.orderId,
        carrier: shipment.carrier,
        trackingNumber: shipment.trackingNumber,
        status: shipment.status,
        carrierException: shipment.carrierException,
        exceptionVerified: shipment.exceptionVerified,
        shippedAt: shipment.shippedAt,
        deliveredAt: shipment.deliveredAt,
      },
      update: {
        orderId: shipment.orderId,
        carrier: shipment.carrier,
        trackingNumber: shipment.trackingNumber,
        status: shipment.status,
        carrierException: shipment.carrierException,
        exceptionVerified: shipment.exceptionVerified,
        shippedAt: shipment.shippedAt,
        deliveredAt: shipment.deliveredAt,
      },
    });
    return toShipment(row);
  }

  async updateCustomerRisk(id: string, riskScore: number): Promise<Customer> {
    const row = await this.db.customer.update({
      where: { id },
      data: { riskScore },
    });
    return toCustomer(row);
  }
}

/** Process-wide default store for the MCP server. */
export const store = new Store();
