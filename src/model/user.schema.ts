import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument } from 'mongoose';
export type UserDocument = HydratedDocument<User>;

@Schema()
export class User {
    @Prop({required:true})
    fullname: string;
    @Prop({required:true, unique:true, lowercase:true, trim:true})
    email: string;
    @Prop({required:true})
    password: string
    @Prop({ trim: true, maxlength: 40 })
    phone?: string;
    @Prop({ trim: true, maxlength: 150 })
    school?: string;
    @Prop({ trim: true, maxlength: 150 })
    major?: string;
    // Reserved for the future avatar upload/storage workflow, not client-editable.
    @Prop({ trim: true, maxlength: 1024 })
    avatarKey?: string;
    @Prop({default: Date.now })
    createdDate: Date
}
export const UserSchema = SchemaFactory.createForClass(User)
