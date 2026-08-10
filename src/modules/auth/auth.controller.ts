import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
} from "@nestjs/swagger";
import { AuthService } from "./auth.service";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { RefreshTokenDto } from "./dto/refresh-token.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { JwtPayload } from "./strategies/jwt.strategy";
import {
  ApiEnvelopeCreated,
  ApiEnvelopeOk,
  ApiErrorResponse,
} from "../../common/swagger/api-response.decorator";
import { AuthResponseDto, AuthUserDto } from "../../common/swagger/swagger-response.dto";

@ApiTags("Auth")
@Controller({ path: "auth", version: "1" })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ─── Register ─────────────────────────────────────────────────────────────

  @Post("register")
  @ApiOperation({
    summary: "Register a new customer account",
    description:
      "Creates a new customer user and returns a token pair. Admin users must be created by a super-admin.",
  })
  @ApiEnvelopeCreated(AuthResponseDto)
  @ApiConflictResponse({ description: "Email already registered", type: ApiErrorResponse })
  @ApiBadRequestResponse({ description: "Validation error", type: ApiErrorResponse })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  // ─── Login ────────────────────────────────────────────────────────────────

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Login with email and password",
    description:
      "Returns a short-lived access token (15 min) and a long-lived refresh token (7 days).",
  })
  @ApiEnvelopeOk(AuthResponseDto)
  @ApiUnauthorizedResponse({ description: "Invalid credentials", type: ApiErrorResponse })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  // ─── Refresh ──────────────────────────────────────────────────────────────

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Refresh token pair",
    description:
      "Exchange a valid refresh token for a new access + refresh token pair. The old refresh token is invalidated.",
  })
  @ApiEnvelopeOk(AuthResponseDto)
  @ApiUnauthorizedResponse({
    description: "Invalid or expired refresh token",
    type: ApiErrorResponse,
  })
  refresh(@Body() dto: RefreshTokenDto) {
    const payload = this.authService["jwtService"].decode(dto.refreshToken) as JwtPayload | null;
    if (!payload?.sub) throw new Error("Invalid refresh token structure");
    return this.authService.refreshTokens(payload.sub, dto.refreshToken);
  }

  // ─── Logout ───────────────────────────────────────────────────────────────

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Logout — invalidate refresh token" })
  @ApiResponse({ status: 200, description: "Logged out successfully" })
  @ApiUnauthorizedResponse({ description: "Missing or invalid JWT", type: ApiErrorResponse })
  logout(@CurrentUser() user: JwtPayload) {
    return this.authService.logout(user.sub);
  }

  // ─── Me ───────────────────────────────────────────────────────────────────

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get("me")
  @ApiOperation({ summary: "Get current user profile" })
  @ApiEnvelopeOk(AuthUserDto)
  @ApiUnauthorizedResponse({ description: "Missing or invalid JWT", type: ApiErrorResponse })
  me(@CurrentUser() user: JwtPayload) {
    return this.authService.profile(user.sub);
  }
}
