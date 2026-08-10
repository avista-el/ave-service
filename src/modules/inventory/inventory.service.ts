import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, ClientSession } from 'mongoose';
import { Product, ProductDocument } from '../catalog/schemas/product.schema';

export interface StockAdjustment {
  productId: string;
  qty: number;
}

@Injectable()
export class InventoryService {
  constructor(
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
  ) {}

  // ─── Reservation (called at order creation) ───────────────────────────────
  // Single atomic findOneAndUpdate — no read-then-write race window.

  async reserveStock(
    productId: string,
    qty: number,
    session?: ClientSession,
  ): Promise<void> {
    const result = await this.productModel.findOneAndUpdate(
      {
        _id: productId,
        status: 'active',
        // available = stock - reserved >= qty
        $expr: { $gte: [{ $subtract: ['$stock', '$reserved'] }, qty] },
      },
      { $inc: { reserved: qty } },
      { new: true, session },
    );
    if (!result) {
      const product = await this.productModel.findById(productId).lean();
      if (!product) throw new NotFoundException(`Product ${productId} not found`);
      throw new ConflictException(
        `Insufficient stock for "${product.title}" — only ${product.stock - product.reserved} available`,
      );
    }
  }

  // ─── Batch reservation (multi-item order, uses Mongo transaction) ─────────

  async reserveStockBatch(
    items: StockAdjustment[],
    session: ClientSession,
  ): Promise<void> {
    for (const item of items) {
      await this.reserveStock(item.productId, item.qty, session);
    }
  }

  // ─── Commit (called on confirmed payment) ────────────────────────────────
  // Converts reservation into actual stock decrement.

  async commitReservedStock(
    productId: string,
    qty: number,
    session?: ClientSession,
  ): Promise<void> {
    const result = await this.productModel.findByIdAndUpdate(
      productId,
      { $inc: { stock: -qty, reserved: -qty } },
      { new: true, session },
    );
    if (!result) throw new NotFoundException(`Product ${productId} not found`);
  }

  async commitReservedStockBatch(
    items: StockAdjustment[],
    session: ClientSession,
  ): Promise<void> {
    for (const item of items) {
      await this.commitReservedStock(item.productId, item.qty, session);
    }
  }

  // ─── Release (called on payment failure / cart/order expiry) ─────────────

  async releaseStock(
    productId: string,
    qty: number,
    session?: ClientSession,
  ): Promise<void> {
    await this.productModel.findByIdAndUpdate(
      productId,
      {
        $inc: { reserved: -qty },
        // Guard: reserved must not go below 0
        $max: { reserved: 0 },
      },
      { session },
    );
  }

  async releaseStockBatch(
    items: StockAdjustment[],
    session?: ClientSession,
  ): Promise<void> {
    for (const item of items) {
      await this.releaseStock(item.productId, item.qty, session);
    }
  }

  // ─── Admin: direct stock adjustment ──────────────────────────────────────
  // Used by sync module and admin dashboard.
  // Validates that new stock level is not below reserved.

  async setStock(
    productId: string,
    newStock: number,
    actorId: string,
  ): Promise<ProductDocument> {
    const product = await this.productModel.findById(productId);
    if (!product) throw new NotFoundException(`Product ${productId} not found`);

    if (newStock < product.reserved) {
      throw new ConflictException(
        `Cannot set stock to ${newStock} — ${product.reserved} units are currently reserved by in-flight orders`,
      );
    }

    const updated = await this.productModel.findByIdAndUpdate(
      productId,
      {
        stock: newStock,
        lastModifiedBy: `admin:${actorId}`,
      },
      { new: true },
    );
    return updated!;
  }

  // ─── Expiry: release reservations for orders stuck in pending_payment ─────
  // Called by BullMQ reservation-expiry job.

  async releaseExpiredReservations(
    productId: string,
    qty: number,
  ): Promise<void> {
    await this.releaseStock(productId, qty);
  }

  // ─── Query helpers ────────────────────────────────────────────────────────

  async getStockStatus(productId: string) {
    const product = await this.productModel
      .findById(productId)
      .select('stock reserved title')
      .lean();
    if (!product) throw new NotFoundException('Product not found');
    const available = product.stock - product.reserved;
    return {
      productId,
      stock: product.stock,
      reserved: product.reserved,
      available,
      stockStatus:
        available <= 0
          ? 'out_of_stock'
          : available <= 5
            ? 'low_stock'
            : 'in_stock',
    };
  }

  async getLowStockProducts(threshold = 5) {
    return this.productModel
      .find({
        status: 'active',
        $expr: { $lte: [{ $subtract: ['$stock', '$reserved'] }, threshold] },
      })
      .select('title sku stock reserved images categoryName brandName')
      .lean();
  }
}
