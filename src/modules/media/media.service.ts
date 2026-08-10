import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(private readonly config: ConfigService) {
    cloudinary.config({
      cloud_name: this.config.get<string>('cloudinary.cloudName'),
      api_key: this.config.get<string>('cloudinary.apiKey'),
      api_secret: this.config.get<string>('cloudinary.apiSecret'),
    });
  }

  // ─── Upload a file buffer directly to Cloudinary ─────────────────────────

  async uploadBuffer(
    buffer: Buffer,
    folder: string = 'alphavista/products',
    publicId?: string,
  ): Promise<{ publicId: string; url: string; secureUrl: string }> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder,
          public_id: publicId,
          // Let Cloudinary handle format negotiation (WebP/AVIF)
          format: 'auto',
          quality: 'auto',
          transformation: [{ width: 1200, crop: 'limit' }],
        },
        (error, result) => {
          if (error || !result) return reject(error ?? new Error('Upload failed'));
          resolve({
            publicId: result.public_id,
            url: result.url,
            secureUrl: result.secure_url,
          });
        },
      );
      stream.end(buffer);
    });
  }

  // ─── Download an external URL and re-upload to Cloudinary ────────────────
  // Used by SyncModule when sheet contains third-party image URLs.

  async uploadFromUrl(
    url: string,
    folder: string = 'alphavista/products',
  ): Promise<{ publicId: string; secureUrl: string }> {
    try {
      const result: UploadApiResponse = await cloudinary.uploader.upload(url, {
        folder,
        format: 'auto',
        quality: 'auto',
        transformation: [{ width: 1200, crop: 'limit' }],
      });
      return { publicId: result.public_id, secureUrl: result.secure_url };
    } catch (err) {
      this.logger.error(`Failed to upload from URL ${url}`, err);
      throw new BadRequestException(`Could not upload image from: ${url}`);
    }
  }

  // ─── Generate a signed upload URL for direct browser-to-Cloudinary upload ─

  generateSignedUploadParams(folder = 'alphavista/products'): {
    apiKey: string;
    cloudName: string;
    timestamp: number;
    signature: string;
    folder: string;
  } {
    const timestamp = Math.round(Date.now() / 1000);
    const signature = cloudinary.utils.api_sign_request(
      { timestamp, folder },
      this.config.get<string>('cloudinary.apiSecret')!,
    );

    return {
      apiKey: this.config.get<string>('cloudinary.apiKey')!,
      cloudName: this.config.get<string>('cloudinary.cloudName')!,
      timestamp,
      signature,
      folder,
    };
  }

  // ─── Delete an image ──────────────────────────────────────────────────────

  async deleteImage(publicId: string): Promise<void> {
    await cloudinary.uploader.destroy(publicId);
  }

  // ─── URL transformer helper (mirrors frontend getCloudinaryUrl) ───────────

  static getUrl(
    publicIdOrUrl: string,
    opts: { width?: number; quality?: string; format?: string } = {},
  ): string {
    const { width = 800, quality = 'auto', format = 'auto' } = opts;
    // If already a full URL with transformations, return as-is
    if (publicIdOrUrl.startsWith('http') && publicIdOrUrl.includes('/upload/')) {
      return publicIdOrUrl;
    }
    // Build transformation URL from public ID
    const transformations = `f_${format},q_${quality},w_${width}`;
    return cloudinary.url(publicIdOrUrl, {
      transformation: transformations,
      secure: true,
    });
  }
}
