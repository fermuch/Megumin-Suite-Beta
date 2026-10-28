// ─────────────────────────────────────────────────────────────────────────────
// Shared per-turn assessments (docs/jev.md proposals 3 and 9).
//
// The point is not to save tokens on one call; it is that every consumer sees the
// SAME reading of the turn. Two features asking separately can disagree, and the
// user then sees a reply that both "changed the outfit" and "did not".
//
// Cache identity is the whole safety story: the active data identity (chat +
// character + vector collection), the message, its swipe, a hash of the cleaned
// text, the question-set version, the provider, and the model. Change any of
// them, including editing the text or switching chats, and this is a miss — never
// a stale hit. Everything lives in memory for the page session: an assessment is
// derived metadata, not story state, so it is not worth persisting.
// ─────────────────────────────────────────────────────────────────────────────

import { getContext } from "../st.js";
import { meguminActiveDataIdentity } from "../core/keys.js";
import { jevJudge, hashText } from "./index.js";
import { jevSettings, featureMode } from "./settings.js";

const MAX_ENTRIES = 48;
const cache = new Map();

// Registered by the reply hub: JEV never imports the state store back.
let contextProvider = () => ({ locations: [], directorEnabled: false });

export function setAssessmentContextProvider(fn) {
    if (typeof fn === "function") contextProvider = fn;
}

export function clearAssessments() {
    cache.clear();
}

function clean(text) {
    return String(text ?? "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<img\b[^>]*>/gi, "")
        .replace(/\s+/g, " ")
        .trim();
}

function messageAt(index) {
    const chat = getContext()?.chat || [];
    if (typeof index === "number" && index >= 0) return chat[index] || null;
    return chat[chat.length - 1] || null;
}

/** The latest user turn(s) + the reply, as the model will read them. */
export function exchangeFor(index) {
    const chat = getContext()?.chat || [];
    const at = typeof index === "number" ? index : chat.length - 1;
    const reply = chat[at];
    if (!reply || reply.is_user || reply.is_system) return null;
    const users = [];
    for (let i = at - 1; i >= 0 && users.length < 2; i--) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        if (!m.is_user) break;
        users.unshift(m);
    }
    const userText = users.map(m => clean(m.mes)).join("\n");
    const replyText = clean(reply.mes);
    return {
        index: at,
        userText,
        replyText,
        exchange: `User:\n${userText}\n\nReply:\n${replyText}`,
        swipe: Number(reply.swipe_id) || 0,
        hash: hashText(`${userText}\u0000${replyText}`),
    };
}

function keyOf(kind, exchange, feature) {
    const s = jevSettings();
    return [
        kind,
        meguminActiveDataIdentity(),
        exchange.index,
        exchange.swipe,
        exchange.hash,
        featureMode(feature),
        s.provider,
        s.model,
    ].join("|");
}

function remember(key, value) {
    cache.set(key, value);
    while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
    }
}

async function assess(kind, feature, exchange, buildCtx) {
    if (!exchange) return null;
    if (featureMode(feature) === "off") return null;
    const key = keyOf(kind, exchange, feature);
    const hit = cache.get(key);
    if (hit) return hit;

    const judged = await jevJudge(feature, buildCtx(exchange));
    const value = {
        kind,
        id: judged.id,
        feature,
        mode: judged.mode,
        active: Boolean(judged.ok && judged.mode === "on" && judged.route),
        confidence: judged.confidence,
        values: judged.route ? judged.route.values ?? judged.route : null,
        answers: judged.answers,
        model: judged.model,
        at: Date.now(),
    };
    // Cache failures too: a down provider must not be retried by every consumer
    // of the same turn. The next turn gets a new key and tries again.
    remember(key, value);
    return value;
}

/**
 * The shared reply assessment.
 * @param {number} [index]  reply message index (default: the last message)
 * @returns {Promise<null | {kind, id, feature, mode, active, confidence, values,
 *                           answers, model, at}>}
 */
export async function getReplyAssessment(index) {
    const exchange = exchangeFor(index);
    if (!exchange) return null;
    return assess("reply", "reply.assess", exchange, (ex) => {
        const extra = contextProvider(ex.index) || {};
        return {
            exchange: ex.exchange,
            locations: Array.isArray(extra.locations) ? extra.locations : [],
            directorEnabled: Boolean(extra.directorEnabled),
        };
    });
}

/** The user-turn half. Cheap enough to warm on the user-message debounce. */
export async function getUserTurnAssessment() {
    const chat = getContext()?.chat || [];
    let at = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i] && chat[i].is_user) { at = i; break; }
    }
    if (at < 0) return null;
    const userText = clean(chat[at].mes);
    if (!userText) return null;
    const exchange = { index: at, swipe: 0, hash: hashText(userText), userText };
    return assess("turn", "turn.assess", exchange, (ex) => ({
        userText: ex.userText,
        exchange: ex.userText,
    }));
}
