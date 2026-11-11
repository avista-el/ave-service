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
import { NotificationsService } from "../notifications/notifications.service";

interface PaystackInitResponse {
  status: boolean;
  message: string;
  data: { authorization_url: string; access_code: string; reference: string };
}

interface PaystackVerifyResponse {
  status: boolean;
  data: {
    status: string;
    reference: string;
    id: number;
    amount: number; // in kobo
    currency: string;
    gateway_response?: string;
  };
}

interface FlutterwaveVerifyResponse {
  status: string;
  data: {
    status: string;
    tx_ref: string;
    id: number;
    amount: number; // in full NGN units
    currency: string;
    processor_response?: string;
  };
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
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  // ─── Initialize payment ───────────────────────────────────────────────────

  async initializePayment(
    order: OrderDocument,
  ): Promise<{ checkoutUrl: string; reference: string } | null> {
    if (order.paymentMethod === "pay_on_delivery") return null;

    const provider = order.paymentProvider;
    const isInstallment = order.paymentMethod === "installment";

    let result: { checkoutUrl: string; reference: string };

    if (provider === "paystack") {
      result = await this.initializePaystack(order, isInstallment);
    } else if (provider === "flutterwave") {
      result = await this.initializeFlutterwave(order, isInstallment);
    } else {
      throw new BadRequestException("Unknown payment provider");
    }

    // Record the INITIATED attempt now that we have the reference
    const orderId = (order._id as unknown as Types.ObjectId).toString();
    await this.orderService.recordInitiatedAttempt({
      orderId,
      reference: result.reference,
      provider: provider as "paystack" | "flutterwave",
    });

    return result;
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

    // Use the real customer email — never fall back to a placeholder
    const email = order.customerEmail;
    if (!email) throw new BadRequestException("Order has no customer email");

    const body = JSON.stringify({
      email,
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

    const email = order.customerEmail;
    if (!email) throw new BadRequestException("Order has no customer email");

    const body = JSON.stringify({
      tx_ref: order.paymentReference,
      amount,
      currency: "NGN",
      redirect_url: `${this.config.get("storefront.baseUrl")}/checkout/confirm?ref=${order.paymentReference}`,
      customer: {
        email,
        name: order.customerName ?? "Customer",
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

  // ─── Instalment charge (BullMQ job) ──────────────────────────────────────

  async chargeInstallment(planId: string, installmentNumber: number): Promise<void> {
    const plan = await this.installmentService.findById(planId);
    const entry = plan.schedule.find((s) => s.installmentNumber === installmentNumber);
    if (!entry || entry.status === "paid" || plan.status !== "active") return;

    const order = await this.orderService.findById(plan.orderId.toString());
    const reference = `${order.paymentReference}-INST-${installmentNumber}`;
    const email = order.customerEmail;
    if (!email) {
      this.logger.warn({ event: "installment_no_email", planId, installmentNumber });
      return;
    }

    try {
      if (plan.provider === "paystack") {
        const secretKey = this.config.get<string>("paystack.secretKey");
        const res = await fetch("https://api.paystack.co/transaction/charge_authorization", {
          method: "POST",
          headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            authorization_code: plan.authorizationCode,
            email,
            amount: Math.round(entry.amount * 100),
            reference,
            metadata: { purpose: "installment_payment", planId, installmentNumber },
          }),
        });
        if (!res.ok) await this.installmentService.markEntryFailed(planId, installmentNumber);
      } else {
        const secretKey = this.config.get<string>("flutterwave.secretKey");
        const res = await fetch("https://api.flutterwave.com/v3/charges?type=token", {
          method: "POST",
          headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            token: plan.authorizationCode,
            email,
            amount: entry.amount,
            currency: "NGN",
            tx_ref: reference,
            meta: { purpose: "installment_payment", planId, installmentNumber },
          }),
        });
        if (!res.ok) await this.installmentService.markEntryFailed(planId, installmentNumber);
      }
    } catch (err) {
      this.logger.error(
        `Instalment charge error (plan ${planId}, #${installmentNumber})`,
        (err as Error).message,
      );
      await this.installmentService.markEntryFailed(planId, installmentNumber);
    }
  }

  // ─── verifyAndProcess — shared by /verify endpoint + reconcile job ────────

  /**
   * Calls the gateway's verify API for the given reference, then runs the
   * same success/failure handler as the inbound webhook.
   * Uses the same WebhookEvent dedup so it is safe to call multiple times.
   */
  async verifyAndProcess(
    reference: string,
  ): Promise<{ status: string; order: OrderDocument | null }> {
    const order = await this.orderService.findByAnyReference(reference);
    if (!order) {
      this.logger.warn({ event: "verify_no_order", reference });
      return { status: "not_found", order: null };
    }

    const provider = order.paymentProvider;
    if (!provider) return { status: "no_provider", order };

    this.logger.log({ event: "verify_initiated", orderNumber: order.orderNumber, provider });

    if (provider === "paystack") {
      const result = await this.verifyPaystackFull(reference);
      const syntheticEventId = `verify:paystack:${reference}`;
      const existing = await this.webhookModel.findOne({ eventId: syntheticEventId }).lean();
      if (existing) {
        this.logger.log({ event: "verify_duplicate", syntheticEventId });
        return { status: result.status, order };
      }
      if (result.status === "success") {
        await this.handleFullPaymentSuccess({
          orderId: (order._id as unknown as Types.ObjectId).toString(),
          reference,
          paidAmountNgn: result.amountNgn,
          currency: result.currency,
          eventId: syntheticEventId,
          gatewayResponse: result.gatewayResponse,
        });
      } else if (result.status === "failed" || result.status === "abandoned") {
        await this.handleFullPaymentFailure({
          reference,
          rawReason: result.gatewayResponse,
        });
      }
      await this.webhookModel.create({
        provider: "paystack",
        eventId: syntheticEventId,
        type: `verify:${result.status}`,
        payload: { reference, result } as unknown as Record<string, unknown>,
        orderId: null,
        processedAt: new Date(),
      });
      return {
        status: result.status,
        order: await this.orderService.findByAnyReference(reference),
      };
    }

    if (provider === "flutterwave") {
      const result = await this.verifyFlutterwaveFull(reference);
      const syntheticEventId = `verify:flutterwave:${reference}`;
      const existing = await this.webhookModel.findOne({ eventId: syntheticEventId }).lean();
      if (existing) return { status: result.status, order };
      if (result.status === "successful") {
        await this.handleFullPaymentSuccess({
          orderId: (order._id as unknown as Types.ObjectId).toString(),
          reference,
          paidAmountNgn: result.amountNgn,
          currency: result.currency,
          eventId: syntheticEventId,
          gatewayResponse: result.gatewayResponse,
        });
      } else if (result.status === "failed") {
        await this.handleFullPaymentFailure({ reference, rawReason: result.gatewayResponse });
      }
      await this.webhookModel.create({
        provider: "flutterwave",
        eventId: syntheticEventId,
        type: `verify:${result.status}`,
        payload: { reference, result } as unknown as Record<string, unknown>,
        orderId: null,
        processedAt: new Date(),
      });
      return {
        status: result.status,
        order: await this.orderService.findByAnyReference(reference),
      };
    }

    return { status: "unsupported_provider", order };
  }

  // ─── Shared success handler ───────────────────────────────────────────────

  private async handleFullPaymentSuccess(opts: {
    orderId: string;
    reference: string;
    paidAmountNgn: number;
    currency: string;
    eventId: string;
    gatewayResponse?: string;
  }): Promise<void> {
    const order = await this.orderService.findById(opts.orderId);
    const terminalStatuses = [
      "paid",
      "fulfilled",
      "refunded",
      "refund_required",
      "in_installments",
    ];

    if (terminalStatuses.includes(order.status)) {
      this.logger.log({
        event: "success_already_terminal",
        orderNumber: order.orderNumber,
        status: order.status,
      });
      return;
    }

    // Late payment — stock was already released
    const lateStatuses = ["failed", "abandoned", "cancelled"];
    if (lateStatuses.includes(order.status)) {
      const { reserved, order: updated } = await this.orderService.handleLatePayment({
        orderId: opts.orderId,
        webhookId: opts.eventId,
        paidAmountNgn: opts.paidAmountNgn,
        currency: opts.currency,
        reference: opts.reference,
      });

      if (!reserved) {
        // Stock unavailable — customer needs a refund
        await this.notifications.sendRefundRequired(updated);
      } else {
        // Successfully recovered — send confirmation
        const rawToken = updated.customerId
          ? undefined
          : await this.orderService.issueAccessToken(opts.orderId);
        await this.notifications.sendOrderConfirmation(updated, rawToken);
      }
      return;
    }

    // Normal path — pending_payment
    const { mismatch, order: resultOrder } = await this.orderService.markPaidWithAmountCheck({
      orderId: opts.orderId,
      webhookId: opts.eventId,
      paidAmountNgn: opts.paidAmountNgn,
      currency: opts.currency,
      reference: opts.reference,
    });

    if (mismatch) {
      this.logger.warn({ event: "amount_mismatch_flagged", orderNumber: resultOrder.orderNumber });
      return; // Admin will review — no email
    }

    // Commit stock and notify
    for (const item of resultOrder.items) {
      await this.inventoryService.commitReservedStock(item.productId, item.qty);
    }

    const rawToken = resultOrder.customerId
      ? undefined
      : await this.orderService.issueAccessToken(opts.orderId);
    await this.notifications.sendOrderConfirmation(resultOrder, rawToken);
  }

  // ─── Shared failure handler ───────────────────────────────────────────────

  private async handleFullPaymentFailure(opts: {
    reference: string;
    rawReason?: string;
  }): Promise<void> {
    const updated = await this.orderService.markFailedAttempt({
      reference: opts.reference,
      rawFailureReason: opts.rawReason,
    });
    if (!updated) return;

    // Only send the failed-payment email while the hold window is still open
    const now = new Date();
    const holdStillActive =
      updated.reservationExpiresAt !== null && updated.reservationExpiresAt > now;

    if (holdStillActive) {
      const failureCode =
        updated.paymentAttempts
          .slice()
          .reverse()
          .find((a) => a.reference === opts.reference)?.failureCode ?? "UNKNOWN";

      const rawToken = updated.customerId
        ? undefined
        : await this.orderService.issueAccessToken(
            (updated._id as unknown as Types.ObjectId).toString(),
          );

      if (rawToken !== undefined || updated.customerId) {
        await this.notifications.sendPaymentFailed(updated, rawToken ?? "", failureCode);
      }
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
        amount: number; // kobo
        currency: string;
        gateway_response?: string;
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

    // Atomic claim — the unique index on eventId ensures only one concurrent
    // webhook with this eventId proceeds. Any duplicate (retry or race) hits
    // the duplicate-key error and is silently skipped.
    try {
      await this.webhookModel.create({
        provider: "paystack",
        eventId,
        type: event.event,
        payload: event as unknown as Record<string, unknown>,
        orderId: null,
        processedAt: new Date(),
      });
    } catch (err: unknown) {
      const code = (err as { code?: number })?.code;
      if (code === 11000) {
        this.logger.log(`Duplicate Paystack webhook ${eventId} — skipping`);
        return;
      }
      throw err;
    }

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
          const order = await this.orderService.findByAnyReference(event.data.reference);
          if (order) {
            await this.handleFullPaymentSuccess({
              orderId: (order._id as unknown as Types.ObjectId).toString(),
              reference: event.data.reference,
              paidAmountNgn: event.data.amount / 100, // kobo → NGN
              currency: event.data.currency,
              eventId,
              gatewayResponse: event.data.gateway_response,
            });
          }
        }
      } else if (event.event === "charge.failed" || event.event === "transfer.failed") {
        if (purpose === "installment_payment") {
          const { planId, installmentNumber } = event.data.metadata ?? {};
          if (planId && installmentNumber !== undefined) {
            await this.installmentService.markEntryFailed(planId, installmentNumber);
          }
        } else {
          await this.handleFullPaymentFailure({
            reference: event.data.reference,
            rawReason: event.data.gateway_response,
          });
        }
      }
    } catch (err) {
      this.logger.error(`Error processing Paystack webhook ${eventId}`, (err as Error).message);
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
        amount: number; // full NGN
        currency: string;
        processor_response?: string;
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
        const order = await this.orderService.findByAnyReference(event.data.tx_ref);
        if (order) {
          await this.handleFullPaymentSuccess({
            orderId: (order._id as unknown as Types.ObjectId).toString(),
            reference: event.data.tx_ref,
            paidAmountNgn: event.data.amount, // already in NGN
            currency: event.data.currency,
            eventId,
            gatewayResponse: event.data.processor_response,
          });
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
        await this.handleFullPaymentFailure({
          reference: event.data.tx_ref,
          rawReason: event.data.processor_response,
        });
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

  // ─── Installment deposit ──────────────────────────────────────────────────

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

    for (const item of order.items) {
      await this.inventoryService.commitReservedStock(item.productId, item.qty);
    }

    await this.orderService.markInInstallments(orderId);

    await this.installmentService.createPlan({
      orderId,
      customerId: order.customerId ?? "",
      cashPrice: order.total,
      authorizationCode: opts.authorizationCode,
      provider: opts.provider,
    });

    // Confirmation email with order link
    const rawToken = order.customerId
      ? undefined
      : await this.orderService.issueAccessToken(orderId);
    await this.notifications.sendOrderConfirmation(order, rawToken);

    this.logger.log({ event: "installment_deposit_confirmed", orderNumber: order.orderNumber });
  }

  // ─── Gateway verify helpers ───────────────────────────────────────────────

  async verifyPaystackFull(reference: string): Promise<{
    status: string;
    amountNgn: number;
    currency: string;
    gatewayResponse?: string;
  }> {
    const secretKey = this.config.get<string>("paystack.secretKey");
    const res = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${secretKey}` } },
    );
    if (!res.ok) return { status: "unknown", amountNgn: 0, currency: "NGN" };
    const data = (await res.json()) as PaystackVerifyResponse;
    return {
      status: data.data?.status ?? "unknown",
      amountNgn: (data.data?.amount ?? 0) / 100, // kobo → NGN
      currency: data.data?.currency ?? "NGN",
      gatewayResponse: data.data?.gateway_response,
    };
  }

  /** @deprecated Use verifyPaystackFull */
  async verifyPaystackTransaction(reference: string): Promise<string> {
    const result = await this.verifyPaystackFull(reference);
    return result.status;
  }

  async verifyFlutterwaveFull(reference: string): Promise<{
    status: string;
    amountNgn: number;
    currency: string;
    gatewayResponse?: string;
  }> {
    const secretKey = this.config.get<string>("flutterwave.secretKey");
    const res = await fetch(
      `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${secretKey}` } },
    );
    if (!res.ok) return { status: "unknown", amountNgn: 0, currency: "NGN" };
    const data = (await res.json()) as FlutterwaveVerifyResponse;
    return {
      status: data.data?.status ?? "unknown",
      amountNgn: data.data?.amount ?? 0,
      currency: data.data?.currency ?? "NGN",
      gatewayResponse: data.data?.processor_response,
    };
  }
}
