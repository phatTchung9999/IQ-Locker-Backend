import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';
import type { HydratedDocument } from 'mongoose';
export type FolderDocument = HydratedDocument<Folder>;
@Schema({ timestamps: true })
export class Folder {
    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, immutable: true }) owner: Types.ObjectId;
    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Course', required: true, immutable: true }) course: Types.ObjectId;
    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Folder', default: null, immutable: true }) parent: Types.ObjectId | null;
    @Prop({ required: true, maxlength: 120 }) name: string;
    @Prop({ required: true }) nameKey: string;
    @Prop({ enum: ['', 'syllabus', 'lecture', 'quiz', 'exam', 'other'], default: '' }) materialType: string;
    @Prop({ enum: ['syllabus', 'lecture', 'quiz', 'exam'], default: undefined, immutable: true }) starterKey?: string;
    createdAt: Date;
    updatedAt: Date;
}
export const FolderSchema = SchemaFactory.createForClass(Folder);
FolderSchema.index({ owner: 1, course: 1, parent: 1, nameKey: 1 }, { unique: true });
FolderSchema.index({ owner: 1, course: 1, starterKey: 1 }, { unique: true, partialFilterExpression: { starterKey: { $type: 'string' } } });
