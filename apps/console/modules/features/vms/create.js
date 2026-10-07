/**
 * Create a VM, on one screen: a suggested name, a size preset, Ubuntu
 * 24.04 preselected, the remembered SSH key, and one Create button.
 * Everything else takes the safe default (private network, no inbound
 * traffic).
 */

import { COPY } from "../../shared/copy.js";
import { busy, h, mount } from "../../shared/dom.js";
import { ApiError } from "../../shared/errors.js";
import { formatDate, sizeDetail } from "../../shared/format.js";
import { NAME_RE, suggestName } from "../../shared/names.js";
import { toast } from "../../shared/ui.js";

/** Ubuntu 24.04 first and preselected, then the others. */
export function orderImages(images) {
  const available = images.filter((i) => i.status === "available");
  return [...available].sort((a, b) => (a.id === "ubuntu-24.04" ? -1 : b.id === "ubuntu-24.04" ? 1 : a.name.localeCompare(b.name)));
}

const IMAGE_LABELS = Object.freeze({ "ubuntu-24.04": "Ubuntu 24.04", "debian-12": "Debian 12" });
const IMAGE_SUBS = Object.freeze({ "ubuntu-24.04": "Long-term support", "debian-12": "Stable" });

function newIdempotencyKey() {
  return `create-${crypto.randomUUID()}`;
}

/**
 * @param {{ api: Function, shell: any, view: HTMLElement, sizes: any[], defaultSizeId: string | null, canWrite: boolean, navigate: (hash: string) => void }} ctx
 */
export function renderCreate(ctx) {
  const { api, shell, view } = ctx;
  const body = h("div", { class: "sq-create" });
  mount(
    view,
    h("a", { class: "sq-back", href: "#/" }, h("span", { "aria-hidden": "true" }, "←"), COPY.back),
    h("div", { class: "sq-page-head" }, h("div", null, h("h1", null, COPY.createTitle), h("p", null, COPY.createLead))),
    body,
  );
  mount(body, shell.loadingState());
  void load();
  return () => undefined;

  async function load() {
    let images;
    let keys;
    try {
      [images, keys] = await Promise.all([
        api("/console/v1/images").then((r) => r.images),
        api("/console/v1/ssh-keys").then((r) => r.sshKeys),
      ]);
    } catch (error) {
      const state = shell.errorState(error, () => {
        mount(body, shell.loadingState());
        void load();
      });
      if (state) mount(body, state);
      return;
    }
    draw(orderImages(images), keys);
  }

  function choice(name, value, checked, title, sub) {
    return h(
      "label",
      { class: "sq-choice" },
      h("input", { type: "radio", name, value, checked }),
      h("span", { class: "sq-choice-body" }, h("span", { class: "sq-choice-title" }, title), sub ? h("span", { class: "sq-choice-sub" }, sub) : null),
    );
  }

  function draw(images, keys) {
    let idempotencyKey = newIdempotencyKey();

    const nameInput = h("input", {
      id: "vmName",
      class: "sq-input",
      name: "name",
      value: suggestName(),
      autocomplete: "off",
      autocapitalize: "none",
      spellcheck: "false",
      maxlength: "63",
      required: true,
      "aria-describedby": "vmNameHint",
    });
    const shuffle = h("button", { type: "button", class: "sq-btn", "aria-label": COPY.nameShuffle, title: COPY.nameShuffle }, h("span", { "aria-hidden": "true" }, "↻"));
    shuffle.addEventListener("click", () => {
      nameInput.value = suggestName();
      nameInput.focus();
    });
    const nameError = h("p", { class: "sq-field-error", id: "vmNameError", hidden: true }, COPY.nameInvalid);

    const sizeChoices = ctx.sizes.map((s) => choice("size", s.id, s.id === ctx.defaultSizeId, s.name, sizeDetail(s)));
    const imageChoices = images.map((img, index) =>
      choice("image", img.id, index === 0, IMAGE_LABELS[img.id] ?? img.name, IMAGE_SUBS[img.id] ?? null),
    );

    const keyArea = h("textarea", {
      id: "sshKey",
      class: "sq-input",
      name: "sshKey",
      rows: "3",
      placeholder: COPY.keyPlaceholder,
      spellcheck: "false",
      autocomplete: "off",
      "aria-describedby": "sshKeyHint",
    });
    const keyHint = h("p", { class: "sq-hint", id: "sshKeyHint" }, COPY.keyHint);
    const keyNew = h("div", { class: "sq-field" }, keyArea, keyHint);
    const keyChoices = keys.map((k, index) =>
      choice("key", k.id, index === 0, k.name, `${k.type === "ssh-ed25519" ? "ed25519" : `RSA ${k.bits}`} · ${formatDate(k.createdAt)}`),
    );
    if (keys.length > 0) {
      keyChoices.push(choice("key", "new", false, COPY.keyAddAnother, null));
      keyNew.hidden = true;
    }

    const notice = h("div", { class: "sq-notice", dataset: { tone: "bad" }, role: "alert", hidden: true });
    const submit = h("button", { type: "submit", class: "sq-btn sq-btn-primary sq-btn-large" }, COPY.create);
    if (!ctx.canWrite || ctx.sizes.length === 0) submit.disabled = true;

    const form = h(
      "form",
      { class: "sq-form", novalidate: true },
      h(
        "div",
        { class: "sq-field" },
        h("label", { class: "sq-label", for: "vmName" }, COPY.nameLabel),
        h("div", { class: "sq-input-row" }, nameInput, shuffle),
        h("p", { class: "sq-hint", id: "vmNameHint" }, COPY.nameHint),
        nameError,
      ),
      h(
        "fieldset",
        { class: "sq-field" },
        h("legend", null, COPY.sizeLabel),
        ctx.sizes.length > 0 ? h("div", { class: "sq-choices" }, sizeChoices) : h("p", { class: "sq-notice", dataset: { tone: "warn" } }, COPY.noSizes),
      ),
      h("fieldset", { class: "sq-field" }, h("legend", null, COPY.imageLabel), h("div", { class: "sq-choices" }, imageChoices)),
      h(
        "fieldset",
        { class: "sq-field" },
        h("legend", null, COPY.keyLabel),
        keys.length > 0 ? h("div", { class: "sq-choices" }, keyChoices) : null,
        keyNew,
        keys.length === 0 ? h("p", { class: "sq-hint" }, COPY.keyRemembered) : null,
      ),
      notice,
      h("div", { class: "sq-create-foot" }, h("p", { class: "sq-hint" }, ctx.canWrite ? COPY.createDefaults : COPY.viewOnly), submit),
    );

    form.addEventListener("change", (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.name === "key") {
        keyNew.hidden = target.value !== "new";
        if (!keyNew.hidden) keyArea.focus();
      }
    });
    nameInput.addEventListener("input", () => {
      nameError.hidden = true;
      nameInput.removeAttribute("aria-invalid");
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      notice.hidden = true;
      const name = nameInput.value.trim();
      if (!NAME_RE.test(name)) {
        nameError.hidden = false;
        nameInput.setAttribute("aria-invalid", "true");
        nameInput.setAttribute("aria-describedby", "vmNameHint vmNameError");
        nameInput.focus();
        return;
      }
      const data = new FormData(form);
      const size = ctx.sizes.find((s) => s.id === data.get("size"));
      const imageId = String(data.get("image") ?? "");
      const chosenKey = data.get("key");
      const pasted = keyArea.value.trim();
      const saved = keys.find((k) => k.id === chosenKey);
      if (!size) return;
      if (!saved && !pasted) {
        showError(COPY.keyMissing);
        keyArea.focus();
        return;
      }
      void busy(submit, async () => {
        try {
          let publicKey = saved?.publicKey;
          if (!publicKey) {
            const res = await api("/console/v1/ssh-keys", { method: "POST", body: { publicKey: pasted } });
            publicKey = res.sshKey.publicKey;
          }
          const res = await api("/console/v1/instances", {
            method: "POST",
            headers: { "Idempotency-Key": idempotencyKey },
            body: { name, imageId, vcpu: size.vcpu, memoryMb: size.memoryMb, diskGb: size.diskGb, sshPublicKeys: [publicKey] },
          });
          toast(COPY.createdToast);
          ctx.navigate(`#/vm/${res.instance.id}`);
        } catch (error) {
          // A lost connection may have created it: keep the key so a retry is safe.
          if (!(error instanceof ApiError && error.status === 0)) idempotencyKey = newIdempotencyKey();
          const message = shell.handleError(error);
          if (message) showError(message);
        }
      });
    });

    function showError(message) {
      mount(notice, h("p", null, message));
      notice.hidden = false;
    }

    mount(body, h("div", { class: "sq-card" }, form));
  }
}
