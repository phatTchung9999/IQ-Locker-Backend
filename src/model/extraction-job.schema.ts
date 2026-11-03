import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';
import type { HydratedDocument } from 'mongoose';

export const EXTRACTION_JOB_STATES = ['queued', 'processing', 'ready', 'failed'] as const;
export const EXTRACTION_ERROR_CODES = ['no_readable_text', 'parser_failed', 'timeout', 'storage_unavailable', 'output_limit', 'attempts_exhausted'] as const;
export type ExtractionJobDocument = HydratedDocument<ExtractionJob>;

// Internal durable task. Ownership must come from the verified material when
// jobs are created; schema validation alone does not authorize a student.
@Schema({ timestamps: true })
export class ExtractionJob {
    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, immutable: true }) owner: Types.ObjectId;
    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Course', required: true, immutable: true }) course: Types.ObjectId;
    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Material', required: true, immutable: true }) material: Types.ObjectId;
    @Prop({ type: Number, required: true, min: 1, validate: Number.isSafeInteger, immutable: true }) materialVersion: number;
    @Prop({ type: Number, default: 1, min: 1, validate: Number.isSafeInteger }) extractorVersion: number;
    @Prop({ type: String, enum: EXTRACTION_JOB_STATES, default: 'queued', required: true }) state: string;
    @Prop({ type: Number, default: 0, min: 0, validate: Number.isSafeInteger }) attempts: number;
    @Prop({ type: Number, default: 3, min: 1, max: 10, validate: Number.isSafeInteger }) maxAttempts: number;
    @Prop({ type: Date, default: Date.now }) runAfter: Date;
    @Prop({ type: Date, default: null }) leaseUntil: Date | null;
    @Prop({ type: String, default: null, select: false }) leaseToken: string | null;
    @Prop({ type: Date, default: null }) startedAt: Date | null;
    @Prop({ type: Date, default: null }) completedAt: Date | null;
    // Store safe categories, never raw parser exceptions or private blob keys.
    @Prop({ type: String, enum: EXTRACTION_ERROR_CODES, default: null }) errorCode: string | null;
    createdAt: Date;
    updatedAt: Date;
}
export const ExtractionJobSchema = SchemaFactory.createForClass(ExtractionJob);
// Retrying reuses the same job; one task per original material version.
ExtractionJobSchema.index({ material: 1, materialVersion: 1 }, { unique: true });
ExtractionJobSchema.index({ state: 1, runAfter: 1 });
ExtractionJobSchema.index({ state: 1, leaseUntil: 1 });
ExtractionJobSchema.index({ owner: 1, course: 1, material: 1 });
// No TTL: expiring a lease must not silently remove a recoverable task.
