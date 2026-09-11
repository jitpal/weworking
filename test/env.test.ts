/**
 * `parseConfig`: the one place a `vars` string becomes a number the rest of the
 * codebase trusts.
 *
 * The money caps get the most attention here because they are the only
 * configuration that bounds spending: a var that silently parses to the wrong
 * number is a cap that is not there.
 */

import { describe, expect, it } from "vitest";
import { type Env, parseConfig } from "../src/env";
import { isAppError } from "../src/errors";
import { fakeEnv } from "./auth/helpers";

/** `fakeEnv` with the given vars replaced. */
function envWith(overrides: Record<string, string>): Env {
  return fakeEnv(overrides);
}

/** The `code` of the `AppError` `parseConfig` throws, or "" when it did not throw. */
function codeOf(env: Env): string {
  try {
    parseConfig(env);
  } catch (error) {
    if (!isAppError(error)) throw error;
    return error.code;
  }
  return "";
}

describe("MAX_CASH_PER_BOOKING", () => {
  it("defaults to 0, which refuses every booking with a cash price", () => {
    const env = envWith({});
    delete (env as unknown as Record<string, unknown>).MAX_CASH_PER_BOOKING;
    expect(parseConfig(env).maxCashPerBooking).toBe(0);
  });

  it.each(["unlimited", "none", "-1", "UNLIMITED", "  none  "])(
    "treats %s as no limit",
    (value) => {
      expect(parseConfig(envWith({ MAX_CASH_PER_BOOKING: value })).maxCashPerBooking).toBe(-1);
    },
  );

  it("keeps decimals, because a day rate is rarely a round number", () => {
    expect(parseConfig(envWith({ MAX_CASH_PER_BOOKING: "84.50" })).maxCashPerBooking).toBe(84.5);
    expect(parseConfig(envWith({ MAX_CASH_PER_BOOKING: "0" })).maxCashPerBooking).toBe(0);
    expect(parseConfig(envWith({ MAX_CASH_PER_BOOKING: " 12 " })).maxCashPerBooking).toBe(12);
  });

  it.each(["-5", "lots", "1e3", "84,50", ""])("rejects %s", (value) => {
    expect(codeOf(envWith({ MAX_CASH_PER_BOOKING: value }))).toBe("VALIDATION");
  });

  it("rejects an amount past the sanity ceiling", () => {
    expect(codeOf(envWith({ MAX_CASH_PER_BOOKING: "1000001" }))).toBe("VALIDATION");
  });

  it("never names the value of a secret in the message", () => {
    try {
      parseConfig(envWith({ MAX_CASH_PER_BOOKING: "nope" }));
      throw new Error("expected a rejection");
    } catch (error) {
      if (!isAppError(error)) throw error;
      expect(error.message).toContain("MAX_CASH_PER_BOOKING");
      expect(error.message).not.toContain("nope");
    }
  });
});

describe("MAX_CREDITS_PER_BOOKING", () => {
  it("keeps its own spellings for no limit, and stays an integer", () => {
    expect(
      parseConfig(envWith({ MAX_CREDITS_PER_BOOKING: "unlimited" })).maxCreditsPerBooking,
    ).toBe(-1);
    expect(parseConfig(envWith({ MAX_CREDITS_PER_BOOKING: "12" })).maxCreditsPerBooking).toBe(12);
    expect(codeOf(envWith({ MAX_CREDITS_PER_BOOKING: "1.5" }))).toBe("VALIDATION");
  });
});

describe("the two money caps are independent", () => {
  it("parses one as unlimited and the other as zero", () => {
    const config = parseConfig(
      envWith({ MAX_CREDITS_PER_BOOKING: "unlimited", MAX_CASH_PER_BOOKING: "0" }),
    );
    expect(config).toMatchObject({ maxCreditsPerBooking: -1, maxCashPerBooking: 0 });
  });
});
