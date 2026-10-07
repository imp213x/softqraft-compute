/**
 * The customer Console at /console/: VMs of the service instance the Cloud
 * launch opened. Hash routes: `#/` the list, `#/new` create, `#/vm/<id>`
 * one VM.
 */

import { createApi } from "./api.js";
import { h, mount } from "./shared/dom.js";
import { createShell } from "./shared/shell.js";
import { renderCreate } from "./features/vms/create.js";
import { renderDetail } from "./features/vms/detail.js";
import { renderList } from "./features/vms/list.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The view a hash names. Anything unknown is the list. */
export function routeOf(hash) {
  const path = (hash ?? "").replace(/^#/, "");
  if (path === "/new") return { view: "create" };
  const vm = /^\/vm\/([^/]+)$/.exec(path);
  if (vm && UUID_RE.test(vm[1])) return { view: "detail", id: vm[1] };
  return { view: "list" };
}

async function start() {
  const api = createApi();
  const shell = createShell({ base: "/console", surface: "console", api });
  const statusReady = shell.loadStatus();

  if (location.pathname === "/console/launch") {
    await statusReady;
    await shell.redeemLaunch();
    return;
  }

  let me;
  let sizes;
  let images;
  try {
    [me, sizes, images] = await Promise.all([
      api("/console/v1/auth/me"),
      api("/console/v1/sizes"),
      api("/console/v1/images").then((r) => r.images),
      statusReady,
    ]);
  } catch (error) {
    await statusReady;
    const state = shell.errorState(error, () => location.reload());
    if (state) mount(shell.main, state);
    return;
  }

  shell.showAccount(me.serviceInstance?.displayName ?? "");
  const view = h("div");
  mount(shell.main, view);
  const canWrite = me.role === "admin" || me.role === "developer";
  let cleanup = () => undefined;

  const navigate = (hash) => {
    if (location.hash === hash) render();
    else location.hash = hash;
  };

  function render() {
    cleanup();
    const route = routeOf(location.hash);
    const ctx = { api, shell, view, sizes: sizes.sizes, defaultSizeId: sizes.defaultSizeId, images, canWrite, navigate };
    if (route.view === "create" && canWrite) cleanup = renderCreate(ctx);
    else if (route.view === "detail") cleanup = renderDetail({ ...ctx, id: route.id });
    else cleanup = renderList(ctx);
    window.scrollTo(0, 0);
  }

  window.addEventListener("hashchange", () => {
    render();
    shell.main.focus({ preventScroll: true });
  });
  render();
}

if (typeof document !== "undefined") void start();
