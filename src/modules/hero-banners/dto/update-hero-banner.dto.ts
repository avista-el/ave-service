import { PartialType } from "@nestjs/swagger";
import { CreateHeroBannerDto } from "./create-hero-banner.dto";

export class UpdateHeroBannerDto extends PartialType(CreateHeroBannerDto) {}
