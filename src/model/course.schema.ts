import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';
import type { HydratedDocument } from 'mongoose';

export type CourseDocument = HydratedDocument<Course>;

@Schema({ timestamps: true })
export class Course {
    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, immutable: true })
    owner: Types.ObjectId;
    @Prop({ required: true, trim: true, maxlength: 120 })
    name: string;
    @Prop({ trim: true, maxlength: 40, default: '' })
    code: string;
    @Prop({ trim: true, maxlength: 80, default: '' })
    semester: string;
    @Prop({ default: 0 })
    treeRevision: number;
    createdAt: Date;
    updatedAt: Date;
}

export const CourseSchema = SchemaFactory.createForClass(Course);
CourseSchema.index({ owner: 1, createdAt: -1, _id: -1 });
