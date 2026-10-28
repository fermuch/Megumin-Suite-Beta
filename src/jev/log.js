// ─────────────────────────────────────────────────────────────────────────────
// The decision log (docs/jev.md proposal 4).
//
// What this is FOR: every adoption decision in the doc is "does this judgment
// agree with the current behaviour on OUR chats?" That needs a record of what was
// asked, what came back, what policy did with it, and whether the user agrees.
//
// What this deliberately is NOT: a transcript. Entries carry metadata only —
// feature, versions, model, answers, route, latency, tokens. The state that was
// sent (story text) is dropped before writing unless the user turns on "keep
// fixtures". Nothing here can contain the API key: the key never enters these
// functions.
//
// Storage mirrors the background-prompt log: SillyTavern's localforage, a capped
// list, one write chain. Losing the log is not a behaviour change.
// ─────────────────────────────────────────────────────────────────────────────

const LOG_KEY = "megumin_jev_decisions";
const MAX_ENTRIES = 400;

let writing = Promise.resolve();
let counter = 0;

function store() {
    return (typeof window !== "undefined" && window.localforage) || null;
}

function newId() {
    counter += 1;
    const rand = (typeof crypto !== "undefined" && crypto.randomUUID)
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
    return `${Date.now().toString(36)}-${counter}-${rand}`;
}

export async function readDecisions() {
    const lf = store();
    if (!lf) return [];
    try {
        const v = await lf.getItem(LOG_KEY);
        return Array.isArray(v) ? v : [];
    } catch (e) {
        return [];
    }
}

function write(list) {
    const lf = store();
    if (!lf) return;
    writing = writing.then(async () => {
        try { await lf.setItem(LOG_KEY, list.slice(0, MAX_ENTRIES)); }
        catch (e) { console.warn("[Megumin-Suite] Could not save the JEV decision log.", e); }
    });
}

/**
 * Record one judgment.
 * @param {object} entry
 * @param {string} entry.feature
 * @param {string} entry.mode        "on"; there is no shadow mode
 * @param {number} entry.version     question-set version
 * @param {string} entry.provider
 * @param {string} entry.model       the model the provider reported
 * @param {object} [entry.answers]   validated answers, as returned
 * @param {any}    [entry.route]     what policy proposed
 * @param {any}    [entry.current]   what the suite would have done without JEV
 * @param {number} [entry.confidence]
 * @param {number} [entry.latencyMs]
 * @param {object} [entry.usage]
 * @param {string} [entry.fallback]  why the current path was used, when it was
 * @param {any}    [entry.raw]       state sent — stored only with the fixture toggle
 * @param {boolean} [entry.keepRaw]
 * @param {string} [entry.note]
 */
export async function recordDecision(entry) {
    if (!entry || !entry.feature) return null;
    const id = newId();
    const row = {
        id,
        at: Date.now(),
        feature: entry.feature,
        mode: entry.mode || "on",
        version: entry.version || 0,
        provider: entry.provider || "",
        model: entry.model || "",
        confidence: Number.isFinite(entry.confidence) ? entry.confidence : null,
        route: entry.route ?? null,
        current: entry.current ?? null,
        reason: entry.reason || "",
        answers: entry.answers || null,
        latencyMs: Number.isFinite(entry.latencyMs) ? entry.latencyMs : null,
        usage: entry.usage || null,
        fallback: entry.fallback || "",
        note: entry.note || "",
        raw: entry.keepRaw ? entry.raw ?? null : null,
        label: null,
        labelledAt: null,
    };
    const list = await readDecisions();
    list.unshift(row);
    write(list);
    return id;
}

/** The user's accept/reject label on one entry. */
export async function labelDecision(id, label) {
    if (label !== "accept" && label !== "reject" && label !== null) return false;
    const list = await readDecisions();
    const row = list.find(r => r.id === id);
    if (!row) return false;
    row.label = label;
    row.labelledAt = label ? Date.now() : null;
    write(list);
    return true;
}

export async function clearDecisions() {
    const lf = store();
    if (lf) { try { await lf.removeItem(LOG_KEY); } catch (e) { /* nothing to clear */ } }
}

/** Per-feature counts: how often JEV's proposal matched the current route, and
 *  how the user labelled the decisions they were shown. */
export function summarise(list) {
    const by = new Map();
    for (const row of list || []) {
        if (!by.has(row.feature)) by.set(row.feature, { feature: row.feature, total: 0, agreed: 0, disagreed: 0, accept: 0, reject: 0, fallback: 0, lastAt: 0 });
        const s = by.get(row.feature);
        s.total += 1;
        s.lastAt = Math.max(s.lastAt, row.at || 0);
        if (row.fallback) s.fallback += 1;
        else if (row.route !== null && row.current !== null && JSON.stringify(row.route) === JSON.stringify(row.current)) s.agreed += 1;
        else if (row.route !== null) s.disagreed += 1;
        if (row.label === "accept") s.accept += 1;
        if (row.label === "reject") s.reject += 1;
    }
    return [...by.values()].sort((a, b) => a.feature.localeCompare(b.feature));
}

/**
 * A diagnostics object. The key is never present; raw state only when the
 * fixture toggle is on (and even then only for rows that captured it).
 */
export function exportBundle(list, { includeRaw = false } = {}) {
    return {
        kind: "megumin-jev-decisions",
        version: 1,
        exportedAt: new Date().toISOString(),
        entries: (list || []).map(row => {
            const copy = { ...row };
            if (!includeRaw) delete copy.raw;
            return copy;
        }),
    };
}
