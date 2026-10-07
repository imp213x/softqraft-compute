/**
 * One VM: status in words, the ssh command with a copy button, the console
 * button (only when the host offers one), usage hours, snapshots, and one
 * actions menu (Start or Stop, Resize, Snapshot, Delete). Polls every 5 s
 * while the VM or a snapshot is changing.
 */

import { COPY } from "../../shared/copy.js";
import { busy, h, mount, statusPill } from "../../shared/dom.js";
import {
  formatDate,
  formatDateTime,
  hours,
  imageName,
  instanceStatus,
  sizeDetail,
  sizeName,
  snapshotStatus,
  sshCommand,
} from "../../shared/format.js";
import { actionsMenu, copyButton, openDialog, poller, toast } from "../../shared/ui.js";
import { confirmDelete, resizeDialog, snapshotDialog } from "./dialogs.js";
import { POLL_MS } from "./list.js";

/** Which menu actions apply now, and why the others do not. */
export function menuState(instance) {
  const s = instance.state;
  const changing = instanceStatus(s).changing;
  return {
    power: s === "running" ? "stop" : "start",
    powerEnabled: s === "running" || s === "stopped",
    resizeEnabled: s === "stopped",
    snapshotEnabled: s === "running" || s === "stopped",
    deleteEnabled: s !== "deleting" && s !== "deleted",
    changing,
  };
}

/**
 * @param {{ api: Function, shell: any, view: HTMLElement, id: string, sizes: any[], images: any[], canWrite: boolean, navigate: (hash: string) => void }} ctx
 */
export function renderDetail(ctx) {
  const { api, shell, view, id } = ctx;
  const body = h("div");
  const poll = poller(refresh, POLL_MS);
  let shown = false;

  mount(view, h("a", { class: "sq-back", href: "#/" }, h("span", { "aria-hidden": "true" }, "←"), COPY.back), body);
  mount(body, shell.loadingState());
  void refresh(true);

  async function refresh(first = false) {
    let detail;
    let snapshots;
    let usage = null;
    try {
      [detail, snapshots] = await Promise.all([
        api(`/console/v1/instances/${id}`),
        api(`/console/v1/instances/${id}/snapshots`).then((r) => r.snapshots),
      ]);
      usage = await api(`/console/v1/instances/${id}/usage`).then((r) => r.usage).catch(() => null);
    } catch (error) {
      if (!shown || first) {
        const state = shell.errorState(error, () => {
          mount(body, shell.loadingState());
          void refresh(true);
        });
        if (state) mount(body, state);
        return false;
      }
      return true;
    }
    shown = true;
    draw(detail.instance, detail.capabilities ?? { console: false }, snapshots, usage);
    const again = instanceStatus(detail.instance.state).changing || snapshots.some((s) => snapshotStatus(s.state).changing);
    if (again) poll.ensure();
    return again;
  }

  /** After an action: show the new state now and keep polling until it settles. */
  function afterChange() {
    void refresh().then((again) => {
      if (again) poll.ensure();
    });
  }

  async function act(body, okToast) {
    try {
      await api(`/console/v1/instances/${id}/actions`, { method: "POST", body });
      toast(okToast);
      afterChange();
    } catch (error) {
      const message = shell.handleError(error);
      if (message) toast(message);
    }
  }

  function menu(instance) {
    const m = menuState(instance);
    return actionsMenu({
      label: COPY.actions,
      items: [
        {
          label: m.power === "stop" ? COPY.stop : COPY.start,
          disabled: !m.powerEnabled,
          hint: m.powerEnabled ? undefined : COPY.busy,
          onSelect: () =>
            void act({ action: m.power }, m.power === "stop" ? COPY.stoppedToast : COPY.startedToast),
        },
        {
          label: COPY.resize,
          disabled: !m.resizeEnabled,
          hint: m.resizeEnabled ? undefined : COPY.resizeStopFirst,
          onSelect: () => resizeDialog({ ...ctx, instance, onDone: afterChange }),
        },
        {
          label: COPY.snapshot,
          disabled: !m.snapshotEnabled,
          hint: m.snapshotEnabled ? undefined : COPY.snapshotNeedsState,
          onSelect: () => snapshotDialog({ ...ctx, instance, onDone: afterChange }),
        },
        { separator: true },
        {
          label: COPY.deleteVm,
          danger: true,
          disabled: !m.deleteEnabled,
          onSelect: () =>
            confirmDelete({
              ...ctx,
              instance,
              path: `/console/v1/instances/${id}`,
              title: COPY.deleteTitle,
              body: COPY.deleteBody,
              doneToast: COPY.deletedToast,
              onDone: () => ctx.navigate("#/"),
            }),
        },
      ],
    });
  }

  function connectCard(instance, capabilities) {
    const command = sshCommand(instance);
    const running = instance.state === "running";
    const consoleButton =
      running && capabilities.console && ctx.canWrite
        ? h("button", { type: "button", class: "sq-btn" }, COPY.openConsole)
        : null;
    consoleButton?.addEventListener("click", () =>
      void busy(consoleButton, async () => {
        try {
          await api(`/console/v1/instances/${id}/console`, { method: "POST" });
          openDialog({
            title: COPY.consoleReadyTitle,
            render: (close) => [
              h("p", null, COPY.consoleReadyBody),
              h("div", { class: "sq-dialog-actions" }, h("button", { type: "button", class: "sq-btn sq-btn-primary", onclick: close }, COPY.close)),
            ],
          });
        } catch (error) {
          const message = shell.handleError(error);
          if (message) toast(message);
        }
      }),
    );
    return h(
      "section",
      { class: "sq-card sq-wide", "aria-labelledby": "connectTitle" },
      h("h2", { id: "connectTitle" }, COPY.detailConnect),
      running && command
        ? h(
            "div",
            { class: "sq-field" },
            h("div", { class: "sq-code" }, h("code", null, command), copyButton(() => command)),
            h("p", { class: "sq-hint" }, COPY.connectNoKey),
            consoleButton ? h("div", null, consoleButton) : null,
          )
        : h("p", { class: "sq-hint" }, COPY.connectWhenRunning),
    );
  }

  function usageCard(usage) {
    return h(
      "section",
      { class: "sq-card", "aria-labelledby": "usageTitle" },
      h("h2", { id: "usageTitle" }, COPY.usageTitle),
      usage
        ? h(
            "div",
            { class: "sq-usage" },
            h("div", null, h("strong", null, hours(usage.vcpuHours)), h("span", null, COPY.usageVcpu)),
            h("div", null, h("strong", null, hours(usage.memoryGbHours)), h("span", null, COPY.usageMemory)),
            h("div", null, h("strong", null, hours(usage.diskGbHours)), h("span", null, COPY.usageDisk)),
          )
        : h("p", { class: "sq-hint" }, COPY.usageUnavailable),
    );
  }

  function snapshotsCard(instance, snapshots) {
    const items = snapshots.map((s) => {
      const status = snapshotStatus(s.state);
      const canDelete = ctx.canWrite && (s.state === "available" || s.state === "error");
      const del = canDelete ? h("button", { type: "button", class: "sq-btn sq-btn-small" }, COPY.deleteSnapshot) : null;
      del?.addEventListener("click", () =>
        confirmDelete({
          ...ctx,
          instance,
          path: `/console/v1/instances/${id}/snapshots/${s.id}`,
          title: COPY.deleteSnapshotTitle,
          body: COPY.deleteSnapshotBody,
          doneToast: COPY.snapshotDeletedToast,
          onDone: afterChange,
        }),
      );
      return h(
        "li",
        null,
        h("div", { class: "sq-list-main" }, h("strong", null, s.name), h("span", { class: "sq-cell-sub" }, formatDateTime(s.createdAt))),
        h("div", { class: "sq-list-side" }, statusPill(status), del),
      );
    });
    return h(
      "section",
      { class: "sq-card", "aria-labelledby": "snapsTitle" },
      h("h2", { id: "snapsTitle" }, COPY.snapshotsTitle),
      items.length ? h("ul", { class: "sq-list" }, items) : h("p", { class: "sq-hint" }, COPY.snapshotsEmpty),
    );
  }

  function draw(instance, capabilities, snapshots, usage) {
    const status = instanceStatus(instance.state);
    let note = null;
    if (instance.state === "pending" && instance.pendingReason) note = COPY.waitingForRoom;
    if (instance.state === "error") note = COPY.needsAttention;
    if (instance.state === "deleted") note = COPY.gone;
    const focusInside = body.contains(document.activeElement) ? document.activeElement?.id : null;
    mount(
      body,
      h(
        "div",
        { class: "sq-page-head" },
        h(
          "div",
          { class: "sq-detail-head" },
          h("h1", null, instance.spec.name),
          h("span", { role: "status", "aria-live": "polite" }, statusPill(status)),
        ),
        ctx.canWrite && instance.state !== "deleted" ? menu(instance) : null,
      ),
      note ? h("div", { class: "sq-notice", dataset: { tone: instance.state === "error" ? "bad" : "warn" } }, h("p", null, note)) : null,
      h(
        "div",
        { class: "sq-grid" },
        connectCard(instance, capabilities),
        h(
          "section",
          { class: "sq-card", "aria-labelledby": "aboutTitle" },
          h("h2", { id: "aboutTitle" }, COPY.detailAbout),
          h(
            "dl",
            { class: "sq-facts" },
            h("dt", null, COPY.factSize),
            h("dd", null, `${sizeName(instance.spec, ctx.sizes)} · ${sizeDetail(instance.spec)}`),
            h("dt", null, COPY.factImage),
            h("dd", null, imageName(instance.spec.imageId, ctx.images)),
            h("dt", null, COPY.factPrivateIp),
            h("dd", null, instance.privateIp ?? COPY.noAddressYet),
            h("dt", null, COPY.factCreated),
            h("dd", null, formatDate(instance.createdAt)),
          ),
        ),
        usageCard(usage),
        snapshotsCard(instance, snapshots),
      ),
    );
    if (note) body.querySelector(".sq-notice")?.classList.add("sq-wide");
    if (focusInside) document.getElementById(focusInside)?.focus();
  }

  return () => poll.stop();
}
