// ─────────────────────────────────────────────────────────────────────────────
// JEV settings and credentials.
//
// Everything lives where the rest of the extension keeps its settings: in
// `extension_settings[extensionName].globalSettings.jev`, i.e. this user's
// server-side settings.json. That is what makes the provider, model and the
// provider key follow the account across sessions and browsers.
//
// The key is therefore plaintext at rest in the SillyTavern data directory, it
// is part of the settings file and its backups, and it is sent to the browser on
// page load like every other setting. This is a deliberate change from
// docs/jev.md's original "never in extension_settings" rule, requested by the
// maintainer. What still never happens: the key is not copied into extension
// profiles, presets, the decision log, diagnostics exports, or error text.
//
// `getSettings()` hands back the live object the settings tab writes to; every
// field is defaulted here so a feature never has to guess whether it is set.
// ─────────────────────────────────────────────────────────────────────────────

import { extension_settings } from "../st.js";
import { extensionName } from "../core/constants.js";

const STORAGE_KEY = "megumin_jev_key";

// There is no shadow mode and no per-feature setting: enabling the runtime
// enables every decision, disabling it runs none of them.

const DEFAULTS = {
    enabled: false,       // master switch for the whole runtime
    optIn: false,         // explicit consent to send story text to a third party
    provider: "openrouter",
    model: "jev-1.13",    // documented System One id on OpenRouter; the response reports what served it
    key: "",              // server-side, like every other JEV setting
    logRaw: false,        // opt-in fixtures: keep the exact state sent, not just metadata
    vision: false,        // experimental (Dreamer-era) image input
    timeoutMs: 12000,
    maxCalls: 16,         // per user turn; a runaway turn should not become a bill
    contextBudget: 900,   // optional-context token budget for proposal 22 (0 = no budgeting)
};

// The provider key lives in jevSettings().key like every other JEV setting.

export function jevSettings() {
    const store = extension_settings[extensionName];
    if (!store) return { ...DEFAULTS };
    if (!store.globalSettings) store.globalSettings = {};
    const s = store.globalSettings;
    if (!s.jev || typeof s.jev !== "object") s.jev = {};
    const jev = s.jev;
    // Earlier builds offered per-tab/browser key storage and per-feature modes;
    // both are gone, so those flags are stale (the browser key is lifted once).
    delete jev.keyStorage;
    delete jev.rememberKey;
    delete jev.shadow;
    delete jev.features;
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (jev[k] === undefined) jev[k] = v;
    }
    // `jev-1.14.0` came from TypeSafe's model list but is not an id OpenRouter's
    // System One API accepts (400 "Model ... does not exist"); 1.13 is the id its
    // own System One example uses. Move the broken value once.
    if (jev.model === "jev-1.14.0" || jev.model === "jev-latest") jev.model = "jev-1.13";
    return jev;
}

// ── Credentials ─────────────────────────────────────────────────────────────

function storage() {
    try {
        return typeof localStorage !== "undefined" ? localStorage : null;
    } catch (e) {
        return null; // no browser storage: nothing to migrate or clean up
    }
}

function clearBrowserCopy() {
    const ls = storage();
    if (!ls) return;
    try { ls.removeItem(STORAGE_KEY); } catch (e) { /* nothing to remove */ }
}

export function getJevKey() {
    return String(jevSettings().key || "").trim();
}

/** Store the key in this user's server-side settings. */
export function setJevKey(key) {
    jevSettings().key = String(key || "").trim();
    clearBrowserCopy();
}

/** One-time lift of a key left in this browser by the earlier localStorage mode. */
export function migrateBrowserKeyToServer() {
    const s = jevSettings();
    const ls = storage();
    if (!ls) return false;
    let stored = "";
    try { stored = String(ls.getItem(STORAGE_KEY) || "").trim(); } catch (e) { stored = ""; }
    if (!stored) return false;
    const changed = !s.key;
    if (changed) s.key = stored;
    clearBrowserCopy();
    return changed;
}

export function clearJevKey() {
    jevSettings().key = "";
    clearBrowserCopy();
}

/** Last four characters only. Never the key. */
export function keyHint() {
    const key = getJevKey();
    return key ? `••••${key.slice(-4)}` : "";
}

// ── Feature modes ───────────────────────────────────────────────────────────

/** One answer for every decision: on when the runtime is ready, off otherwise. */
export function featureMode() {
    return jevReady() ? "on" : "off";
}

export function jevReady() {
    const s = jevSettings();
    return Boolean(s.enabled && s.optIn && getJevKey());
}

export function jevUnavailableReason() {
    const s = jevSettings();
    if (!s.enabled) return "off";
    if (!s.optIn) return "no-consent";
    if (!getJevKey()) return "no-key";
    return "";
}

export function thresholdFor(id, fallback) {
    const s = jevSettings();
    const t = s.thresholds && s.thresholds[id];
    return Number.isFinite(t) ? t : fallback;
}
