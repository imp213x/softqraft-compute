/**
 * The hosts table: state in words, capacity used and free, last seen, and
 * Drain, "Stop all VMs on this host" (with a confirmation) and Enable.
 * Viewers see the actions disabled, with the reason. "Add a host" shows a
 * one-time enrolment token.
 */

import { COPY } from "../../shared/copy.js";
import { busy, h, mount, statusPill } from "../../shared/dom.js";
import { capacity, formatTime, hostActions, hostStatus, timeAgo } from "../../shared/format.js";
import { copyButton, openDialog, poller, toast } from "../../shared/ui.js";

export const HOSTS_POLL_MS = 15000;

/**
 * @param {{ api: Function, shell: any, view: HTMLElement, canWrite: boolean, runbookUrl: string | null }} ctx
 */
export function renderHosts(ctx) {
  const { api, shell, view } = ctx;
  const body = h("div");
  const poll = poller(() => refresh().then(() => true), HOSTS_POLL_MS);
  const addHost = h("button", { type: "button", class: "sq-btn sq-btn-primary", disabled: !ctx.canWrite }, COPY.addHost);
  addHost.addEventListener("click", () => void busy(addHost, enrol));

  mount(
    view,
    h(
      "div",
      { class: "sq-page-head" },
      h("div", null, h("h1", null, COPY.hostsTitle), h("p", null, COPY.hostsLead)),
      addHost,
    ),
    ctx.canWrite ? null : h("div", { class: "sq-notice" }, h("p", null, COPY.viewerReason)),
    body,
  );
  mount(body, shell.loadingState());
  void refresh(true);

  async function refresh(first = false) {
    let hosts;
    try {
      hosts = (await api("/admin/v1/fleet/hosts")).hosts;
    } catch (error) {
      if (first) {
        const state = shell.errorState(error, () => {
          mount(body, shell.loadingState());
          void refresh(true);
        });
        if (state) mount(body, state);
      }
      return;
    }
    draw(hosts);
    if (first) poll.ensure();
  }

  async function write(path, okToast) {
    try {
      await api(path, { method: "POST", body: {} });
      toast(okToast);
      await refresh();
    } catch (error) {
      const message = shell.handleError(error, { reauthKind: "admin" });
      if (message) toast(message);
    }
  }

  function confirmDisable(host) {
    openDialog({
      title: COPY.disableTitle,
      render: (close) => {
        const go = h("button", { type: "button", class: "sq-btn sq-btn-danger" }, COPY.disableConfirm);
        go.addEventListener("click", () =>
          void busy(go, async () => {
            close();
            await write(`/admin/v1/fleet/hosts/${host.id}/disable`, COPY.disabledToast);
          }),
        );
        return [
          h("p", null, h("strong", null, host.name)),
          h("p", null, COPY.disableBody),
          h("div", { class: "sq-dialog-actions" }, h("button", { type: "button", class: "sq-btn", onclick: close }, COPY.cancel), go),
        ];
      },
    });
  }

  async function enrol() {
    let created;
    try {
      created = await api("/admin/v1/fleet/enrolment-tokens", { method: "POST", body: {} });
    } catch (error) {
      const message = shell.handleError(error, { reauthKind: "admin" });
      if (message) toast(message);
      return;
    }
    const token = created.token;
    openDialog({
      title: COPY.enrolTitle,
      render: (close) => [
        h("p", null, COPY.enrolBody),
        h("div", { class: "sq-code" }, h("code", { class: "sq-token" }, token), copyButton(() => token)),
        h("p", { class: "sq-hint" }, `${COPY.enrolExpires} ${formatTime(created.expiresAt)}`),
        ctx.runbookUrl ? h("p", null, h("a", { href: ctx.runbookUrl, target: "_blank", rel: "noopener noreferrer" }, COPY.enrolRunbook)) : null,
        h("div", { class: "sq-dialog-actions" }, h("button", { type: "button", class: "sq-btn sq-btn-primary", onclick: close }, COPY.enrolDone)),
      ],
    });
  }

  function actionButton(label, enabled, onClick, danger = false) {
    const disabled = !ctx.canWrite || !enabled;
    const b = h(
      "button",
      {
        type: "button",
        class: `sq-btn sq-btn-small${danger && !disabled ? " sq-btn-danger" : ""}`,
        disabled,
        title: !ctx.canWrite ? COPY.viewerReason : undefined,
      },
      label,
    );
    if (!disabled) b.addEventListener("click", () => void busy(b, onClick));
    return b;
  }

  function draw(hosts) {
    if (hosts.length === 0) {
      mount(body, h("div", { class: "sq-card sq-empty" }, h("p", null, COPY.hostsEmpty)));
      return;
    }
    const now = new Date();
    const rows = hosts.map((host) => {
      const can = hostActions(host);
      const cap = capacity(host);
      return h(
        "tr",
        null,
        h("td", { class: "sq-primary-cell", "data-label": COPY.colName }, h("strong", null, host.name)),
        h("td", { "data-label": COPY.colState }, statusPill(hostStatus(host, now))),
        h("td", { "data-label": COPY.colCapacity }, h("span", { class: "sq-lines" }, cap.used.map((l) => h("span", null, l)))),
        h("td", { "data-label": COPY.colFree }, h("span", { class: "sq-lines" }, cap.free.map((l) => h("span", null, l)))),
        h("td", { "data-label": COPY.colLastSeen }, host.lastSeenAt ? timeAgo(host.lastSeenAt, now) : COPY.never),
        h(
          "td",
          { "data-label": COPY.actions },
          h(
            "div",
            { class: "sq-actions" },
            can.enable ? actionButton(COPY.enable, true, () => write(`/admin/v1/fleet/hosts/${host.id}/enable`, COPY.enabledToast)) : null,
            can.drain ? actionButton(COPY.drain, true, () => write(`/admin/v1/fleet/hosts/${host.id}/drain`, COPY.drainedToast)) : null,
            can.disable ? actionButton(COPY.disable, true, async () => confirmDisable(host), true) : null,
          ),
        ),
      );
    });
    mount(
      body,
      h(
        "div",
        { class: "sq-card" },
        h(
          "table",
          { class: "sq-table sq-table-wide" },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              h("th", { scope: "col" }, COPY.colName),
              h("th", { scope: "col" }, COPY.colState),
              h("th", { scope: "col" }, COPY.colCapacity),
              h("th", { scope: "col" }, COPY.colFree),
              h("th", { scope: "col" }, COPY.colLastSeen),
              h("th", { scope: "col" }, h("span", { class: "sq-sr" }, COPY.actions)),
            ),
          ),
          h("tbody", null, rows),
        ),
      ),
    );
  }

  return () => poll.stop();
}
