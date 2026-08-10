import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { JwtService } from "@nestjs/jwt";
import { Model, Types } from "mongoose";
import * as bcrypt from "bcrypt";
import { User, UserDocument } from "./schemas/user.schema";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { UserRole } from "../../common/decorators/roles.decorator";

const SALT_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  // ─── Registration ────────────────────────────────────────────────────────────

  async register(dto: RegisterDto) {
    const exists = await this.userModel.exists({ email: dto.email });
    if (exists) throw new ConflictException("Email already registered");

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    const user = await this.userModel.create({
      name: dto.name,
      email: dto.email,
      passwordHash,
      role: "customer",
    });

    return this.issueTokenPair(user);
  }

  // ─── Login ───────────────────────────────────────────────────────────────────

  async login(dto: LoginDto) {
    const user = await this.userModel
      .findOne({ email: dto.email, active: true })
      .select("+passwordHash")
      .lean();

    if (!user) throw new UnauthorizedException("Invalid credentials");

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) throw new UnauthorizedException("Invalid credentials");

    // Cast to get the _id
    const userDoc = await this.userModel.findById(user._id);
    if (!userDoc) throw new UnauthorizedException("Invalid credentials");
    return this.issueTokenPair(userDoc);
  }

  // ─── Refresh ─────────────────────────────────────────────────────────────────

  async refreshTokens(userId: string, refreshToken: string) {
    const user = await this.userModel.findById(userId).select("+refreshTokenHash");

    if (!user?.refreshTokenHash) throw new UnauthorizedException("No active session");

    const matches = await bcrypt.compare(refreshToken, user.refreshTokenHash);
    if (!matches) throw new UnauthorizedException("Invalid refresh token");

    return this.issueTokenPair(user);
  }

  // ─── Logout ──────────────────────────────────────────────────────────────────

  async logout(userId: string) {
    await this.userModel.findByIdAndUpdate(userId, {
      refreshTokenHash: null,
    });
  }

  // ─── Admin: create user ───────────────────────────────────────────────────────

  async createAdminUser(dto: RegisterDto & { role: UserRole }): Promise<UserDocument> {
    const exists = await this.userModel.exists({ email: dto.email });
    if (exists) throw new ConflictException("Email already registered");

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    return this.userModel.create({
      name: dto.name,
      email: dto.email,
      passwordHash,
      role: dto.role,
    });
  }

  // ─── Profile ─────────────────────────────────────────────────────────────────

  async profile(userId: string) {
    const user = await this.userModel.findById(userId).lean();
    if (!user) throw new BadRequestException("User not found");
    return user;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private async issueTokenPair(user: UserDocument) {
    const payload = {
      sub: (user._id as unknown as Types.ObjectId).toString(),
      email: user.email,
      role: user.role,
    };

    const accessToken = this.jwtService.sign(payload, {
      secret: this.config.get<string>("jwt.secret"),
      expiresIn: this.config.get<string>("jwt.expiresIn", "15m"),
    });

    const refreshToken = this.jwtService.sign(payload, {
      secret: this.config.get<string>("jwt.refreshSecret"),
      expiresIn: this.config.get<string>("jwt.refreshExpiresIn", "7d"),
    });

    // Store hashed refresh token
    const hash = await bcrypt.hash(refreshToken, SALT_ROUNDS);
    await this.userModel.findByIdAndUpdate(user._id, {
      refreshTokenHash: hash,
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: (user._id as unknown as Types.ObjectId).toString(),
        name: user.name,
        email: user.email,
        role: user.role,
      },
    };
  }
}
