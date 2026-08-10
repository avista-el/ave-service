import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";
import { UserRole } from "../../../common/decorators/roles.decorator";

export type UserDocument = User & Document;

@Schema({ timestamps: true, collection: "users" })
export class User {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ required: true, select: false })
  passwordHash: string;

  @Prop({
    type: String,
    enum: ["super_admin", "merchandiser", "support_agent", "customer"],
    default: "customer",
  })
  role: UserRole;

  @Prop({ default: true })
  active: boolean;

  @Prop({ type: String, select: false, default: null })
  refreshTokenHash: string | null;

  @Prop({ default: false })
  twoFactorEnabled: boolean;

  @Prop({ type: String, select: false, default: null })
  twoFactorSecret: string | null;
}

export const UserSchema = SchemaFactory.createForClass(User);
