/** Dialogs, toasts, copy buttons and the actions menu. */

import { COPY } from "./copy.js";
import { h } from "./dom.js";

/**
 * Open a modal dialog. The native <dialog> keeps focus inside and closes on
 * Escape. Returns a handle with `close()`.
 * @param {{ title: string, label?: string, render: (close: () => void) => Node[] }} options
 */
export function openDialog({ title, render }) {
  const titleId = `dlg-${Math.random().toString(36).slice(2)}`;
  const dialog = h("dialog", { class: "sq-dialog", "aria-labelledby": titleId });
  const close = () => {
    if (dialog.open) dialog.close();
  };
  dialog.addEventListener("close", () => dialog.remove());
  const body = h("div", { class: "sq-dialog-body" }, h("h2", { id: titleId }, title), ...render(close));
  dialog.append(body);
  document.body.append(dialog);
  dialog.showModal();
  const first = dialog.querySelector("[autofocus], input, textarea, button.sq-btn-primary, button.sq-btn-danger, button");
  if (first instanceof HTMLElement) first.focus();
  return { close, dialog, body };
}

/** Replace a dialog's content after its title. */
export function setDialogContent(handle, nodes) {
  const [heading] = handle.body.children;
  handle.body.replaceChildren(heading, ...nodes);
}

let toastRoot = null;

export function toast(message) {
  if (!toastRoot) {
    toastRoot = h("div", { class: "sq-toasts", role: "status", "aria-live": "polite" });
    document.body.append(toastRoot);
  }
  const node = h("div", { class: "sq-toast" }, message);
  toastRoot.append(node);
  setTimeout(() => node.remove(), 4000);
}

/** A "Copy" button for a piece of text. */
export function copyButton(getText, label = COPY.copy) {
  const button = h("button", { type: "button", class: "sq-btn sq-btn-small" }, label);
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText());
      button.textContent = COPY.copied;
      setTimeout(() => (button.textContent = label), 1600);
    } catch {
      toast(COPY.copyFailed);
    }
  });
  return button;
}

/**
 * The one actions menu: a button that opens a list of actions. Arrow keys
 * move, Escape closes and returns focus to the button.
 * @param {{ label: string, items: Array<{ label: string, hint?: string, disabled?: boolean, danger?: boolean, separator?: boolean, onSelect?: () => void }> }} options
 */
export function actionsMenu({ label, items }) {
  const listId = `menu-${Math.random().toString(36).slice(2)}`;
  const button = h(
    "button",
    { type: "button", class: "sq-btn", "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": listId },
    label,
    h("span", { "aria-hidden": "true" }, "▾"),
  );
  const list = h("ul", { class: "sq-menu-list", role: "menu", id: listId, hidden: true });
  const wrap = h("div", { class: "sq-menu" }, button, list);
  const buttons = [];
  for (const item of items) {
    if (item.separator) {
      list.append(h("li", { role: "none" }, h("hr")));
      continue;
    }
    const b = h(
      "button",
      {
        type: "button",
        role: "menuitem",
        disabled: Boolean(item.disabled),
        class: item.danger ? "sq-danger-item" : undefined,
        tabindex: "-1",
      },
      item.label,
      item.hint ? h("span", { class: "sq-cell-sub" }, item.hint) : null,
    );
    b.addEventListener("click", () => {
      closeMenu(true);
      item.onSelect?.();
    });
    buttons.push(b);
    list.append(h("li", { role: "none" }, b));
  }
  const enabled = () => buttons.filter((b) => !b.disabled);
  function openMenu() {
    list.hidden = false;
    button.setAttribute("aria-expanded", "true");
    (enabled()[0] ?? buttons[0])?.focus();
    document.addEventListener("pointerdown", outside, true);
  }
  function closeMenu(focusButton) {
    list.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    if (focusButton) button.focus();
  }
  function outside(event) {
    if (!wrap.contains(/** @type {Node} */ (event.target))) closeMenu(false);
  }
  button.addEventListener("click", () => (list.hidden ? openMenu() : closeMenu(true)));
  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openMenu();
    }
  });
  list.addEventListener("keydown", (event) => {
    const items = enabled();
    const at = items.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(at + 1) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(at - 1 + items.length) % items.length]?.focus();
    } else if (event.key === "Tab") {
      closeMenu(false);
    }
  });
  return wrap;
}

/** Calls `tick` every `ms` while it returns true. `stop()` ends it. */
export function poller(tick, ms = 5000) {
  let timer = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      let again = false;
      try {
        again = await tick();
      } catch {
        again = true;
      }
      if (again) schedule();
      else timer = null;
    }, ms);
  };
  return {
    /** Start, unless already scheduled. */
    ensure() {
      if (!stopped && timer === null) schedule();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    get running() {
      return timer !== null;
    },
  };
}
