#!/usr/bin/env node
// Admin CLI for Questionnaire. Needs Node 18+.
//
// Config comes from the environment, falling back to
// ~/.config/questionnaire/admin.env (KEY=value lines):
//   QUESTIONNAIRE_URL          e.g. https://questionnaire.example.workers.dev
//   QUESTIONNAIRE_ADMIN_TOKEN  the Worker's ADMIN_TOKEN secret

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const USAGE = `qn: manage Questionnaire polls

  qn list                         list polls with response counts
  qn get <id|slug>                show one poll's definition
  qn create <file.json | ->       create a poll from JSON (- reads stdin)
  qn update <id|slug> <file|->    merge changes into a poll (PATCH)
  qn replace <id|slug> <file|->   replace a poll's definition (PUT)
  qn open <id|slug>               start taking responses
  qn close <id|slug>              stop taking responses
  qn results <id|slug>            tallied results, including free-text answers
  qn export <id|slug> [--csv] [-o file]   every response, JSON or CSV
  qn delete <id|slug> --yes       delete a poll and its responses

See docs/API.md for the poll JSON format.`;

function loadConfig() {
  const file = join(homedir(), ".config", "questionnaire", "admin.env");
  const fromFile = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m) fromFile[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  const url = process.env.QUESTIONNAIRE_URL || fromFile.QUESTIONNAIRE_URL;
  const token = process.env.QUESTIONNAIRE_ADMIN_TOKEN || fromFile.QUESTIONNAIRE_ADMIN_TOKEN;
  if (!url || !token) {
    console.error(`Set QUESTIONNAIRE_URL and QUESTIONNAIRE_ADMIN_TOKEN, or put them in ${file}`);
    process.exit(2);
  }
  return { url: url.replace(/\/$/, ""), token };
}

function readInput(path) {
  if (!path) throw new Error("missing JSON file argument");
  const text = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  return JSON.parse(text);
}

async function call(cfg, method, path, body) {
  const res = await fetch(`${cfg.url}/api/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${cfg.token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }
  return data;
}

const print = (d) => console.log(typeof d === "string" ? d : JSON.stringify(d, null, 2));

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return console.log(USAGE);
  const cfg = loadConfig();
  const id = args[0] ? encodeURIComponent(args[0]) : undefined;
  const needId = () => {
    if (!id) throw new Error(`${cmd} needs a poll id or slug`);
  };

  switch (cmd) {
    case "list": {
      const { polls } = await call(cfg, "GET", "/polls");
      if (!polls.length) return console.log("No polls yet.");
      for (const p of polls) {
        console.log(`${p.open ? "●" : "○"} ${p.title}\n  ${p.status} · ${p.responseCount} responses · ${p.url}\n  id ${p.id}`);
      }
      return;
    }
    case "get": needId(); return print(await call(cfg, "GET", `/polls/${id}`));
    case "create": return print(await call(cfg, "POST", "/polls", readInput(args[0])));
    case "update": needId(); return print(await call(cfg, "PATCH", `/polls/${id}`, readInput(args[1])));
    case "replace": needId(); return print(await call(cfg, "PUT", `/polls/${id}`, readInput(args[1])));
    case "open":
    case "close": {
      needId();
      const p = await call(cfg, "PATCH", `/polls/${id}`, { status: cmd === "open" ? "open" : "closed" });
      return console.log(`${p.title} is now ${p.status}: ${p.url}`);
    }
    case "results": needId(); return print(await call(cfg, "GET", `/polls/${id}/results`));
    case "export": {
      needId();
      const csv = args.includes("--csv");
      const out = args.includes("-o") ? args[args.indexOf("-o") + 1] : undefined;
      const data = await call(cfg, "GET", `/polls/${id}/responses${csv ? "?format=csv" : ""}`);
      const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
      if (out) {
        writeFileSync(out, text);
        console.error(`Wrote ${out}`);
      } else process.stdout.write(text.endsWith("\n") ? text : text + "\n");
      return;
    }
    case "delete": {
      needId();
      if (!args.includes("--yes")) throw new Error("delete removes the poll and every response; add --yes to confirm");
      return print(await call(cfg, "DELETE", `/polls/${id}`));
    }
    default:
      console.error(USAGE);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(`qn: ${err.message}`);
  process.exit(1);
});
