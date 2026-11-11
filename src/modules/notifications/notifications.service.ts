import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Resend } from "resend";
import { Order, OrderDocument } from "../order/schemas/order.schema";

// ─── Email type keys (used for idempotency via order.sentEmails) ──────────────
export const EMAIL_TYPE = {
  ORDER_CONFIRMED: "order_confirmed",
  PAYMENT_FAILED: "payment_failed",
  ORDER_EXPIRED: "order_expired",
  ORDER_CANCELLED: "order_cancelled",
  REFUND_REQUIRED: "refund_required",
  TRACK_LINK: "track_link",
} as const;

export type EmailType = (typeof EMAIL_TYPE)[keyof typeof EMAIL_TYPE];

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly resend: Resend;
  private readonly fromEmail: string;
  private readonly storefrontUrl: string;

  constructor(
    private readonly config: ConfigService,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
  ) {
    this.resend = new Resend(this.config.get<string>("resend.apiKey"));
    this.fromEmail = this.config.get<string>(
      "resend.fromEmail",
      "orders@mail.alphavistaelectronics.com",
    );
    this.storefrontUrl = this.config.get<string>(
      "storefront.baseUrl",
      "https://alphavistaelectronics.com",
    );
  }

  // ─── Order confirmed ──────────────────────────────────────────────────────

  async sendOrderConfirmation(order: OrderDocument, rawToken?: string): Promise<void> {
    const to = order.customerEmail;
    if (!to) return;

    const sent = await this.markEmailSent(
      (order._id as Types.ObjectId).toString(),
      EMAIL_TYPE.ORDER_CONFIRMED,
    );
    if (!sent) return; // already sent — idempotent

    const orderLink = this.orderLink(order.orderNumber, rawToken);

    const itemRows = order.items
      .map(
        (i) =>
          `<tr>
            <td style="padding:8px 0;border-bottom:1px solid #eee">${escHtml(i.title)}</td>
            <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:center">${i.qty}</td>
            <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">₦${i.unitPrice.toLocaleString("en-NG")}</td>
          </tr>`,
      )
      .join("");

    const html = `
      <!DOCTYPE html>
      <html>
      <body style="font-family:'DM Sans',Arial,sans-serif;color:#111;max-width:600px;margin:0 auto;padding:24px">
        <h1 style="font-size:22px;margin-bottom:4px">Order Confirmed ✅</h1>
        <p style="color:#555">Hi ${escHtml(order.customerName ?? "there")}, your order has been received and payment confirmed.</p>

        <div style="background:#f9f9f9;border-radius:8px;padding:16px;margin:16px 0">
          <p style="margin:0 0 4px"><strong>Order:</strong> ${order.orderNumber}</p>
          <p style="margin:0"><strong>Total:</strong> ₦${order.total.toLocaleString("en-NG")}</p>
        </div>

        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="border-bottom:2px solid #eee">
              <th style="text-align:left;padding-bottom:8px">Item</th>
              <th style="text-align:center;padding-bottom:8px">Qty</th>
              <th style="text-align:right;padding-bottom:8px">Price</th>
            </tr>
          </thead>
          <tbody>${itemRows}</tbody>
        </table>

        <p style="margin-top:24px">
          <a href="${orderLink}"
             style="background:#111;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">
            View Order
          </a>
        </p>

        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="font-size:12px;color:#999">
          Alphavista Electronics · Abuja, Nigeria<br>
          Questions? Reply to this email or WhatsApp +234-907-124-2555
        </p>
      </body>
      </html>
    `;

    await this.send(to, `Order Confirmed: ${order.orderNumber}`, html);
  }

  // ─── Payment failed (sent while hold is still active) ────────────────────

  /**
   * Sent once per order after the first failed payment attempt, while
   * reservationExpiresAt is still in the future.
   * Includes a retry link with a fresh access token and the expiry time.
   */
  async sendPaymentFailed(
    order: OrderDocument,
    rawToken: string,
    failureCode: string,
  ): Promise<void> {
    const to = order.customerEmail;
    if (!to) return;

    const sent = await this.markEmailSent(
      (order._id as Types.ObjectId).toString(),
      EMAIL_TYPE.PAYMENT_FAILED,
    );
    if (!sent) return;

    const retryLink = this.orderLink(order.orderNumber, rawToken);
    const expiryText = order.reservationExpiresAt
      ? `Your items are reserved until <strong>${formatDate(order.reservationExpiresAt)}</strong>.`
      : "Your items are still reserved while you retry.";

    const friendlyReason: Record<string, string> = {
      DECLINED: "Your card was declined.",
      INSUFFICIENT_FUNDS: "Your card had insufficient funds.",
      TIMEOUT: "The payment timed out.",
      CANCELLED_BY_USER: "The payment was cancelled.",
      UNKNOWN: "The payment could not be completed.",
    };

    const html = `
      <!DOCTYPE html>
      <html>
      <body style="font-family:'DM Sans',Arial,sans-serif;color:#111;max-width:600px;margin:0 auto;padding:24px">
        <h1 style="font-size:22px;margin-bottom:4px">Payment unsuccessful</h1>
        <p style="color:#555">Hi ${escHtml(order.customerName ?? "there")},</p>
        <p>${escHtml(friendlyReason[failureCode] ?? friendlyReason["UNKNOWN"])} No money was taken from your account.</p>

        <div style="background:#fff8e1;border-left:4px solid #f59e0b;border-radius:4px;padding:12px 16px;margin:16px 0">
          <p style="margin:0">${expiryText} You can try again with the same or a different card.</p>
        </div>

        <p style="margin-top:24px">
          <a href="${retryLink}"
             style="background:#7c3aed;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">
            Retry payment →
          </a>
        </p>

        <p style="font-size:13px;color:#555">
          Order: <strong>${order.orderNumber}</strong> · Total: ₦${order.total.toLocaleString("en-NG")}
        </p>

        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="font-size:12px;color:#999">
          Alphavista Electronics · Abuja, Nigeria<br>
          Questions? WhatsApp +234-907-124-2555
        </p>
      </body>
      </html>
    `;

    await this.send(to, `Payment unsuccessful — Order ${order.orderNumber}`, html);
  }

  // ─── Order expired / abandoned ────────────────────────────────────────────

  /**
   * Sent when an order expires (reservation released) IF a payment attempt
   * was started (i.e. the customer actually tried to pay).
   * Never sent for orders that were created but never initiated.
   */
  async sendOrderExpired(order: OrderDocument): Promise<void> {
    const to = order.customerEmail;
    if (!to) return;

    // Only send if at least one attempt was started
    if (!order.paymentAttempts || order.paymentAttempts.length === 0) return;

    const sent = await this.markEmailSent(
      (order._id as Types.ObjectId).toString(),
      EMAIL_TYPE.ORDER_EXPIRED,
    );
    if (!sent) return;

    const html = `
      <!DOCTYPE html>
      <html>
      <body style="font-family:'DM Sans',Arial,sans-serif;color:#111;max-width:600px;margin:0 auto;padding:24px">
        <h1 style="font-size:22px;margin-bottom:4px">Your order reservation expired</h1>
        <p style="color:#555">Hi ${escHtml(order.customerName ?? "there")},</p>
        <p>
          Unfortunately your order <strong>${order.orderNumber}</strong> could not be completed in time
          and the reserved stock has been released back to our inventory.
        </p>
        <p>
          If you still want these items, please
          <a href="${this.storefrontUrl}/shop" style="color:#7c3aed">visit the store</a> and place a new order.
        </p>
        <p style="font-size:13px;color:#777">No money was taken from your account.</p>

        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="font-size:12px;color:#999">Alphavista Electronics · Abuja, Nigeria</p>
      </body>
      </html>
    `;

    await this.send(to, `Order ${order.orderNumber} expired`, html);
  }

  // ─── Order cancelled ──────────────────────────────────────────────────────

  async sendOrderCancelled(order: OrderDocument, rawToken?: string): Promise<void> {
    const to = order.customerEmail;
    if (!to) return;

    const sent = await this.markEmailSent(
      (order._id as Types.ObjectId).toString(),
      EMAIL_TYPE.ORDER_CANCELLED,
    );
    if (!sent) return;

    const shopLink = `${this.storefrontUrl}/shop`;
    const orderLink = rawToken ? this.orderLink(order.orderNumber, rawToken) : null;

    const html = `
      <!DOCTYPE html>
      <html>
      <body style="font-family:'DM Sans',Arial,sans-serif;color:#111;max-width:600px;margin:0 auto;padding:24px">
        <h1 style="font-size:22px;margin-bottom:4px">Order cancelled</h1>
        <p style="color:#555">Hi ${escHtml(order.customerName ?? "there")},</p>
        <p>Your order <strong>${order.orderNumber}</strong> has been cancelled.</p>
        ${
          order.cancellationReason
            ? `<p style="color:#555">Reason: ${escHtml(order.cancellationReason)}</p>`
            : ""
        }
        <p>No payment was taken. If you have questions, contact us on WhatsApp.</p>
        ${
          orderLink
            ? `<p><a href="${orderLink}" style="color:#7c3aed">View order details</a></p>`
            : ""
        }
        <p><a href="${shopLink}" style="color:#7c3aed">Continue shopping →</a></p>

        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="font-size:12px;color:#999">Alphavista Electronics · Abuja, Nigeria</p>
      </body>
      </html>
    `;

    await this.send(to, `Order ${order.orderNumber} cancelled`, html);
  }

  // ─── Refund required ──────────────────────────────────────────────────────

  /**
   * Sent when a late payment arrives but stock cannot be re-reserved.
   * Tells the customer a full refund is being arranged.
   */
  async sendRefundRequired(order: OrderDocument): Promise<void> {
    const to = order.customerEmail;
    if (!to) return;

    const sent = await this.markEmailSent(
      (order._id as Types.ObjectId).toString(),
      EMAIL_TYPE.REFUND_REQUIRED,
    );
    if (!sent) return;

    const html = `
      <!DOCTYPE html>
      <html>
      <body style="font-family:'DM Sans',Arial,sans-serif;color:#111;max-width:600px;margin:0 auto;padding:24px">
        <h1 style="font-size:22px;margin-bottom:4px">We received your payment — but there's a problem</h1>
        <p style="color:#555">Hi ${escHtml(order.customerName ?? "there")},</p>
        <p>
          We received your payment for order <strong>${order.orderNumber}</strong>, but unfortunately
          the items you ordered are no longer in stock and we cannot fulfil the order.
        </p>
        <p>
          <strong>A full refund of ₦${order.total.toLocaleString("en-NG")} will be issued to your original payment method
          within 3–5 business days.</strong>
        </p>
        <p>
          Our team has been notified and will process your refund as a priority.
          If you have questions, please reply to this email or WhatsApp +234-907-124-2555.
        </p>

        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="font-size:12px;color:#999">Alphavista Electronics · Abuja, Nigeria</p>
      </body>
      </html>
    `;

    await this.send(to, `Refund for Order ${order.orderNumber} — Action Required`, html);
  }

  // ─── Track link (self-service order lookup) ───────────────────────────────

  /**
   * Sends a fresh secure link for the customer to view their order.
   * Unlike other emails this is NOT idempotent — a new token is issued
   * on every call.  Rate limiting is enforced at the controller layer.
   */
  async sendTrackLink(opts: {
    to: string;
    orderNumber: string;
    rawToken: string;
    customerName?: string | null;
  }): Promise<void> {
    const orderLink = this.orderLink(opts.orderNumber, opts.rawToken);

    const html = `
      <!DOCTYPE html>
      <html>
      <body style="font-family:'DM Sans',Arial,sans-serif;color:#111;max-width:600px;margin:0 auto;padding:24px">
        <h1 style="font-size:22px;margin-bottom:4px">Your order link</h1>
        <p style="color:#555">Hi ${escHtml(opts.customerName ?? "there")},</p>
        <p>Here is your secure link to view order <strong>${opts.orderNumber}</strong>.</p>
        <p>
          <a href="${orderLink}"
             style="background:#111;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">
            View order →
          </a>
        </p>
        <p style="font-size:12px;color:#777">This link expires in 30 days. Do not share it with others.</p>

        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="font-size:12px;color:#999">Alphavista Electronics · Abuja, Nigeria</p>
      </body>
      </html>
    `;

    await this.send(opts.to, `Your order link — ${opts.orderNumber}`, html);
  }

  // ─── Order status update (existing, kept for backward compat) ────────────

  async sendOrderStatusUpdate(order: OrderDocument, previousStatus: string): Promise<void> {
    const to = order.customerEmail;
    if (!to) return;

    const statusMessages: Record<string, string> = {
      fulfilled: "Your order has been dispatched and is on its way!",
      cancelled: "Your order has been cancelled. Contact us if you have questions.",
      refunded: "Your refund has been processed. It should appear within 3–5 business days.",
    };

    const message = statusMessages[order.status];
    if (!message) return;

    const html = `
      <p>Hi ${escHtml(order.customerName ?? "there")},</p>
      <p>${message}</p>
      <p><strong>Order:</strong> ${order.orderNumber}</p>
      <p><a href="${this.storefrontUrl}/account/orders">View Order</a></p>
    `;

    const subjects: Record<string, string> = {
      fulfilled: `Your order ${order.orderNumber} is on its way!`,
      cancelled: `Order ${order.orderNumber} cancelled`,
      refunded: `Refund processed for ${order.orderNumber}`,
    };

    await this.send(to, subjects[order.status] ?? `Order Update: ${order.orderNumber}`, html);
  }

  // ─── Back-in-stock alert (existing) ──────────────────────────────────────

  async sendBackInStockAlert(to: string, productTitle: string, productSlug: string): Promise<void> {
    const html = `
      <p>Good news! <strong>${escHtml(productTitle)}</strong> is back in stock.</p>
      <p><a href="${this.storefrontUrl}/product/${productSlug}">Shop now →</a></p>
    `;
    await this.send(to, `Back in stock: ${productTitle}`, html);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Idempotent email-sent marker.
   * Uses an atomic findOneAndUpdate CAS so duplicate webhook/verify calls
   * can't send the same email twice.
   * Returns true only on the first call (the email should be sent now).
   */
  private async markEmailSent(orderId: string, emailType: string): Promise<boolean> {
    const result = await this.orderModel.findOneAndUpdate(
      {
        _id: new Types.ObjectId(orderId),
        [`sentEmails.${emailType}`]: { $exists: false },
      },
      { $set: { [`sentEmails.${emailType}`]: new Date() } },
      { new: false },
    );
    return result !== null;
  }

  /**
   * Builds the storefront order-tracking URL.
   * When a rawToken is provided it is appended so the customer can view the
   * order without logging in.  The token is passed as a query param — the
   * frontend passes it to GET /v1/orders/public/:orderNumber?token=...
   */
  private orderLink(orderNumber: string, rawToken?: string): string {
    const base = `${this.storefrontUrl}/order/${orderNumber}`;
    return rawToken ? `${base}?token=${encodeURIComponent(rawToken)}` : base;
  }

  private async send(to: string, subject: string, html: string): Promise<void> {
    try {
      await this.resend.emails.send({ from: this.fromEmail, to, subject, html });
    } catch (err) {
      // Log but never crash the caller — email failures are non-fatal
      this.logger.error(`Email send failed (subject: "${subject}"): ${(err as Error).message}`);
    }
  }
}

// ─── Utility — minimal HTML escaping to prevent injection in email bodies ────
function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(d: Date): string {
  return d.toLocaleString("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
