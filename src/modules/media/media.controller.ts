import {
  Controller,
  Get,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiForbiddenResponse,
} from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { MediaService } from "./media.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { ApiEnvelopeOk, ApiErrorResponse } from "../../common/swagger/api-response.decorator";
import {
  SignedUploadParamsDto,
  UploadResponseDto,
} from "../../common/swagger/swagger-response.dto";

class SignedUploadQueryDto {
  @ApiPropertyOptional({ example: "alphavista/products" })
  @IsOptional()
  @IsString()
  folder?: string;
}

@ApiTags("Admin — Media")
@ApiBearerAuth()
@Controller({ path: "admin/media", version: "1" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("super_admin", "merchandiser")
@ApiForbiddenResponse({ description: "Insufficient role", type: ApiErrorResponse })
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Get("sign")
  @ApiOperation({
    summary: "Get signed upload parameters for direct browser → Cloudinary upload",
    description: `Returns a pre-signed credential set. Use the \`signature\`, \`timestamp\`, \`apiKey\`, and \`cloudName\` with the Cloudinary Upload Widget or SDK to upload files directly from the browser without routing large files through this API. Signature expires in ~1 minute.`,
  })
  @ApiEnvelopeOk(SignedUploadParamsDto)
  getSignedParams(@Query() query: SignedUploadQueryDto) {
    return this.mediaService.generateSignedUploadParams(query.folder ?? "alphavista/products");
  }

  @Post("upload")
  @ApiOperation({
    summary: "Server-side image upload to Cloudinary",
    description:
      "Accepts multipart/form-data with a single `file` field. Max 10 MB. Cloudinary handles format conversion (WebP/AVIF) and resizing. Prefer the signed upload approach for the admin UI — use this endpoint for programmatic or seed-script uploads.",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["file"],
      properties: {
        file: { type: "string", format: "binary", description: "Image file (max 10 MB)" },
      },
    },
  })
  @ApiEnvelopeOk(UploadResponseDto)
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 10 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!file.mimetype.startsWith("image/")) {
          return cb(new Error("Only image files allowed"), false);
        }
        cb(null, true);
      },
    }),
  )
  uploadFile(@UploadedFile() file: Express.Multer.File) {
    return this.mediaService.uploadBuffer(file.buffer, "alphavista/products");
  }
}
