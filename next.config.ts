import type { NextConfig } from "next";

/**
 * Baseline security headers applied to every response.
 *
 * Note what is deliberately absent: an *enforcing* Content-Security-Policy.
 * Next.js injects inline bootstrap scripts (and this app adds its own
 * `beforeInteractive` theme script in app/layout.tsx), so a strict policy
 * needs per-request nonces from middleware — which this app does not have yet.
 * Shipping `script-src 'unsafe-inline'` would be security theatre, and
 * shipping a strict policy without nonces would white-screen the app. So the
 * policy below is sent in Report-Only mode: it breaks nothing, and the
 * violation reports show exactly what a future enforcing policy must allow.
 */
const CONTENT_SECURITY_POLICY_REPORT_ONLY = [
  "default-src 'self'",
  // 'unsafe-inline'/'unsafe-eval' are listed so the report highlights genuine
  // third-party sources rather than drowning in Next's own inline bootstrap.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  // Force HTTPS for two years, including subdomains.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  // Stop browsers from MIME-sniffing uploaded files into executable types.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Legacy companion to frame-ancestors, for older browsers.
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  // Don't leak full study URLs (which can contain question ids) to third parties.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The app never uses these APIs; deny them outright.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
];

/**
 * When object storage is configured, signed URLs point at the bucket's own
 * origin. Report-Only CSP would otherwise flag every past-paper fetch and every
 * uploaded image as a violation, burying the reports that actually matter.
 */
const storageOrigin = (() => {
  const source = process.env.STORAGE_PUBLIC_BASE_URL || process.env.STORAGE_ENDPOINT;
  if (!source) return null;
  try {
    return new URL(source).origin;
  } catch {
    return null;
  }
})();

const CSP_WITH_STORAGE = storageOrigin
  ? CONTENT_SECURITY_POLICY_REPORT_ONLY.replace(
      "connect-src 'self'",
      `connect-src 'self' ${storageOrigin}`
    )
  : CONTENT_SECURITY_POLICY_REPORT_ONLY;

const nextConfig: NextConfig = {
  allowedDevOrigins: ['192.168.1.101'],
  // Don't advertise the framework version to attackers scanning for CVEs.
  poweredByHeader: false,

  /**
   * The bulk asset trees are read through `lib/storage/` at runtime, never
   * imported, but the tracer still walks them and warns that
   * `/ROOT/pdf_extraction` matches 16,027 files. Excluding them keeps the
   * serverless bundles small — and they could not fit in a bundle anyway
   * (`pdf_extraction/` alone is ~17 GB).
   */
  outputFileTracingExcludes: {
    "/*": [
      "./pdf_extraction/**/*",
      "./public/uploads/**/*",
      "./public/extracted_images/**/*",
      "./public/step-images/**/*",
      "./data/**/*",
      "./backups/**/*",
      "./.venv-bank/**/*",
      "./gold-set/**/*",
    ],
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          ...securityHeaders,
          {
            key: "Content-Security-Policy-Report-Only",
            value: CSP_WITH_STORAGE,
          },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Content-Type", value: "application/manifest+json" },
        ],
      },
    ];
  },
};

export default nextConfig;
