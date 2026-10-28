// ─────────────────────────────────────────────────────────────────────────────
// JEV settings and credentials.
//
// Everything lives where the rest of the extension keeps its settings: in
// `extension_settings[extensionName].globalSettings.jev`, i.e. this user's
// server-side settings.json. That is what makes features, provider, model,
// shadow mode and the provider key follow the account across sessions and
// browsers.
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

// Feature mode values. "shadow" runs the judgment and logs it without acting; it
// is the rollout state every proposal must go through before "on".
export const MODES = ["off", "shadow", "on"];

const DEFAULTS = {
    enabled: false,       // master switch for the whole runtime
    optIn: false,         // explicit consent to send story text to a third party
    provider: "openrouter",
    model: "jev-1.13",    // documented System One id on OpenRouter; the response reports what served it
    key: "",              // server-side, like every other JEV setting
    shadow: true,         // force every feature into shadow regardless of its own mode
    logRaw: false,        // opt-in fixtures: keep the exact state sent, not just metadata
    vision: false,        // experimental (Dreamer-era) image input
    timeoutMs: 12000,
    maxCalls: 16,         // per user turn; a runaway turn should not become a bill
    contextBudget: 900,   // optional-context token budget for proposal 22 (0 = no budgeting)
    features: {},         // { [featureId]: "off" | "shadow" | "on" }
};

// The provider key lives in jevSettings().key like every other JEV setting.

export function jevSettings() {
    const store = extension_settings[extensionName];
    if (!store) return { ...DEFAULTS, features: { ...DEFAULTS.features } };
    if (!store.globalSettings) store.globalSettings = {};
    const s = store.globalSettings;
    if (!s.jev || typeof s.jev !== "object") s.jev = {};
    const jev = s.jev;
    // Earlier builds offered per-tab/browser key storage; the key is server-side
    // now, so those flags are stale (the key itself is lifted in the UI once).
    delete jev.keyStorage;
    delete jev.rememberKey;
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (k === "features") continue;
        if (jev[k] === undefined) jev[k] = v;
    }
    if (!jev.features || typeof jev.features !== "object") jev.features = {};
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

export function featureMode(id) {
    const s = jevSettings();
    if (!s.enabled || !s.optIn || !getJevKey()) return "off";
    const own = MODES.includes(s.features[id]) ? s.features[id] : "shadow";
    if (own === "off") return "off";
    // The global shadow switch outranks a feature's "on": the rollout gate is the
    // whole point of it, and a per-feature toggle must not be able to skip it.
    return s.shadow ? "shadow" : own;
}

export function setFeatureMode(id, mode) {
    const s = jevSettings();
    s.features[id] = MODES.includes(mode) ? mode : "shadow";
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
