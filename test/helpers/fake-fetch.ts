/**
 * A route-table `fetch` stub.
 *
 * Tests must never reach the real network: WeWork would rate-limit us, Auth0 would
 * block the datacenter IP, and the results would not be reproducible. Every module
 * that talks upstream takes `fetch` as an injected dependency, so a test passes one of these
 * instead.
 *
 * @example
 * const fetchStub = createFakeFetch([
 *   {
 *     method: "GET",
 *     url: /\/spaces\/get-spaces/,
 *     response: () => Response.json(spacesFixture),
 *   },
 *   {
 *     method: "POST",
 *     url: "https://members.wework.com/workplaceone/api/common-booking/",
 *     times: 1,
 *     response: async (req) => {
 *       expect((await req.json()).SpaceID).toBe("kube-1");
 *       return Response.json({ BookingStatus: "BookingSuccess", ReservationID: "r1" });
 *     },
 *   },
 * ]);
 *
 * const deps = { ...baseDeps, fetch: fetchStub };
 * // ... exercise the unit ...
 * fetchStub.assertAllConsumed();
 */

/** How a route's URL is matched: exact string (after normalisation) or a regular expression. */
export type UrlMatcher = string | RegExp;

/** One entry in the route table. Routes are matched in declaration order. */
export interface FakeRoute {
  /** HTTP method to match, case-insensitive. Omit to match any method. */
  method?: string;
  /**
   * A string matches when it equals the full request URL, or when it equals the
   * URL with the query string removed (so you can ignore query parameters).
   * A RegExp is tested against the full URL.
   */
  url: UrlMatcher;
  /** Builds the response. Receives the actual `Request`, so it can assert on body and headers. */
  response: (request: Request) => Response | Promise<Response>;
  /**
   * How many times this route may be used. Once exhausted it is skipped and
   * matching continues with later routes. Defaults to unlimited.
   */
  times?: number;
}

/** A recorded call, for assertions after the fact. */
export interface RecordedCall {
  method: string;
  url: string;
  /** Header names lower-cased. Values are *not* redacted — this is test-only. */
  headers: Record<string, string>;
  /** The request body as text, or `undefined` when there was none. */
  body?: string;
  /** Index into the route table of the route that served this call. */
  routeIndex: number;
}

/** The stub returned by {@link createFakeFetch}: callable as `fetch`, plus assertions. */
export interface FakeFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Every call made, in order. */
  readonly calls: RecordedCall[];
  /** Calls whose URL matches, for targeted assertions. */
  callsMatching(url: UrlMatcher, method?: string): RecordedCall[];
  /**
   * Throws when any route that declared `times` has remaining uses — i.e. an
   * expected upstream call never happened. Call it at the end of a test.
   */
  assertAllConsumed(): void;
  /** Clears recorded calls and restores every route's `times` budget. */
  reset(): void;
}

/**
 * Builds a `fetch` stub from a route table.
 *
 * An unmatched request throws rather than returning a 404, because a silent 404 in a
 * test usually means the code under test called an endpoint nobody expected — which
 * is exactly the bug you want surfaced.
 */
export function createFakeFetch(routes: FakeRoute[]): FakeFetch {
  const calls: RecordedCall[] = [];
  const remaining = new Map<number, number>();

  const resetBudgets = () => {
    remaining.clear();
    routes.forEach((route, index) => {
      if (route.times !== undefined) remaining.set(index, route.times);
    });
  };
  resetBudgets();

  const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as RequestInfo, init);
    const url = request.url;
    const method = request.method.toUpperCase();

    for (let index = 0; index < routes.length; index += 1) {
      const route = routes[index];
      if (!route) continue;
      if (route.method && route.method.toUpperCase() !== method) continue;
      if (!matchesUrl(route.url, url)) continue;
      if (remaining.has(index)) {
        const left = remaining.get(index) ?? 0;
        if (left <= 0) continue;
        remaining.set(index, left - 1);
      }

      // Clone before handing the request to the route so the recorded body and the
      // route handler can both read it.
      const recorded = request.clone();
      const body = method === "GET" || method === "HEAD" ? undefined : await recorded.text();
      const call: RecordedCall = {
        method,
        url,
        headers: Object.fromEntries(request.headers.entries()),
        routeIndex: index,
      };
      if (body !== undefined) call.body = body;
      calls.push(call);

      return await route.response(request);
    }

    throw new Error(
      `fake-fetch: no route matched ${method} ${url}.\nDeclared routes:\n${routes
        .map((r, i) => `  [${i}] ${r.method ?? "ANY"} ${String(r.url)}`)
        .join("\n")}`,
    );
  };

  return Object.assign(fake, {
    calls,
    callsMatching(url: UrlMatcher, method?: string): RecordedCall[] {
      return calls.filter(
        (call) => matchesUrl(url, call.url) && (!method || method.toUpperCase() === call.method),
      );
    },
    assertAllConsumed(): void {
      const unconsumed: string[] = [];
      for (const [index, left] of remaining.entries()) {
        if (left > 0) {
          const route = routes[index];
          unconsumed.push(
            `  [${index}] ${route?.method ?? "ANY"} ${String(route?.url)} — ${left} expected call(s) never made`,
          );
        }
      }
      if (unconsumed.length > 0) {
        throw new Error(`fake-fetch: unconsumed routes:\n${unconsumed.join("\n")}`);
      }
    },
    reset(): void {
      calls.length = 0;
      resetBudgets();
    },
  }) as FakeFetch;
}

function matchesUrl(matcher: UrlMatcher, url: string): boolean {
  if (matcher instanceof RegExp) return matcher.test(url);
  if (matcher === url) return true;
  const withoutQuery = url.split("?")[0] ?? url;
  return matcher === withoutQuery;
}
