import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import * as crypto from "crypto";
import { WebhookEvent, WebhookEventDocument } from "./schemas/webhook-event.schema";
import { OrderService } from "../order/order.service";
import { InventoryService } from "../inventory/inventory.service";
import { OrderDocument } from "../order/schemas/order.schema";
import { InstallmentService, InstallmentService as IS } from "../installment/installment.service";

interface PaystackInitResponse {
  status: boolean;
  message: string;
  data: { authorization_url: string; access_code: string; reference: string };
}

interface PaystackVerifyResponse {
  status: boolean;
  data: { status: string; reference: string; id: number };
}

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    @InjectModel(WebhookEvent.name)
    private readonly webhookModel: Model<WebhookEventDocument>,
    private readonly orderService: OrderService,
    private readonly inventoryService: InventoryService,
    private readonly installmentService: InstallmentService,
    private readonly config: ConfigService,
  ) {}

  // ─── Public dispatcher — used by OrderController ─────────────────────────

  /**
   * Initialize a payment for an order. Branches on order.paymentMethod:
   *   paystack     → full payment via Paystack
   *   flutterwave  → full payment via Flutterwave
   *   installment  → 40% deposit via Paystack/Flutterwave (paymentProvider on order)
   *   pay_on_delivery → no-op (no gateway involved)
   */
  async initializePayment(
    order: OrderDocument,
  ): Promise<{ checkoutUrl: string; reference: string } | null> {
    if (order.paymentMethod === "pay_on_delivery") return null;

    const provider = order.paymentProvider;
    const isInstallment = order.paymentMethod === "installment";

    if (provider === "paystack") {
      return this.initializePaystack(order, isInstallment);
    }
    if (provider === "flutterwave") {
      return this.initializeFlutterwave(order, isInstallment);
    }
    throw new BadRequestException("Unknown payment provider");
  }

  // ─── Paystack: initialize ─────────────────────────────────────────────────

  async initializePaystack(
    order: OrderDocument,
    isInstallment = false,
  ): Promise<{ checkoutUrl: string; reference: string }> {
    const secretKey = this.config.get<string>("paystack.secretKey");
    const orderId = (order._id as unknown as Types.ObjectId).toString();

    const amount = isInstallment
      ? Math.round(IS.computePlanFigures(order.total).depositAmount * 100)
      : Math.round(order.total * 100);

    const body = JSON.stringify({
      email: order.customerEmail ?? "guest@alphavista.ng",
      amount,
      reference: order.paymentReference,
      callback_url: `${this.config.get("storefront.baseUrl")}/checkout/confirm?ref=${order.paymentReference}`,
      metadata: {
        orderId,
        orderNumber: order.orderNumber,
        purpose: isInstallment ? "installment_deposit" : "full_payment",
      },
    });

    const res = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
      body,
    });

    if (!res.ok) throw new BadRequestException("Paystack initialization failed");

    const data = (await res.json()) as PaystackInitResponse;
    return { checkoutUrl: data.data.authorization_url, reference: data.data.reference };
  }

  // ─── Flutterwave: initialize ──────────────────────────────────────────────

  async initializeFlutterwave(
    order: OrderDocument,
    isInstallment = false,
  ): Promise<{ checkoutUrl: string; reference: string }> {
    const secretKey = this.config.get<string>("flutterwave.secretKey");
    const orderId = (order._id as unknown as Types.ObjectId).toString();

    const amount = isInstallment ? IS.computePlanFigures(order.total).depositAmount : order.total;

    const body = JSON.stringify({
      tx_ref: order.paymentReference,
      amount,
      currency: "NGN",
      redirect_url: `${this.config.get("storefront.baseUrl")}/checkout/confirm?ref=${order.paymentReference}`,
      customer: {
        email: order.customerEmail ?? "guest@alphavista.ng",
        name: order.customerName ?? "Guest",
      },
      meta: {
        orderId,
        purpose: isInstallment ? "installment_deposit" : "full_payment",
      },
    });

    const res = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
      body,
    });

    if (!res.ok) throw new BadRequestException("Flutterwave initialization failed");

    const data = (await res.json()) as { status: string; data: { link: string } };
    return { checkoutUrl: data.data.link, reference: order.paymentReference };
  }

  // ─── Instalment charge (scheduled BullMQ job) ─────────────────────────────

  async chargeInstallment(planId: string, installmentNumber: number): Promise<void> {
    const plan = await this.installmentService.findById(planId);
    const entry = plan.schedule.find((s) => s.installmentNumber === installmentNumber);
    if (!entry || entry.status === "paid" || plan.status !== "active") return;

    const order = await this.orderService.findById(plan.orderId.toString());
    const reference = `${order.paymentReference}-INST-${installmentNumber}`;

    try {
      if (plan.provider === "paystack") {
        const secretKey = this.config.get<string>("paystack.secretKey");
        const res = await fetch("https://api.paystack.co/transaction/charge_authorization", {
          method: "POST",
          headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            authorization_code: plan.authorizationCode,
            email: order.customerEmail ?? "guest@alphavista.ng",
            amount: Math.round(entry.amount * 100),
            reference,
            metadata: {
              purpose: "installment_payment",
              planId,
              installmentNumber,
            },
          }),
        });
        if (!res.ok) {
          await this.installmentService.markEntryFailed(planId, installmentNumber);
        }
        // Outcome confirmed via webhook — job complete
      } else {
        // Flutterwave charge with saved token
        const secretKey = this.config.get<string>("flutterwave.secretKey");
        const res = await fetch("https://api.flutterwave.com/v3/charges?type=token", {
          method: "POST",
          headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            token: plan.authorizationCode,
            email: order.customerEmail ?? "guest@alphavista.ng",
            amount: entry.amount,
            currency: "NGN",
            tx_ref: reference,
            meta: { purpose: "installment_payment", planId, installmentNumber },
          }),
        });
        if (!res.ok) {
          await this.installmentService.markEntryFailed(planId, installmentNumber);
        }
      }
    } catch (err) {
      this.logger.error(
        `Instalment charge error (plan ${planId}, #${installmentNumber})`,
        (err as Error).message,
      );
      await this.installmentService.markEntryFailed(planId, installmentNumber);
    }
  }

  // ─── Webhook: Paystack ────────────────────────────────────────────────────

  async handlePaystackWebhook(rawBody: Buffer, signature: string): Promise<void> {
    const secret = this.config.get<string>("paystack.webhookSecret")!;
    const expected = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");

    if (!crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))) {
      throw new UnauthorizedException("Invalid Paystack webhook signature");
    }

    const event = JSON.parse(rawBody.toString()) as {
      event: string;
      data: {
        id: number;
        reference: string;
        status: string;
        metadata?: {
          purpose?: string;
          orderId?: string;
          planId?: string;
          installmentNumber?: number;
        };
        authorization?: { authorization_code?: string };
      };
    };

    const eventId = `paystack:${event.data.id}`;
    const existing = await this.webhookModel.findOne({ eventId }).lean();
    if (existing) {
      this.logger.log(`Duplicate Paystack webhook ${eventId} — skipping`);
      return;
    }

    await this.processPaystackEvent(event, eventId);
  }

  private async processPaystackEvent(
    event: {
      event: string;
      data: {
        id: number;
        reference: string;
        status: string;
        metadata?: {
          purpose?: string;
          orderId?: string;
          planId?: string;
          installmentNumber?: number;
        };
        authorization?: { authorization_code?: string };
      };
    },
    eventId: string,
  ): Promise<void> {
    const purpose = event.data.metadata?.purpose ?? "full_payment";

    try {
      if (event.event === "charge.success") {
        if (purpose === "installment_deposit") {
          await this.handleInstallmentDeposit({
            reference: event.data.reference,
            authorizationCode: event.data.authorization?.authorization_code ?? "",
            provider: "paystack",
            eventId,
          });
        } else if (purpose === "installment_payment") {
          const { planId, installmentNumber } = event.data.metadata ?? {};
          if (planId && installmentNumber !== undefined) {
            await this.installmentService.recordInstallmentPayment({
              planId,
              installmentNumber,
              paymentReference: event.data.reference,
            });
          }
        } else {
          // Full payment — existing logic
          const order = await this.orderService.findByReference(event.data.reference);
          if (order) {
            await this.orderService.markPaid(
              (order._id as unknown as Types.ObjectId).toString(),
              eventId,
            );
            for (const item of order.items) {
              await this.inventoryService.commitReservedStock(item.productId, item.qty);
            }
          }
        }
      } else if (event.event === "charge.failed" || event.event === "transfer.failed") {
        if (purpose === "installment_payment") {
          const { planId, installmentNumber } = event.data.metadata ?? {};
          if (planId && installmentNumber !== undefined) {
            await this.installmentService.markEntryFailed(planId, installmentNumber);
          }
        } else {
          const order = await this.orderService.findByReference(event.data.reference);
          if (order) {
            await this.orderService.markFailed((order._id as unknown as Types.ObjectId).toString());
          }
        }
      }

      await this.webhookModel.create({
        provider: "paystack",
        eventId,
        type: event.event,
        payload: event as unknown as Record<string, unknown>,
        orderId: null,
        processedAt: new Date(),
      });
    } catch (err) {
      this.logger.error(`Error processing webhook ${eventId}`, err);
      throw err;
    }
  }

  // ─── Webhook: Flutterwave ─────────────────────────────────────────────────

  async handleFlutterwaveWebhook(rawBody: Buffer, signature: string): Promise<void> {
    const secret = this.config.get<string>("flutterwave.secretKey")!;
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

    if (signature !== expected) {
      throw new UnauthorizedException("Invalid Flutterwave webhook signature");
    }

    const event = JSON.parse(rawBody.toString()) as {
      event: string;
      data: {
        id: number;
        tx_ref: string;
        status: string;
        meta?: { purpose?: string; orderId?: string; planId?: string; installmentNumber?: number };
        card?: { token?: string };
      };
    };

    const eventId = `flutterwave:${event.data.id}`;
    const existing = await this.webhookModel.findOne({ eventId }).lean();
    if (existing) {
      this.logger.log(`Duplicate Flutterwave webhook ${eventId} — skipping`);
      return;
    }

    const purpose = event.data.meta?.purpose ?? "full_payment";

    if (event.event === "charge.completed" && event.data.status === "successful") {
      if (purpose === "installment_deposit") {
        await this.handleInstallmentDeposit({
          reference: event.data.tx_ref,
          authorizationCode: event.data.card?.token ?? "",
          provider: "flutterwave",
          eventId,
        });
      } else if (purpose === "installment_payment") {
        const { planId, installmentNumber } = event.data.meta ?? {};
        if (planId && installmentNumber !== undefined) {
          await this.installmentService.recordInstallmentPayment({
            planId,
            installmentNumber,
            paymentReference: event.data.tx_ref,
          });
        }
      } else {
        const order = await this.orderService.findByReference(event.data.tx_ref);
        if (order) {
          await this.orderService.markPaid(
            (order._id as unknown as Types.ObjectId).toString(),
            eventId,
          );
          for (const item of order.items) {
            await this.inventoryService.commitReservedStock(item.productId, item.qty);
          }
        }
      }
    } else if (
      event.event === "charge.failed" ||
      event.event === "transfer.failed" ||
      event.data.status === "failed"
    ) {
      if (purpose === "installment_payment") {
        const { planId, installmentNumber } = event.data.meta ?? {};
        if (planId && installmentNumber !== undefined) {
          await this.installmentService.markEntryFailed(planId, installmentNumber);
        }
      } else {
        const order = await this.orderService.findByReference(event.data.tx_ref);
        if (order) {
          await this.orderService.markFailed((order._id as unknown as Types.ObjectId).toString());
        }
      }
    }

    await this.webhookModel.create({
      provider: "flutterwave",
      eventId,
      type: event.event,
      payload: event as unknown as Record<string, unknown>,
      orderId: null,
      processedAt: new Date(),
    });
  }

  // ─── Shared: handle deposit confirmation ─────────────────────────────────

  private async handleInstallmentDeposit(opts: {
    reference: string;
    authorizationCode: string;
    provider: "paystack" | "flutterwave";
    eventId: string;
  }): Promise<void> {
    const order = await this.orderService.findByReference(opts.reference);
    if (!order) {
      this.logger.warn(`Installment deposit webhook: order not found for ref ${opts.reference}`);
      return;
    }

    const orderId = (order._id as unknown as Types.ObjectId).toString();

    // Commit stock — it's now spoken for
    for (const item of order.items) {
      await this.inventoryService.commitReservedStock(item.productId, item.qty);
    }

    // Transition order to in_installments
    await this.orderService.markInInstallments(orderId);

    // Create the instalment plan with the 3-month schedule
    await this.installmentService.createPlan({
      orderId,
      customerId: order.customerId ?? "",
      cashPrice: order.total,
      authorizationCode: opts.authorizationCode,
      provider: opts.provider,
    });

    this.logger.log(`Installment deposit confirmed for order ${order.orderNumber}`);
  }

  // ─── Active verification ──────────────────────────────────────────────────

  async verifyPaystackTransaction(reference: string): Promise<string> {
    const secretKey = this.config.get<string>("paystack.secretKey");
    const res = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${secretKey}` } },
    );
    if (!res.ok) return "unknown";
    const data = (await res.json()) as PaystackVerifyResponse;
    return data.data?.status ?? "unknown";
  }
}
