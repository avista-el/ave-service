import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Order, OrderDocument } from "../order/schemas/order.schema";
import { Product, ProductDocument } from "../catalog/schemas/product.schema";

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
  ) {}

  // ─── Dashboard metrics — mirrors admin-data.ts frontend shapes ───────────

  async getDashboardMetrics() {
    const [revenueResult, orderCount, pendingCount, unitsSold, lowStockCount] = await Promise.all([
      this.orderModel.aggregate([
        { $match: { status: { $in: ["paid", "fulfilled"] } } },
        {
          $group: {
            _id: null,
            total: { $sum: "$total" },
            count: { $sum: 1 },
          },
        },
      ]),
      this.orderModel.countDocuments(),
      this.orderModel.countDocuments({ status: "pending_payment" }),
      this.orderModel.aggregate([
        { $match: { status: { $in: ["paid", "fulfilled"] } } },
        { $unwind: "$items" },
        { $group: { _id: null, total: { $sum: "$items.qty" } } },
      ]),
      this.productModel.countDocuments({
        status: "active",
        $expr: { $lte: [{ $subtract: ["$stock", "$reserved"] }, 5] },
      }),
    ]);

    const paidRevenue = revenueResult[0]?.total ?? 0;
    const paidCount = revenueResult[0]?.count ?? 0;

    return {
      revenueBase: paidRevenue,
      orderCount,
      unitsSold: unitsSold[0]?.total ?? 0,
      averageOrderBase: paidCount > 0 ? Math.round(paidRevenue / paidCount) : 0,
      pendingCount,
      lowStockCount,
    };
  }

  // ─── Revenue series — last N months ──────────────────────────────────────

  async getRevenueSeries(months = 7) {
    const from = new Date();
    from.setMonth(from.getMonth() - months + 1);
    from.setDate(1);
    from.setHours(0, 0, 0, 0);

    const result = await this.orderModel.aggregate([
      {
        $match: {
          status: { $in: ["paid", "fulfilled"] },
          createdAt: { $gte: from },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
          },
          revenue: { $sum: "$total" },
          orders: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]);

    const monthNames = [
      "",
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];

    return result.map((r) => ({
      month: monthNames[r._id.month as number],
      year: r._id.year as number,
      revenue: r.revenue as number,
      orders: r.orders as number,
    }));
  }

  // ─── Category mix — % of revenue by category ─────────────────────────────

  async getCategoryMix() {
    const result = await this.orderModel.aggregate([
      { $match: { status: { $in: ["paid", "fulfilled"] } } },
      { $unwind: "$items" },
      {
        $lookup: {
          from: "products",
          localField: "items.productId",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: "$product.categoryName",
          revenue: {
            $sum: { $multiply: ["$items.unitPrice", "$items.qty"] },
          },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 6 },
    ]);

    const totalRevenue = result.reduce((s, r) => s + (r.revenue as number), 0);

    return result.map((r) => ({
      name: (r._id as string) ?? "Unknown",
      value: totalRevenue > 0 ? Math.round(((r.revenue as number) / totalRevenue) * 100) : 0,
    }));
  }

  // ─── Top products by revenue ──────────────────────────────────────────────

  async getTopProducts(limit = 10) {
    return this.orderModel.aggregate([
      { $match: { status: { $in: ["paid", "fulfilled"] } } },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.productId",
          title: { $first: "$items.title" },
          revenue: {
            $sum: { $multiply: ["$items.unitPrice", "$items.qty"] },
          },
          unitsSold: { $sum: "$items.qty" },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: limit },
    ]);
  }

  // ─── Low stock products ───────────────────────────────────────────────────

  async getLowStockProducts(threshold = 5) {
    return this.productModel
      .find({
        status: "active",
        $expr: { $lte: [{ $subtract: ["$stock", "$reserved"] }, threshold] },
      })
      .select("title sku stock reserved categoryName brandName images")
      .sort({ stock: 1 })
      .limit(20)
      .lean();
  }
}
