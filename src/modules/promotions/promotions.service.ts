import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";

// Plain lean type to avoid FlattenMaps<Document> incompatibility
type LeanDiscountCode = {
  _id: Types.ObjectId;
  code: string;
  type: "percent" | "fixed";
  value: number;
  minOrderAmount: number | null;
  startsAt: Date;
  endsAt: Date;
  usageLimit: number | null;
  usedCount: number;
  scope: "all" | "category" | "product";
  targets: string[];
  active: boolean;
  applications: Array<{
    _id: Types.ObjectId;
    scope: "product" | "category" | "catalogue";
    targetId: string | null;
    appliedBy: string;
    appliedAt: Date;
    active: boolean;
  }>;
};
import { DiscountCode, DiscountCodeDocument } from "./schemas/discount-code.schema";
import { CreateDiscountDto } from "./dto/create-discount.dto";
import { ApplyScopeDto } from "./dto/apply-scope.dto";

@Injectable()
export class PromotionsService {
  constructor(
    @InjectModel(DiscountCode.name)
    private readonly discountModel: Model<DiscountCodeDocument>,
  ) {}

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  async create(dto: CreateDiscountDto): Promise<DiscountCodeDocument> {
    const code = dto.code.toUpperCase().trim();
    const exists = await this.discountModel.exists({ code });
    if (exists) throw new ConflictException("Discount code already exists");
    return this.discountModel.create({ ...dto, code });
  }

  async findAll(): Promise<LeanDiscountCode[]> {
    return this.discountModel.find().sort({ createdAt: -1 }).lean<LeanDiscountCode[]>();
  }

  async findById(id: string): Promise<LeanDiscountCode> {
    const doc = await this.discountModel.findById(id).lean<LeanDiscountCode>();
    if (!doc) throw new NotFoundException("Discount code not found");
    return doc;
  }

  async update(id: string, dto: Partial<CreateDiscountDto>): Promise<DiscountCodeDocument> {
    const doc = await this.discountModel.findByIdAndUpdate(id, dto, {
      new: true,
    });
    if (!doc) throw new NotFoundException("Discount code not found");
    return doc;
  }

  async remove(id: string): Promise<void> {
    const result = await this.discountModel.findByIdAndDelete(id);
    if (!result) throw new NotFoundException("Discount code not found");
  }

  // ─── Validation: used by cart and checkout ────────────────────────────────

  async validateAndApply(
    code: string,
    orderTotal: number,
    cartCategorySlug?: string,
  ): Promise<{ discountAmount: number; code: string }> {
    const now = new Date();
    const doc = await this.discountModel.findOne({
      code: code.toUpperCase().trim(),
      active: true,
      startsAt: { $lte: now },
      endsAt: { $gte: now },
    });

    if (!doc) throw new BadRequestException("Invalid or expired promo code");

    if (doc.usageLimit !== null && doc.usedCount >= doc.usageLimit) {
      throw new BadRequestException("Promo code usage limit reached");
    }

    if (doc.minOrderAmount !== null && orderTotal < doc.minOrderAmount) {
      throw new BadRequestException(
        `Minimum order amount for this code is ₦${doc.minOrderAmount.toLocaleString()}`,
      );
    }

    let discountAmount = 0;
    if (doc.type === "percent") {
      discountAmount = Math.round((orderTotal * doc.value) / 100);
    } else {
      discountAmount = Math.min(doc.value, orderTotal);
    }

    return { discountAmount, code: doc.code };
  }

  /** Increment usage counter — called after successful payment */
  async incrementUsage(code: string): Promise<void> {
    await this.discountModel.findOneAndUpdate(
      { code: code.toUpperCase() },
      { $inc: { usedCount: 1 } },
    );
  }

  // ─── Auto-apply applications ──────────────────────────────────────────────

  /**
   * Add a new application scope binding to an existing campaign.
   *
   * Duplicate guard: a (scope, targetId) pair that is already active on the
   * same campaign is rejected — the admin should deactivate the existing one
   * first if they want to re-apply with different settings.
   */
  async applyScope(
    campaignId: string,
    dto: ApplyScopeDto,
    actorId: string,
  ): Promise<LeanDiscountCode> {
    const campaign = await this.discountModel.findById(campaignId);
    if (!campaign) throw new NotFoundException("Campaign not found");

    // Normalise targetId
    const targetId = dto.scope === "catalogue" ? null : (dto.targetId ?? null);

    // Guard: prevent duplicate active application for the same (scope, targetId)
    const duplicate = campaign.applications.find(
      (a) => a.active && a.scope === dto.scope && a.targetId === targetId,
    );
    if (duplicate) {
      throw new ConflictException(
        `An active application already exists for scope '${dto.scope}'` +
          (targetId ? ` / target '${targetId}'` : "") +
          `. Remove it first or deactivate it before re-applying.`,
      );
    }

    campaign.applications.push({
      _id: new Types.ObjectId(),
      scope: dto.scope,
      targetId,
      appliedBy: actorId,
      appliedAt: new Date(),
      active: true,
    } as any);

    await campaign.save();
    return campaign.toObject() as unknown as LeanDiscountCode;
  }

  /**
   * Remove (permanently delete) a single application entry.
   * Products whose price was resolved through this application will
   * automatically revert to basePrice on the next read — no product
   * documents are touched.
   */
  async removeApplication(campaignId: string, applicationId: string): Promise<void> {
    const campaign = await this.discountModel.findById(campaignId);
    if (!campaign) throw new NotFoundException("Campaign not found");

    const idx = campaign.applications.findIndex((a) => a._id.toString() === applicationId);
    if (idx === -1) throw new NotFoundException("Application not found");

    campaign.applications.splice(idx, 1);
    campaign.markModified("applications");
    await campaign.save();
  }

  /**
   * List all application entries for a campaign (active and inactive).
   */
  async listApplications(campaignId: string): Promise<LeanDiscountCode["applications"]> {
    const campaign = await this.discountModel
      .findById(campaignId)
      .select("applications")
      .lean<Pick<LeanDiscountCode, "applications">>();
    if (!campaign) throw new NotFoundException("Campaign not found");
    return campaign.applications ?? [];
  }
}
