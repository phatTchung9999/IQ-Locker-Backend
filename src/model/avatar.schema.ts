import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, Types } from 'mongoose';

// Durable blob lifecycle journal. User.avatarKey is the current-avatar reference.
@Schema({ timestamps: true })
export class Avatar {
    @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true }) owner: Types.ObjectId;
    @Prop({ required: true, immutable: true }) key: string;
    @Prop({ required: true, min: 1, immutable: true }) sizeBytes: number;
    @Prop({ required: true, enum: ['uploading', 'active', 'cleanup_pending'] }) state: string;
    @Prop({ type: Date, required: true }) retryAt: Date;
    @Prop({ type: Date, default: null }) cleanupLeaseUntil: Date | null;
    @Prop({ type: String, default: null, select: false }) cleanupToken: string | null;
}
export const AvatarSchema = SchemaFactory.createForClass(Avatar);
AvatarSchema.index({ key: 1 }, { unique: true });
AvatarSchema.index({ owner: 1, state: 1 });
AvatarSchema.index({ state: 1, retryAt: 1 });
