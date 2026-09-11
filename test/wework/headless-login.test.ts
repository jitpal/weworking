/**
 * The headless Auth0 login, driven through a fake redirect chain.
 *
 * The happy path here is deliberately shaped like the real one: discovery ->
 * `/co/authenticate` -> `/authorize` -> two redirects -> the
 * `mfa-detect-browser-capabilities` form -> two more redirects -> the callback with
 * `?code=` -> `/oauth/token`. That is what makes the cookie-carrying and
 * form-submitting assertions meaningful; a one-hop chain would pass without either
 * working.
 *
 * The blocked paths matter more than the happy one in practice, since Auth0's bot
 * protection is the expected outcome from a datacenter IP — so CAPTCHA, MFA and 429
 * each get their own case, and each must produce a terminal error with a hint
 * pointing at `/admin/connect` rather than a retry.
 */

import { describe, expect, it, vi } from "vitest";
import { isAppError } from "../../src/errors";
import { AUTH0_CONFIG_URL, FALLBACK_AUTH0_CONFIG } from "../../src/wework/auth/config";
import {
  createHeadlessLoginStrategy,
  headlessLogin,
  isMfaChallenge,
  looksBlocked,
  parseFirstForm,
  parseRetryAfterMs,
  RETRY_AFTER_CAP_MS,
} from "../../src/wework/auth/headless-login";
import { createCodeChallenge } from "../../src/wework/auth/pkce";
import auth0Config from "../fixtures/wework/auth0-config.json";
import coAuthBlocked from "../fixtures/wework/co-authenticate-blocked.json";
import coAuthOk from "../fixtures/wework/co-authenticate-ok.json";
import tokenResponse from "../fixtures/wework/token-response.json";
import { createFakeFetch, type FakeRoute } from "../helpers/fake-fetch";
import {
  FIXTURE_ACCESS_TOKEN,
  FIXTURE_EXPIRES_AT_MS,
  FIXTURE_REFRESH_TOKEN,
  FIXTURE_USER_UUID,
  formBody,
  IDP,
  jsonBody,
  NOW_MS,
  now,
  queryOf,
} from "./helpers";

const CO_AUTH = `${IDP}/co/authenticate`;
const AUTHORIZE = `${IDP}/authorize`;
const RESUME = `${IDP}/authorize/resume`;
const CAPABILITIES = `${IDP}/u/mfa-detect-browser-capabilities`;
const TOKEN = `${IDP}/oauth/token`;
const CALLBACK = "https://members.wework.com/workplaceone/api/auth0/v2/callback";
const CLIENT_ID = FALLBACK_AUTH0_CONFIG.clientId;
const AUTH_CODE = "FAKE-AUTHORIZATION-CODE-0123456789";

const CREDENTIALS = {
  username: "not-a-real-member@example.invalid",
  password: "not-a-real-password",
};

/** The Auth0 capabilities page, with `js-available` deliberately pre-set to false. */
const CAPABILITIES_HTML = `<!DOCTYPE html><html><head><title>Checking your browser</title></head>
<body><form method="post" action="/u/mfa-detect-browser-capabilities?state=txn-1" id="caps">
  <input type="hidden" name="state" value="txn-1">
  <input type="hidden" name="js-available" value="false">
  <input type="hidden" name="tenant" value="wework &amp; co">
  <button type="submit" name="action" value="default">Continue</button>
</form></body></html>`;

const CAPTCHA_HTML = `<!DOCTYPE html><html><body>
<form method="post" action="/u/login/password?state=txn-1">
  <input type="hidden" name="state" value="txn-1">
  <div class="g-recaptcha" data-sitekey="FAKE-SITEKEY"></div>
</form></body></html>`;

const OTP_HTML = `<!DOCTYPE html><html><body>
<form method="post" action="/u/login/password?state=txn-1">
  <input type="hidden" name="state" value="txn-1">
  <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code">
</form></body></html>`;

/** Records sleeps instead of performing them, so the 429 path is instant. */
function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

async function expectAppError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected an AppError with code ${code}`);
}

/**
 * The full happy-path route table.
 *
 * `state` is captured from the `/authorize` request and echoed by the callback, so
 * the CSRF check in `extractCode` is exercised rather than bypassed.
 */
function happyRoutes(overrides: { capabilitiesBody?: string } = {}): {
  routes: FakeRoute[];
  sentState: { value?: string };
} {
  const sentState: { value?: string } = {};
  const routes: FakeRoute[] = [
    {
      method: "GET",
      url: AUTH0_CONFIG_URL,
      times: 1,
      response: () => Response.json(auth0Config),
    },
    { method: "POST", url: CO_AUTH, times: 1, response: () => Response.json(coAuthOk) },
    {
      method: "GET",
      url: AUTHORIZE,
      times: 1,
      response: (request) => {
        sentState.value = new URL(request.url).searchParams.get("state") ?? undefined;
        const headers = new Headers({ location: "/authorize/resume?state=txn-1" });
        headers.append("set-cookie", "did=FAKE-DID; Domain=.wework.com; Path=/; Secure");
        headers.append("set-cookie", "auth0=FAKE-AUTH0-SESSION; Path=/; Secure; HttpOnly");
        return new Response(null, { status: 302, headers });
      },
    },
    {
      method: "GET",
      url: RESUME,
      times: 1,
      response: () => {
        const headers = new Headers({
          location: "/u/mfa-detect-browser-capabilities?state=txn-1",
        });
        headers.append("set-cookie", "_csrf=FAKE-CSRF; Path=/u; Secure; SameSite=Lax");
        return new Response(null, { status: 302, headers });
      },
    },
    {
      method: "GET",
      url: CAPABILITIES,
      times: 1,
      response: () =>
        new Response(overrides.capabilitiesBody ?? CAPABILITIES_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    },
    {
      method: "POST",
      url: CAPABILITIES,
      times: 1,
      response: () =>
        new Response(null, {
          status: 302,
          headers: { location: "/authorize/resume?state=txn-2" },
        }),
    },
    {
      method: "GET",
      url: RESUME,
      times: 1,
      response: () =>
        new Response(null, {
          status: 302,
          headers: {
            location: `${CALLBACK}?domain=members.wework.com/workplaceone&code=${AUTH_CODE}&state=${encodeURIComponent(sentState.value ?? "")}`,
          },
        }),
    },
    { method: "POST", url: TOKEN, times: 1, response: () => Response.json(tokenResponse) },
  ];
  return { routes, sentState };
}

/** Reads the seeded Auth0 transaction back out of a recorded `Cookie` header. */
function transactionFromCookieHeader(cookie: string | undefined): Record<string, unknown> {
  if (!cookie) throw new Error("expected a Cookie header");
  const entry = cookie.split("; ").find((pair) => pair.startsWith(`a0.spajs.txs.${CLIENT_ID}=`));
  if (!entry) throw new Error(`no transaction cookie in: ${cookie}`);
  return JSON.parse(decodeURIComponent(entry.slice(entry.indexOf("=") + 1)));
}

describe("headlessLogin — happy path", () => {
  it("returns a login-sourced SessionRecord", async () => {
    const { routes } = happyRoutes();
    const fetchStub = createFakeFetch(routes);
    const session = await headlessLogin({ ...CREDENTIALS, fetch: fetchStub, now });

    expect(session).toEqual({
      accessToken: FIXTURE_ACCESS_TOKEN,
      refreshToken: FIXTURE_REFRESH_TOKEN,
      expiresAt: FIXTURE_EXPIRES_AT_MS,
      obtainedAt: NOW_MS,
      source: "login",
      userUuid: FIXTURE_USER_UUID,
    });
    fetchStub.assertAllConsumed();
  });

  it("walks the whole chain in order, with no skipped hops", async () => {
    const { routes } = happyRoutes();
    const fetchStub = createFakeFetch(routes);
    await headlessLogin({ ...CREDENTIALS, fetch: fetchStub, now });

    expect(fetchStub.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "GET /workplaceone/api/auth0/v2/config",
      "POST /co/authenticate",
      "GET /authorize",
      "GET /authorize/resume",
      "GET /u/mfa-detect-browser-capabilities",
      "POST /u/mfa-detect-browser-capabilities",
      "GET /authorize/resume",
      "POST /oauth/token",
    ]);
  });

  it("sends the password-realm credential type to /co/authenticate", async () => {
    const { routes } = happyRoutes();
    const fetchStub = createFakeFetch(routes);
    await headlessLogin({ ...CREDENTIALS, fetch: fetchStub, now });

    const call = fetchStub.callsMatching(CO_AUTH)[0];
    expect(jsonBody(call?.body)).toEqual({
      client_id: CLIENT_ID,
      username: CREDENTIALS.username,
      password: CREDENTIALS.password,
      realm: "id-wework",
      credential_type: "http://auth0.com/oauth/grant-type/password-realm",
    });
    expect(call?.headers.origin).toBe("https://members.wework.com");
    expect(call?.headers.referer).toBe("https://members.wework.com/");
    expect(call?.headers["auth0-client"]).toBe(
      "eyJuYW1lIjoiYXV0aDAtc3BhLWpzIiwidmVyc2lvbiI6IjIuMS4yIn0=",
    );
    expect(call?.headers["user-agent"]).toContain("Safari");
  });

  it("builds /authorize with the login ticket, PKCE and response_mode=query", async () => {
    const { routes, sentState } = happyRoutes();
    const fetchStub = createFakeFetch(routes);
    await headlessLogin({ ...CREDENTIALS, fetch: fetchStub, now });

    const query = queryOf(fetchStub.callsMatching(AUTHORIZE, "GET")[0]?.url ?? "");
    expect(query).toMatchObject({
      client_id: CLIENT_ID,
      response_type: "code",
      response_mode: "query",
      redirect_uri: FALLBACK_AUTH0_CONFIG.redirectUri,
      scope: FALLBACK_AUTH0_CONFIG.scope,
      audience: "wework",
      code_challenge_method: "S256",
      login_ticket: coAuthOk.login_ticket,
    });
    expect(query.state).toBe(sentState.value);
    expect(query.nonce).toBeTypeOf("string");
    expect(query.auth0Client).toBeTypeOf("string");
  });

  it("seeds both transaction cookies and proves the PKCE pair is consistent", async () => {
    const { routes } = happyRoutes();
    const fetchStub = createFakeFetch(routes);
    await headlessLogin({ ...CREDENTIALS, fetch: fetchStub, now });

    const authorizeCall = fetchStub.callsMatching(AUTHORIZE, "GET")[0];
    const cookie = authorizeCall?.headers.cookie;
    expect(cookie).toContain(`a0.spajs.txs.${CLIENT_ID}=`);
    expect(cookie).toContain(`_legacy_a0.spajs.txs.${CLIENT_ID}=`);

    const transaction = transactionFromCookieHeader(cookie);
    expect(transaction).toMatchObject({
      scope: FALLBACK_AUTH0_CONFIG.scope,
      audience: "wework",
      redirect_uri: FALLBACK_AUTH0_CONFIG.redirectUri,
    });
    expect(transaction.state).toBe(queryOf(authorizeCall?.url ?? "").state);
    expect(transaction.nonce).toBe(queryOf(authorizeCall?.url ?? "").nonce);

    // The challenge on /authorize must be S256 of the verifier in the cookie...
    const verifier = transaction.code_verifier as string;
    await expect(createCodeChallenge(verifier)).resolves.toBe(
      queryOf(authorizeCall?.url ?? "").code_challenge,
    );
    // ...and the verifier sent to /oauth/token must be that same value.
    expect(jsonBody(fetchStub.callsMatching(TOKEN)[0]?.body).code_verifier).toBe(verifier);
  });

  it("carries cookies collected mid-chain into later hops", async () => {
    const { routes } = happyRoutes();
    const fetchStub = createFakeFetch(routes);
    await headlessLogin({ ...CREDENTIALS, fetch: fetchStub, now });

    const capabilitiesGet = fetchStub.callsMatching(CAPABILITIES, "GET")[0];
    const cookie = capabilitiesGet?.headers.cookie ?? "";
    // Set by /authorize, on .wework.com and host-only respectively.
    expect(cookie).toContain("did=FAKE-DID");
    expect(cookie).toContain("auth0=FAKE-AUTH0-SESSION");
    // Set by /authorize/resume, scoped to Path=/u — so it only reaches /u/* hops.
    expect(cookie).toContain("_csrf=FAKE-CSRF");
    // Longest path first.
    expect(cookie.indexOf("_csrf=")).toBeLessThan(cookie.indexOf("did="));

    // The /authorize hop happened before _csrf existed, and is scoped out anyway.
    expect(fetchStub.callsMatching(AUTHORIZE, "GET")[0]?.headers.cookie).not.toContain("_csrf");
  });

  it("submits the capabilities form with the known capability fields", async () => {
    const { routes } = happyRoutes();
    const fetchStub = createFakeFetch(routes);
    await headlessLogin({ ...CREDENTIALS, fetch: fetchStub, now });

    const post = fetchStub.callsMatching(CAPABILITIES, "POST")[0];
    expect(post?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(post?.headers.origin).toBe(IDP);
    expect(post?.headers.referer).toContain("/u/mfa-detect-browser-capabilities");
    expect(formBody(post?.body)).toEqual({
      state: "txn-1",
      // Overridden: the page's hidden input said "false".
      "js-available": "true",
      "webauthn-available": "false",
      "webauthn-platform-available": "false",
      "is-brave": "false",
      action: "default",
      // Carried through generically, with its HTML entity decoded.
      tenant: "wework & co",
    });
  });

  it("exchanges the code for tokens with the authorization_code grant", async () => {
    const { routes } = happyRoutes();
    const fetchStub = createFakeFetch(routes);
    await headlessLogin({ ...CREDENTIALS, fetch: fetchStub, now });

    const body = jsonBody(fetchStub.callsMatching(TOKEN)[0]?.body);
    expect(body).toMatchObject({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: AUTH_CODE,
      redirect_uri: FALLBACK_AUTH0_CONFIG.redirectUri,
    });
  });

  it("never sends the password anywhere but /co/authenticate", async () => {
    const { routes } = happyRoutes();
    const fetchStub = createFakeFetch(routes);
    await headlessLogin({ ...CREDENTIALS, fetch: fetchStub, now });

    const leaks = fetchStub.calls.filter(
      (call) =>
        !call.url.startsWith(CO_AUTH) &&
        (call.body?.includes(CREDENTIALS.password) || call.url.includes(CREDENTIALS.password)),
    );
    expect(leaks).toEqual([]);
  });
});

describe("createHeadlessLoginStrategy", () => {
  it('is named "headless" and logs in on demand', async () => {
    const { routes } = happyRoutes();
    const strategy = createHeadlessLoginStrategy({
      ...CREDENTIALS,
      fetch: createFakeFetch(routes),
      now,
    });
    expect(strategy.name).toBe("headless");
    await expect(strategy.login()).resolves.toMatchObject({ source: "login" });
  });

  it("refuses to start without credentials", async () => {
    const strategy = createHeadlessLoginStrategy({
      username: "",
      password: "",
      fetch: createFakeFetch([]),
      now,
    });
    await expectAppError(strategy.login(), "UPSTREAM_AUTH");
  });
});

describe("headlessLogin — discovery fallback", () => {
  it("uses the pinned constants when the config endpoint fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { routes } = happyRoutes();
      routes[0] = {
        method: "GET",
        url: AUTH0_CONFIG_URL,
        times: 1,
        response: () => new Response("upstream down", { status: 503 }),
      };
      const fetchStub = createFakeFetch(routes);
      await expect(headlessLogin({ ...CREDENTIALS, fetch: fetchStub, now })).resolves.toMatchObject(
        { source: "login" },
      );

      expect(fetchStub.callsMatching(CO_AUTH)).toHaveLength(1);
      expect(warn).toHaveBeenCalled();
      // The warning carries no credential material.
      expect(JSON.stringify(warn.mock.calls)).not.toContain(CREDENTIALS.password);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("headlessLogin — blocked by bot protection", () => {
  it("maps requires_verification on /co/authenticate to UPSTREAM_BLOCKED", async () => {
    const { routes } = happyRoutes();
    routes[1] = {
      method: "POST",
      url: CO_AUTH,
      times: 1,
      response: () => new Response(JSON.stringify(coAuthBlocked), { status: 400 }),
    };
    const error = await expectAppError(
      headlessLogin({ ...CREDENTIALS, fetch: createFakeFetch(routes), now }),
      "UPSTREAM_BLOCKED",
    );
    expect(error.hint).toContain("/admin/connect");
  });

  it("maps a CAPTCHA page mid-chain to UPSTREAM_BLOCKED", async () => {
    const { routes } = happyRoutes({ capabilitiesBody: CAPTCHA_HTML });
    const error = await expectAppError(
      headlessLogin({ ...CREDENTIALS, fetch: createFakeFetch(routes), now }),
      "UPSTREAM_BLOCKED",
    );
    expect(error.hint).toContain("/admin/connect");
  });

  it("maps error=requires_verification on the callback to UPSTREAM_BLOCKED", async () => {
    const { routes } = happyRoutes();
    routes[6] = {
      method: "GET",
      url: RESUME,
      times: 1,
      response: () =>
        new Response(null, {
          status: 302,
          headers: {
            location: `${CALLBACK}?domain=x&error=requires_verification&error_description=Please%20verify`,
          },
        }),
    };
    await expectAppError(
      headlessLogin({ ...CREDENTIALS, fetch: createFakeFetch(routes), now }),
      "UPSTREAM_BLOCKED",
    );
  });
});

describe("headlessLogin — MFA", () => {
  it("stops at an /u/mfa- challenge page with the connect-page hint", async () => {
    const { routes } = happyRoutes();
    routes[3] = {
      method: "GET",
      url: RESUME,
      times: 1,
      response: () =>
        new Response(null, {
          status: 302,
          headers: { location: "/u/mfa-sms-challenge?state=txn-1" },
        }),
    };
    routes.splice(4, 2, {
      method: "GET",
      url: `${IDP}/u/mfa-sms-challenge`,
      times: 1,
      response: () => new Response(OTP_HTML, { headers: { "content-type": "text/html" } }),
    });

    const error = await expectAppError(
      headlessLogin({ ...CREDENTIALS, fetch: createFakeFetch(routes), now }),
      "UPSTREAM_BLOCKED",
    );
    expect(error.hint).toBe("MFA enrolled accounts must use /admin/connect");
    expect(error.message).toMatch(/multi-factor/i);
  });

  it("detects an OTP form even on a path that does not say mfa", async () => {
    const { routes } = happyRoutes();
    routes[3] = {
      method: "GET",
      url: RESUME,
      times: 1,
      response: () =>
        new Response(null, { status: 302, headers: { location: "/u/login/password?state=txn-1" } }),
    };
    routes.splice(4, 2, {
      method: "GET",
      url: `${IDP}/u/login/password`,
      times: 1,
      response: () => new Response(OTP_HTML, { headers: { "content-type": "text/html" } }),
    });

    const error = await expectAppError(
      headlessLogin({ ...CREDENTIALS, fetch: createFakeFetch(routes), now }),
      "UPSTREAM_BLOCKED",
    );
    expect(error.hint).toBe("MFA enrolled accounts must use /admin/connect");
  });

  it("does not mistake the capabilities page for an MFA challenge", async () => {
    // It lives under /u/mfa-detect-browser-capabilities, which matches /u/mfa-.
    const { routes } = happyRoutes();
    await expect(
      headlessLogin({ ...CREDENTIALS, fetch: createFakeFetch(routes), now }),
    ).resolves.toMatchObject({ source: "login" });
  });
});

describe("headlessLogin — credentials and rate limits", () => {
  it("maps a 401 from /co/authenticate to UPSTREAM_AUTH", async () => {
    const { routes } = happyRoutes();
    routes[1] = {
      method: "POST",
      url: CO_AUTH,
      times: 1,
      response: () =>
        new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "Wrong email or password." }),
          {
            status: 401,
          },
        ),
    };
    const error = await expectAppError(
      headlessLogin({ ...CREDENTIALS, fetch: createFakeFetch(routes), now }),
      "UPSTREAM_AUTH",
    );
    expect(error.hint).toContain("WEWORK_USERNAME");
  });

  it("retries a 429 on /co/authenticate, honouring Retry-After", async () => {
    const { routes } = happyRoutes();
    const { waits, sleep } = recordingSleep();
    routes.splice(
      1,
      1,
      {
        method: "POST",
        url: CO_AUTH,
        times: 1,
        response: () => new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
      },
      {
        method: "POST",
        url: CO_AUTH,
        times: 1,
        response: () => Response.json(coAuthOk),
      },
    );

    const fetchStub = createFakeFetch(routes);
    await expect(
      headlessLogin({ ...CREDENTIALS, fetch: fetchStub, now, sleep }),
    ).resolves.toMatchObject({ source: "login" });
    expect(waits).toEqual([2000]);
    expect(fetchStub.callsMatching(CO_AUTH)).toHaveLength(2);
  });

  it("gives up after three 429s with UPSTREAM_RATE_LIMITED", async () => {
    const { routes } = happyRoutes();
    const { waits, sleep } = recordingSleep();
    routes[1] = {
      method: "POST",
      url: CO_AUTH,
      response: () => new Response("slow down", { status: 429, headers: { "retry-after": "1" } }),
    };

    const fetchStub = createFakeFetch(routes);
    await expectAppError(
      headlessLogin({ ...CREDENTIALS, fetch: fetchStub, now, sleep }),
      "UPSTREAM_RATE_LIMITED",
    );
    expect(fetchStub.callsMatching(CO_AUTH)).toHaveLength(3);
    expect(waits).toEqual([1000, 1000]);
  });

  it("retries a 429 mid-chain on /authorize", async () => {
    const { routes } = happyRoutes();
    const { waits, sleep } = recordingSleep();
    routes.splice(2, 0, {
      method: "GET",
      url: AUTHORIZE,
      times: 1,
      response: () => new Response("slow down", { status: 429, headers: { "retry-after": "3" } }),
    });

    const fetchStub = createFakeFetch(routes);
    await expect(
      headlessLogin({ ...CREDENTIALS, fetch: fetchStub, now, sleep }),
    ).resolves.toMatchObject({ source: "login" });
    expect(waits).toEqual([3000]);
  });
});

describe("headlessLogin — chain failures", () => {
  it("gives up after the hop budget", async () => {
    const { routes } = happyRoutes();
    routes.splice(3, 4, {
      method: "GET",
      url: RESUME,
      response: () =>
        new Response(null, { status: 302, headers: { location: "/authorize/resume?state=loop" } }),
    });
    const error = await expectAppError(
      headlessLogin({ ...CREDENTIALS, fetch: createFakeFetch(routes), now, maxRedirects: 4 }),
      "UPSTREAM_ERROR",
    );
    expect(error.message).toContain("4 hops");
  });

  it("fails when a redirect carries no Location", async () => {
    const { routes } = happyRoutes();
    routes[3] = {
      method: "GET",
      url: RESUME,
      times: 1,
      response: () => new Response(null, { status: 302 }),
    };
    await expectAppError(
      headlessLogin({ ...CREDENTIALS, fetch: createFakeFetch(routes), now }),
      "UPSTREAM_ERROR",
    );
  });

  it("fails when a 200 hop has no form to continue from", async () => {
    const { routes } = happyRoutes({ capabilitiesBody: "<html><body>Nothing here.</body></html>" });
    await expectAppError(
      headlessLogin({ ...CREDENTIALS, fetch: createFakeFetch(routes), now }),
      "UPSTREAM_ERROR",
    );
  });

  it("rejects a callback whose state we did not send", async () => {
    const { routes } = happyRoutes();
    routes[6] = {
      method: "GET",
      url: RESUME,
      times: 1,
      response: () =>
        new Response(null, {
          status: 302,
          headers: { location: `${CALLBACK}?domain=x&code=${AUTH_CODE}&state=SOMEONE-ELSES-STATE` },
        }),
    };
    const error = await expectAppError(
      headlessLogin({ ...CREDENTIALS, fetch: createFakeFetch(routes), now }),
      "UPSTREAM_ERROR",
    );
    expect(error.message).toMatch(/state/i);
  });

  it("refuses to follow a redirect off the WeWork and Auth0 hosts", async () => {
    const { routes } = happyRoutes();
    // Hop 2 tries to send the chain elsewhere. The Referer of that hop would carry
    // the single-use login_ticket, so the chain must stop rather than follow.
    routes[3] = {
      method: "GET",
      url: RESUME,
      times: 1,
      response: () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://idp.wework.com.evil.example/authorize?state=txn-1" },
        }),
    };
    const fetchStub = createFakeFetch(routes);
    const error = await expectAppError(
      headlessLogin({ ...CREDENTIALS, fetch: fetchStub, now }),
      "UPSTREAM_ERROR",
    );
    expect(error.message).toContain("idp.wework.com.evil.example");
    // Nothing was sent to that host.
    expect(fetchStub.calls.some((call) => call.url.includes("evil.example"))).toBe(false);
  });

  it("refuses to submit a form whose action points off-tenant", async () => {
    const { routes } = happyRoutes({
      capabilitiesBody: `<html><body><form method="post" action="https://collector.example/steal">
<input type="hidden" name="state" value="txn-1"></form></body></html>`,
    });
    const fetchStub = createFakeFetch(routes);
    const error = await expectAppError(
      headlessLogin({ ...CREDENTIALS, fetch: fetchStub, now }),
      "UPSTREAM_ERROR",
    );
    expect(error.message).toContain("collector.example");
    expect(fetchStub.calls.some((call) => call.url.includes("collector.example"))).toBe(false);
  });

  it("maps error=access_denied on the callback to UPSTREAM_AUTH", async () => {
    const { routes } = happyRoutes();
    routes[6] = {
      method: "GET",
      url: RESUME,
      times: 1,
      response: () =>
        new Response(null, {
          status: 302,
          headers: {
            location: `${CALLBACK}?domain=x&error=access_denied&error_description=Wrong%20credentials`,
          },
        }),
    };
    await expectAppError(
      headlessLogin({ ...CREDENTIALS, fetch: createFakeFetch(routes), now }),
      "UPSTREAM_AUTH",
    );
  });
});

describe("parseFirstForm", () => {
  it("reads the action, method and every named field", () => {
    const form = parseFirstForm(CAPABILITIES_HTML);
    expect(form?.action).toBe("/u/mfa-detect-browser-capabilities?state=txn-1");
    expect(form?.method).toBe("post");
    expect(form?.fields).toEqual({
      state: "txn-1",
      "js-available": "false",
      tenant: "wework & co",
      action: "default",
    });
    expect(form?.names).toContain("action");
  });

  it("defaults to POST when the form declares no method", () => {
    expect(parseFirstForm('<form action="/x"><input name="a" value="1"></form>')?.method).toBe(
      "POST",
    );
  });

  it("handles single-quoted and unquoted attributes", () => {
    const form = parseFirstForm("<form action='/y' method=get><input name='a' value=1></form>");
    expect(form?.action).toBe("/y");
    expect(form?.method).toBe("get");
    expect(form?.fields.a).toBe("1");
  });

  it("gives a named input with no value the empty string", () => {
    expect(parseFirstForm('<form><input name="a"></form>')?.fields.a).toBe("");
  });

  it("returns undefined when there is no form", () => {
    expect(parseFirstForm("<html><body>no form</body></html>")).toBeUndefined();
  });
});

describe("classification helpers", () => {
  it("looksBlocked recognises the common bot-protection markers", () => {
    expect(looksBlocked(CAPTCHA_HTML)).toBe(true);
    expect(looksBlocked('{"error":"requires_verification"}')).toBe(true);
    expect(looksBlocked("<html>arkoselabs/v2/FAKE</html>")).toBe(true);
    expect(looksBlocked("<html>Attention Required! | Cloudflare</html>")).toBe(true);
    expect(looksBlocked(CAPABILITIES_HTML)).toBe(false);
  });

  it("isMfaChallenge separates the challenge pages from the capabilities probe", () => {
    expect(isMfaChallenge("/u/mfa-sms-challenge", undefined)).toBe(true);
    expect(isMfaChallenge("/u/challenge", undefined)).toBe(true);
    expect(isMfaChallenge("/u/login/password", parseFirstForm(OTP_HTML))).toBe(true);
    expect(isMfaChallenge("/u/login/password", parseFirstForm(CAPABILITIES_HTML))).toBe(false);
  });

  it("parseRetryAfterMs reads seconds, HTTP dates and nonsense", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs(null)).toBe(1000);
    expect(parseRetryAfterMs("not-a-number")).toBe(1000);
    expect(parseRetryAfterMs("0")).toBe(1000);
  });

  it("parseRetryAfterMs caps an over-long wait", () => {
    expect(parseRetryAfterMs("600")).toBe(RETRY_AFTER_CAP_MS);
    expect(parseRetryAfterMs(new Date(Date.now() + 3_600_000).toUTCString())).toBe(
      RETRY_AFTER_CAP_MS,
    );
  });
});
