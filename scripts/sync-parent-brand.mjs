#!/usr/bin/env node
/**
 * The parent brand, pinned. Compute inherits the SoftQraft Labs identity
 * exactly as Realtime Media does (Media's myDocs/console/brand-contract.md):
 * the parent's brand CSS, logo and favicons are copied unchanged into
 * apps/console, with selected Tailwind tokens from the parent's header, and
 * every file is pinned by SHA-256 in apps/console/brand-manifest.json.
 *
 *   node scripts/sync-parent-brand.mjs                                  # CI: verify the pinned hashes (no sibling repo)
 *   node scripts/sync-parent-brand.mjs --source ../softqraft_labs        # also compare with a parent checkout
 *   node scripts/sync-parent-brand.mjs --source ../softqraft_labs --live # and the live parent's image bytes
 *   node scripts/sync-parent-brand.mjs --source ../softqraft_labs --write # intentional update, after review
 *
 * Never invent a child brand: service labels change, the identity does not.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const consoleRoot = path.join(root, "apps/console");
const manifestPath = path.join(consoleRoot, "brand-manifest.json");
const args = process.argv.slice(2);
const sourceIndex = args.indexOf("--source");
const source = sourceIndex < 0 ? null : path.resolve(args[sourceIndex + 1]);
const writing = args.includes("--write");
assert.ok(!writing || source, "--write requires an explicit --source parent checkout");

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const copies = [
  ["src/styles/brand.css", "styles/brand/parent.css"],
  ["public/brand/png/softqraft-infinity-photo-512.png", "assets/brand/softqraft-infinity-photo-512.png"],
  ...["favicon.svg", "favicon-32.png", "favicon-16.png", "favicon-180.png"].map((name) => [`public/${name}`, `assets/brand/${name}`]),
];
const themeKeys = [
  "font-sans",
  "color-white",
  "color-slate-50",
  "color-slate-100",
  "color-slate-200",
  "color-slate-300",
  "color-slate-400",
  "color-slate-500",
  "color-slate-600",
  "color-slate-700",
  "color-slate-800",
  "color-slate-900",
  "color-amber-50",
  "color-amber-100",
  "color-amber-600",
  "color-amber-700",
];

async function parentSnapshot() {
  const files = [];
  for (const [from, to] of copies) files.push({ from, to, bytes: await readFile(path.join(source, from)) });
  const theme = await readFile(path.join(source, "node_modules/tailwindcss/theme.css"), "utf8");
  const declarations = themeKeys.map((key) => {
    const value = theme.match(new RegExp(`--${key}:\\s*([^;]+);`))?.[1];
    assert.ok(value, `Parent Tailwind token missing: ${key}`);
    return `  --sql-parent-${key}: ${value};`;
  });
  files.push({
    from: "node_modules/tailwindcss/theme.css (selected header/surface tokens)",
    to: "styles/brand/parent-shell.css",
    bytes: Buffer.from(`/* Generated from the parent's Tailwind theme; do not edit. */\n:root {\n${declarations.join("\n")}\n}\n`),
  });
  return files;
}

if (writing) {
  const files = await parentSnapshot();
  for (const { to, bytes } of files) {
    const target = path.join(consoleRoot, to);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  const revision = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const manifest = {
    parent: "https://github.com/imp213x/softqraft_labs",
    revision,
    headerSource: "src/app/components/Navbar.tsx",
    files: files.map(({ from, to, bytes }) => ({ source: from, target: to, sha256: digest(bytes) })),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
} else {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.files.length, copies.length + 1, "Brand manifest must pin every inherited file");
  for (const file of manifest.files) {
    assert.equal(digest(await readFile(path.join(consoleRoot, file.target))), file.sha256, `Brand drift: ${file.target}`);
  }
  if (source) {
    for (const file of await parentSnapshot()) {
      assert.equal(
        digest(file.bytes),
        manifest.files.find((item) => item.target === file.to)?.sha256,
        `Parent changed: ${file.from}. Review and sync intentionally.`,
      );
    }
  }
}

if (args.includes("--live")) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const file of manifest.files.filter((item) => item.source.startsWith("public/"))) {
    const response = await fetch(`https://www.softqraftlabs.com/${file.source.slice(7)}`, { signal: AbortSignal.timeout(15000) });
    assert.ok(response.ok, `Parent asset unavailable: ${file.source}`);
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), file.sha256, `Live parent asset drift: ${file.source}`);
  }
  console.log("Live parent: all five image asset hashes match.");
}

console.log(`Parent brand ${writing ? "synced" : "verified"}: 5 exact image assets, brand CSS and inherited shell tokens.`);
