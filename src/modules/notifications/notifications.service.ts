import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { OrderDocument } from '../order/schemas/order.schema';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly resend: Resend;
  private readonly fromEmail: string;
  private readonly storefrontUrl: string;

  constructor(private readonly config: ConfigService) {
    this.resend = new Resend(this.config.get<string>('resend.apiKey'));
    this.fromEmail = this.config.get<string>(
      'resend.fromEmail',
      'orders@mail.alphavista.ng',
    );
    this.storefrontUrl = this.config.get<string>(
      'storefront.baseUrl',
      'https://alphavista.ng',
    );
  }

  // ─── Order confirmation ───────────────────────────────────────────────────

  async sendOrderConfirmation(order: OrderDocument): Promise<void> {
    const to = order.customerEmail;
    if (!to) return;

    const itemRows = order.items
      .map(
        (i) =>
          `<tr>
            <td style="padding:8px 0;border-bottom:1px solid #eee">${i.title}</td>
            <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:center">${i.qty}</td>
            <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">₦${i.unitPrice.toLocaleString()}</td>
          </tr>`,
      )
      .join('');

    const html = `
      <!DOCTYPE html>
      <html>
      <body style="font-family:'DM Sans',Arial,sans-serif;color:#111;max-width:600px;margin:0 auto;padding:24px">
        <h1 style="font-size:22px;margin-bottom:4px">Order Confirmed ✅</h1>
        <p style="color:#555">Hi ${order.customerName ?? 'there'}, your order has been received and payment confirmed.</p>

        <div style="background:#f9f9f9;border-radius:8px;padding:16px;margin:16px 0">
          <p style="margin:0 0 4px"><strong>Order:</strong> ${order.orderNumber}</p>
          <p style="margin:0"><strong>Total:</strong> ₦${order.total.toLocaleString()}</p>
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
          <a href="${this.storefrontUrl}/account/orders"
             style="background:#111;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">
            View Order
          </a>
        </p>

        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="font-size:12px;color:#999">
          Alphavista Electronics · Abuja, Nigeria<br>
          Questions? Reply to this email or WhatsApp +234-XXX-XXXX-XXX
        </p>
      </body>
      </html>
    `;

    await this.send(to, `Order Confirmed: ${order.orderNumber}`, html);
  }

  // ─── Order status update ──────────────────────────────────────────────────

  async sendOrderStatusUpdate(
    order: OrderDocument,
    previousStatus: string,
  ): Promise<void> {
    const to = order.customerEmail;
    if (!to) return;

    const statusMessages: Record<string, string> = {
      fulfilled: 'Your order has been dispatched and is on its way!',
      cancelled: 'Your order has been cancelled. Contact us if you have questions.',
      refunded: 'Your refund has been processed. It should appear within 3–5 business days.',
    };

    const message = statusMessages[order.status];
    if (!message) return;

    const html = `
      <p>Hi ${order.customerName ?? 'there'},</p>
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

  // ─── Back-in-stock alert ──────────────────────────────────────────────────

  async sendBackInStockAlert(
    to: string,
    productTitle: string,
    productSlug: string,
  ): Promise<void> {
    const html = `
      <p>Good news! <strong>${productTitle}</strong> is back in stock.</p>
      <p><a href="${this.storefrontUrl}/product/${productSlug}">Shop now →</a></p>
    `;
    await this.send(to, `Back in stock: ${productTitle}`, html);
  }

  // ─── Core send helper ─────────────────────────────────────────────────────

  private async send(to: string, subject: string, html: string): Promise<void> {
    try {
      await this.resend.emails.send({
        from: this.fromEmail,
        to,
        subject,
        html,
      });
    } catch (err) {
      // Log but never crash the caller
      this.logger.error(`Email send failed to ${to}: ${(err as Error).message}`);
    }
  }
}
