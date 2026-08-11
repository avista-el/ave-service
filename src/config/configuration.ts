export default () => ({
  port: parseInt(process.env.PORT ?? '4000', 10),
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:3000',

  swaggerEnabled: process.env.SWAGGER_ENABLED ?? false,

  database: {
    uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017/alphavista',
  },

  jwt: {
    secret: process.env.JWT_SECRET ?? 'change-me-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '15m',
    refreshSecret:
      process.env.JWT_REFRESH_SECRET ?? 'change-refresh-me-in-production',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
  },

  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD,
    url: process.env.REDIS_URL,
  },

  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME ?? '',
    apiKey: process.env.CLOUDINARY_API_KEY ?? '',
    apiSecret: process.env.CLOUDINARY_API_SECRET ?? '',
  },

  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY ?? '',
    webhookSecret: process.env.PAYSTACK_WEBHOOK_SECRET ?? '',
    baseUrl: 'https://api.paystack.co',
  },

  flutterwave: {
    secretKey: process.env.FLUTTERWAVE_SECRET_KEY ?? '',
    encryptionKey: process.env.FLUTTERWAVE_ENCRYPTION_KEY ?? '',
    baseUrl: 'https://api.flutterwave.com/v3',
  },

  meilisearch: {
    host: process.env.MEILISEARCH_HOST ?? 'http://localhost:7700',
    apiKey: process.env.MEILISEARCH_API_KEY ?? '',
  },

  geolocation: {
    provider: (process.env.GEO_PROVIDER ?? 'ipapi') as 'ipapi' | 'ipinfo',
    ipapiToken: process.env.IPAPI_TOKEN,
    ipinfoToken: process.env.IPINFO_TOKEN,
  },

  resend: {
    apiKey: process.env.RESEND_API_KEY ?? '',
    fromEmail:
      process.env.RESEND_FROM_EMAIL ?? 'orders@mail.alphavista.ng',
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  },

  storefront: {
    baseUrl: process.env.STOREFRONT_URL ?? 'http://localhost:3000',
  },
});
