import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Tests run inside workerd via `@cloudflare/vitest-pool-workers`, reusing the real
 * `wrangler.jsonc` so that bindings (`env.SESSION`, `env.OAUTH_KV`, `vars`) and the
 * Durable Object migrations match production.
 *
 * Import path note: 0.22.x ships `cloudflareTest` (a Vite plugin) from the package
 * root — there is no `@cloudflare/vitest-pool-workers/config` subpath and no
 * `defineWorkersConfig` export. See docs/DEPENDENCY_NOTES.md.
 *
 * Tests must never touch the real network. Stub `fetch` with
 * `test/helpers/fake-fetch.ts`, or use `fetchMock` from `cloudflare:test`.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        /**
         * Deterministic test configuration; these override the `vars` in wrangler.jsonc.
         * The keys are fake and exist only so `parseConfig()` succeeds under test.
         */
        bindings: {
          WRITE_ENABLED: "true",
          MAX_BOOKINGS_PER_DAY: "1",
          MAX_BOOKINGS_PER_WEEK: "5",
          MAX_CREDITS_PER_BOOKING: "unlimited",
          LOGIN_STRATEGY: "manual",
          PUBLIC_BASE_URL: "https://weworking.test",
          ADMIN_PASSWORD: "test-admin-password",
          QUOTE_SIGNING_KEY: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
          COOKIE_SIGNING_KEY: "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100",
          WEWORK_USERNAME: "",
          WEWORK_PASSWORD: "",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
