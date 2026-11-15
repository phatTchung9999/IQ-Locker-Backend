import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, Types } from 'mongoose';

const id = { type: MongoSchema.Types.ObjectId, required: true, immutable: true };
const day = { type: String, match: /^\d{4}-\d{2}-\d{2}$/ };
const version = { type: Number, min: 1, validate: Number.isSafeInteger, required: true, immutable: true };

@Schema({ _id: false })
class Evidence {
    @Prop(id) chunk: Types.ObjectId;
    @Prop({ required: true, min: 0, max: 3999, validate: Number.isSafeInteger }) start: number;
    @Prop({ required: true, min: 1, max: 4000, validate: Number.isSafeInteger }) end: number;
    @Prop({ required: true, maxlength: 4000 }) quote: string;
}
const EvidenceSchema = SchemaFactory.createForClass(Evidence);

@Schema({ _id: false })
class Suggestion {
    @Prop({ required: true, enum: ['exam', 'assignment'] }) kind: string;
    @Prop({ required: true, maxlength: 200 }) title: string;
    @Prop({ type: [String], required: true }) originalDateText: string[];
    @Prop({ ...day, default: null }) date: string | null;
    @Prop({ type: String, match: /^(?:[01]\d|2[0-3]):[0-5]\d$/, default: null }) time: string | null;
    @Prop({ type: String, maxlength: 100, default: null }) timezone: string | null;
    @Prop({ type: new MongoSchema({ start: { ...day, required: true }, end: { ...day, required: true } }, { _id: false }), default: null }) dateRange: { start: string; end: string } | null;
    @Prop({ type: String, enum: ['explicit', 'course_term', 'current_year', 'course_week', null], default: null }) dateBasis: string | null;
    @Prop({ type: [String], default: [] }) flags: string[];
    @Prop({ type: [EvidenceSchema], required: true, validate: (items: Evidence[]) => items.length > 0 && items.length <= 10 }) sources: Evidence[];
    @Prop({ type: [EvidenceSchema], default: [] }) contextSources: Evidence[];
}
const SuggestionSchema = SchemaFactory.createForClass(Suggestion);

// Analysis output is always pending. Student decisions will live separately.
@Schema({ timestamps: true })
export class SyllabusAnalysis {
    @Prop(id) owner: Types.ObjectId;
    @Prop(id) course: Types.ObjectId;
    @Prop(id) material: Types.ObjectId;
    @Prop(id) extraction: Types.ObjectId;
    @Prop(version) materialVersion: number;
    @Prop(version) analyzerVersion: number;
    @Prop({ ...day, required: true, immutable: true }) referenceDate: string;
    @Prop({ type: Number, min: 1, max: 9999, validate: (value: number | null) => value === null || Number.isSafeInteger(value), default: null, immutable: true }) termYear: number | null;
    @Prop({ ...day, default: null, immutable: true }) weekOneStart: string | null;
    @Prop({ type: String, enum: ['consecutive_seven_day_weeks', null], default: null, immutable: true }) weekCounting: string | null;
    @Prop({ type: String, enum: ['queued', 'processing', 'ready', 'failed'], default: 'queued', required: true }) state: string;
    @Prop({ type: Number, min: 0, max: 3, validate: Number.isSafeInteger, default: 0 }) attempts: number;
    @Prop({ type: Date, default: Date.now }) runAfter: Date;
    @Prop({ type: Date, default: null }) leaseUntil: Date | null;
    @Prop({ type: String, default: null, select: false }) leaseToken: string | null;
    @Prop({ type: String, enum: ['stale_extraction', 'analysis_failed', 'invalid_output', 'attempts_exhausted', null], default: null }) errorCode: string | null;
    @Prop({ type: [new MongoSchema({
        index: { type: Number, required: true },
        status: { type: String, enum: ['confirmed', 'dismissed'], required: true },
        dateRange: { type: new MongoSchema({ start: day, end: day }, { _id: false }), default: null },
        date: { ...day, default: null },
    }, { _id: false })], default: [] })
    decisions: { index: number; status: 'confirmed' | 'dismissed'; date: string | null; dateRange?: { start: string; end: string } | null }[];
    @Prop({ type: [SuggestionSchema], default: undefined, validate: (items: Suggestion[]) => items.length <= 100 }) suggestions?: Suggestion[];
}
export const SyllabusAnalysisSchema = SchemaFactory.createForClass(SyllabusAnalysis);
SyllabusAnalysisSchema.index({ owner: 1, course: 1, material: 1, materialVersion: 1, extraction: 1, analyzerVersion: 1 }, { unique: true });
SyllabusAnalysisSchema.index({ state: 1, runAfter: 1 });
SyllabusAnalysisSchema.index({ state: 1, leaseUntil: 1 });
