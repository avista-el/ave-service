import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Cart, CartDocument, CartLineEmbedded } from "./schemas/cart.schema";
import { Product, ProductDocument } from "../catalog/schemas/product.schema";
import { AddToCartDto, UpdateLineDto } from "./dto/cart.dto";
import { Types } from "mongoose";

const CART_TTL_DAYS = 14;

@Injectable()
export class CartService {
  constructor(
    @InjectModel(Cart.name) private readonly cartModel: Model<CartDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
  ) {}

  // ─── Resolve or create cart ───────────────────────────────────────────────

  async getOrCreate(userId: string | null, guestId: string | null): Promise<CartDocument> {
    const query = userId ? { userId } : { guestId };
    let cart = await this.cartModel.findOne(query);
    if (!cart) {
      cart = await this.cartModel.create({
        userId,
        guestId,
        lines: [],
        expiresAt: this.newExpiry(),
      });
    }
    return cart;
  }

  async getCart(userId: string | null, guestId: string | null) {
    const cart = await this.getOrCreate(userId, guestId);
    return this.buildResponse(cart);
  }

  // ─── Add / update / remove lines ─────────────────────────────────────────

  async addToCart(userId: string | null, guestId: string | null, dto: AddToCartDto) {
    const product = await this.productModel.findById(dto.productId).lean();
    if (!product) throw new NotFoundException("Product not found");
    if (product.status !== "active") throw new BadRequestException("Product is not available");

    const available = product.stock - product.reserved;
    if (available <= 0) throw new BadRequestException(`"${product.title}" is out of stock`);

    const cart = await this.getOrCreate(userId, guestId);
    const existing = cart.lines.find((l) => l.productId === dto.productId);

    if (existing) {
      const newQty = existing.quantity + dto.quantity;
      if (newQty > available)
        throw new BadRequestException(`Only ${available} unit(s) available for "${product.title}"`);
      existing.quantity = newQty;
      existing.unitPrice = product.price; // refresh price on add
    } else {
      if (dto.quantity > available)
        throw new BadRequestException(`Only ${available} unit(s) available for "${product.title}"`);
      cart.lines.push({
        productId: dto.productId,
        sku: product.sku,
        title: product.title,
        image: product.images[0] ?? "",
        unitPrice: product.price,
        quantity: dto.quantity,
      } as CartLineEmbedded);
    }

    cart.expiresAt = this.newExpiry();
    cart.markModified("lines");
    await cart.save();
    return this.buildResponse(cart);
  }

  async updateLine(userId: string | null, guestId: string | null, dto: UpdateLineDto) {
    const cart = await this.getOrCreate(userId, guestId);
    if (dto.quantity === 0) {
      cart.lines = cart.lines.filter((l) => l.productId !== dto.productId);
    } else {
      const line = cart.lines.find((l) => l.productId === dto.productId);
      if (!line) throw new NotFoundException("Line item not found");

      const product = await this.productModel.findById(dto.productId).lean();
      if (product) {
        const available = product.stock - product.reserved;
        if (dto.quantity > available)
          throw new BadRequestException(`Only ${available} unit(s) available`);
      }
      line.quantity = dto.quantity;
    }

    cart.markModified("lines");
    await cart.save();
    return this.buildResponse(cart);
  }

  async removeLine(userId: string | null, guestId: string | null, productId: string) {
    const cart = await this.getOrCreate(userId, guestId);
    cart.lines = cart.lines.filter((l) => l.productId !== productId);
    cart.markModified("lines");
    await cart.save();
    return this.buildResponse(cart);
  }

  async clearCart(userId: string | null, guestId: string | null) {
    const cart = await this.getOrCreate(userId, guestId);
    cart.lines = [];
    cart.promoCode = null;
    cart.discountAmount = null;
    await cart.save();
    return this.buildResponse(cart);
  }

  // ─── Merge guest cart into authenticated user cart on login ──────────────

  async mergeGuestCart(userId: string, guestId: string) {
    const guestCart = await this.cartModel.findOne({ guestId });
    if (!guestCart || guestCart.lines.length === 0) return;

    let userCart = await this.cartModel.findOne({ userId });
    if (!userCart) {
      // Promote guest cart to user cart
      guestCart.userId = userId;
      guestCart.guestId = null;
      guestCart.expiresAt = this.newExpiry();
      await guestCart.save();
      return;
    }

    // Merge lines — guest quantity wins for matching products
    for (const guestLine of guestCart.lines) {
      const existing = userCart.lines.find((l) => l.productId === guestLine.productId);
      if (existing) {
        existing.quantity = Math.max(existing.quantity, guestLine.quantity);
      } else {
        userCart.lines.push(guestLine);
      }
    }

    userCart.expiresAt = this.newExpiry();
    userCart.markModified("lines");
    await userCart.save();
    await guestCart.deleteOne();
  }

  // ─── Response builder ─────────────────────────────────────────────────────

  private buildResponse(cart: CartDocument) {
    const subtotal = cart.lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
    const discount = cart.discountAmount ?? 0;
    return {
      id: (cart._id as unknown as Types.ObjectId).toString(),
      lines: cart.lines.map((l) => ({
        productId: l.productId,
        sku: l.sku,
        title: l.title,
        image: l.image,
        unitPrice: l.unitPrice,
        quantity: l.quantity,
        lineTotal: l.unitPrice * l.quantity,
      })),
      count: cart.lines.reduce((sum, l) => sum + l.quantity, 0),
      subtotal,
      discountAmount: discount,
      total: subtotal - discount,
      promoCode: cart.promoCode,
    };
  }

  private newExpiry(): Date {
    const d = new Date();
    d.setDate(d.getDate() + CART_TTL_DAYS);
    return d;
  }

  // Used by OrderModule to read cart before checkout
  async getCartById(cartId: string): Promise<CartDocument | null> {
    return this.cartModel.findById(cartId);
  }

  async applyPromo(
    userId: string | null,
    guestId: string | null,
    code: string,
    discountAmount: number,
  ) {
    const cart = await this.getOrCreate(userId, guestId);
    cart.promoCode = code;
    cart.discountAmount = discountAmount;
    await cart.save();
    return this.buildResponse(cart);
  }
}
