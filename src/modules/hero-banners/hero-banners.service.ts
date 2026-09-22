import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { HeroBanner, HeroBannerDocument } from "./schemas/hero-banner.schema";
import { CreateHeroBannerDto } from "./dto/create-hero-banner.dto";
import { UpdateHeroBannerDto } from "./dto/update-hero-banner.dto";

type LeanBanner = Omit<HeroBannerDocument, keyof Document> & { _id: Types.ObjectId };

@Injectable()
export class HeroBannersService {
  constructor(
    @InjectModel(HeroBanner.name)
    private readonly bannerModel: Model<HeroBannerDocument>,
  ) {}

  // ─── Public ────────────────────────────────────────────────────────────────

  /** Returns all active banners ordered by sortOrder — used by the storefront. */
  async findActive(): Promise<LeanBanner[]> {
    return this.bannerModel
      .find({ active: true })
      .sort({ sortOrder: 1 })
      .lean<LeanBanner[]>();
  }

  // ─── Admin ─────────────────────────────────────────────────────────────────

  /** Returns all banners (active + inactive) ordered by sortOrder. */
  async findAll(): Promise<LeanBanner[]> {
    return this.bannerModel.find().sort({ sortOrder: 1 }).lean<LeanBanner[]>();
  }

  async create(dto: CreateHeroBannerDto): Promise<HeroBannerDocument> {
    const count = await this.bannerModel.countDocuments();
    return this.bannerModel.create({
      headline: dto.headline,
      subline: dto.subline ?? "",
      image: dto.image ?? "",
      link: dto.link ?? "/shop",
      startsAt: dto.startsAt ?? "",
      endsAt: dto.endsAt ?? "",
      active: dto.active ?? false,
      sortOrder: dto.sortOrder ?? count, // append to end by default
    });
  }

  async update(id: string, dto: UpdateHeroBannerDto): Promise<HeroBannerDocument> {
    const banner = await this.bannerModel.findByIdAndUpdate(id, { $set: dto }, { new: true });
    if (!banner) throw new NotFoundException("Banner not found");
    return banner;
  }

  async remove(id: string): Promise<void> {
    const result = await this.bannerModel.findByIdAndDelete(id);
    if (!result) throw new NotFoundException("Banner not found");
  }

  /**
   * Accepts an ordered array of banner IDs and writes sortOrder = index
   * for each one in a single bulkWrite call.
   */
  async reorder(ids: string[]): Promise<void> {
    const ops = ids.map((id, index) => ({
      updateOne: {
        filter: { _id: new Types.ObjectId(id) },
        update: { $set: { sortOrder: index } },
      },
    }));
    await this.bannerModel.bulkWrite(ops);
  }

  // ─── Serialisation helper ──────────────────────────────────────────────────

  toResponse(banner: LeanBanner | HeroBannerDocument) {
    const b = banner as unknown as Record<string, unknown> & { _id: { toString(): string } };
    return {
      id: b._id.toString(),
      headline: b.headline,
      subline: b.subline,
      image: b.image,
      link: b.link,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      active: b.active,
      sortOrder: b.sortOrder,
    };
  }
}
