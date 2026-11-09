import sharp from 'sharp';
import { prepareAvatar, AVATAR_MAX_BYTES } from './avatar.dto.js';
const file = (buffer: Buffer, mimetype = 'image/png') => ({ buffer, mimetype, originalname: 'avatar.png' } as Express.Multer.File);
it.each(['png', 'jpeg', 'webp'] as const)('decodes and normalizes actual %s pixels into a metadata-free static WebP', async format => {
    const buffer = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#334455' } }).toFormat(format).withMetadata().toBuffer();
    const output = await prepareAvatar(file(buffer, `image/${format}`));
    const info = await sharp(output).metadata();
    expect(info).toMatchObject({ format: 'webp', width: 512, height: 512 });
    expect(info.exif).toBeUndefined(); expect(info.icc).toBeUndefined();
});
it('rejects empty, oversized, corrupt and mislabeled images', async () => {
    await expect(prepareAvatar()).rejects.toMatchObject({ status: 400 });
    await expect(prepareAvatar(file(Buffer.alloc(AVATAR_MAX_BYTES + 1)))).rejects.toMatchObject({ status: 413 });
    await expect(prepareAvatar(file(Buffer.from('not an image')))).rejects.toMatchObject({ status: 400 });
    const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#123456' } }).jpeg().toBuffer();
    await expect(prepareAvatar(file(jpeg))).rejects.toMatchObject({ status: 400 });
    await expect(prepareAvatar(file(jpeg, 'image/svg+xml'))).rejects.toMatchObject({ status: 400 });
});
it('rejects SVG and oversized decoded dimensions', async () => {
    await expect(prepareAvatar(file(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')))).rejects.toMatchObject({ status: 400 });
    const buffer = await sharp({ create: { width: 4100, height: 4000, channels: 3, background: '#123456' } }).png().toBuffer();
    await expect(prepareAvatar(file(buffer))).rejects.toMatchObject({ status: 400 });
});

it.each([90, 180, 270])('persists %s-degree clockwise rotation after normalizing the image', async angle => {
    const svg = Buffer.from('<svg width="512" height="512"><path fill="red" d="M0 0h256v256H0z"/><path fill="#00ff00" d="M256 0h256v256H256z"/><path fill="blue" d="M0 256h256v256H0z"/><path fill="yellow" d="M256 256h256v256H256z"/></svg>');
    const input = await sharp(svg).png().toBuffer();
    const output = await prepareAvatar(file(input), String(angle));
    const pixel = await sharp(output).removeAlpha().extract({ left: 128, top: 128, width: 1, height: 1 }).raw().toBuffer();
    const expected = angle === 90 ? [0, 0, 255] : angle === 180 ? [255, 255, 0] : [0, 255, 0];
    expected.forEach((value, index) => expect(Math.abs(pixel[index]! - value)).toBeLessThan(15));
});
it.each(['45', 360, -90, null, {}, ['90']])('rejects unsupported rotation input %j', async angle => {
    const input = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer();
    await expect(prepareAvatar(file(input), angle)).rejects.toMatchObject({ status: 400 });
});
