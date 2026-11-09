import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import sharp from 'sharp';
export const AVATAR_MAX_BYTES = 5_000_000;
export function avatarRotation(value: unknown = 0): number {
    if (![0, 90, 180, 270, '0', '90', '180', '270'].includes(value as any)) throw new BadRequestException('Choose a rotation of 0, 90, 180 or 270 degrees.');
    return Number(value);
}
export async function prepareAvatar(file?: Express.Multer.File, rotation: unknown = 0): Promise<Buffer> {
    const angle = avatarRotation(rotation);
    if (!file?.buffer?.length) throw new BadRequestException('Choose a JPG, PNG or WebP image.');
    if (file.buffer.length > AVATAR_MAX_BYTES) throw new PayloadTooLargeException('Avatar must be 5 MB or smaller.');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) throw new BadRequestException('Choose a JPG, PNG or WebP image.');
    try {
        const image = sharp(file.buffer, { limitInputPixels: 16_000_000, failOn: 'warning' });
        const metadata = await image.metadata();
        const types = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
        if (!(metadata.format! in types) || types[metadata.format as keyof typeof types] !== file.mimetype ||
            (metadata.pages ?? 1) !== 1) throw new Error('Unsupported image');
        // Decode actual pixels, normalize orientation, strip metadata and store one
        // small static format rather than trusting the filename or MIME header.
        return await image.autoOrient().rotate(angle).resize(512, 512, { fit: 'cover' }).webp({ quality: 85 }).timeout({ seconds: 10 }).toBuffer();
    } catch { throw new BadRequestException('Image is unreadable, animated, or exceeds the 16-megapixel limit.'); }
}
