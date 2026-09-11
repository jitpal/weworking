/**
 * The cookie jar. Every case here corresponds to something the Auth0 login chain
 * actually does — a `Domain=.wework.com` cookie set on `idp.wework.com`, a
 * path-scoped `_csrf`, a `Max-Age=0` deletion on logout, and the two transaction
 * cookies we seed ourselves.
 */

import { describe, expect, it } from "vitest";
import {
  CookieJar,
  defaultPath,
  domainMatches,
  pathMatches,
} from "../../src/wework/auth/cookie-jar";

const IDP = "https://idp.wework.com/authorize";

/** A response carrying one or more `Set-Cookie` headers. */
function withCookies(...cookies: string[]): Response {
  const headers = new Headers();
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response("", { headers });
}

describe("addFromResponse", () => {
  it("reads multiple Set-Cookie headers individually", () => {
    const jar = new CookieJar();
    jar.addFromResponse(IDP, withCookies("did=FAKE-DID; Path=/; Secure", "auth0=FAKE; Path=/"));
    expect(jar.size).toBe(2);
    expect(jar.headerFor(IDP)).toBe("did=FAKE-DID; auth0=FAKE");
  });

  it("keeps an Expires value intact despite its embedded comma", () => {
    const jar = new CookieJar({ now: () => Date.parse("2026-09-20T00:00:00Z") });
    jar.addFromResponse(
      IDP,
      withCookies("a=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Path=/", "b=2; Path=/"),
    );
    expect(jar.headerFor(IDP)).toBe("a=1; b=2");
  });

  it("ignores a malformed header rather than throwing", () => {
    const jar = new CookieJar();
    jar.addFromResponse(IDP, withCookies("", "=novalue", "ok=1"));
    expect(jar.headerFor(IDP)).toBe("ok=1");
  });
});

describe("domain scoping", () => {
  it("sends a host-only cookie to its exact host and nowhere else", () => {
    const jar = new CookieJar();
    jar.addFromResponse(IDP, withCookies("session=S; Path=/"));
    expect(jar.headerFor("https://idp.wework.com/oauth/token")).toBe("session=S");
    expect(jar.headerFor("https://members.wework.com/")).toBe("");
    expect(jar.headerFor("https://other.idp.wework.com/")).toBe("");
  });

  it("sends a Domain cookie to subdomains of that domain", () => {
    const jar = new CookieJar();
    jar.addFromResponse(IDP, withCookies("shared=S; Domain=.wework.com; Path=/"));
    expect(jar.headerFor("https://idp.wework.com/")).toBe("shared=S");
    expect(jar.headerFor("https://members.wework.com/")).toBe("shared=S");
    expect(jar.headerFor("https://wework.com/")).toBe("shared=S");
    expect(jar.headerFor("https://notwework.com/")).toBe("");
  });

  it("rejects a Domain the setting host is not inside", () => {
    const jar = new CookieJar();
    jar.addFromResponse(IDP, withCookies("evil=E; Domain=example.com; Path=/"));
    // Falls back to host-only rather than being stored for example.com.
    expect(jar.headerFor("https://example.com/")).toBe("");
    expect(jar.headerFor("https://idp.wework.com/")).toBe("evil=E");
  });
});

describe("path scoping", () => {
  it("only sends a path cookie inside that path", () => {
    const jar = new CookieJar();
    jar.addFromResponse(IDP, withCookies("csrf=C; Path=/u/login"));
    expect(jar.headerFor("https://idp.wework.com/u/login")).toBe("csrf=C");
    expect(jar.headerFor("https://idp.wework.com/u/login/password")).toBe("csrf=C");
    expect(jar.headerFor("https://idp.wework.com/u/logout")).toBe("");
    expect(jar.headerFor("https://idp.wework.com/")).toBe("");
  });

  it("derives the default path from the request, per RFC 6265", () => {
    const jar = new CookieJar();
    jar.addFromResponse("https://idp.wework.com/u/login/identifier", withCookies("a=1"));
    expect(jar.headerFor("https://idp.wework.com/u/login/other")).toBe("a=1");
    expect(jar.headerFor("https://idp.wework.com/u/")).toBe("");
  });

  it("orders longer paths first in the Cookie header", () => {
    const jar = new CookieJar();
    jar.addFromResponse(IDP, withCookies("root=R; Path=/"));
    jar.addFromResponse(IDP, withCookies("deep=D; Path=/u/login"));
    expect(jar.headerFor("https://idp.wework.com/u/login")).toBe("deep=D; root=R");
  });
});

describe("expiry", () => {
  it("drops a cookie once Expires has passed", () => {
    let clock = Date.parse("2026-09-20T00:00:00Z");
    const jar = new CookieJar({ now: () => clock });
    jar.addFromResponse(
      IDP,
      withCookies("temp=T; Path=/; Expires=Sun, 20 Sep 2026 01:00:00 GMT"),
    );
    expect(jar.headerFor(IDP)).toBe("temp=T");
    clock = Date.parse("2026-09-20T02:00:00Z");
    expect(jar.headerFor(IDP)).toBe("");
    expect(jar.size).toBe(0);
  });

  it("lets Max-Age win over Expires", () => {
    let clock = Date.parse("2026-09-20T00:00:00Z");
    const jar = new CookieJar({ now: () => clock });
    jar.addFromResponse(
      IDP,
      // Expires says an hour, Max-Age says ten seconds; Max-Age must win.
      withCookies("x=1; Path=/; Expires=Sun, 20 Sep 2026 01:00:00 GMT; Max-Age=10"),
    );
    clock += 30_000;
    expect(jar.headerFor(IDP)).toBe("");
  });

  it("treats Max-Age=0 as a deletion", () => {
    const jar = new CookieJar();
    jar.addFromResponse(IDP, withCookies("gone=G; Path=/"));
    expect(jar.size).toBe(1);
    jar.addFromResponse(IDP, withCookies("gone=G; Path=/; Max-Age=0"));
    expect(jar.size).toBe(0);
  });

  it("keeps a session cookie with no expiry indefinitely", () => {
    let clock = Date.parse("2026-09-20T00:00:00Z");
    const jar = new CookieJar({ now: () => clock });
    jar.addFromResponse(IDP, withCookies("s=1; Path=/"));
    clock += 10 * 365 * 86_400_000;
    expect(jar.headerFor(IDP)).toBe("s=1");
  });
});

describe("Secure", () => {
  it("withholds a Secure cookie from plain http", () => {
    const jar = new CookieJar();
    jar.addFromResponse(IDP, withCookies("s=1; Path=/; Secure", "plain=2; Path=/"));
    expect(jar.headerFor("http://idp.wework.com/")).toBe("plain=2");
    expect(jar.headerFor("https://idp.wework.com/")).toBe("s=1; plain=2");
  });
});

describe("overwriting", () => {
  it("replaces by (domain, path, name) and keeps the original ordering", () => {
    const jar = new CookieJar();
    jar.addFromResponse(IDP, withCookies("a=first; Path=/"));
    jar.addFromResponse(IDP, withCookies("b=other; Path=/"));
    jar.addFromResponse(IDP, withCookies("a=second; Path=/"));
    expect(jar.size).toBe(2);
    expect(jar.headerFor(IDP)).toBe("a=second; b=other");
  });

  it("treats the same name on a different path as a different cookie", () => {
    const jar = new CookieJar();
    jar.addFromResponse(IDP, withCookies("t=root; Path=/"));
    jar.addFromResponse(IDP, withCookies("t=scoped; Path=/u/login"));
    expect(jar.size).toBe(2);
    expect(jar.headerFor("https://idp.wework.com/u/login")).toBe("t=scoped; t=root");
  });

  it("treats the same name on a different domain as a different cookie", () => {
    const jar = new CookieJar();
    jar.addFromResponse(IDP, withCookies("t=host; Path=/"));
    jar.addFromResponse(IDP, withCookies("t=domain; Domain=wework.com; Path=/"));
    expect(jar.size).toBe(2);
  });
});

describe("seed", () => {
  it("stores a cookie as host-only and secure by default", () => {
    const jar = new CookieJar();
    jar.seed({ name: "a0.spajs.txs.CLIENT", value: "%7B%22x%22%3A1%7D", domain: "idp.wework.com" });
    expect(jar.headerFor("https://idp.wework.com/authorize")).toBe(
      "a0.spajs.txs.CLIENT=%7B%22x%22%3A1%7D",
    );
    expect(jar.headerFor("http://idp.wework.com/authorize")).toBe("");
    expect(jar.headerFor("https://members.wework.com/")).toBe("");
  });

  it("strips a leading dot from the domain", () => {
    const jar = new CookieJar();
    jar.seed({ name: "a", value: "1", domain: ".wework.com", hostOnly: false });
    expect(jar.headerFor("https://idp.wework.com/")).toBe("a=1");
  });
});

describe("describe() and clear()", () => {
  it("reports identity triples without values, so a jar can be logged safely", () => {
    const jar = new CookieJar();
    jar.addFromResponse(IDP, withCookies("secret=SHOULD-NOT-APPEAR; Path=/u/login"));
    const described = jar.describe();
    expect(described).toEqual(["idp.wework.com/u/login secret"]);
    expect(described.join()).not.toContain("SHOULD-NOT-APPEAR");
  });

  it("clear() empties the jar", () => {
    const jar = new CookieJar();
    jar.addFromResponse(IDP, withCookies("a=1; Path=/"));
    jar.clear();
    expect(jar.size).toBe(0);
  });
});

describe("matching primitives", () => {
  it("defaultPath", () => {
    expect(defaultPath("/u/login/identifier")).toBe("/u/login");
    expect(defaultPath("/authorize")).toBe("/");
    expect(defaultPath("/")).toBe("/");
    expect(defaultPath("relative")).toBe("/");
  });

  it("domainMatches", () => {
    expect(domainMatches("idp.wework.com", "idp.wework.com", true)).toBe(true);
    expect(domainMatches("a.idp.wework.com", "idp.wework.com", true)).toBe(false);
    expect(domainMatches("a.idp.wework.com", "idp.wework.com", false)).toBe(true);
    expect(domainMatches("notidp.wework.com", "idp.wework.com", false)).toBe(false);
  });

  it("pathMatches", () => {
    expect(pathMatches("/u/login", "/u/login")).toBe(true);
    expect(pathMatches("/u/login/x", "/u/login")).toBe(true);
    expect(pathMatches("/u/loginx", "/u/login")).toBe(false);
    expect(pathMatches("/anything", "/")).toBe(true);
  });
});
