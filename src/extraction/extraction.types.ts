import type { ClientSession } from 'mongoose';
import type { MaterialDocument } from '../model/material.schema.js';
import type { ExtractionJobDocument } from '../model/extraction-job.schema.js';
export type ExtractionCode = 'no_readable_text' | 'parser_failed' | 'timeout' | 'storage_unavailable' | 'output_limit' | 'attempts_exhausted';
export class ExtractionFailure extends Error {
    constructor(public readonly code: ExtractionCode) { super(code); }
}
export interface ExtractionResult {
    extractorVersion: number;
    pages: { page: number | null; text: string }[];
    textChars: number;
}
export const EXTRACTION_RESULT_WRITER = Symbol('EXTRACTION_RESULT_WRITER');
export interface ExtractionResultWriter {
    // Persist source-linked text inside the worker publication transaction.
    save(result: ExtractionResult, material: MaterialDocument, job: ExtractionJobDocument, session: ClientSession): Promise<void>;
}
export function extractionLimits() {
    const integer = (key: string, fallback: number, min: number, max: number) => {
        const raw = process.env[key];
        if (raw === undefined) return fallback;
        const value = Number(raw);
        if (!raw.trim() || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
        return value;
    };
    const enabled = process.env.EXTRACTION_PROCESSING_ENABLED ?? 'false';
    if (!['true', 'false'].includes(enabled)) throw new Error('Invalid EXTRACTION_PROCESSING_ENABLED');
    return {
        enabled: enabled === 'true',
        maxInputBytes: integer('EXTRACTION_MAX_INPUT_BYTES', 20_000_000, 1, 20_000_000),
        maxTextChars: integer('EXTRACTION_MAX_TEXT_CHARS', 2_000_000, 1, 2_000_000),
        timeoutMs: integer('EXTRACTION_TIMEOUT_MS', 60_000, 100, 120_000),
        maxPages: 1000,
        leaseMs: 180_000,
    };
}
