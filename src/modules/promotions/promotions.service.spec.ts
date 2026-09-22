/**
 * Unit tests for PromotionsService — application management methods.
 *
 * Tests cover:
 *  1. applyScope — creates a new application entry
 *  2. applyScope — rejects duplicate active (scope, targetId) on same campaign
 *  3. applyScope — catalogue scope stores targetId as null regardless of input
 *  4. removeApplication — deletes the entry; subsequent listApplications is empty
 *  5. removeApplication — throws NotFoundException for unknown applicationId
 *  6. listApplications — returns all entries including inactive ones
 */

import { ConflictException, NotFoundException } from "@nestjs/common";
import { getModelToken } from "@nestjs/mongoose";
import { Test, TestingModule } from "@nestjs/testing";
import { Types } from "mongoose";
import { PromotionsService } from "./promotions.service";
import { DiscountCode } from "./schemas/discount-code.schema";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeId() {
  return new Types.ObjectId();
}

/**
 * Returns a minimal mock campaign document that behaves like a Mongoose doc:
 *  - `applications` is a mutable array
 *  - `.push()` works on it
 *  - `.save()` is a jest.fn() that resolves
 *  - `.toObject()` returns a plain copy
 *  - `.markModified()` is a jest.fn()
 */
function makeCampaignDoc(
  applications: Array<{
    _id: Types.ObjectId;
    scope: "product" | "category" | "catalogue";
    targetId: string | null;
    appliedBy: string;
    appliedAt: Date;
    active: boolean;
  }> = [],
) {
  const doc: any = {
    _id: makeId(),
    code: "SUMMER30",
    type: "percent",
    value: 30,
    active: true,
    applications: [...applications],
    save: jest.fn().mockImplementation(async function () {
      return this;
    }),
    markModified: jest.fn(),
    toObject: jest.fn().mockImplementation(function () {
      return { ...this, applications: [...this.applications] };
    }),
  };
  return doc;
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("PromotionsService — application management", () => {
  let service: PromotionsService;
  let doc: ReturnType<typeof makeCampaignDoc>;

  async function bootstrap(campaignDoc: ReturnType<typeof makeCampaignDoc>) {
    doc = campaignDoc;
    const mockModel = {
      findById: jest.fn().mockResolvedValue(campaignDoc),
      exists: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PromotionsService,
        { provide: getModelToken(DiscountCode.name), useValue: mockModel },
      ],
    }).compile();

    service = module.get(PromotionsService);
  }

  // ── 1. applyScope creates an application entry ───────────────────────────

  it("applyScope adds a new application entry to the campaign", async () => {
    await bootstrap(makeCampaignDoc());

    await service.applyScope(doc._id.toString(), { scope: "category", targetId: "televisions" }, "admin1");

    expect(doc.applications).toHaveLength(1);
    expect(doc.applications[0].scope).toBe("category");
    expect(doc.applications[0].targetId).toBe("televisions");
    expect(doc.applications[0].appliedBy).toBe("admin1");
    expect(doc.applications[0].active).toBe(true);
    expect(doc.save).toHaveBeenCalledTimes(1);
  });

  // ── 2. applyScope rejects duplicate active (scope, targetId) ────────────

  it("applyScope throws ConflictException for a duplicate active application", async () => {
    const existingApp = {
      _id: makeId(),
      scope: "category" as const,
      targetId: "televisions",
      appliedBy: "admin1",
      appliedAt: new Date(),
      active: true,
    };
    await bootstrap(makeCampaignDoc([existingApp]));

    await expect(
      service.applyScope(
        doc._id.toString(),
        { scope: "category", targetId: "televisions" },
        "admin2",
      ),
    ).rejects.toThrow(ConflictException);

    // Should not have called save.
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("allows a new application after the old one is deactivated (active: false)", async () => {
    const existingApp = {
      _id: makeId(),
      scope: "category" as const,
      targetId: "televisions",
      appliedBy: "admin1",
      appliedAt: new Date(),
      active: false, // deactivated — not a duplicate
    };
    await bootstrap(makeCampaignDoc([existingApp]));

    await service.applyScope(
      doc._id.toString(),
      { scope: "category", targetId: "televisions" },
      "admin2",
    );

    expect(doc.applications).toHaveLength(2);
    expect(doc.applications[1].active).toBe(true);
  });

  // ── 3. catalogue scope stores targetId as null ───────────────────────────

  it("applyScope stores targetId as null for catalogue scope", async () => {
    await bootstrap(makeCampaignDoc());

    await service.applyScope(
      doc._id.toString(),
      { scope: "catalogue", targetId: "ignored-value" }, // should be discarded
      "admin1",
    );

    expect(doc.applications[0].targetId).toBeNull();
    expect(doc.applications[0].scope).toBe("catalogue");
  });

  // ── 4. removeApplication deletes the entry ───────────────────────────────

  it("removeApplication removes the specified application entry", async () => {
    const appId = makeId();
    const app = {
      _id: appId,
      scope: "catalogue" as const,
      targetId: null,
      appliedBy: "admin1",
      appliedAt: new Date(),
      active: true,
    };
    const campaignDoc = makeCampaignDoc([app]);
    await bootstrap(campaignDoc);

    await service.removeApplication(campaignDoc._id.toString(), appId.toString());

    expect(doc.applications).toHaveLength(0);
    expect(doc.markModified).toHaveBeenCalledWith("applications");
    expect(doc.save).toHaveBeenCalledTimes(1);
  });

  // ── 5. removeApplication throws for unknown applicationId ────────────────

  it("removeApplication throws NotFoundException for an unknown applicationId", async () => {
    await bootstrap(makeCampaignDoc());

    await expect(
      service.removeApplication(doc._id.toString(), makeId().toString()),
    ).rejects.toThrow(NotFoundException);
  });

  // ── 6. listApplications returns all entries (active and inactive) ─────────

  it("listApplications returns all entries including inactive ones", async () => {
    const apps = [
      { _id: makeId(), scope: "product" as const, targetId: "prod1", appliedBy: "a", appliedAt: new Date(), active: true },
      { _id: makeId(), scope: "category" as const, targetId: "televisions", appliedBy: "a", appliedAt: new Date(), active: false },
    ];

    // listApplications uses a separate .select().lean() query — set up a dedicated mock.
    const selectMock = jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({ applications: apps }),
    });
    const mockModel = {
      findById: jest.fn().mockReturnValue({ select: selectMock }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PromotionsService,
        { provide: getModelToken(DiscountCode.name), useValue: mockModel },
      ],
    }).compile();
    service = module.get(PromotionsService);

    const result = await service.listApplications(makeId().toString());

    expect(result).toHaveLength(2);
    expect(result[0].active).toBe(true);
    expect(result[1].active).toBe(false);
  });
});
