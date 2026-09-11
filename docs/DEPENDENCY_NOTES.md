# Dependency notes

Exactly what the pinned libraries export and expect, read out of their own `.d.ts`
files in this repository's `node_modules` on 2026-09-11. Written for the engineers
building the MCP, OAuth, HTTP and session modules so nobody has to re-derive a
signature from a blog post.

Re-verify with `npm run typecheck` after any dependency bump; every snippet below
was compiled against the installed versions before being written down.

## Installed versions

| Package | Installed | Notes |
| --- | --- | --- |
| `hono` | 4.13.7 | router |
| `zod` | 4.6.2 | tool schemas; `z.toJSONSchema()` for OpenAPI |
| `agents` | 0.23.0 | `createMcpHandler` |
| `@modelcontextprotocol/server` | 2.0.0 | `McpServer`; pinned exactly, see peers below |
| `@modelcontextprotocol/client` | 2.0.0 | non-optional peer of `agents` |
| `@modelcontextprotocol/sdk` | 1.30.0 | non-optional peer of `agents` |
| `@cloudflare/workers-oauth-provider` | 0.10.3 | needs the `OAUTH_KV` binding |
| `wrangler` | 4.131.0 | dev |
| `typescript` | 5.9.3 | dev, see deviation note |
| `vitest` | 4.1.11 | dev, must stay on 4.x for the pool |
| `@cloudflare/vitest-pool-workers` | 0.22.0 | dev |
| `@biomejs/biome` | 2.5.13 | dev |
| `@cloudflare/workers-types` | 5.20260911.1 | dev, runtime types also come from `wrangler types` |

### `agents` peer dependencies

`npm view agents peerDependenciesMeta` marks `ai`, `chat`, `vite`, `react`,
`@x402/evm`, `@x402/core`, `just-bash`, `@tanstack/ai`, `@ai-sdk/react` and
`@cloudflare/codemode` **optional**. The four peers that are **not** optional, and
are therefore installed as direct dependencies:

- `zod@^4.0.0`
- `@modelcontextprotocol/sdk@1.30.0` (exact)
- `@modelcontextprotocol/client@2.0.0` (exact)
- `@modelcontextprotocol/server@2.0.0` (exact)

The three MCP peers are pinned without a caret in `package.json` because `agents`
requires those exact versions; a caret would let `npm update` break the peer graph.

### npm version caveat

`npm install` fails with `TypeError: Cannot read properties of null (reading
'edgesOut')` on **npm 10.9.7** (the version bundled with Node 22.22) while building
the peer set for `vitest@4`. It is an Arborist bug, not a dependency conflict.
Install with npm 11:

```sh
npx -y npm@11 install
```

npm 11 does not run postinstall scripts by default, but nothing here needs them:
`esbuild` and `workerd` ship their binaries in platform-specific optional packages
(`@esbuild/linux-x64`, `@cloudflare/workerd-linux-64`) and both were verified
working (`workerd --version` → `workerd 2026-08-15`).

### Known audit findings

`npm audit` reports 4 high-severity advisories, all the same transitive path:
`@cloudflare/vitest-pool-workers` → `miniflare` → `sharp` (libheif CVEs in
`sharp`'s image-resizing path). `sharp` is a **dev-only** dependency of the test
pool and is never bundled into the Worker; the only "fix" npm offers is downgrading
the pool to 0.8.x, which does not support vitest 4. Left as-is deliberately.

## MCP: `agents/mcp/server`

Source: `node_modules/agents/dist/mcp/server/index.d.ts` and
`node_modules/agents/dist/handler-stateless-DxYpJ_XF.d.ts`.

The module is a thin re-export of the *stateless* handler, under the names the
Cloudflare docs use:

```ts
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import type {
  CreateMcpHandlerOptions,   // alias of CreateStatelessMcpHandlerOptions
  McpAuthContext,
  StatelessMcpHandler,
  StatelessMcpServerInput,   // = McpServerFactory
} from "agents/mcp/server";
```

Signature:

```ts
declare function createMcpHandler(
  factory: McpServerFactory,
  options?: CreateStatelessMcpHandlerOptions,
): StatelessMcpHandler;
```

### `CreateStatelessMcpHandlerOptions`

Extends `Omit<CreateMcpHandlerOptions, "bus">` from `@modelcontextprotocol/server`
and adds the Worker-specific options:

| Option | Type | Default / meaning |
| --- | --- | --- |
| `route` | `string` | `"/mcp"`. The exact pathname this wrapper serves. |
| `corsOptions` | `CORSOptions \| false` | CORS headers the wrapper adds; `false` disables. |
| `allowedHostnames` | `string[]` | Restricts the `Host` header. Localhost and `workers.dev` get defaults; **a custom domain needs this set explicitly.** |
| `allowedOriginHostnames` | `string[] \| "*"` | Restricts a present browser `Origin`. Requests with no `Origin` (normal MCP clients) always pass. |
| `authContext` | `McpAuthContext` | **How auth reaches the tools.** See below. |

Inherited from `CreateMcpHandlerOptions`: `legacy?: "stateless" \| "reject"`
(default `"stateless"`, 2025-era requests get a fresh per-request instance, and
`GET`/`DELETE` answer `405`), `onerror?: (error: Error) => void`,
`responseMode?: "auto" \| "sse" \| "json"` (default `"auto"`),
`maxSubscriptions?: number` (1024), `keepAliveMs?: number` (15000). `bus` is
omitted by the Workers wrapper.

### How the auth context is passed

Two halves, and they must match:

1. **In**: build the handler *per request* with the resolved `Actor` in
   `options.authContext.props`. `McpAuthContext` is exactly
   `{ props: Record<string, unknown> }`.
2. **Out**: inside a tool callback, call `getMcpAuthContext()`, a zero-argument
   function returning `McpAuthContext | undefined` from async-local storage.

```ts
// src/mcp/server.ts, sketch
const handler = createMcpHandler(
  (ctx) => createServer(ctx),           // fresh McpServer per request
  {
    route: "/mcp",
    authContext: { props: { ...actor } },  // actor from src/auth/guard.ts
  },
);
return handler.fetch(request);
```

Because the handler is cheap and stateless, constructing it per request (to inject
a per-request `authContext`) is the intended pattern. Alternatively close over the
`Actor` in the factory and ignore `getMcpAuthContext()` entirely, the factory
receives `ctx.authInfo` and `ctx.requestInfo` too (see below).

`StatelessMcpHandler` is callable three ways:

```ts
type StatelessMcpHandler = {
  (request: Request, env: unknown, ctx: ExecutionContext): Promise<Response>;
  fetch(request: Request, options?: McpHandlerRequestOptions): Promise<Response>;
  notify: ServerNotifier;
};
// McpHandlerRequestOptions = { authInfo?: AuthInfo; parsedBody?: unknown }
```

From Hono, use `handler.fetch(c.req.raw)`, `parsedBody` is only needed when a
framework already consumed the body.

## MCP: `@modelcontextprotocol/server` 2.0.0

Exports used here: `McpServer`, `McpServerFactory`, `CreateMcpHandlerOptions`,
`createMcpHandler`, `ToolAnnotations`, `CallToolResult`,
`WebStandardStreamableHTTPServerTransport`.

### The factory

```ts
type McpServerFactory = (ctx: McpRequestContext) => McpServer | Server | Promise<McpServer | Server>;

interface McpRequestContext {
  era: "legacy" | "modern";   // "modern" = protocol 2026-07-28
  authInfo?: AuthInfo;        // pass-through only; never parsed from headers by the handler
  requestInfo?: Request;      // the original HTTP request
}
```

One instance per request. Do not cache an `McpServer` in module scope.

### Constructor

```ts
new McpServer(serverInfo: Implementation, options?: ServerOptions)
// Implementation: { name, version, title?, ... }
// ServerOptions.instructions?: string  ← the disclaimer + "search, then confirm" text goes here
```

### `registerTool`

Two overloads; **use the first** (the raw-shape form is deprecated):

```ts
registerTool<
  OutputArgs extends StandardSchemaWithJSON,
  InputArgs extends StandardSchemaWithJSON | undefined = undefined,
>(
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema?: InputArgs;      // a whole z.object({...}), NOT a raw shape
    outputSchema?: OutputArgs;
    annotations?: ToolAnnotations; // { readOnlyHint, destructiveHint, idempotentHint, openWorldHint, title }
    icons?: Icon[];
    _meta?: Record<string, unknown>;
  },
  cb: ToolCallback<InputArgs>,
): RegisteredTool;
```

The callback is `(args, ctx: ServerContext) => CallToolResult | InputRequiredResult`
(or a promise of one). `args` is the parsed output of `inputSchema`; when there is no
`inputSchema`, the callback takes `(ctx)` only.

```ts
server.registerTool(
  "search_availability",
  {
    title: "Search desk availability",
    description: "…",
    inputSchema: z.object({ date: z.string(), city: z.string().optional() }),
    outputSchema: z.object({ results: z.array(z.unknown()) }),
    annotations: { readOnlyHint: true },
  },
  async (args) => ({
    content: [{ type: "text", text: summary }],
    structuredContent: { results },
  }),
);
```

`ServerContext` carries `sessionId?`, `mcpReq` (`id`, `method`, `_meta`, plus
deprecated `log` / `elicitInput` / `requestSampling`) and `http?` with
`req?: Request`, `authInfo?: AuthInfo`, `closeSSE?`, `closeStandaloneSSE?`.
Note that `z.object({})` (an empty object) is accepted as `inputSchema` for
no-argument tools, and is friendlier to clients than omitting it.

### Fallback transport (if `agents` ever has to go)

The web-standard streamable HTTP transport **does** exist, exported as
`WebStandardStreamableHTTPServerTransport` (options type
`WebStandardStreamableHTTPServerTransportOptions`; the stateless idiom is
`{ sessionIdGenerator: undefined }`). Its `handleRequest(req: Request, options?:
HandleRequestOptions): Promise<Response>` is Fetch-API-shaped, so it mounts in Hono
directly. `@modelcontextprotocol/server` also exports its *own*
`createMcpHandler(factory, options): McpHttpHandler`, a `{ fetch, close, notify,
bus }` object, which is what `agents` wraps. Either is a drop-in escape hatch; the
only thing lost is `getMcpAuthContext()` and the Host/Origin guards, which would
then be our own middleware's job.

**Decision: we use `agents@0.23`'s `createMcpHandler`.** It typechecks against the
installed versions (verified) and adds the Host/Origin validation we would
otherwise hand-roll.

## OAuth: `@cloudflare/workers-oauth-provider` 0.10.3

Source: `node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.d.ts`
and that package's `README.md`.

```ts
import OAuthProvider, {
  AuthorizationError,
  type AuthRequest,
  type OAuthHelpers,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
```

`OAuthProvider` is both the default and a named export. `new OAuthProvider<Env>(options)`
produces the object you `export default`, it *replaces* the Hono app as the entry
point and delegates to it.

### Constructor options (the ones that matter here)

```ts
interface OAuthProviderOptions<Env = Cloudflare.Env> {
  // Routing
  apiRoute?: string | string[];        // e.g. ["/mcp", "/api/"], prefixes the provider protects
  apiHandler?: ExportedHandlerWithFetch<Env>
            | (new (ctx: ExecutionContext, env: Env) => WorkerEntrypointWithFetch<Env>);
  apiHandlers?: Record<string, …>;     // use instead of apiHandler for per-prefix handlers
  defaultHandler: ExportedHandler<Env> | (new (…) => WorkerEntrypointWithFetch<Env>);  // required

  // Endpoints
  authorizeEndpoint: string;           // required, e.g. "/oauth/authorize"
  tokenEndpoint: string;               // required, e.g. "/oauth/token"
  clientRegistrationEndpoint?: string; // optional DCR, e.g. "/oauth/register"

  // Lifetimes and policy
  accessTokenTTL?: number; refreshTokenTTL?: number; clientRegistrationTTL?: number;
  scopesSupported?: string[];
  allowImplicitFlow?: boolean; allowPlainPKCE?: boolean; allowTokenExchangeGrant?: boolean;
  disallowPublicClientRegistration?: boolean;
  clientIdMetadataDocumentEnabled?: boolean;  // CIMD; also needs `global_fetch_strictly_public` in wrangler.jsonc
  resourceMatchOriginOnly?: boolean;

  // RFC 9728 metadata served at /.well-known/oauth-protected-resource
  resourceMetadata?: {
    resource?: string;                 // pins grant + access-token audience to this exact URI
    authorization_servers?: string[];
    scopes_supported?: string[];
    bearer_methods_supported?: string[];
    resource_name?: string;
  };

  // Callbacks
  clientRegistrationCallback?(options: ClientRegistrationCallbackOptions): …;
  tokenExchangeCallback?(options: TokenExchangeCallbackOptions): …;   // can rewrite props/scope/TTL
  resolveExternalToken?(input: ResolveExternalTokenInput<Env>): Promise<ResolveExternalTokenResult | null>;
  onError?(error: { code; description; status; headers; internal?; request? }): Response | void;
}
```

`resolveExternalToken` is worth knowing about: it is the library's official seam for
accepting a **non-OAuth** credential on a protected route and returning
`{ props, audience }`. That is an alternative to our own static-bearer guard ,
evaluate it, but the hand-rolled guard in `src/auth/guard.ts` stays the plan because
it must also answer 401 with the `WWW-Authenticate: Bearer resource_metadata=…`
challenge MCP clients need.

### `OAUTH_PROVIDER` binding and `completeAuthorization`

The provider injects a helper object into the env as `OAUTH_PROVIDER`
(`env.OAUTH_PROVIDER: OAuthHelpers`). Declare it on `Env`; there is no binding in
`wrangler.jsonc` for it.

The authorize page flow, in `defaultHandler`:

```ts
let oauthRequest: AuthRequest;
try {
  oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
} catch (error) {
  if (!(error instanceof AuthorizationError)) throw error;
  // error.redirectUri / .code / .description / .state / .issuer
  // No redirectUri ⇒ render the error locally with status 400.
}

const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId); // ClientInfo | null
// …render the HTML form, check ADMIN_PASSWORD, let the operator approve…

const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
  request: oauthRequest,          // AuthRequest, required
  userId: "admin",                // string, required
  metadata: { clientName: client.clientName },  // any, shown in grant listings
  scope: grantedScopes,           // string[], the scopes actually granted
  props: { kind: "oauth", name: "admin", scopes: grantedScopes, accountId: "default" },
  // revokeExistingGrants?: boolean; revokeExistingGrantsBatchSize?: number;
});
return Response.redirect(redirectTo, 302);
```

`completeAuthorization` returns `Promise<{ redirectTo: string }>`. It throws if the
response type is not permitted, and `CimdFetchError` when a CIMD client id cannot be
resolved.

Other `OAuthHelpers` methods available for `/admin`: `createClient`, `listClients`,
`updateClient`, plus grant/token listing and `purge`.

### Reading props in the `apiHandler`

The provider validates the bearer token, checks its audience, and exposes the
decrypted `props` as **`ctx.props`** on the execution context of the protected
handler. The handler performs no token parsing of its own, but it *must* still
enforce scope, because the provider does not.

```ts
// Class form (recommended, typed props):
class ApiHandler extends WorkerEntrypoint<Env, ActorProps> {
  fetch(request: Request): Response | Promise<Response> {
    const actor = this.ctx.props;   // ActorProps
    …
  }
}

// Plain-object form: the props arrive on the third argument.
const apiHandler: ExportedHandler<Env> = {
  fetch(request, env, ctx) {
    const actor = (ctx as ExecutionContext & { props: ActorProps }).props;
    …
  },
};
```

`props` are encrypted with AES-GCM, keyed by material wrapped in the token itself,
so a leaked KV dump does not reveal them. `tokenExchangeCallback` can rewrite them
on refresh (`accessTokenProps` for this token only, `newProps` for the grant).

Requests *outside* every `apiRoute` prefix go to `defaultHandler`, which is where
our Hono app (`/healthz`, `/admin/*`, the authorize page) lives.

## Tests: `@cloudflare/vitest-pool-workers` 0.22.0

**The import path in the spec does not exist in this version.** There is no
`@cloudflare/vitest-pool-workers/config` subpath and no `defineWorkersConfig` /
`defineWorkersProject` export. 0.22.0 exports exactly three subpaths ,
`.`, `./types` and `./codemods/vitest-v3-to-v4`, and the pool is wired up as a
**Vite plugin** from the package root:

```ts
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { … } } })],
  test: { include: ["test/**/*.test.ts"] },
});
```

`cloudflareTest(options | (ctx) => options): Vite.Plugin`. The options schema is
`{ main?, remoteBindings?, verbose?, additionalExports?, miniflare?, wrangler? }` ,
note there is no `isolatedStorage` or `singleWorker` key any more. `cloudflarePool`
(a `PoolRunnerInitializer`) is the lower-level alternative.

Types: add `"@cloudflare/vitest-pool-workers/types"` to `compilerOptions.types` ,
**not** the bare package name, which has no ambient types. In 0.22 `env` from
`cloudflare:test` is typed as **`Cloudflare.Env`**, not the old `ProvidedEnv`
interface, so extra test-only bindings are declared by augmenting
`declare global { namespace Cloudflare { interface Env { … } } }`. That augmentation
lives in `src/env.ts`, next to the `Env` interface it mirrors.

The pool **does** start in this sandbox (`workerd 2026-08-15`); all scaffold tests
pass under it, so no plain-node fallback project was needed. If workerd ever fails
to start on a contributor's machine, add a second project to `defineConfig` with
`environment: "node"` restricted to the pure-unit files (`quote`, `time`,
`mappers`, `tokens`, `redact`), they take no bindings.

## TypeScript version

`typescript@7.0.2` is the current latest, but this repo pins **`typescript@^5.9`**
(5.9.3 installed). TS 7 is the native-port release line; Biome 2.5 and the
`@cloudflare/vitest-pool-workers` 0.22 type surface are only tested against 5.x, and
the spec explicitly permits 5.9 when TS 7 risks tooling trouble. Revisit once the
Cloudflare and Biome toolchains declare TS 7 support.
