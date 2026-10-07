/** All instances, read only, for staff support. */

import { COPY } from "../../shared/copy.js";
import { h, mount, statusPill } from "../../shared/dom.js";
import { anyChanging, formatDate, instanceStatus, sizeName } from "../../shared/format.js";
import { poller } from "../../shared/ui.js";

/**
 * @param {{ api: Function, shell: any, view: HTMLElement }} ctx
 */
export function renderInstances(ctx) {
  const { api, shell, view } = ctx;
  const body = h("div");
  const poll = poller(() => refresh(), 5000);
  mount(view, h("div", { class: "sq-page-head" }, h("div", null, h("h1", null, COPY.instancesTitle), h("p", null, COPY.instancesLead))), body);
  mount(body, shell.loadingState());
  void refresh(true);

  async function refresh(first = false) {
    let instances;
    let hosts;
    try {
      [instances, hosts] = await Promise.all([
        api("/admin/v1/fleet/instances").then((r) => r.instances),
        api("/admin/v1/fleet/hosts").then((r) => r.hosts),
      ]);
    } catch (error) {
      if (first) {
        const state = shell.errorState(error, () => {
          mount(body, shell.loadingState());
          void refresh(true);
        });
        if (state) mount(body, state);
        return false;
      }
      return true;
    }
    const hostNames = new Map(hosts.map((host) => [host.id, host.name]));
    draw(instances, hostNames);
    const again = anyChanging(instances);
    if (first && again) poll.ensure();
    return again;
  }

  function draw(instances, hostNames) {
    if (instances.length === 0) {
      mount(body, h("div", { class: "sq-card sq-empty" }, h("p", null, COPY.instancesEmpty)));
      return;
    }
    const rows = instances.map((i) =>
      h(
        "tr",
        null,
        h("td", { class: "sq-primary-cell", "data-label": COPY.colName }, h("strong", null, i.spec.name)),
        h("td", { "data-label": COPY.colStatus }, statusPill(instanceStatus(i.state))),
        h("td", { "data-label": COPY.colSize }, sizeName(i.spec)),
        h("td", { "data-label": COPY.colPrivateIp, class: "sq-num" }, i.privateIp ?? COPY.noAddressYet),
        h("td", { "data-label": COPY.colHost }, (i.hostId && hostNames.get(i.hostId)) || COPY.noAddressYet),
        h("td", { "data-label": COPY.colCreated }, formatDate(i.createdAt)),
      ),
    );
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
              h("th", { scope: "col" }, COPY.colStatus),
              h("th", { scope: "col" }, COPY.colSize),
              h("th", { scope: "col" }, COPY.colPrivateIp),
              h("th", { scope: "col" }, COPY.colHost),
              h("th", { scope: "col" }, COPY.colCreated),
            ),
          ),
          h("tbody", null, rows),
        ),
      ),
    );
  }

  return () => poll.stop();
}
