import { NestFactory } from "@nestjs/core";
import { ValidationPipe, VersioningType } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter";
import { TransformInterceptor } from "./common/interceptors/transform.interceptor";

async function bootstrap() {
  // rawBody: true → NestJS stores req.rawBody (Buffer) for every request.
  // Webhook handlers use RawBodyRequest<Request> to access it for HMAC verification.
  // No need to manually register express raw() / json() middleware — NestJS handles
  // body parsing internally when this option is set.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  const config = app.get(ConfigService);
  const port = config.get<number>("PORT", 3001);
  const clientOrigin = config.get<string>("CLIENT_ORIGIN", "http://localhost:3000");
  const nodeEnv = config.get<string>("NODE_ENV", "development");
  const storefrontUrl = config.get<string>("STOREFRONT_URL", "http://localhost:3000");

  // ── CORS ────────────────────────────────────────────────────────────────────
  app.enableCors({
    origin:
      nodeEnv === "production"
        ? [clientOrigin, storefrontUrl]
        : [clientOrigin, storefrontUrl, /localhost:\d+/],
    credentials: true,
  });

  // ── Validation ──────────────────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // ── Response envelope ────────────────────────────────────────────────────────
  // Every success → { success: true, data: <payload> }
  app.useGlobalInterceptors(new TransformInterceptor());

  // ── Exception filter ─────────────────────────────────────────────────────────
  // Every error → { success: false, statusCode, message, path }
  app.useGlobalFilters(new HttpExceptionFilter());

  // ── URI versioning — all routes under /v1/ ───────────────────────────────────
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });

  // ── Swagger / OpenAPI ────────────────────────────────────────────────────────
  const swaggerEnabled =
    nodeEnv !== "production" || config.get<string>("SWAGGER_ENABLED", "false") === "true";

  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle("Alphavista Electronics API")
      .setDescription(
        `## Overview
REST API for the Alphavista Electronics e-commerce platform.

### Authentication
Most endpoints are public. Admin and account endpoints require a **Bearer JWT** obtained from \`POST /v1/auth/login\`.

Pass the token in the \`Authorization\` header:
\`\`\`
Authorization: Bearer <accessToken>
\`\`\`

### Response envelope
All responses follow the standard envelope:
\`\`\`json
{ "success": true, "data": { ... } }
\`\`\`
Errors follow:
\`\`\`json
{ "success": false, "statusCode": 400, "message": "...", "path": "/v1/..." }
\`\`\`

### Guest cart
For unauthenticated cart operations, generate a UUID and pass it in every request:
\`\`\`
X-Guest-Id: f47ac10b-58cc-4372-a567-0e02b2c3d479
\`\`\`
Call \`POST /v1/cart/merge\` with \`guestId\` immediately after login.

### Versioning
All routes are prefixed with \`/v1/\`.`,
      )
      .setVersion("1.0")
      .setContact("Alphavista Dev", storefrontUrl, "dev@alphavista.ng")
      .addServer(`http://localhost:${port}`, "Local development")
      .addServer("https://alphavista-api.onrender.com", "Production (Render)")
      .addBearerAuth(
        {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          name: "Authorization",
          description: "Enter the JWT access token from POST /v1/auth/login",
          in: "header",
        },
        "bearerAuth",
      )
      .addApiKey(
        {
          type: "apiKey",
          in: "header",
          name: "X-Guest-Id",
          description: "UUID for guest cart operations (generate with crypto.randomUUID())",
        },
        "guestId",
      )
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig, {
      operationIdFactory: (_controllerKey, methodKey) => methodKey,
      deepScanRoutes: true,
    });

    SwaggerModule.setup("docs", app, document, {
      customSiteTitle: "Alphavista API Docs",
      customCss: `
        .swagger-ui .topbar { background: #111827; }
        .swagger-ui .topbar-wrapper img { content: url(''); width: 0; }
        .swagger-ui .topbar-wrapper::after {
          content: 'Alphavista Electronics API';
          color: #f9fafb; font-size: 1.1rem; font-weight: 600; margin-left: 12px;
        }
      `,
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
        filter: true,
        docExpansion: "none",
        tagsSorter: "alpha",
        operationsSorter: "alpha",
        defaultModelsExpandDepth: 2,
      },
    });
  }

  // ── Health check — Render + Docker probe ─────────────────────────────────────
  const httpAdapter = app.getHttpAdapter();
  httpAdapter.get(
    "/health",
    (_req: unknown, res: { status: (code: number) => { json(body: unknown): void } }) => {
      res.status(200).json({
        status: "ok",
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        env: nodeEnv,
      });
    },
  );

  await app.listen(port);

  console.log(`\n🚀  Alphavista API → http://localhost:${port}`);
  if (swaggerEnabled) console.log(`📖  Swagger docs  → http://localhost:${port}/docs`);
  console.log(`❤️   Health check  → http://localhost:${port}/health\n`);
}

bootstrap();
