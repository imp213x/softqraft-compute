#!/usr/bin/env node
// Verify a vendored copy of @softqraft/federation against its VENDORED.json.
//
//   node verify-vendored.mjs <vendoredDir> [--ignore <relative path>]... [--quiet]
//
// Recomputes the SHA-256 of every file and exits 1 when any file listed in
// the manifest is missing or changed, or when any file not listed is present.
// Ignored by default: VENDORED.json itself, node_modules/, dist/ and
// *.tsbuildinfo (build output of the service's own compile). A service that
// keeps its own files next to the copy (for example a local tsconfig.json)
// names each one with --ignore. Symbolic links are never followed and count
// as extra files.
//
// Zero dependencies; node:crypto, node:fs and node:path only. Prints paths,
// never file contents.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_IGNORED_DIRS = new Set(["node_modules", "dist"]);
const MANIFEST = "VENDORED.json";

function usage(message) {
  if (message) process.stderr.write(`verify-vendored: ${message}\n`);
  process.stderr.write("usage: node verify-vendored.mjs <vendoredDir> [--ignore <relative path>]... [--quiet]\n");
  process.exit(2);
}

const args = process.argv.slice(2);
let dir = null;
const ignores = [];
let quiet = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--ignore") {
    const value = args[++i];
    if (!value) usage("--ignore needs a path");
    ignores.push(value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, ""));
  } else if (a === "--quiet") {
    quiet = true;
  } else if (a.startsWith("--")) {
    usage(`unknown option ${a}`);
  } else if (dir === null) {
    dir = a;
  } else {
    usage("only one directory may be given");
  }
}
if (dir === null) usage();
const root = path.resolve(dir);

function isIgnored(rel) {
  if (rel === MANIFEST) return true;
  const first = rel.split("/")[0];
  if (DEFAULT_IGNORED_DIRS.has(first)) return true;
  if (rel.endsWith(".tsbuildinfo")) return true;
  return ignores.some((p) => rel === p || rel.startsWith(`${p}/`));
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(path.join(root, MANIFEST), "utf8"));
} catch {
  process.stderr.write(`verify-vendored: FAIL cannot read ${MANIFEST} in ${root}\n`);
  process.exit(1);
}
if (!manifest || typeof manifest !== "object" || !manifest.files || typeof manifest.files !== "object") {
  process.stderr.write(`verify-vendored: FAIL ${MANIFEST} has no files map\n`);
  process.exit(1);
}

const problems = [];
const expected = new Map();
for (const [rel, hash] of Object.entries(manifest.files)) {
  if (
    typeof hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(hash) ||
    rel.startsWith("/") ||
    rel.includes("\\") ||
    rel.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  ) {
    problems.push(`invalid manifest entry: ${rel}`);
    continue;
  }
  expected.set(rel, hash);
}

const present = new Map(); // rel → "file" | "symlink" | "other"
function walk(abs, rel) {
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (isIgnored(childRel)) continue;
    const childAbs = path.join(abs, entry.name);
    const st = lstatSync(childAbs);
    if (st.isSymbolicLink()) present.set(childRel, "symlink");
    else if (st.isDirectory()) walk(childAbs, childRel);
    else if (st.isFile()) present.set(childRel, "file");
    else present.set(childRel, "other");
  }
}
walk(root, "");

for (const [rel, want] of expected) {
  const kind = present.get(rel);
  if (kind === undefined) {
    problems.push(`missing: ${rel}`);
  } else if (kind !== "file") {
    problems.push(`not a regular file: ${rel}`);
  } else if (sha256(path.join(root, rel)) !== want) {
    problems.push(`changed: ${rel}`);
  }
}
for (const [rel] of present) {
  if (!expected.has(rel)) problems.push(`extra: ${rel}`);
}

const label = `${manifest.package ?? "?"}@${manifest.version ?? "?"}${manifest.tag ? ` (${manifest.tag})` : ""}`;
if (problems.length > 0) {
  process.stderr.write(`verify-vendored: FAIL ${label} in ${root}\n`);
  for (const p of problems.sort()) process.stderr.write(`  ${p}\n`);
  process.exit(1);
}
if (!quiet) {
  process.stdout.write(`verify-vendored: OK ${label}, ${expected.size} files match in ${root}\n`);
}
