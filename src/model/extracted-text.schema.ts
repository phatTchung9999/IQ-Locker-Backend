import type { PdfTextSpan } from '../extraction/extraction.types.js';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

@Schema({ timestamps: true })
export class ExtractedText {
    @Prop({ type: MongooseSchema.Types.ObjectId, required: true, immutable: true }) owner: Types.ObjectId;
    @Prop({ type: MongooseSchema.Types.ObjectId, required: true, immutable: true }) course: Types.ObjectId;
    @Prop({ type: MongooseSchema.Types.ObjectId, required: true, immutable: true }) material: Types.ObjectId;
    @Prop({ required: true, min: 1, immutable: true }) materialVersion: number;
    @Prop({ required: true, min: 1, immutable: true }) extractorVersion: number;
    @Prop({ required: true, min: 1, max: 2000 }) chunkCount: number;
    @Prop({ required: true, min: 1, max: 2_000_000 }) textChars: number;
    @Prop({ required: true, min: 1, max: 1000 }) pageCount: number;
    @Prop({ required: true, enum: ['application/pdf', 'text/plain'] }) mediaType: string;
    createdAt: Date;
    updatedAt: Date;
}
export const ExtractedTextSchema = SchemaFactory.createForClass(ExtractedText);
ExtractedTextSchema.index({ material: 1, materialVersion: 1 }, { unique: true });
ExtractedTextSchema.index({ owner: 1, course: 1, material: 1 });

@Schema({ timestamps: true })
export class ExtractedTextChunk {
    @Prop({ type: MongooseSchema.Types.ObjectId, required: true, immutable: true }) extraction: Types.ObjectId;
    @Prop({ type: MongooseSchema.Types.ObjectId, required: true, immutable: true }) owner: Types.ObjectId;
    @Prop({ type: MongooseSchema.Types.ObjectId, required: true, immutable: true }) course: Types.ObjectId;
    @Prop({ type: MongooseSchema.Types.ObjectId, required: true, immutable: true }) material: Types.ObjectId;
    @Prop({ required: true, min: 1, immutable: true }) materialVersion: number;
    @Prop({ required: true, min: 1, immutable: true }) extractorVersion: number;
    @Prop({ required: true, min: 0, max: 1999 }) index: number;
    @Prop({ required: true, maxlength: 4000 }) text: string;
    @Prop({ type: [new MongooseSchema({
        start: Number, end: Number, transform: [Number], width: Number, height: Number,
    }, { _id: false })], default: undefined })
    spans?: PdfTextSpan[];
    @Prop({ type: Number, default: null, min: 1 }) page: number | null;
    @Prop({ required: true, min: 0 }) charStart: number;
    @Prop({ required: true, min: 1 }) charEnd: number;
    @Prop({ type: Number, default: null, min: 1 }) lineStart: number | null;
    @Prop({ type: Number, default: null, min: 1 }) lineEnd: number | null;
}
export const ExtractedTextChunkSchema = SchemaFactory.createForClass(ExtractedTextChunk);
ExtractedTextChunkSchema.index({ extraction: 1, index: 1 }, { unique: true });
ExtractedTextChunkSchema.index({ owner: 1, course: 1, material: 1, materialVersion: 1 });
