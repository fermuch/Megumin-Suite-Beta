// ─────────────────────────────────────────────────────────────────────────────
// The JEV provider boundary.
//
// Two browser-reachable routes share one internal contract (docs/jev.md §Transport):
//
//   openrouter  POST https://openrouter.ai/api/v1/systemone   TypeSafe shape as-is
//   vercel      POST https://ai-gateway.vercel.sh/v1/evaluate  `boolean` + `probability`
//
// Feature code never learns a provider quirk: everything below normalises to
// { noul } | { choice, probabilities, confidence } | { score, probabilities, confidence }
// and validates it. A malformed answer is dropped on its own — the other answers in
// the same response stay usable — and a failed request throws a JevError whose
// message never contains the key or any story text.
//
// No SDK and no build step: `fetch` + `AbortController`, exactly what the extension
// already has.
// ─────────────────────────────────────────────────────────────────────────────

import { getJevKey, jevSettings, jevUnavailableReason } from "./settings.js";

export class JevError extends Error {
    constructor(kind, message = "") {
        super(message || kind);
        this.name = "JevError";
        this.kind = kind; // disabled | no-consent | no-key | network | http | aborted | malformed | budget
    }
}

const OPENROUTER = {
    id: "openrouter",
    label: "OpenRouter · System One",
    url: "https://openrouter.ai/api/v1/systemone",
    keyHint: "OpenRouter key (sk-or-…)",
    wireType: t => t,
    model: m => m || "jev-1.14.0",
    answers: body => body && body.answers,
};

// The AI Gateway speaks AI SDK's evaluation shape: `boolean`/`probability` instead
// of `noul`/`noul`, and a single model id rather than TypeSafe's versioned ones.
const VERCEL = {
    id: "vercel",
    label: "Vercel AI Gateway",
    url: "https://ai-gateway.vercel.sh/v1/evaluate",
    keyHint: "AI Gateway key",
    wireType: t => (t === "noul" ? "boolean" : t),
    model: () => "typesafe-ai/jev",
    answers: body => (body && body.answers) || (body && body.results) || null,
};

const PROVIDERS = { openrouter: OPENROUTER, vercel: VERCEL };

export function jevProviderList() {
    return Object.values(PROVIDERS).map(p => ({ id: p.id, label: p.label, url: p.url, keyHint: p.keyHint }));
}

export function jevProvider() {
    const s = jevSettings();
    return PROVIDERS[s.provider] || OPENROUTER;
}

// ── Validation ──────────────────────────────────────────────────────────────

const finite = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
const clamp01 = v => Math.max(0, Math.min(1, v));

/** Confidence from the spread of a distribution, for answers that omit it.
 *  One peak ⇒ 1; evenly spread ⇒ 0. Matches the documented summary. */
function confidenceOf(probabilities) {
    const values = Object.values(probabilities).filter(v => v > 0);
    if (values.length <= 1) return values.length === 1 ? 1 : 0;
    const h = -values.reduce((sum, p) => sum + p * Math.log(p), 0);
    return clamp01(1 - h / Math.log(Object.keys(probabilities).length));
}

/** Accepts {a:0.2,b:0.8} or [0.2,0.8]; requires every declared key, sums to 1. */
function normalizeProbabilities(raw, keys) {
    if (!raw) return null;
    const out = {};
    if (Array.isArray(raw)) {
        if (raw.length !== keys.length) return null;
        keys.forEach((k, i) => { out[k] = finite(raw[i]); });
    } else if (typeof raw === "object") {
        for (const k of keys) {
            const v = finite(raw[k]);
            out[k] = v === null ? 0 : v;
        }
    } else return null;
    for (const k of keys) {
        const v = out[k];
        if (v === null || v < 0 || v > 1) return null;
    }
    const sum = keys.reduce((n, k) => n + out[k], 0);
    if (Math.abs(sum - 1) > 0.03) return null;
    return out;
}

/**
 * One answer, validated against the question that was asked.
 * @returns {{answer: object}|{error: string}}
 */
function normalizeAnswer(type, raw, criteria) {
    if (!raw || typeof raw !== "object") return { error: "missing answer" };
    if (type === "noul") {
        const v = finite(raw.noul) !== null ? raw.noul : finite(raw.probability);
        if (v === null || v < 0 || v > 1) return { error: "noul out of range" };
        return { answer: { type: "noul", noul: v } };
    }
    if (type === "choice") {
        const keys = Object.keys(criteria || {});
        if (!keys.length) return { error: "no options declared" };
        const choice = String(raw.choice ?? raw.value ?? "");
        if (!keys.includes(choice)) return { error: "choice outside options" };
        const probabilities = normalizeProbabilities(raw.probabilities, keys);
        if (!probabilities) return { error: "choice probabilities invalid" };
        const reported = finite(raw.confidence);
        const confidence = reported !== null ? clamp01(reported) : confidenceOf(probabilities);
        return { answer: { type: "choice", choice, probabilities, confidence } };
    }
    if (type === "score") {
        const levels = Array.isArray(criteria) ? criteria.length : 0;
        if (levels < 2) return { error: "no levels declared" };
        const score = finite(raw.score);
        if (score === null || score < 0 || score > levels - 1) return { error: "score out of range" };
        const probabilities = normalizeProbabilities(raw.probabilities, Array.from({ length: levels }, (_, i) => String(i)));
        if (!probabilities) return { error: "score probabilities invalid" };
        const reported = finite(raw.confidence);
        const confidence = reported !== null ? clamp01(reported) : confidenceOf(probabilities);
        return { answer: { type: "score", score, probabilities, confidence } };
    }
    return { error: `unknown question type ${type}` };
}

// ── Request ─────────────────────────────────────────────────────────────────

function linkAbort(signal, controller) {
    if (!signal) return () => {};
    if (signal.aborted) { controller.abort(); return () => {}; }
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    return () => signal.removeEventListener("abort", onAbort);
}

/**
 * One System One request.
 *
 * @param {object} opts
 * @param {object} opts.questions  { id: { type, instructions, criteria } }
 * @param {any}    opts.state      string | JSON value; keep it to what the questions need
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{answers: object, malformed: object, model: string, provider: string,
 *                    usage: object, latencyMs: number}>}
 *          `answers` holds only validated answers, keyed by question id.
 */
export async function jevRequest({ questions, state, signal }) {
    const reason = jevUnavailableReason();
    if (reason) throw new JevError(reason);

    const s = jevSettings();
    const provider = jevProvider();
    const key = getJevKey();
    const model = provider.model(String(s.model || "").trim());
    const ids = Object.keys(questions || {});
    if (!ids.length) throw new JevError("malformed", "no questions");

    const wireQuestions = {};
    for (const id of ids) {
        const q = questions[id];
        const wire = {
            type: provider.wireType(q.type),
            instructions: q.instructions,
        };
        if (q.criteria !== undefined) wire.criteria = q.criteria;
        wireQuestions[id] = wire;
    }

    const started = Date.now();
    const controller = new AbortController();
    const unlink = linkAbort(signal, controller);
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(s.timeoutMs) || 12000));

    let res;
    try {
        res = await fetch(provider.url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify({ model, state, questions: wireQuestions }),
            signal: controller.signal,
        });
    } catch (e) {
        if (controller.signal.aborted) throw new JevError("aborted", "The JEV request timed out.");
        throw new JevError("network", "Could not reach the JEV provider.");
    } finally {
        clearTimeout(timer);
        unlink();
    }

    if (!res.ok) {
        // Status only: a response body can echo the request, and the request can
        // contain story text or a key fragment the provider chose to repeat.
        throw new JevError("http", `JEV provider returned HTTP ${res.status}.`);
    }

    let body;
    try { body = await res.json(); } catch (e) { throw new JevError("malformed", "The JEV provider did not return JSON."); }

    const rawAnswers = provider.answers(body);
    if (!rawAnswers || typeof rawAnswers !== "object") {
        throw new JevError("malformed", "The JEV response had no answers.");
    }

    const answers = {};
    const malformed = {};
    for (const id of ids) {
        const { answer, error } = normalizeAnswer(questions[id].type, rawAnswers[id], questions[id].criteria);
        if (answer) answers[id] = answer;
        else malformed[id] = error;
    }

    return {
        answers,
        malformed,
        model: String(body.model || model),
        provider: provider.id,
        usage: body.usage && typeof body.usage === "object" ? body.usage : {},
        latencyMs: Date.now() - started,
    };
}
