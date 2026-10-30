import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import { TextDecoder } from 'node:util';

export function materialLimits() {
    const value = (key: string, fallback: number) => {
        if (!process.env[key]) return fallback;
        const number = Number(process.env[key]);
        if (!Number.isSafeInteger(number) || number < 1) throw new Error(`Invalid ${key}`);
        return number;
    };
    return { maxFileBytes: value('MATERIAL_MAX_FILE_BYTES', 20_000_000), limitBytes: value('MATERIAL_ACCOUNT_LIMIT_BYTES', 500_000_000) };
}
export function materialTitle(input: unknown) {
    if (typeof input !== 'string') throw new BadRequestException('A document title is required');
    const title = input.trim().replace(/\s+/g, ' ');
    if (!title || title.length > 160 || /[\x00-\x1f\x7f]/.test(title)) throw new BadRequestException('Title must contain 1–160 characters');
    return title;
}
export async function validateMaterial(file: Express.Multer.File | undefined, inputTitle?: unknown) {
    if (!file?.buffer?.length) throw new BadRequestException('Choose a nonempty PDF or UTF-8 TXT file');
    if (file.buffer.length > materialLimits().maxFileBytes) throw new PayloadTooLargeException('This file exceeds the upload limit');
    // Multer decodes multipart filenames as Latin-1 unless filename* is provided.
    const filename = file.originalname;
    if (!filename || filename.length > 255 || /[\/\\\x00-\x1f\x7f]/.test(filename)) throw new BadRequestException('Invalid filename');
    const extension = filename.toLowerCase().match(/\.(pdf|txt)$/)?.[1];
    const mediaType = extension === 'pdf' ? 'application/pdf' : extension === 'txt' ? 'text/plain' : '';
    if (!mediaType || !['', 'application/octet-stream', mediaType].includes(file.mimetype)) throw new BadRequestException('Only PDF and UTF-8 TXT files are supported');
    try {
        if (extension === 'pdf') {
            if (!/^%PDF-\d\.\d/.test(file.buffer.subarray(0, 8).toString('ascii'))) throw new Error('Not PDF');
            const pdf = await PDFDocument.load(file.buffer, { updateMetadata: false, throwOnInvalidObject: true });
            if (!pdf.getPageCount() || pdf.getPageCount() > 1000) throw new Error('Invalid page count');
        } else {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
            if (!text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error('Not text');
        }
    } catch { throw new BadRequestException('The file is not a readable, unencrypted PDF (up to 1,000 pages) or valid UTF-8 text'); }
    return { title: materialTitle(inputTitle ?? filename.replace(/\.(pdf|txt)$/i, '').slice(0, 160)), originalFilename: filename,
        mediaType, sizeBytes: file.buffer.length };
}
