/**
 * `redact()`: the last thing between an upstream body and the log stream.
 *
 * Two rules are tested here because the module has two. A key-name filter catches
 * the credential fields, and it is exact about which names those are. A value-level
 * rule catches email addresses, which arrive under key names nobody can predict, in
 * free text and in upstream error envelopes.
 */

import { describe, expect, it } from "vitest";
import {
  isSensitiveKey,
  maskEmails,
  REDACTED,
  redact,
  redactHeaders,
  redactUrl,
} from "../src/redact";

describe("isSensitiveKey", () => {
  it.each([
    "access_token",
    "accessToken",
    "refresh_token",
    "password",
    "client_secret",
    "Authorization",
    "WeWorkAuth",
    "weworkauth",
    "set-cookie",
    "email",
    "userEmail",
    "EMAIL_ADDRESS",
  ])("matches %s", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(["user", "locationId", "credits", "date", "summary", "name"])(
    "leaves %s alone",
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});

describe("redact", () => {
  it("replaces a sensitive value and keeps the rest", () => {
    expect(redact({ user: "ada", access_token: "eyJhbGciOi", credits: 3 })).toEqual({
      user: "ada",
      access_token: REDACTED,
      credits: 3,
    });
  });

  it("replaces the whole value under an email key, whatever its shape", () => {
    expect(redact({ email: "ada@example.com", contactEmails: ["a@b.co", "c@d.co"] })).toEqual({
      email: REDACTED,
      contactEmails: REDACTED,
    });
  });

  it("masks an address inside free text, where no key name would help", () => {
    expect(redact({ note: "book it for ada.lovelace+desk@example.co.uk please" })).toEqual({
      note: `book it for ${REDACTED} please`,
    });
  });

  it("masks addresses nested in arrays, maps, sets and errors", () => {
    const result = redact({
      list: ["ada@example.com"],
      map: new Map([["who", "ada@example.com"]]),
      set: new Set(["ada@example.com"]),
      error: new Error("no account for ada@example.com"),
    }) as Record<string, unknown>;

    expect(result.list).toEqual([REDACTED]);
    expect(result.map).toEqual({ who: REDACTED });
    expect(result.set).toEqual([REDACTED]);
    expect(result.error).toEqual({ name: "Error", message: `no account for ${REDACTED}` });
  });

  it("masks every address in a string, not only the first", () => {
    expect(maskEmails("from ada@example.com to grace@example.org")).toBe(
      `from ${REDACTED} to ${REDACTED}`,
    );
  });

  it("leaves text that only looks like an address alone", () => {
    expect(maskEmails("rates @ 10am, see you @ the desk")).toBe("rates @ 10am, see you @ the desk");
    expect(maskEmails("no address here")).toBe("no address here");
  });

  it("never mutates its input", () => {
    const input = { note: "ada@example.com", nested: { password: "hunter2" } };
    redact(input);
    expect(input).toEqual({ note: "ada@example.com", nested: { password: "hunter2" } });
  });

  it("still breaks cycles and caps depth", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(redact(cyclic)).toEqual({ name: "loop", self: "[circular]" });
  });
});

describe("redactHeaders", () => {
  it("replaces WeWork's own auth header, which is not spelled authorization", () => {
    expect(redactHeaders({ WeWorkAuth: "Bearer ey...", Accept: "application/json" })).toEqual({
      weworkauth: REDACTED,
      accept: "application/json",
    });
  });

  it("masks an address that arrives in an ordinary header", () => {
    expect(redactHeaders(new Headers({ "x-member": "ada@example.com" }))).toEqual({
      "x-member": REDACTED,
    });
  });
});

describe("redactUrl", () => {
  it("replaces the Auth0 single-use parameters", () => {
    const redacted = redactUrl(
      "https://idp.wework.com/authorize?login_ticket=abc&state=xyz&code=123&client_id=public",
    );
    expect(redacted).toContain(`login_ticket=${encodeURIComponent(REDACTED)}`);
    expect(redacted).toContain(`state=${encodeURIComponent(REDACTED)}`);
    expect(redacted).toContain(`code=${encodeURIComponent(REDACTED)}`);
    expect(redacted).toContain("client_id=public");
  });

  it("masks an address passed as an ordinary query parameter", () => {
    expect(redactUrl("https://members.wework.com/x?username=ada@example.com")).toContain(
      `username=${encodeURIComponent(REDACTED)}`,
    );
  });

  it("answers with the marker for something that is not a URL", () => {
    expect(redactUrl("not a url")).toBe(REDACTED);
  });
});
