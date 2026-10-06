import {
  BadRequestException,
  Controller,
  PayloadTooLargeException,
  Post,
  ServiceUnavailableException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { AwsClient } from 'aws4fetch';
import { randomUUID } from 'node:crypto';
import { Auth } from '../common/auth';
import { env } from '../config';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Detects the image type from its first bytes; the client's Content-Type is not trusted. SVG is never accepted (it can carry script). */
export function sniffImage(b: Buffer) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return { type: 'image/jpeg', ext: 'jpg' };
  if (b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    return { type: 'image/png', ext: 'png' };
  if (
    b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WEBP'
  )
    return { type: 'image/webp', ext: 'webp' };
  if (
    b.toString('ascii', 4, 8) === 'ftyp' &&
    ['avif', 'avis'].includes(b.toString('ascii', 8, 12))
  )
    return { type: 'image/avif', ext: 'avif' };
  return null;
}

type UploadedImage = { buffer: Buffer; size: number };

/** Product photos go to the Cloudflare R2 bucket; the returned URL is what POST /admin/products and PUT /admin/colors/:id/images take. */
@ApiTags('admin: catalog')
@ApiBearerAuth()
@Auth('merchandiser')
@Controller('admin/uploads')
export class AdminUploadsController {
  // ponytail: proxied through the API (5 MB cap); switch to presigned PUTs if uploads get large or frequent.
  // Replaced/removed images stay in the bucket; add a sweep if storage cost matters.
  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
    }),
  )
  async upload(@UploadedFile() file?: UploadedImage) {
    if (!file) throw new BadRequestException('Attach an image as "file".');
    if (file.size > MAX_IMAGE_BYTES)
      throw new PayloadTooLargeException('Images must be 5 MB or smaller.');
    const kind = sniffImage(file.buffer);
    if (!kind)
      throw new BadRequestException('Use a JPEG, PNG, WebP or AVIF image.');

    const r2 = env.r2;
    if (!r2)
      throw new ServiceUnavailableException(
        'Image uploads are not configured. Set the R2_* variables on the API.',
      );

    const key = `products/${randomUUID()}.${kind.ext}`;
    const client = new AwsClient({
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
      service: 's3',
      region: 'auto',
    });
    const res = await client.fetch(
      `https://${r2.accountId}.r2.cloudflarestorage.com/${r2.bucket}/${key}`,
      {
        method: 'PUT',
        body: new Uint8Array(file.buffer),
        headers: {
          'Content-Type': kind.type,
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      },
    );
    if (!res.ok) {
      console.error(`R2 upload failed: ${res.status} ${await res.text()}`);
      throw new ServiceUnavailableException(
        "We couldn't store that image. Try again.",
      );
    }
    return { url: `${r2.publicUrl}/${key}`, key };
  }
}
