/**
 * A tiny element builder. Text always goes in as text nodes, never as HTML,
 * so nothing a server returns can become markup.
 */

/**
 * @param {string} tag
 * @param {Record<string, unknown> | null} [attrs]
 * @param {...(Node | string | number | null | undefined | false | Array<unknown>)} children
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), /** @type {EventListener} */ (value));
    } else if (key === "class") {
      el.className = String(value);
    } else if (key === "dataset") {
      for (const [k, v] of Object.entries(/** @type {Record<string, string>} */ (value))) el.dataset[k] = v;
    } else if (value === true) {
      el.setAttribute(key, "");
    } else if (key in el && typeof value !== "string") {
      /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (el))[key] = value;
    } else {
      el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Replace a node's children. */
export function mount(node, ...children) {
  node.replaceChildren();
  append(node, children);
}

/** A status pill: a neutral pill with a coloured dot and the state in words. */
export function statusPill(status) {
  return h("span", { class: "sq-status", dataset: { tone: status.tone } }, status.label);
}

export function spinner() {
  return h("span", { class: "sq-spinner", "aria-hidden": "true" });
}

/** A button that shows a spinner and is disabled while `work` runs. */
export async function busy(button, work) {
  const previous = [...button.childNodes];
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.prepend(spinner());
  try {
    return await work();
  } finally {
    button.replaceChildren(...previous);
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}
