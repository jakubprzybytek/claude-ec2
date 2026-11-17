// The site and the API on one domain per stage: the site at "/", the API at "/api/*" (same origin, one certificate).

import { api, webClient } from "./api";
import { COGNITO_POOL_ID, domain, isProd, TEST_USER } from "./stage";

// Security headers on every response. The CSP allows only this origin and Cognito (the login): no inline scripts, no
// other hosts, so one injected script can't send the tokens (kept in localStorage) anywhere.
const securityHeaders = new aws.cloudfront.ResponseHeadersPolicy("SecurityHeaders", {
  name: `claude-ec2-${$app.stage}-security-headers`,
  securityHeadersConfig: {
    contentSecurityPolicy: {
      override: true,
      contentSecurityPolicy: [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self' https://cognito-idp.eu-west-1.amazonaws.com",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    },
    strictTransportSecurity: { override: true, accessControlMaxAgeSec: 31_536_000, includeSubdomains: true },
    contentTypeOptions: { override: true },
    frameOptions: { override: true, frameOption: "DENY" },
    referrerPolicy: { override: true, referrerPolicy: "no-referrer" },
  },
});

const router = new sst.aws.Router("Router", {
  domain,
  transform: {
    cdn: (args) => {
      args.defaultCacheBehavior = $resolve([args.defaultCacheBehavior, securityHeaders.id]).apply(([b, id]) => ({ ...b, responseHeadersPolicyId: id }));
      args.orderedCacheBehaviors = $resolve([args.orderedCacheBehaviors ?? [], securityHeaders.id]).apply(([bs, id]) =>
        bs.map((b) => ({ ...b, responseHeadersPolicyId: id })),
      );
    },
  },
});
router.route("/api", api.url, { rewrite: { regex: "^/api/(.*)$", to: "/$1" } });

export const web = new sst.aws.StaticSite("Web", {
  path: "packages/web",
  build: { command: "npm run build", output: "dist" },
  router: { instance: router },
  environment: {
    // In `sst dev` the site runs on localhost and talks to API Gateway directly.
    VITE_API_URL: $dev ? api.url : "/api",
    VITE_APP_VERSION: process.env["APP_VERSION"] ?? `${$app.stage}-local`,
    VITE_AUTH_USER_POOL_ID: COGNITO_POOL_ID,
    VITE_AUTH_CLIENT_ID: webClient.id,
  },
  dev: { command: "npm run dev", title: "web" },
});

export const siteUrl = `https://${domain}`;

// Read by the integration and E2E tests through `sst shell` (Resource.TestUser, Resource.TestUserPassword). Not on
// prod, where the test group has no access at all.
if (!isProd) {
  new sst.Secret("TestUserPassword");
  new sst.Linkable("TestUser", { properties: { email: TEST_USER, clientId: webClient.id, siteUrl, apiUrl: api.url } });
}
