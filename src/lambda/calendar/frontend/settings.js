/**
 * settings.js - client logic for the settings page.
 *
 * TASK-013 adds the "Disconnect Gmail" control. TASK-010 owns the rest of this
 * page (school name, search domains, schedule) - add to this module rather than
 * replacing it.
 *
 * Vanilla ES module, no build step and no CDN dependency: the Lambda is the only
 * origin this page loads from.
 *
 * NO `innerHTML`. Every string that reaches the DOM here goes through
 * `textContent`, including the ones this file authored itself - the rule is
 * worth more as a habit with no exceptions than as a judgement call made per
 * string.
 *
 * The pure helpers are exported so the confirmation rules can be proved without
 * a DOM, and `initDisconnectControl` takes its element root and its `fetch` as
 * parameters so it can be driven against any DOM implementation.
 */

/** Where the disconnect request goes. Mirrors AUTH_DISCONNECT_PATH in index.mjs. */
export const DISCONNECT_ENDPOINT = "/calendar/api/auth/disconnect";

/**
 * The phrase the user must type, per choice.
 *
 * TWO DIFFERENT PHRASES ON PURPOSE. A single phrase would let someone type it
 * while "keep my calendar" is selected, change their mind, switch to "delete
 * everything" and submit - with the confirmation for the milder action standing
 * in for the irreversible one. Changing the choice invalidates the typed text,
 * so the destructive option is always confirmed on its own terms.
 */
export const CONFIRM_PHRASE_KEEP = "DISCONNECT";
export const CONFIRM_PHRASE_DELETE = "DELETE MY EVENTS";

/**
 * Which phrase applies to a choice.
 *
 * @param {boolean} deleteEvents
 * @returns {string}
 */
export function requiredConfirmation(deleteEvents) {
  return deleteEvents === true ? CONFIRM_PHRASE_DELETE : CONFIRM_PHRASE_KEEP;
}

/**
 * Has the user typed the phrase this choice requires?
 *
 * Surrounding whitespace is forgiven (a paste or a mobile keyboard adds it);
 * case is NOT. A confirmation that accepts "delete my events" is a confirmation
 * you can type without noticing, which is the opposite of the point.
 *
 * Anything that is not a string is false, so an absent input element - a page
 * whose markup drifted - cannot read as "confirmed".
 *
 * @param {unknown} typed
 * @param {boolean} deleteEvents
 * @returns {boolean}
 */
export function isConfirmed(typed, deleteEvents) {
  if (typeof typed !== "string") return false;
  return typed.trim() === requiredConfirmation(deleteEvents);
}

/**
 * The request body for a disconnect.
 *
 * `deleteEvents` is always sent explicitly, and always as a real boolean, so the
 * server never has to infer intent from an absent field.
 *
 * @param {boolean} deleteEvents
 * @returns {{ deleteEvents: boolean }}
 */
export function disconnectRequestBody(deleteEvents) {
  return { deleteEvents: deleteEvents === true };
}

/**
 * Turn a disconnect response body into the sentence the user sees.
 *
 * `eventsDeleteComplete: false` is reported, not smoothed over: it means rows
 * may still be there, and a page that says "all your events were deleted"
 * anyway would be lying about the one thing the user came here to be sure of.
 *
 * @param {object} result Parsed 200 body from the disconnect route.
 * @returns {string}
 */
export function disconnectSummary(result) {
  const parts = [];
  parts.push(
    result?.revoked === true
      ? "Access to your Gmail account has been revoked."
      : "There was no stored Gmail authorisation to revoke."
  );
  const deleted = Number.isFinite(result?.eventsDeleted) ? result.eventsDeleted : 0;
  if (result?.eventsDeleteComplete === false) {
    parts.push(`${deleted} event(s) were deleted, but some may remain. Please try disconnecting again.`);
  } else if (deleted > 0) {
    parts.push(`${deleted} event(s) were deleted.`);
  } else {
    parts.push("Your calendar was kept.");
  }
  return parts.join(" ");
}

/**
 * Wire the disconnect section up.
 *
 * Returns null (rather than throwing) when the section is not on the page, so
 * this can be called unconditionally from a shared settings bootstrap.
 *
 * @param {object} [options]
 * @param {Document|Element} [options.root] Where to look the elements up.
 * @param {(url: string, init: object) => Promise<any>} [options.fetchImpl]
 * @param {(result: object) => void} [options.onDisconnected] Called after a 200.
 * @returns {object|null} The bound elements and a `refresh` for tests.
 */
export function initDisconnectControl({ root = globalThis.document, fetchImpl, onDisconnected } = {}) {
  if (!root || typeof root.querySelector !== "function") return null;

  const section = root.querySelector("#disconnect-gmail");
  const deleteRadio = root.querySelector("#disconnect-events-delete");
  const keepRadio = root.querySelector("#disconnect-events-keep");
  const phrase = root.querySelector("#disconnect-confirm-phrase");
  const confirmInput = root.querySelector("#disconnect-confirm");
  const submit = root.querySelector("#disconnect-submit");
  const status = root.querySelector("#disconnect-status");
  if (!section || !deleteRadio || !keepRadio || !confirmInput || !submit) return null;

  const wantsDelete = () => deleteRadio.checked === true;

  const setStatus = (text) => {
    // textContent, never innerHTML - see the module docblock.
    if (status) status.textContent = text;
  };

  const refresh = () => {
    if (phrase) phrase.textContent = requiredConfirmation(wantsDelete());
    // The button is the gate. It starts disabled in the markup too, so a page
    // whose script failed to load cannot submit an unconfirmed disconnect.
    submit.disabled = !isConfirmed(confirmInput.value, wantsDelete());
  };

  const onChoiceChange = () => {
    // Switching choice invalidates the confirmation: the phrase it matched was
    // for the other action.
    confirmInput.value = "";
    setStatus("");
    refresh();
  };

  confirmInput.addEventListener("input", refresh);
  deleteRadio.addEventListener("change", onChoiceChange);
  keepRadio.addEventListener("change", onChoiceChange);

  submit.addEventListener("click", async () => {
    const deleteEvents = wantsDelete();
    // Re-checked at submit time, not trusted from the disabled attribute: the
    // attribute is a hint to the user, this is the actual gate.
    if (!isConfirmed(confirmInput.value, deleteEvents)) {
      refresh();
      return;
    }

    submit.disabled = true;
    setStatus("Disconnecting...");

    const doFetch = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
    let response;
    try {
      response = await doFetch(DISCONNECT_ENDPOINT, {
        method: "POST",
        // The session cookie is the only credential; without this the request
        // is unauthenticated and comes back 401.
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(disconnectRequestBody(deleteEvents)),
      });
    } catch {
      setStatus("Could not reach the server. Nothing was changed - please try again.");
      refresh();
      return;
    }

    if (!response?.ok) {
      // 502 is the retryable one: the grant could not be revoked and NOTHING was
      // deleted, which is exactly what the user needs to be told.
      setStatus(
        response?.status === 502
          ? "Google could not be reached to revoke access. Nothing was deleted - please try again."
          : "Could not disconnect your Google account. Please try again."
      );
      refresh();
      return;
    }

    let result = null;
    try {
      result = await response.json();
    } catch {
      result = null;
    }
    setStatus(disconnectSummary(result || {}));
    if (typeof onDisconnected === "function") onDisconnected(result || {});
  });

  refresh();
  return { section, deleteRadio, keepRadio, confirmInput, submit, status, refresh };
}

// Auto-wire when loaded in a browser. Guarded so importing this module in a test
// runner (no document) is inert.
if (typeof globalThis.document !== "undefined" && globalThis.document !== null) {
  initDisconnectControl();
}
