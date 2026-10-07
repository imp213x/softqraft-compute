/** Delete (type the VM name), Resize (only while stopped) and Snapshot dialogs. */

import { COPY } from "../../shared/copy.js";
import { busy, h, mount } from "../../shared/dom.js";
import { NEXT, presentError } from "../../shared/errors.js";
import { sizeDetail } from "../../shared/format.js";
import { SNAPSHOT_NAME_RE, suggestSnapshotName } from "../../shared/names.js";
import { openDialog, setDialogContent, toast } from "../../shared/ui.js";

function errorNotice() {
  return h("div", { class: "sq-notice", dataset: { tone: "bad" }, role: "alert", hidden: true });
}

function show(notice, message) {
  mount(notice, h("p", null, message));
  notice.hidden = false;
}

/**
 * Delete a VM or a snapshot. The user types the VM's name. If the sign-in
 * is older than 15 minutes the server refuses, and the dialog turns into
 * "Sign in again to delete" with one button that goes back through Cloud.
 */
export function confirmDelete(ctx) {
  const { api, shell, instance, path, title, body, doneToast, onDone } = ctx;
  const name = instance.spec.name;
  const input = h("input", {
    id: "confirmName",
    class: "sq-input",
    autocomplete: "off",
    autocapitalize: "none",
    spellcheck: "false",
    "aria-describedby": "confirmHint",
  });
  const notice = errorNotice();
  const confirm = h("button", { type: "submit", class: "sq-btn sq-btn-danger", disabled: true }, COPY.deleteConfirm);
  input.addEventListener("input", () => {
    confirm.disabled = input.value.trim() !== name;
  });
  const handle = openDialog({
    title,
    render: (close) => {
      const form = h(
        "form",
        { class: "sq-field", novalidate: true },
        h("p", null, body),
        h("label", { class: "sq-label", for: "confirmName" }, COPY.deleteTypeName),
        h("p", { class: "sq-hint", id: "confirmHint" }, h("code", { class: "sq-token" }, name)),
        input,
        notice,
        h("div", { class: "sq-dialog-actions" }, h("button", { type: "button", class: "sq-btn", onclick: close }, COPY.cancel), confirm),
      );
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (input.value.trim() !== name) return;
        void busy(confirm, async () => {
          try {
            await api(path, { method: "DELETE" });
            close();
            toast(doneToast);
            onDone?.();
          } catch (error) {
            const presented = presentError(error);
            if (presented.next === NEXT.reauth) {
              setDialogContent(handle, [
                h("p", null, COPY.reauthBody),
                h(
                  "div",
                  { class: "sq-dialog-actions" },
                  h("button", { type: "button", class: "sq-btn", onclick: close }, COPY.cancel),
                  shell.signInUrl ? h("a", { class: "sq-btn sq-btn-primary", href: shell.signInUrl }, COPY.signInAgain) : null,
                ),
              ]);
              const heading = handle.body.querySelector("h2");
              if (heading) heading.textContent = COPY.reauthTitle;
              handle.body.querySelector("a.sq-btn-primary, button")?.focus();
              return;
            }
            const message = shell.handleError(error);
            if (message === null) close();
            else show(notice, message);
          }
        });
      });
      return [form];
    },
  });
  input.focus();
  return handle;
}

/** Resize: presets only, while stopped. The disk never shrinks. */
export function resizeDialog(ctx) {
  const { api, shell, instance, sizes, onDone } = ctx;
  const spec = instance.spec;
  const notice = errorNotice();
  const current = sizes.find((s) => s.vcpu === spec.vcpu && s.memoryMb === spec.memoryMb);
  const choices = sizes.map((s) =>
    h(
      "label",
      { class: "sq-choice" },
      h("input", { type: "radio", name: "size", value: s.id, checked: current ? s.id === current.id : false }),
      h(
        "span",
        { class: "sq-choice-body" },
        h("span", { class: "sq-choice-title" }, s.name),
        h("span", { class: "sq-choice-sub" }, sizeDetail({ ...s, diskGb: Math.max(s.diskGb, spec.diskGb) })),
        current?.id === s.id ? h("span", { class: "sq-choice-sub" }, COPY.currentSize) : null,
      ),
    ),
  );
  const confirm = h("button", { type: "submit", class: "sq-btn sq-btn-primary" }, COPY.resizeConfirm);
  return openDialog({
    title: COPY.resizeTitle,
    render: (close) => {
      const form = h(
        "form",
        { class: "sq-field", novalidate: true },
        h("p", null, COPY.resizeBody),
        h("fieldset", { class: "sq-field" }, h("legend", { class: "sq-sr" }, COPY.sizeLabel), h("div", { class: "sq-choices" }, choices)),
        notice,
        h("div", { class: "sq-dialog-actions" }, h("button", { type: "button", class: "sq-btn", onclick: close }, COPY.cancel), confirm),
      );
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const chosen = sizes.find((s) => s.id === new FormData(form).get("size"));
        if (!chosen || (chosen.vcpu === spec.vcpu && chosen.memoryMb === spec.memoryMb && chosen.diskGb <= spec.diskGb)) {
          show(notice, COPY.resizeSame);
          return;
        }
        const request = { action: "resize", vcpu: chosen.vcpu, memoryMb: chosen.memoryMb };
        if (chosen.diskGb > spec.diskGb) request.diskGb = chosen.diskGb;
        void busy(confirm, async () => {
          try {
            await api(`/console/v1/instances/${instance.id}/actions`, { method: "POST", body: request });
            close();
            toast(COPY.resizedToast);
            onDone?.();
          } catch (error) {
            const message = shell.handleError(error);
            if (message === null) close();
            else show(notice, message);
          }
        });
      });
      return [form];
    },
  });
}

/** Take a snapshot with a suggested name. */
export function snapshotDialog(ctx) {
  const { api, shell, instance, onDone } = ctx;
  const notice = errorNotice();
  const input = h("input", {
    id: "snapshotName",
    class: "sq-input",
    value: suggestSnapshotName(),
    maxlength: "40",
    autocomplete: "off",
    autocapitalize: "none",
    spellcheck: "false",
  });
  const confirm = h("button", { type: "submit", class: "sq-btn sq-btn-primary" }, COPY.snapshotConfirm);
  return openDialog({
    title: COPY.snapshotTitle,
    render: (close) => {
      const form = h(
        "form",
        { class: "sq-field", novalidate: true },
        h("p", null, COPY.snapshotBody),
        h("label", { class: "sq-label", for: "snapshotName" }, COPY.snapshotNameLabel),
        input,
        notice,
        h("div", { class: "sq-dialog-actions" }, h("button", { type: "button", class: "sq-btn", onclick: close }, COPY.cancel), confirm),
      );
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const name = input.value.trim();
        if (!SNAPSHOT_NAME_RE.test(name)) {
          show(notice, COPY.snapshotNameInvalid);
          input.focus();
          return;
        }
        void busy(confirm, async () => {
          try {
            await api(`/console/v1/instances/${instance.id}/snapshots`, { method: "POST", body: { name } });
            close();
            toast(COPY.snapshotToast);
            onDone?.();
          } catch (error) {
            const message = shell.handleError(error);
            if (message === null) close();
            else show(notice, message);
          }
        });
      });
      return [form];
    },
  });
}
