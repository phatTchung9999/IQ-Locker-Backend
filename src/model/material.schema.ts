import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';
import type { HydratedDocument } from 'mongoose';
export type MaterialDocument = HydratedDocument<Material>;
@Schema({ timestamps: true })
export class Material {
    @Prop({ type: MongooseSchema.Types.ObjectId, required: true, immutable: true }) owner: Types.ObjectId;
    @Prop({ type: MongooseSchema.Types.ObjectId, required: true, immutable: true }) course: Types.ObjectId;
    @Prop({ type: MongooseSchema.Types.ObjectId, default: null, immutable: true }) folder: Types.ObjectId | null;
    @Prop({ required: true, maxlength: 160 }) title: string;
    @Prop({ required: true, maxlength: 255, immutable: true }) originalFilename: string;
    @Prop({ required: true, enum: ['application/pdf', 'text/plain'], immutable: true }) mediaType: string;
    @Prop({ required: true, min: 1, immutable: true }) sizeBytes: number;
    @Prop({ required: true, immutable: true }) storageKey: string;
    @Prop({ enum: ['', 'syllabus', 'lecture', 'quiz', 'exam', 'other'], default: '', immutable: true }) materialType: string;
    @Prop({ default: 1, immutable: true }) version: number;
    @Prop({ default: 'not_started', enum: ['not_started'] }) processingStatus: string;
    @Prop({ required: true, enum: ['uploading', 'ready', 'deleting', 'cleanup_pending'] }) state: string;
    @Prop({ type: Date, default: null }) retryAt: Date | null;
    @Prop({ type: Date, default: null }) cleanupLeaseUntil: Date | null;
    @Prop({ type: String, default: null }) cleanupToken: string | null;
    createdAt: Date;
    updatedAt: Date;
}
export const MaterialSchema = SchemaFactory.createForClass(Material);
MaterialSchema.index({ owner: 1, course: 1, folder: 1, createdAt: -1 });
MaterialSchema.index({ state: 1, retryAt: 1 });
MaterialSchema.index({ storageKey: 1 }, { unique: true });

@Schema()
export class StorageUsage {
    @Prop({ type: MongooseSchema.Types.ObjectId }) _id: Types.ObjectId;
    @Prop({ default: 0, min: 0 }) bytes: number;
    @Prop({ default: 0 }) revision: number;
}
export const StorageUsageSchema = SchemaFactory.createForClass(StorageUsage);
