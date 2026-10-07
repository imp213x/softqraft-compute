/**
 * The staff fleet at /admin/: hosts and all instances. Opened from Ops with
 * an operator session. Hash routes: `#/` hosts, `#/instances`.
 */

import { createApi } from "./api.js";
import { COPY } from "./shared/copy.js";
import { h, mount } from "./shared/dom.js";
import { createShell } from "./shared/shell.js";
import { renderHosts } from "./features/fleet/hosts.js";
import { renderInstances } from "./features/fleet/instances.js";

export function adminRouteOf(hash) {
  return (hash ?? "").replace(/^#/, "") === "/instances" ? "instances" : "hosts";
}

async function start() {
  const api = createApi();
  const shell = createShell({ base: "/admin", surface: "admin", api });
  const statusReady = shell.loadStatus();

  if (location.pathname === "/admin/launch") {
    await statusReady;
    await shell.redeemLaunch();
    return;
  }

  let me;
  let status;
  try {
    [me, status] = await Promise.all([api("/admin/v1/auth/me"), statusReady]);
  } catch (error) {
    await statusReady;
    const state = shell.errorState(error, () => location.reload());
    if (state) mount(shell.main, state);
    return;
  }

  shell.showAccount(me.operator?.displayName ?? "");
  const canWrite = me.operator?.role === "owner" || me.operator?.role === "admin";
  const runbookUrl = typeof status.hostRunbookUrl === "string" && status.hostRunbookUrl.startsWith("https://") ? status.hostRunbookUrl : null;
  const hostsTab = h("a", { href: "#/" }, COPY.hostsTab);
  const instancesTab = h("a", { href: "#/instances" }, COPY.instancesTab);
  const view = h("div");
  mount(shell.main, h("nav", { class: "sq-tabs", "aria-label": COPY.fleetName }, hostsTab, instancesTab), view);
  let cleanup = () => undefined;

  function render() {
    cleanup();
    const route = adminRouteOf(location.hash);
    hostsTab.toggleAttribute("aria-current", route === "hosts");
    instancesTab.toggleAttribute("aria-current", route === "instances");
    if (route === "hosts") hostsTab.setAttribute("aria-current", "page");
    if (route === "instances") instancesTab.setAttribute("aria-current", "page");
    const ctx = { api, shell, view, canWrite, runbookUrl };
    cleanup = route === "instances" ? renderInstances(ctx) : renderHosts(ctx);
  }

  window.addEventListener("hashchange", render);
  render();
}

if (typeof document !== "undefined") void start();
