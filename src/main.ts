import { NestFactory } from "@nestjs/core";
import { ValidationPipe, VersioningType } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter";
import { TransformInterceptor } from "./common/interceptors/transform.interceptor";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  const config = app.get(ConfigService);
  const port = config.get<number>("PORT", 4000);
  const clientOrigin = config.get<string>("CLIENT_ORIGIN", "http://localhost:3000");
  const nodeEnv = config.get<string>("NODE_ENV", "development");
  const storefrontUrl = config.get<string>("STOREFRONT_URL", "http://localhost:3000");

  // ── CORS ─────────────────────────────────────────────────────────────────────
  app.enableCors({
    origin:
      nodeEnv === "production"
        ? [clientOrigin, storefrontUrl]
        : [clientOrigin, storefrontUrl, /localhost:\d+/],
    credentials: true,
  });

  // ── Validation ───────────────────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // ── Response envelope ────────────────────────────────────────────────────────
  app.useGlobalInterceptors(new TransformInterceptor());

  // ── Exception filter ─────────────────────────────────────────────────────────
  app.useGlobalFilters(new HttpExceptionFilter());

  // ── URI versioning ───────────────────────────────────────────────────────────
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });

  // ── Health check — registered BEFORE Swagger so it works even if Swagger fails
  // Render's port scanner hits this endpoint to confirm the service is up.
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

  // ── START LISTENING FIRST ────────────────────────────────────────────────────
  // Bind the port immediately so Render detects it within the scan window.
  // Swagger setup runs after — it's not required for the port to be open.
  await app.listen(port, "0.0.0.0");
  console.log(`\n🚀  Alphavista API → http://localhost:${port}`);
  console.log(`❤️   Health check  → http://localhost:${port}/health`);

  // ── Swagger / OpenAPI ────────────────────────────────────────────────────────
  // Runs after listen() — doesn't block port binding.
  const swaggerEnabled =
    nodeEnv !== "production" || config.get<string>("SWAGGER_ENABLED", "false") === "true";

  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle("Alphavista Electronics API")
      .setDescription(
        `## Overview
REST API for the Alphavista Electronics e-commerce platform.

### Authentication
Obtain a **Bearer JWT** from \`POST /v1/auth/login\`, then pass it as:
\`Authorization: Bearer <accessToken>\`

### Response envelope
\`\`\`json
{ "success": true, "data": { ... } }
\`\`\`
Errors:
\`\`\`json
{ "success": false, "statusCode": 400, "message": "...", "path": "/v1/..." }
\`\`\`

### Guest cart
Pass a client-generated UUID in every unauthenticated cart request:
\`X-Guest-Id: f47ac10b-58cc-4372-a567-0e02b2c3d479\`
Call \`POST /v1/cart/merge\` immediately after login.

### Versioning
All routes are prefixed with \`/v1/\`.`,
      )
      .setVersion("1.0")
      .setContact("Alphavista Dev", storefrontUrl, "dev@alphavista.ng")
      .addServer(`http://localhost:${port}`, "Local development")
      .addServer("https://ave-service.onrender.com", "Production (Render)")
      .addBearerAuth(
        {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          name: "Authorization",
          description: "JWT access token from POST /v1/auth/login",
          in: "header",
        },
        "bearerAuth",
      )
      .addApiKey(
        {
          type: "apiKey",
          in: "header",
          name: "X-Guest-Id",
          description: "UUID for guest cart operations",
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

    console.log(`📖  Swagger docs  → http://localhost:${port}/docs\n`);
  }
}

bootstrap();
