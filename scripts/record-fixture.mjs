#!/usr/bin/env node
//
// ============================================================================
//  MANUAL ONLY. This script talks to the LIVE WeWork API with a REAL session
//  token. It is never run by CI, never imported by the Worker, and never run
//  by the test suite. Tests read the files it produces, nothing more.
// ============================================================================
//
// Records one upstream response into test/fixtures/wework/<name>.json, with
// credentials and personal data redacted on the way in.
//
// You still have to read the output before committing it. Redaction here is a
// safety net, not a guarantee: upstream can put an email or a name in a field
// this script has never seen. See CONTRIBUTING.md ("Adding a fixture").
//
// Setup:
//   export WEWORK_TOKEN="<access token from members.wework.com>"
//     Get it from DevTools > Application > Local Storage > the @@auth0spajs@@
//     entry, or from the Authorization header of any workplaceone/api request.
//     It is valid for ~12 hours. Do not put it in your shell history file.
//
// Usage:
//   node scripts/record-fixture.mjs --name get-locations-london \
//     --path "/wework-yardi/ondemand/get-locations-by-geo?isAuthenticated=true&city=London&isOnDemandUser=false&isWeb=true"
//
//   node scripts/record-fixture.mjs --name get-spaces-london \
//     --path "/spaces/get-spaces?locationUUIDs=<uuid>&date=2026-09-21&duration=30&locationOffset=%2B01:00&type=0&capacity=0&offset=0&limit=50&isWeb=true" \
//     --redact-uuids
//
//   node scripts/record-fixture.mjs --name quote-desk --method POST \
//     --path "/common-booking/quote" --body ./quote-request.json --dry-run
//
// Read endpoints are safe. POSTing to /common-booking/ BOOKS A REAL DESK and
// spends real credits; this script refuses to do that without --i-know.
//
// Flags:
//   --name <n>        Fixture name (becomes test/fixtures/wework/<n>.json). Required.
//   --path <p>        Path under https://members.wework.com/workplaceone/api. Required.
//   --method <m>      GET (default) or POST.
//   --body <file>     JSON file to send as the POST body.
//   --uuid <uuid>     WeWorkUUID header. Defaults to the user_uuid claim in the token.
//   --redact-uuids    Replace every UUID consistently (00000001-0000-..., 00000002-...).
//                     Keeps cross-references intact. Recommended for anything public.
//   --keep-emails     Do NOT redact email addresses. Almost never what you want.
//   --dry-run         Print what would be requested, send nothing, write nothing.
//   --force           Overwrite an existing fixture file.
//   --i-know          Required to POST to a booking or cancel endpoint.

import { Buffer } from "node:buffer";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const FIXTURE_DIR = resolve(REPO, "test/fixtures/wework");
const BASE = "https://members.wework.com/workplaceone/api";

// Endpoints that change state. Recording these costs money.
const WRITE_PATHS = [/^\/common-booking\/?($|\?)/, /^\/common-booking\/cancel/];

function fail(msg) {
  process.stderr.write(`record-fixture: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {
    name: undefined,
    path: undefined,
    method: "GET",
    body: undefined,
    uuid: undefined,
    redactUuids: false,
    keepEmails: false,
    dryRun: false,
    force: false,
    iKnow: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) fail(`${a} needs a value`);
      return v;
    };
    if (a === "--name") out.name = take();
    else if (a === "--path") out.path = take();
    else if (a === "--method") out.method = take().toUpperCase();
    else if (a === "--body") out.body = take();
    else if (a === "--uuid") out.uuid = take();
    else if (a === "--redact-uuids") out.redactUuids = true;
    else if (a === "--keep-emails") out.keepEmails = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a === "--i-know") out.iKnow = true;
    else fail(`unknown argument ${a}`);
  }
  return out;
}

// --- redaction ---------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

// Field names whose values are always replaced, whatever they contain.
const SECRET_KEYS = new Set(
  [
    "access_token",
    "accesstoken",
    "refresh_token",
    "refreshtoken",
    "id_token",
    "idtoken",
    "authorization",
    "weworkauth",
    "cookie",
    "set-cookie",
    "password",
    "token",
    "bearer",
    "login_ticket",
    "code_verifier",
    "client_secret",
    "apikey",
    "api_key",
  ].map((k) => k.toLowerCase()),
);

// Field names that hold personal data we do not need in a fixture.
const PII_KEYS = new Set(
  [
    "email",
    "emailaddress",
    "primaryemail",
    "phone",
    "phonenumber",
    "mobile",
    "firstname",
    "lastname",
    "fullname",
    "displayname",
    "username",
    "companyname",
    "organizationname",
  ].map((k) => k.toLowerCase()),
);

function makeRedactor({ redactUuids, keepEmails }) {
  const uuidMap = new Map();
  const mapUuid = (u) => {
    const k = u.toLowerCase();
    if (!uuidMap.has(k)) {
      uuidMap.set(k, `${String(uuidMap.size + 1).padStart(8, "0")}-0000-4000-8000-000000000000`);
    }
    return uuidMap.get(k);
  };

  const scrubString = (s) => {
    let v = s.replace(JWT_RE, "REDACTED.JWT.VALUE");
    if (!keepEmails) v = v.replace(EMAIL_RE, "redacted@example.com");
    if (redactUuids) v = v.replace(UUID_RE, (m) => mapUuid(m));
    return v;
  };

  const walk = (value, keyPath = []) => {
    const key = keyPath.at(-1);
    const lowerKey = typeof key === "string" ? key.toLowerCase() : "";
    if (SECRET_KEYS.has(lowerKey)) return "REDACTED";
    if (PII_KEYS.has(lowerKey)) {
      if (typeof value === "string") {
        return lowerKey.includes("email") ? "redacted@example.com" : "REDACTED";
      }
      return value === null ? null : "REDACTED";
    }
    if (typeof value === "string") return scrubString(value);
    if (Array.isArray(value)) return value.map((v, i) => walk(v, [...keyPath, i]));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, [...keyPath, k]);
      return out;
    }
    return value;
  };

  return { walk, scrubString, uuidCount: () => uuidMap.size };
}

// Last-chance scan over the serialised fixture. If this trips, do not commit.
function leakCheck(text, { keepEmails }) {
  const problems = [];
  if (JWT_RE.test(text)) problems.push("a JWT-shaped string");
  if (/[Bb]earer [A-Za-z0-9._~+/-]{20,}/.test(text)) problems.push("a bearer token");
  if (!keepEmails && EMAIL_RE.test(text.replace(/redacted@example\.com/g, ""))) {
    problems.push("an email address");
  }
  JWT_RE.lastIndex = 0;
  EMAIL_RE.lastIndex = 0;
  return problems;
}

// --- main --------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));

if (!args.name) fail("--name is required");
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(args.name)) {
  fail("--name must be lowercase letters, digits and hyphens");
}
if (!args.path) fail("--path is required");
if (!args.path.startsWith("/")) fail("--path must start with /");
if (args.method !== "GET" && args.method !== "POST") fail("--method must be GET or POST");

const isWrite = WRITE_PATHS.some((re) => re.test(args.path));
if (isWrite && !args.iKnow && !args.dryRun) {
  fail(
    "that path makes a real booking or cancellation and spends real credits.\n" +
      "            Re-run with --dry-run to inspect it, or --i-know to actually do it.",
  );
}

const token = process.env.WEWORK_TOKEN;
if (!token && !args.dryRun) fail("set WEWORK_TOKEN to a live access token (see header comment)");

// The WeWorkUUID header is the user_uuid claim from the token. Decode, do not log.
function userUuidFromToken(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    return payload["https://wework.com/user_uuid"];
  } catch {
    return undefined;
  }
}

const userUuid = args.uuid ?? (token ? userUuidFromToken(token) : undefined);
if (!userUuid && !args.dryRun) {
  fail("could not read the user_uuid claim from WEWORK_TOKEN; pass --uuid explicitly");
}

const headers = {
  Authorization: `Bearer ${token ?? "<WEWORK_TOKEN>"}`,
  WeWorkAuth: `Bearer ${token ?? "<WEWORK_TOKEN>"}`,
  WeWorkUUID: userUuid ?? "<user_uuid>",
  WeWorkMemberType: "2",
  "Request-Source": "com.wework.ondemand/WorkplaceOne/Prod/iOS/2.71.0(26.1)",
  "fe-pg": "/workplaceone/content2/dashboard",
  Origin: "https://members.wework.com",
  Referer: "https://members.wework.com/workplaceone/content2/dashboard",
  Accept: "application/json",
  "Content-Type": "application/json",
};

let bodyText;
if (args.body) {
  bodyText = await readFile(resolve(process.cwd(), args.body), "utf8");
  JSON.parse(bodyText); // fail early on malformed input
  if (args.method !== "POST") fail("--body requires --method POST");
}

const url = `${BASE}${args.path}`;

if (args.dryRun) {
  process.stdout.write(
    [
      "dry run, nothing sent:",
      `  ${args.method} ${url}`,
      `  headers: ${Object.keys(headers).join(", ")} (Authorization/WeWorkAuth redacted)`,
      bodyText ? `  body: ${bodyText.length} bytes` : "  body: none",
      `  would write: ${resolve(FIXTURE_DIR, `${args.name}.json`)}`,
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const outPath = resolve(FIXTURE_DIR, `${args.name}.json`);
if (!args.force) {
  const exists = await access(outPath).then(
    () => true,
    () => false,
  );
  if (exists) fail(`${outPath} already exists; pass --force to overwrite`);
}

process.stderr.write(`${args.method} ${url}\n`);

const res = await fetch(url, {
  method: args.method,
  headers,
  body: bodyText,
  redirect: "manual",
});

const raw = await res.text();
process.stderr.write(`-> ${res.status} ${res.statusText}, ${raw.length} bytes\n`);

let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  fail(
    `response was not JSON (status ${res.status}). First 200 chars, redacted:\n` +
      `            ${raw.slice(0, 200).replace(JWT_RE, "REDACTED.JWT.VALUE")}`,
  );
}

const redactor = makeRedactor(args);
const fixture = {
  // Metadata the fetch stub in test/helpers/fake-fetch.ts keys off.
  _meta: {
    recordedAt: new Date().toISOString().slice(0, 10),
    method: args.method,
    // Query string kept (it is part of the contract) but scrubbed of ids if asked.
    path: redactor.scrubString(args.path),
    status: res.status,
    note: "Recorded from the live API with scripts/record-fixture.mjs and redacted. Review before trusting.",
  },
  body: redactor.walk(parsed),
};

const text = `${JSON.stringify(fixture, null, 2)}\n`;
const problems = leakCheck(text, args);

await mkdir(FIXTURE_DIR, { recursive: true });
await writeFile(outPath, text, "utf8");

process.stdout.write(`wrote ${outPath}\n`);
if (args.redactUuids) process.stdout.write(`mapped ${redactor.uuidCount()} uuids\n`);
if (problems.length > 0) {
  process.stderr.write(
    `\nWARNING: the fixture still appears to contain ${problems.join(" and ")}.\n` +
      "Fix it by hand before committing.\n",
  );
  process.exitCode = 2;
}
process.stdout.write(
  "\nNow open the file and read it. Check for real names, phone numbers, employer\n" +
    "names, and anything in a MailData block. Fixtures are committed forever.\n",
);
