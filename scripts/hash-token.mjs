#!/usr/bin/env node
// Generate a static bearer token for weworking and print the AUTH_TOKENS entry for it.
//
// The Worker stores only the SHA-256 hash, so the plaintext token is shown exactly once,
// here, and cannot be recovered afterwards. Copy it into your client config now.
//
// Usage:
//   node scripts/hash-token.mjs --name claude-code --scopes read,write
//   node scripts/hash-token.mjs --name dashboard --scopes read
//   node scripts/hash-token.mjs claude-code read write      (positional form)
//   node scripts/hash-token.mjs --name ci --scopes read --token <existing-token>
//   node scripts/hash-token.mjs --name admin --scopes read,write,admin --json
//
// Then merge the printed object into the AUTH_TOKENS JSON array and push it:
//   npx wrangler secret put AUTH_TOKENS

import { Buffer } from "node:buffer";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const VALID_SCOPES = ["read", "write", "admin"];

function parseArgs(argv) {
  const out = { name: undefined, scopes: undefined, token: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) fail(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "--name":
      case "-n":
        out.name = take();
        break;
      case "--scopes":
      case "-s":
        out.scopes = take();
        break;
      case "--token":
      case "-t":
        out.token = take();
        break;
      case "--json":
        out.json = true;
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
        break;
      default: {
        if (arg.startsWith("-")) fail(`unknown flag ${arg}`);
        // Positional form, as referenced in .dev.vars.example:
        //   node scripts/hash-token.mjs claude-code read write
        if (out.name === undefined) out.name = arg;
        else out.scopes = out.scopes ? `${out.scopes},${arg}` : arg;
      }
    }
  }
  return out;
}

function usage() {
  process.stdout.write(
    [
      "Usage: node scripts/hash-token.mjs --name <client> [--scopes read,write] [--token <token>] [--json]",
      "       node scripts/hash-token.mjs <client> [scope ...]",
      "",
      "  --name, -n     Label for this token, as it appears in the audit log. Required.",
      "  --scopes, -s   Comma-separated scopes from: read, write, admin. Default: read.",
      "  --token, -t    Hash an existing token instead of generating a new one.",
      "  --json         Print only the JSON entry (no token, no instructions).",
      "",
    ].join("\n"),
  );
}

function fail(msg) {
  process.stderr.write(`hash-token: ${msg}\n\n`);
  usage();
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

if (!args.name) fail("--name is required");
if (!/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,63}$/.test(args.name)) {
  fail("--name must be 1-64 chars of letters, digits, space, dot, underscore or hyphen");
}

const scopes = (args.scopes ?? "read")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

if (scopes.length === 0) fail("--scopes must list at least one scope");
for (const scope of scopes) {
  if (!VALID_SCOPES.includes(scope)) {
    fail(`unknown scope "${scope}" (valid: ${VALID_SCOPES.join(", ")})`);
  }
}
const uniqueScopes = VALID_SCOPES.filter((s) => scopes.includes(s));

// 32 random bytes, base64url. Generated, not derived from the name, so two tokens with
// the same label are still distinct.
const generated = args.token === undefined;
const token = args.token ?? randomBytes(32).toString("base64url");

if (!generated && token.length < 16) {
  fail("--token looks too short to be a credential (need at least 16 chars)");
}

const sha256 = createHash("sha256").update(token, "utf8").digest("hex");

// Sanity check: the Worker compares hashes in constant time, so make sure ours is the
// shape it expects (64 lowercase hex chars) before telling the user to paste it.
const expected = createHash("sha256").update(token, "utf8").digest();
if (!timingSafeEqual(Buffer.from(sha256, "hex"), expected)) {
  process.stderr.write("hash-token: internal hash mismatch, refusing to print\n");
  process.exit(1);
}

const entry = { name: args.name, sha256, scopes: uniqueScopes };

if (args.json) {
  process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
  if (generated) {
    // Still has to go somewhere, or the token is useless. stderr keeps stdout clean
    // for `--json | jq`.
    process.stderr.write(`token: ${token}\n`);
  }
  process.exit(0);
}

const lines = [];
if (generated) {
  lines.push(
    "",
    "  Token (shown once - copy it now, it is not recoverable):",
    "",
    `    ${token}`,
    "",
  );
} else {
  lines.push("", "  Hashed the token you supplied. It is not stored here.", "");
}
lines.push(
  "  AUTH_TOKENS entry - merge this into the existing JSON array:",
  "",
  ...JSON.stringify(entry, null, 2)
    .split("\n")
    .map((l) => `    ${l}`),
  "",
  "  Then push the complete array:",
  "",
  "    npx wrangler secret put AUTH_TOKENS",
  "",
  "  Use it from a client:",
  "",
  `    Authorization: Bearer ${generated ? token : "<your token>"}`,
  "",
);
if (uniqueScopes.includes("write")) {
  lines.push(
    "  This token can book and cancel desks, spending real credits, within the",
    "  MAX_BOOKINGS_PER_DAY / MAX_BOOKINGS_PER_WEEK caps. Use --scopes read for",
    "  anything that does not need to book.",
    "",
  );
}
if (uniqueScopes.includes("admin")) {
  lines.push(
    "  This token can read the audit log and replace the stored WeWork session.",
    "  Issue it only to something you control directly.",
    "",
  );
}
process.stdout.write(`${lines.join("\n")}\n`);
