/** The VM list: empty state, table, and polling while anything is changing. */

import { COPY } from "../../shared/copy.js";
import { h, mount, statusPill } from "../../shared/dom.js";
import { anyChanging, formatDate, instanceStatus, sizeName } from "../../shared/format.js";
import { poller } from "../../shared/ui.js";

export const POLL_MS = 5000;

/**
 * @param {{ api: Function, shell: any, view: HTMLElement, sizes: any[], canWrite: boolean, navigate: (hash: string) => void }} ctx
 * @returns {() => void} cleanup
 */
export function renderList(ctx) {
  const { api, shell, view } = ctx;
  const body = h("div");
  let shown = false;
  const poll = poller(refresh, POLL_MS);

  mount(view, body);
  mount(body, shell.loadingState());
  void refresh(true);

  async function refresh(first = false) {
    let instances;
    try {
      instances = (await api("/console/v1/instances")).instances;
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
    draw(instances);
    const again = anyChanging(instances);
    if (first && again) poll.ensure();
    return again;
  }

  function draw(instances) {
    if (instances.length === 0) {
      mount(
        body,
        h(
          "section",
          { class: "sq-card sq-empty", "aria-labelledby": "emptyTitle" },
          h("img", { src: "/console/assets/brand/softqraft-infinity-photo-512.png", alt: "", width: 512, height: 215 }),
          h("h1", { id: "emptyTitle" }, COPY.emptyTitle),
          h("p", null, COPY.emptyBody),
          ctx.canWrite
            ? h("a", { class: "sq-btn sq-btn-primary sq-btn-large", href: "#/new" }, COPY.createFirstVm)
            : h("p", { class: "sq-hint" }, COPY.viewOnly),
        ),
      );
      return;
    }
    const rows = instances.map((i) => {
      const href = `#/vm/${i.id}`;
      const row = h(
        "tr",
        { class: "sq-clickable" },
        h("td", { class: "sq-primary-cell", "data-label": COPY.colName }, h("a", { class: "sq-row-link", href }, i.spec.name)),
        h("td", { "data-label": COPY.colStatus }, statusPill(instanceStatus(i.state))),
        h("td", { "data-label": COPY.colSize }, sizeName(i.spec, ctx.sizes)),
        h("td", { "data-label": COPY.colPrivateIp, class: "sq-num" }, i.privateIp ?? COPY.noAddressYet),
        h("td", { "data-label": COPY.colCreated }, formatDate(i.createdAt)),
      );
      row.addEventListener("click", (event) => {
        if (!(event.target instanceof HTMLAnchorElement)) ctx.navigate(href);
      });
      return row;
    });
    mount(
      body,
      h(
        "div",
        { class: "sq-page-head" },
        h("div", null, h("h1", null, COPY.vmsTitle), h("p", null, COPY.vmsLead)),
        ctx.canWrite ? h("a", { class: "sq-btn sq-btn-primary", href: "#/new" }, COPY.createVm) : null,
      ),
      h(
        "div",
        { class: "sq-card" },
        h(
          "table",
          { class: "sq-table" },
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
