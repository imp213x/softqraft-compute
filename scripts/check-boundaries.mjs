#!/usr/bin/env node
// Boundary checks for softqraft-compute.
//
//   node scripts/check-boundaries.mjs
//
// 1. Modules in apps/api/src/modules/<m>/ talk to each other only through
//    ../<other>/index.js. Code outside a module (app.ts, index.ts, lib/,
//    store/, tests) imports a module only through its index.js, and the
//    store only through store/index.js.
// 2. apps/api/src/lib/ imports no module and no store.
// 3. No package under packages/ imports anything from apps/, by path or by
//    package name, and packages import each other only by bare package name
//    (no deep imports into another package's files).
// 4. Each workspace package depends only on the workspace packages it is
//    allowed to (see ALLOWED_WORKSPACE_DEPENDENCIES).
//
// Exits 1 and prints every violation, or prints a one-line summary.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs"]);

export const ALLOWED_WORKSPACE_DEPENDENCIES = Object.freeze({
  "@softqraft/compute-contracts": [],
  "@softqraft/compute-jobs": ["@softqraft/compute-contracts"],
  "@softqraft/compute-driver": ["@softqraft/compute-contracts"],
  "@softqraft/federation": [],
  "@softqraft/compute-api": [
    "@softqraft/compute-contracts",
    "@softqraft/compute-jobs",
    "@softqraft/compute-driver",
    "@softqraft/federation",
  ],
});

const API_SRC = "apps/api/src";
const MODULES = `${API_SRC}/modules`;
const STORE = `${API_SRC}/store`;
const LIB = `${API_SRC}/lib`;

const IMPORT_RE =
  /(?:^|[\s;])(?:import|export)\s[^'"]*?\sfrom\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

/** Every module specifier in a source text. */
export function importsOf(source) {
  const out = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    out.push(match[1] ?? match[2] ?? match[3]);
  }
  return out;
}

const toPosix = (p) => p.split(path.sep).join("/");

/** The module a repo-relative path belongs to, or null. */
function moduleOf(rel) {
  if (!rel.startsWith(`${MODULES}/`)) return null;
  return rel.slice(MODULES.length + 1).split("/")[0];
}

function isIndex(rel, dir) {
  return rel === `${dir}/index.js` || rel === `${dir}/index.ts` || rel === dir;
}

/**
 * Check one file's imports. `rel` is the repo-relative POSIX path of the
 * importing file. Returns a list of violation strings.
 */
export function checkFile(rel, source) {
  const violations = [];
  const fromModule = moduleOf(rel);
  const inPackage = rel.startsWith("packages/");
  const packageDir = inPackage ? rel.split("/").slice(0, 2).join("/") : null;
  const inStore = rel.startsWith(`${STORE}/`);
  const inLib = rel.startsWith(`${LIB}/`);

  for (const spec of importsOf(source)) {
    if (spec.startsWith(".")) {
      const target = toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
      if (inPackage) {
        if (target.startsWith("apps/")) violations.push(`${rel}: a package imports from apps/ (${spec})`);
        else if (!target.startsWith(`${packageDir}/`)) {
          violations.push(`${rel}: reaches into another package by path (${spec})`);
        }
        continue;
      }
      const toModule = moduleOf(target);
      if (toModule && toModule !== fromModule && !isIndex(target, `${MODULES}/${toModule}`)) {
        violations.push(`${rel}: imports internals of module "${toModule}" (${spec}); use ../${toModule}/index.js`);
      }
      if (target.startsWith(`${STORE}/`) && !inStore && !isIndex(target, STORE)) {
        violations.push(`${rel}: imports store internals (${spec}); use store/index.js`);
      }
      if (inLib && (toModule || target.startsWith(`${STORE}/`))) {
        violations.push(`${rel}: lib/ must not import modules or the store (${spec})`);
      }
      if (target.startsWith("packages/")) {
        violations.push(`${rel}: imports a package by path (${spec}); use its package name`);
      }
      continue;
    }
    if (spec === "@softqraft/compute-api" || spec.startsWith("@softqraft/compute-api/")) {
      if (inPackage) violations.push(`${rel}: a package imports the API app (${spec})`);
    }
    if (/^@softqraft\/[^/]+\/.+/.test(spec) && !spec.startsWith("@softqraft/federation/vectors/")) {
      violations.push(`${rel}: deep import into a workspace package (${spec}); import the package name`);
    }
  }
  return violations;
}

/** Check one package.json against ALLOWED_WORKSPACE_DEPENDENCIES. */
export function checkManifest(rel, manifest) {
  const violations = [];
  const name = manifest.name;
  const allowed = ALLOWED_WORKSPACE_DEPENDENCIES[name];
  if (!allowed) return [`${rel}: workspace package ${name} is not registered in check-boundaries.mjs`];
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const dep of Object.keys(manifest[section] ?? {})) {
      if (dep in ALLOWED_WORKSPACE_DEPENDENCIES && !allowed.includes(dep)) {
        violations.push(`${rel}: ${name} may not depend on ${dep}`);
      }
    }
  }
  return violations;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith(".d.ts")) out.push(abs);
  }
  return out;
}

export function run(root = ROOT) {
  const violations = [];
  let files = 0;
  for (const top of ["apps", "packages"]) {
    for (const abs of walk(path.join(root, top))) {
      const rel = toPosix(path.relative(root, abs));
      // The vendored kit is checked by its own verifier and never edited here.
      if (rel.startsWith("packages/federation/")) continue;
      files += 1;
      violations.push(...checkFile(rel, readFileSync(abs, "utf8")));
    }
  }
  const manifests = [];
  for (const top of ["apps", "packages"]) {
    for (const name of readdirSync(path.join(root, top))) {
      const manifest = path.join(root, top, name, "package.json");
      try {
        if (!statSync(manifest).isFile()) continue;
      } catch {
        continue;
      }
      manifests.push(manifest);
      violations.push(...checkManifest(toPosix(path.relative(root, manifest)), JSON.parse(readFileSync(manifest, "utf8"))));
    }
  }
  return { violations, files, manifests: manifests.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { violations, files, manifests } = run();
  if (violations.length > 0) {
    process.stderr.write(`check-boundaries: ${violations.length} violation(s)\n${violations.map((v) => `  ${v}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`check-boundaries: OK (${files} source files, ${manifests} manifests)\n`);
}
