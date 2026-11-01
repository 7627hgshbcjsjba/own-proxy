'use strict';

const config = {
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 8080),

  // Allow proxying to private / loopback addresses (dev only).
  allowPrivateNetworks: /^(1|true|yes)$/i.test(process.env.ALLOW_PRIVATE_NETWORKS || ''),

  // Skip TLS certificate validation (some sites have broken certs).
  insecureTLS: /^(1|true|yes)$/i.test(process.env.INSECURE_TLS || ''),

  // Socket timeout for outgoing requests, ms.
  timeout: Number(process.env.PROXY_TIMEOUT || 30000),

  // Max size of a page body we will buffer for rewriting (bytes).
  maxBufferSize: Number(process.env.MAX_BUFFER_SIZE || 64 * 1024 * 1024),

  // Max size of an uploaded request body we forward (bytes).
  maxUploadSize: Number(process.env.MAX_UPLOAD_SIZE || 32 * 1024 * 1024),

  // Short token -> origin map lifetime (ms).
  tokenTTL: 12 * 60 * 60 * 1000,
  maxTokens: 50000,

  // User-Agent used when the browser does not send one.
  fallbackUserAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',

  // Accept header used when the browser does not send one.
  fallbackUserAgentAccept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',

  // Log every proxied request + status to stdout.
  logRequests: /^(1|true|yes)$/i.test(process.env.LOG_REQUESTS || ''),

  // --- abuse protection -------------------------------------------------
  // Requests per minute allowed per visitor for proxied pages.
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE || 120),

  // Maximum number of proxied requests running at the same time.
  maxConcurrentRequests: Number(process.env.MAX_CONCURRENT_REQUESTS || 64),

  // Trust X-Forwarded-* headers (set when running behind a hosting proxy).
  trustProxyHeaders: !/^(0|false|no)$/i.test(process.env.TRUST_PROXY || ''),
};

module.exports = config;
