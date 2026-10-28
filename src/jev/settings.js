// ─────────────────────────────────────────────────────────────────────────────
// JEV settings and credentials.
//
// The doc's transport decision (docs/jev.md): per-user keys only, session-only by
// default, persistent storage only after an explicit "remember on this browser"
// choice — and then in the BROWSER's localStorage, never in extension_settings,
// presets, profiles, logs or error text. So:
//
//   session    memory in this page (gone on reload)      ← default
//   remembered localStorage under STORAGE_KEY            ← explicit opt-in
//   never      getSettings() / the profile / the log
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
    model: "jev-1.14.0",  // pinned: thresholds are only valid for the model they were tuned on
    rememberKey: false,   // shown in the UI; the key itself lives in localStorage when true
    shadow: true,         // force every feature into shadow regardless of its own mode
    logRaw: false,        // opt-in fixtures: keep the exact state sent, not just metadata
    vision: false,        // experimental (Dreamer-era) image input
    timeoutMs: 12000,
    maxCalls: 16,         // per user turn; a runaway turn should not become a bill
    contextBudget: 900,   // optional-context token budget for proposal 22 (0 = no budgeting)
    features: {},         // { [featureId]: "off" | "shadow" | "on" }
};

// The page session's key. Deliberately module state, not settings.
let sessionKey = "";

export function jevSettings() {
    const store = extension_settings[extensionName];
    if (!store) return { ...DEFAULTS, features: { ...DEFAULTS.features } };
    if (!store.globalSettings) store.globalSettings = {};
    const s = store.globalSettings;
    if (!s.jev || typeof s.jev !== "object") s.jev = {};
    const jev = s.jev;
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (k === "features") continue;
        if (jev[k] === undefined) jev[k] = v;
    }
    if (!jev.features || typeof jev.features !== "object") jev.features = {};
    return jev;
}

// ── Credentials ─────────────────────────────────────────────────────────────

function storage() {
    try {
        return typeof localStorage !== "undefined" ? localStorage : null;
    } catch (e) {
        return null; // a locked-down browser: the session key still works
    }
}

export function getJevKey() {
    if (sessionKey) return sessionKey;
    if (!jevSettings().rememberKey) return "";
    const ls = storage();
    if (!ls) return "";
    try { return String(ls.getItem(STORAGE_KEY) || "").trim(); } catch (e) { return ""; }
}

/** Store a key. `remember` persists it in this browser's localStorage; otherwise it
 *  is kept for the session and any remembered copy is removed. */
export function setJevKey(key, remember = false) {
    const value = String(key || "").trim();
    sessionKey = value;
    jevSettings().rememberKey = Boolean(remember);
    const ls = storage();
    if (!ls) return;
    try {
        if (remember && value) ls.setItem(STORAGE_KEY, value);
        else ls.removeItem(STORAGE_KEY);
    } catch (e) {
        console.warn(`[${extensionName}] Could not store the JEV key in this browser.`, e);
    }
}

export function clearJevKey() {
    sessionKey = "";
    jevSettings().rememberKey = false;
    const ls = storage();
    if (!ls) return;
    try { ls.removeItem(STORAGE_KEY); } catch (e) { /* nothing to remove */ }
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
