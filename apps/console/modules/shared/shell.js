/**
 * What both pages share: redeeming a Cloud launch, the signed-out state,
 * the "Sign in again" dialog, the account area in the header and loading
 * and error states.
 */

import { COPY } from "./copy.js";
import { h, mount } from "./dom.js";
import { NEXT, presentError } from "./errors.js";
import { openDialog } from "./ui.js";

/** Only `<base>/` and its hash routes are places a launch may return to. */
export function safeReturnPath(base, returnPath) {
  return typeof returnPath === "string" && (returnPath === `${base}/` || returnPath.startsWith(`${base}/#/`))
    ? returnPath
    : `${base}/`;
}

/** The grant in a launch URL's fragment (`#grant=…`), or null. */
export function grantFromHash(hash) {
  const match = /^#grant=([A-Za-z0-9_-]{1,200})$/.exec(hash ?? "");
  return match ? match[1] : null;
}

/**
 * The shell of one page.
 * @param {{ base: "/console" | "/admin", surface: "console" | "admin", api: Function }} options
 */
export function createShell({ base, surface, api }) {
  const main = /** @type {HTMLElement} */ (document.getElementById("main"));
  const account = /** @type {HTMLElement} */ (document.getElementById("account"));
  let signInUrl = null;

  async function loadStatus() {
    try {
      const status = await api(`${base}/v1/auth/status`);
      signInUrl = typeof status.signInUrl === "string" && /^https?:\/\//.test(status.signInUrl) ? status.signInUrl : null;
      if (signInUrl) {
        const home = document.getElementById("brandHome");
        if (home instanceof HTMLAnchorElement) home.href = new URL(signInUrl).origin + "/";
      }
      return status;
    } catch {
      return {};
    }
  }

  function signInLink(primary = true) {
    if (!signInUrl) return null;
    return h(
      "a",
      { class: `sq-btn ${primary ? "sq-btn-primary" : ""}`, href: signInUrl },
      surface === "admin" ? COPY.openFromOps : COPY.openFromCloud,
    );
  }

  function centered(title, body, ...actions) {
    mount(main, h("div", { class: "sq-center" }, h("div", { class: "sq-card" }, h("h1", null, title), h("p", null, body), ...actions)));
    main.focus();
  }

  function renderSignedOut() {
    account.hidden = true;
    centered(
      COPY.signedOutTitle,
      surface === "admin" ? COPY.signedOutAdminBody : signInUrl ? COPY.signedOutBody : COPY.signedOutNoLink,
      signInLink(),
    );
  }

  /** Redeem the grant in the fragment, then go to the page. */
  async function redeemLaunch() {
    const grant = grantFromHash(location.hash);
    // The grant must not stay in the address bar or history.
    history.replaceState(null, "", `${base}/launch`);
    mount(main, h("div", { class: "sq-center", role: "status" }, h("div", { class: "sq-card" }, h("span", { class: "sq-spinner", "aria-hidden": "true" }), h("p", null, COPY.signingIn))));
    if (!grant) {
      centered(COPY.launchFailedTitle, COPY.launchFailedBody, signInLink());
      return;
    }
    try {
      const res = await api(`${base}/v1/auth/cloud-launch/redeem`, { method: "POST", body: { grant } });
      location.replace(safeReturnPath(base, res.returnPath));
    } catch (error) {
      const { message } = presentError(error, { surface });
      centered(COPY.launchFailedTitle, message, signInLink());
    }
  }

  function showAccount(name) {
    const signOut = h("button", { type: "button", class: "sq-btn sq-btn-quiet sq-btn-small" }, COPY.signOut);
    signOut.addEventListener("click", async () => {
      try {
        await api(`${base}/v1/auth/logout`, { method: "POST" });
      } catch {
        // Signed out either way: the cookie is cleared or already gone.
      }
      renderSignedOut();
    });
    mount(account, name ? h("span", null, name) : null, signOut);
    account.hidden = false;
  }

  /** The "Sign in again" dialog for a write refused by the 15-minute rule. */
  function reauthDialog(kind = "delete") {
    const title = kind === "delete" ? COPY.reauthTitle : COPY.reauthAdminTitle;
    const body = kind === "delete" ? COPY.reauthBody : COPY.reauthAdminBody;
    return openDialog({
      title,
      render: (close) => [
        h("p", null, body),
        h(
          "div",
          { class: "sq-dialog-actions" },
          h("button", { type: "button", class: "sq-btn", onclick: close }, COPY.cancel),
          signInUrl
            ? h("a", { class: "sq-btn sq-btn-primary", href: signInUrl }, COPY.signInAgain)
            : null,
        ),
      ],
    });
  }

  /**
   * Handle an error from a user action: the session ended, a stale sign-in,
   * or a plain sentence. Returns the sentence when the caller shows it.
   */
  function handleError(error, { reauthKind = "delete" } = {}) {
    const presented = presentError(error, { surface });
    if (presented.next === NEXT.signIn) {
      renderSignedOut();
      return null;
    }
    if (presented.next === NEXT.reauth) {
      reauthDialog(reauthKind);
      return null;
    }
    return presented.message;
  }

  function loadingState() {
    return h(
      "div",
      { class: "sq-card", role: "status", "aria-live": "polite" },
      h("span", { class: "sq-sr" }, COPY.loading),
      h("div", { class: "sq-skeleton", "aria-hidden": "true" }, h("span"), h("span"), h("span")),
    );
  }

  function errorState(error, retry) {
    const message = handleError(error);
    if (message === null) return null;
    return h(
      "div",
      { class: "sq-card sq-state sq-state-error", role: "alert" },
      h("p", null, message),
      h("button", { type: "button", class: "sq-btn", onclick: retry }, COPY.retry),
    );
  }

  return {
    main,
    get signInUrl() {
      return signInUrl;
    },
    loadStatus,
    redeemLaunch,
    renderSignedOut,
    showAccount,
    reauthDialog,
    handleError,
    loadingState,
    errorState,
  };
}
