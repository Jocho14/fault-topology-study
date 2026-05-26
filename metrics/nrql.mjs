#!/usr/bin/env node
// Minimal NerdGraph NRQL runner for the thesis metrics.
//
// Usage:
//   node metrics/nrql.mjs "SELECT count(*) FROM Transaction SINCE 10 minutes ago"
//   node metrics/nrql.mjs --json "SELECT ..."     # raw results array only
//
// Credentials / config (read from environment or the gitignored .env):
//   NEW_RELIC_API_KEY      User API key, starts with NRAK-   (REQUIRED)
//   NEW_RELIC_ACCOUNT_ID   numeric account id   (default 8100704)
//   NEW_RELIC_REGION       US | EU              (default EU)
//
// The license/ingest key (...NRAL) CANNOT query — this needs a User key.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// tiny .env loader (KEY=VALUE lines); does not override real env vars
try {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch { /* no .env, rely on real env */ }

const API_KEY = process.env.NEW_RELIC_API_KEY;
const ACCOUNT = process.env.NEW_RELIC_ACCOUNT_ID || "8100704";
const REGION = (process.env.NEW_RELIC_REGION || "EU").toUpperCase();
const ENDPOINT =
  REGION === "EU"
    ? "https://api.eu.newrelic.com/graphql"
    : "https://api.newrelic.com/graphql";

if (!API_KEY) {
  console.error(
    "ERROR: NEW_RELIC_API_KEY not set. Add a User API key (NRAK-...) to .env:\n" +
      "  NEW_RELIC_API_KEY=NRAK-xxxxxxxx",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const jsonOnly = args[0] === "--json";
const nrql = (jsonOnly ? args.slice(1) : args).join(" ").trim();
if (!nrql) {
  console.error('ERROR: pass an NRQL string, e.g. node metrics/nrql.mjs "SELECT count(*) FROM Transaction"');
  process.exit(2);
}

export async function runNrql(query, { account = ACCOUNT } = {}) {
  const gql = `{ actor { account(id: ${account}) { nrql(query: ${JSON.stringify(
    query,
  )}) { results metadata { facets timeWindow { begin end } } } } } }`;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "API-Key": API_KEY },
    body: JSON.stringify({ query: gql }),
  });
  const body = await res.json();
  if (body.errors) {
    throw new Error("NerdGraph error: " + JSON.stringify(body.errors, null, 2));
  }
  return body.data.actor.account.nrql;
}

// Only run as CLI when invoked directly (allows importing runNrql elsewhere)
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const out = await runNrql(nrql);
    if (jsonOnly) {
      console.log(JSON.stringify(out.results, null, 2));
    } else {
      console.log(`account=${ACCOUNT} region=${REGION}`);
      console.log("NRQL>", nrql);
      console.log(JSON.stringify(out.results, null, 2));
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
