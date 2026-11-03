import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, Types } from 'mongoose';

@Schema({ timestamps: true })
export class Notification {
    @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true }) owner: Types.ObjectId;
    @Prop({ required: true, immutable: true }) key: string;
    @Prop({ required: true, enum: ['profile', 'storage', 'extraction'] }) kind: string;
    @Prop({ required: true, maxlength: 240 }) message: string;
    @Prop({ required: true }) path: string;
    @Prop({ default: true }) active: boolean;
    @Prop({ type: Date, default: null }) readAt: Date | null;
    createdAt: Date;
}
export const NotificationSchema = SchemaFactory.createForClass(Notification);
NotificationSchema.index({ owner: 1, key: 1 }, { unique: true });
NotificationSchema.index({ owner: 1, active: 1, _id: -1 });
