#!/usr/bin/env node
/**
 * Runs wrangler with `wrangler.local.jsonc` when that file exists, otherwise
 * with the committed `wrangler.jsonc`.
 *
 * The committed config binds its KV namespace without an id so anyone can
 * self-host from it (the first deploy creates one). Copy it to
 * `wrangler.local.jsonc` (gitignored), let the first deploy fill in the KV namespace
 * id and anything else specific to your account, and `npm run deploy` picks it
 * up. Pass `-c <file>` yourself to override either.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const hasConfigFlag = args.some((a) => a === "-c" || a === "--config" || a.startsWith("--config="));
const local = resolve("wrangler.local.jsonc");
const configArgs = !hasConfigFlag && existsSync(local) ? ["-c", "wrangler.local.jsonc"] : [];

const result = spawnSync("npx", ["wrangler", ...args, ...configArgs], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
