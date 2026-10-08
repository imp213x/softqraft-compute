// The Console and Admin UI contract (C1d), in the spirit of Realtime Media's
// scripts/check-console-ui.test.mjs:
// - the parent brand is inherited, not invented;
// - no developer text on screen: no codes, ids, stack traces or notes;
// - no semicolons or em dashes in UI copy;
// - every API error code a browser can meet has one plain sentence;
// - the pages carry a strict CSP and load no inline script or style.
//
//   node --test scripts/check-console-ui.test.mjs

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { COPY } from "../apps/console/modules/shared/copy.js";
import { ApiError, ERROR_COPY, GENERIC_ERROR, NEXT, OFFLINE_ERROR, SERVER_ERROR, presentError } from "../apps/console/modules/shared/errors.js";
import {
  anyChanging,
  capacity,
  hostStatus,
  hours,
  instanceStatus,
  sizeDetail,
  sizeName,
  snapshotStatus,
  sshCommand,
  timeAgo,
} from "../apps/console/modules/shared/format.js";
import { NAME_RE, SNAPSHOT_NAME_RE, suggestName, suggestSnapshotName } from "../apps/console/modules/shared/names.js";
import { grantFromHash, safeReturnPath } from "../apps/console/modules/shared/shell.js";
import { createApi } from "../apps/console/modules/api.js";
import { routeOf } from "../apps/console/modules/console-app.js";
import { adminRouteOf } from "../apps/console/modules/admin-app.js";
import { capabilitiesOf, menuState } from "../apps/console/modules/features/vms/detail.js";
import { orderImages } from "../apps/console/modules/features/vms/create.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "apps/console");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

function files(dir, ext) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full, ext));
    else if (full.endsWith(ext)) out.push(full);
  }
  return out;
}

const JS_FILES = files(path.join(APP, "modules"), ".js");
const HTML_FILES = ["console.html", "admin.html"].map((f) => path.join(APP, f));

/** Visible text in a page: tag content and the words in alt, title, aria-label and placeholder. */
function htmlText(html) {
  const attrs = [...html.matchAll(/\s(?:alt|title|aria-label|placeholder)="([^"]*)"/g)].map((m) => m[1]);
  const body = html
    .replace(/<head>[\s\S]*?<\/head>/, "")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
  return [...attrs, ...body, ...(title ? [title] : [])];
}

/** String and template literals in UI code that read as prose (letters, then a space, then letters). */
function proseLiterals(source) {
  const out = [];
  for (const m of source.matchAll(/"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
    const text = (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, "X");
    if (/^sq-|^[a-z-]+( [a-z-]+)*$/.test(text) && !/[A-Z]/.test(text) && /^[a-z0-9 .:-]*$/.test(text) && text.split(" ").every((w) => w.startsWith("sq-") || /^[a-z-]+$/.test(w))) {
      // A class list or a lowercase key, unless it is plain prose.
      if (!/\b(the|your|this|is|a|to|of|and|or|you|it|in|on)\b/.test(text)) continue;
    }
    if (/[A-Za-z]{2,}[.,:;!?)]?\s+[A-Za-z(]{2,}/.test(text)) out.push(text);
  }
  return out;
}

const ALL_COPY = [
  ...Object.values(COPY),
  ...Object.values(ERROR_COPY),
  GENERIC_ERROR,
  OFFLINE_ERROR,
  SERVER_ERROR,
  ...HTML_FILES.flatMap((f) => htmlText(readFileSync(f, "utf8"))),
  ...JS_FILES.flatMap((f) => proseLiterals(readFileSync(f, "utf8"))),
];

const DEVELOPER_TEXT = [
  /\bTODO\b|\bFIXME\b|\bXXX\b|\bdebug\b|lorem ipsum/i,
  /\bAPI\b|\bJSON\b|\bHTTP\b|\bendpoint\b|\brequest ?id\b|\bstack\b|\bnull\b|\bundefined\b|\bNaN\b|\[object/i,
  /\bconsole\.log\b|\bexception\b|\bstatus code\b|\berror code\b|\bid\b/i,
  // Raw error codes and states: snake_case words.
  /\b[a-z]+_[a-z_]+\b/,
  // Ids: UUIDs, prefixed tokens.
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|\bsq(?:lg|og|cs|os|et)_/i,
  // Internal state names shown as words.
  /\b(?:provisioning|pending)\b/i,
];

test("UI copy has no semicolons or em dashes", () => {
  assert.ok(ALL_COPY.length > 150, `found ${ALL_COPY.length} pieces of copy`);
  for (const text of ALL_COPY) {
    assert.doesNotMatch(text, /;/, `semicolon in: ${text}`);
    assert.doesNotMatch(text, /—/, `em dash in: ${text}`);
  }
});

test("UI copy carries no developer text, codes or ids", () => {
  for (const text of ALL_COPY) {
    for (const pattern of DEVELOPER_TEXT) assert.doesNotMatch(text, pattern, `developer text in: ${text}`);
  }
});

test("the parent brand is inherited exactly, never a child brand", () => {
  const manifest = JSON.parse(readFileSync(path.join(APP, "brand-manifest.json"), "utf8"));
  assert.equal(manifest.parent, "https://github.com/imp213x/softqraft_labs");
  assert.match(manifest.revision, /^[0-9a-f]{40}$/);
  for (const html of HTML_FILES.map((f) => readFileSync(f, "utf8"))) {
    const base = html.includes("/admin/assets/") ? "/admin" : "/console";
    for (const asset of ["softqraft-infinity-photo-512.png", "favicon.svg", "favicon-32.png", "favicon-16.png", "favicon-180.png"]) {
      assert.ok(html.includes(`${base}/assets/brand/${asset}`), `missing parent asset ${asset}`);
      assert.ok(manifest.files.some((f) => f.target === `assets/brand/${asset}`), `${asset} is not pinned`);
    }
    assert.match(html, /SoftQraft<span>Labs<\/span>/);
    assert.match(html, /Systems&nbsp;·&nbsp;Engineering/);
    assert.match(html, /<span>SoftQraft Cloud<\/span>/);
    assert.doesNotMatch(html, /∞|sq-brand-mark|sq-cloud-wordmark/);
  }
  const tokens = read("apps/console/styles/tokens.css");
  assert.match(tokens, /@import "\.\/brand\/parent\.css"/);
  assert.match(tokens, /@import "\.\/brand\/parent-shell\.css"/);
  assert.match(tokens, /--sq-ink: var\(--sql-paper\)/);
  assert.match(tokens, /--sq-text: var\(--sql-text-on-light\)/);
  assert.match(tokens, /--sq-accent: var\(--sql-parent-color-slate-900\)/);
  assert.match(tokens, /--sq-highlight: var\(--sql-parent-color-amber-600\)/);
  assert.match(tokens, /--sq-font: var\(--sql-parent-font-sans\)/);
  for (const sheet of ["app.css", "base.css", "header.css"]) {
    assert.doesNotMatch(read(`apps/console/styles/${sheet}`), /#[0-9a-f]{3,8}\b/i, `${sheet} must use tokens, not a private palette`);
  }
  const parent = read("apps/console/styles/brand/parent.css");
  for (const token of ["--sql-paper: #F8FAFC", "--sql-ink: #0B1220", "--sql-text-on-light: #0F172A", "--sql-text-muted: #64748B", "--sql-amber: #FFB347"]) {
    assert.ok(parent.includes(token), `parent token ${token}`);
  }
});

test("scrollbars are hidden everywhere and never brought back", () => {
  const base = read("apps/console/styles/base.css");
  assert.match(base, /\* \{ scrollbar-width: none; -ms-overflow-style: none; \}/);
  assert.match(base, /\*::-webkit-scrollbar \{ display: none; \}/);
  for (const sheet of files(path.join(APP, "styles"), ".css")) {
    const css = readFileSync(sheet, "utf8");
    assert.doesNotMatch(css, /scrollbar-width:\s*(thin|auto)|::-webkit-scrollbar\s*\{[^}]*(width|height)/, sheet);
  }
});

test("the pages load no inline script, style or handler, and the server sends a strict CSP", () => {
  for (const file of HTML_FILES) {
    const html = readFileSync(file, "utf8");
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${file}: inline script`);
    assert.doesNotMatch(html, /<style|\sstyle=|\son[a-z]+=/i, `${file}: inline style or handler`);
    assert.doesNotMatch(html, /https?:\/\//, `${file}: no fixed external URL`);
  }
  for (const file of JS_FILES) {
    const js = readFileSync(file, "utf8");
    assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/, `${file}: builds markup from strings`);
    assert.doesNotMatch(js, /setAttribute\(\s*["']style["']|\.style\.cssText/, `${file}: inline style`);
    assert.doesNotMatch(js, /https?:\/\/[a-z0-9]/i, `${file}: no fixed URL, the server names them from config`);
    assert.doesNotMatch(js, /localStorage|sessionStorage/, `${file}: no browser storage for session data`);
  }
  const browser = read("apps/api/src/lib/browser.ts");
  const csp = /BROWSER_CSP = \[([\s\S]*?)\]\.join/.exec(browser)?.[1] ?? "";
  for (const directive of [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ]) {
    assert.ok(csp.includes(`"${directive}"`), `CSP directive ${directive}`);
  }
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*|https?:/);
  assert.match(browser, /reply\.header\("Content-Security-Policy", BROWSER_CSP\)/);
  assert.match(browser, /reply\.header\("Cache-Control", "no-store"\)/);
});

test("every API error code a browser can meet has one plain sentence with a next step", () => {
  const sources = files(path.join(ROOT, "apps/api/src"), ".ts").filter((f) => !f.endsWith(".test.ts"));
  const codes = new Set();
  for (const file of sources) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/HttpError\(\s*\d+,\s*"([a-z_]+)"/g)) codes.add(m[1]);
    for (const m of src.matchAll(/uuidParam\(req, "[A-Za-z]+", "([a-z_]+)"\)/g)) codes.add(`${m[1]}_not_found`);
  }
  for (const code of ["not_supported", "reauth_required", "federation_unknown_instance", "federation_instance_disabled", "payload_too_large", "unsupported_media_type", "bad_request"]) codes.add(code);
  // Reached only by host agents (signed) or by Cloud (server to server), never by a browser.
  const NOT_BROWSER = new Set([
    "agent_ip_not_allowed", "agent_unauthenticated", "enrolment_invalid", "invalid_public_key", "invalid_result", "job_not_found",
    "lease_expired", "lease_lost", "sample_out_of_range", "unknown_driver", "unknown_instance",
  ]);
  assert.ok(codes.size > 40, `found ${codes.size} codes`);
  for (const code of codes) {
    if (NOT_BROWSER.has(code)) continue;
    assert.ok(Object.hasOwn(ERROR_COPY, code), `no copy for ${code}`);
    assert.ok(/[.]$/.test(ERROR_COPY[code]), `${code}: one sentence with an end`);
    for (const pattern of DEVELOPER_TEXT) assert.doesNotMatch(ERROR_COPY[code], pattern, code);
  }
});

test("errors never echo server text, codes, ids or stack traces", async () => {
  const leaks = ["boom at /srv/db.ts:42", "must-not-leak", "SELECT * FROM instances", "6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c11"];
  for (const status of [0, 400, 401, 403, 404, 409, 413, 429, 500, 502, 504]) {
    for (const code of ["quota_exceeded", "reauth_required", "made_up_code", undefined]) {
      for (const message of leaks) {
        const api = createApi({
          fetcher: async () =>
            status === 0
              ? Promise.reject(new TypeError(message))
              : new Response(JSON.stringify({ error: { code, message, requestId: message, stack: message } }), { status }),
        });
        await assert.rejects(api("/console/v1/instances"), (error) => {
          assert.ok(error instanceof ApiError);
          const shown = presentError(error).message;
          for (const leak of leaks) assert.ok(!shown.includes(leak), shown);
          assert.doesNotMatch(shown, /[a-z]+_[a-z]+|\b\d{3}\b/);
          assert.ok(ALL_COPY.includes(shown), `unreviewed copy: ${shown}`);
          return true;
        });
      }
    }
  }
  assert.equal(presentError(new Error("private stack")).message, GENERIC_ERROR);
  assert.equal(presentError("must-not-leak").message, GENERIC_ERROR);
  const reauth = presentError(new ApiError({ status: 403, code: "reauth_required" }));
  assert.equal(reauth.next, NEXT.reauth);
  assert.equal(presentError(new ApiError({ status: 401, code: "unauthorized" })).next, NEXT.signIn);
  assert.match(presentError(new ApiError({ status: 403, code: "forbidden" }), { surface: "admin" }).message, /fleet/);
  const html = await createApi({ fetcher: async () => new Response("<html>trace</html>", { status: 502 }) })("/x").catch((e) => e);
  assert.equal(presentError(html).message, SERVER_ERROR);
});

test("status is shown in words, never as an internal state", () => {
  const states = ["pending", "provisioning", "running", "stopping", "stopped", "starting", "resizing", "deleting", "deleted", "error"];
  const words = new Set(states.map((s) => instanceStatus(s).label));
  for (const s of states) assert.match(instanceStatus(s).label, /^[A-Z][a-z]+( [a-z]+)?$/, s);
  assert.equal(instanceStatus("provisioning").label, "Starting");
  assert.equal(instanceStatus("pending").label, "Starting");
  assert.equal(instanceStatus("running").label, "Running");
  assert.equal(instanceStatus("stopped").label, "Stopped");
  assert.equal(instanceStatus("error").label, "Needs attention");
  assert.equal(instanceStatus("something_new").label, "Checking");
  assert.ok(words.size >= 6);
  for (const s of ["creating", "available", "deleting", "error"]) assert.doesNotMatch(snapshotStatus(s).label, /_/);
  const now = new Date("2026-10-07T12:00:00Z");
  assert.equal(hostStatus({ state: "active", lastSeenAt: "2026-10-07T11:58:00Z" }, now).label, "Online");
  assert.equal(hostStatus({ state: "active", lastSeenAt: "2026-10-07T11:50:00Z" }, now).label, "Not responding");
  assert.equal(hostStatus({ state: "enrolled", lastSeenAt: null }, now).label, "Waiting to connect");
  assert.equal(hostStatus({ state: "disabled", lastSeenAt: null }, now).label, "Disabled");
  assert.equal(timeAgo("2026-10-07T11:56:00Z", now), "4 minutes ago");
  assert.equal(timeAgo("2026-10-07T11:59:30Z", now), "just now");
});

test("polling runs only while something is changing", () => {
  assert.equal(anyChanging([{ state: "running" }, { state: "stopped" }, { state: "error" }]), false);
  for (const s of ["pending", "provisioning", "starting", "stopping", "resizing", "deleting"]) {
    assert.equal(anyChanging([{ state: "running" }, { state: s }]), true, s);
  }
});

test("sizes, names, ssh commands and routes", () => {
  const presets = [
    { id: "small", name: "Small", vcpu: 1, memoryMb: 1024, diskGb: 16 },
    { id: "medium", name: "Medium", vcpu: 2, memoryMb: 2048, diskGb: 16 },
  ];
  assert.equal(sizeName({ vcpu: 2, memoryMb: 2048 }, presets), "Medium");
  assert.equal(sizeName({ vcpu: 3, memoryMb: 3072 }, presets), "3 vCPU, 3 GB");
  assert.equal(sizeDetail(presets[0]), "1 vCPU · 1 GB memory · 16 GB disk");
  assert.equal(hours(0), "0");
  assert.equal(hours(2), "2.0");
  assert.equal(hours(1234.4), "1,234");
  assert.deepEqual(capacity({ capacity: { vcpu: 4, memoryMb: 8192, diskGb: 120 }, allocated: { vcpu: 1, memoryMb: 1024, diskGb: 16 } }).free, ["3 vCPU", "7 GB memory", "104 GB disk"]);
  let seed = 0;
  for (let i = 0; i < 200; i += 1) {
    const name = suggestName(() => ((seed = (seed * 9301 + 49297) % 233280) / 233280));
    assert.match(name, NAME_RE);
    assert.match(name, /^[a-z]+-[a-z]+-\d{2}$/);
  }
  assert.equal(suggestName(() => 0), "amber-badger-10");
  assert.match(suggestName(() => 0, ["amber-badger-10"]), NAME_RE, "a taken name is never suggested");
  assert.notEqual(suggestName(() => 0, ["amber-badger-10"]), "amber-badger-10");
  assert.match(suggestSnapshotName(new Date(2026, 9, 7, 9, 5)), SNAPSHOT_NAME_RE);
  assert.equal(suggestSnapshotName(new Date(2026, 9, 7, 9, 5)), "snap-20261007-0905");
  assert.equal(sshCommand({ privateIp: "10.30.0.5", spec: { imageId: "ubuntu-24.04" } }), "ssh ubuntu@10.30.0.5");
  assert.equal(sshCommand({ privateIp: "10.30.0.6", spec: { imageId: "debian-12" } }), "ssh debian@10.30.0.6");
  assert.equal(sshCommand({ privateIp: null, spec: { imageId: "debian-12" } }), null);
  assert.deepEqual(orderImages([
    { id: "debian-12", name: "Debian 12 (bookworm)", status: "available" },
    { id: "ubuntu-24.04", name: "Ubuntu 24.04 LTS", status: "available" },
  ]).map((i) => i.id), ["ubuntu-24.04", "debian-12"]);
  assert.deepEqual(routeOf("#/new"), { view: "create" });
  assert.deepEqual(routeOf("#/vm/6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c11"), { view: "detail", id: "6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c11" });
  assert.deepEqual(routeOf("#/vm/../../admin"), { view: "list" });
  assert.deepEqual(routeOf("#grant=sqlg_x"), { view: "list" });
  assert.equal(adminRouteOf("#/instances"), "instances");
  assert.equal(adminRouteOf("#/anything"), "hosts");
});

test("the actions menu: resize only while stopped, one power action", () => {
  assert.deepEqual(
    { ...menuState({ state: "running" }) },
    { power: "stop", powerEnabled: true, resizeEnabled: false, snapshotEnabled: true, deleteEnabled: true, changing: false, resizeShown: true, snapshotShown: true },
  );
  assert.equal(menuState({ state: "stopped" }).power, "start");
  assert.equal(menuState({ state: "stopped" }).resizeEnabled, true);
  assert.equal(menuState({ state: "starting" }).powerEnabled, false);
  assert.equal(menuState({ state: "deleting" }).deleteEnabled, false);
  assert.match(COPY.resizeStopFirst, /Stop the VM/);
});

test("capabilities are read defensively: no console unless offered, resize and snapshot unless refused", () => {
  assert.deepEqual(capabilitiesOf({ state: "running" }), { console: false, resize: true, snapshot: true });
  assert.deepEqual(capabilitiesOf({ state: "running", capabilities: { console: true } }), { console: true, resize: true, snapshot: true });
  // A driver without resize or snapshot hides both.
  const proxmox = { state: "stopped", capabilities: { console: false, resize: false, snapshot: false } };
  assert.deepEqual(capabilitiesOf(proxmox), { console: false, resize: false, snapshot: false });
  const m = menuState(proxmox, capabilitiesOf(proxmox));
  assert.equal(m.resizeShown, false);
  assert.equal(m.snapshotShown, false);
  assert.equal(capabilitiesOf({ capabilities: { console: "yes" } }).console, false, "only true means a console");
});

test("launch links: the grant is read from the fragment and the return path stays on the page", () => {
  assert.equal(grantFromHash("#grant=sqlg_abc-DEF_123"), "sqlg_abc-DEF_123");
  assert.equal(grantFromHash("#grant=<script>"), null);
  assert.equal(grantFromHash(""), null);
  assert.equal(safeReturnPath("/console", "/console/"), "/console/");
  assert.equal(safeReturnPath("/console", "/console/#/new"), "/console/#/new");
  assert.equal(safeReturnPath("/console", "https://evil.example/"), "/console/");
  assert.equal(safeReturnPath("/console", "//evil.example"), "/console/");
  assert.equal(safeReturnPath("/admin", "/admin/v1/fleet/hosts"), "/admin/");
});
