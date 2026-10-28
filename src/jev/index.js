// ─────────────────────────────────────────────────────────────────────────────
// The one door feature code uses.
//
//   jevRoute(feature, ctx, current)   → { route, source, ... }   (decision)
//   jevJudge(feature, ctx)            → the raw judgment, for verify/gate sites
//   jevGate(feature, ctx)             → true | false | null
//
// Three guarantees every caller can rely on, because the doc's fallback rule is
// only as good as the door it goes through:
//
//   1. It never throws. A disabled runtime, a network failure, a timeout, an HTTP
//      error, a malformed answer, a policy error, or an exhausted call budget all
//      resolve to "no route" so the caller runs exactly its old code.
//   2. Shadow mode cannot change behaviour. In shadow the judgment is made,
//      compared, and logged; `route` still comes back as the CURRENT value and
//      `source` says "shadow".
//   3. Low confidence cannot change behaviour. `decide()` nulls a route below the
//      feature's threshold before this module sees it.
//
// Story text leaves the browser only through `client.js`, only after the explicit
// opt-in, and only the state a question builder chose to return.
// ─────────────────────────────────────────────────────────────────────────────

import { jevRequest, JevError } from "./client.js";
import { buildQuestions } from "./questions.js";
import { decide, featureMeta, FEATURES } from "./policy.js";
import { recordDecision } from "./log.js";
import { featureMode, jevReady, jevSettings, jevUnavailableReason } from "./settings.js";

// Per-turn budget. Reset from the reply hub when a new generation starts, so a
// retry loop cannot turn into a silent spend.
let callsThisTurn = 0;

// The last hard failure, for the settings panel. Not persisted: it is a
// diagnostic for "why did nothing happen", not story or account data.
let lastError = null;

export function jevLastError() {
    return lastError;
}

export function jevNewTurn() {
    callsThisTurn = 0;
}

export function jevAvailable() {
    return jevReady();
}

export function jevState(feature) {
    return { mode: featureMode(feature), ready: jevReady(), reason: jevUnavailableReason() };
}

/** A stable-ish, non-cryptographic hash for cache identity only. */
export function hashText(text) {
    let h = 2166136261;
    const s = String(text ?? "");
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}

/**
 * Ask, validate, decide, log. Never rejects.
 * @returns {Promise<{
 *   feature: string, mode: string, active: boolean, ok: boolean,
 *   route: any, confidence: number, reason: string, answers: object,
 *   model: string, provider: string, latencyMs: number, id: string|null,
 *   error: string
 * }>}
 */
export async function jevJudge(feature, ctx = {}, opts = {}) {
    const mode = featureMode(feature);
    const base = {
        feature, mode, active: false, ok: false,
        route: null, confidence: 0, reason: "",
        answers: null, model: "", provider: "", latencyMs: 0, id: null, error: "",
    };
    if (mode === "off") return { ...base, reason: jevUnavailableReason() || "off" };

    const s = jevSettings();
    if (callsThisTurn >= Math.max(1, Number(s.maxCalls) || 8)) {
        return { ...base, reason: "budget" };
    }
    if (feature === "image.review" && !s.vision) {
        // Experimental provider surface: refuse before sending an image anywhere.
        return { ...base, reason: "vision-off" };
    }

    const built = buildQuestions(feature, ctx);
    if (!built) return { ...base, reason: "no-questions" };

    let response;
    try {
        callsThisTurn += 1;
        response = await jevRequest({ questions: built.questions, state: built.state, signal: opts.signal });
    } catch (e) {
        const kind = e instanceof JevError ? e.kind : "error";
        const message = e instanceof JevError ? e.message : String(e && e.message || e);
        lastError = { feature, kind, message, at: Date.now() };
        // A rejected model or a refused key is actionable; a timeout is not.
        if (kind !== "aborted") console.warn(`[Megumin-Suite] JEV "${feature}" unavailable: ${message}`);
        return { ...base, reason: kind, error: message };
    }

    const { route, confidence, reason } = decide(feature, response.answers, ctx);
    const active = mode === "on" && route !== null;

    let id = null;
    try {
        id = await recordDecision({
            feature,
            mode,
            version: built.version,
            provider: response.provider,
            model: response.model,
            confidence,
            route,
            current: opts.current ?? null,
            reason,
            answers: response.answers,
            latencyMs: response.latencyMs,
            usage: response.usage,
            fallback: route === null ? reason : "",
            raw: built.state,
            keepRaw: Boolean(s.logRaw),
            note: opts.note || "",
        });
    } catch (e) {
        // Logging is evidence, not behaviour: never let it break a judgment.
    }

    return {
        ...base,
        ok: true,
        active,
        route,
        confidence,
        reason,
        answers: response.answers,
        model: response.model,
        provider: response.provider,
        latencyMs: response.latencyMs,
        id,
    };
}

/**
 * A decision site.
 * @param {string} feature
 * @param {object} ctx
 * @param {any} current  what the suite does today; returned unchanged unless the
 *                       feature is ON and the policy produced a route.
 * @returns {Promise<{route: any, source: "current"|"shadow"|"jev", confidence: number,
 *                    proposed: any, answers: object|null, reason: string}>}
 */
export async function jevRoute(feature, ctx, current) {
    const judged = await jevJudge(feature, ctx, { current });
    if (!judged.ok) {
        return { route: current, source: "current", confidence: 0, proposed: null, answers: null, reason: judged.reason, id: null };
    }
    if (judged.mode === "shadow") {
        return { route: current, source: "shadow", confidence: judged.confidence, proposed: judged.route, answers: judged.answers, reason: judged.reason, id: judged.id };
    }
    if (judged.route === null) {
        return { route: current, source: "current", confidence: judged.confidence, proposed: null, answers: judged.answers, reason: judged.reason, id: judged.id };
    }
    return { route: judged.route, source: "jev", confidence: judged.confidence, proposed: judged.route, answers: judged.answers, reason: judged.reason, id: judged.id };
}

/**
 * A boolean gate. null means "not confident / unavailable — use the old path".
 * Shadow mode always yields null, so a gate cannot act before it is switched on.
 */
export async function jevGate(feature, ctx, opts = {}) {
    const judged = await jevJudge(feature, ctx, opts);
    if (!judged.ok || judged.mode !== "on" || judged.route === null) return null;
    return judged.route;
}

/** The inspector's "is this feature doing anything?" answer, without a call. */
export function jevFeatureStates() {
    const s = jevSettings();
    const out = {};
    for (const id of Object.keys(FEATURES)) {
        out[id] = { mode: featureMode(id), configured: s.features[id] || "shadow", meta: featureMeta(id) };
    }
    return out;
}
