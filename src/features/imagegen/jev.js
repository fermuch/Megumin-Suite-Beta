// ────────────────────────────────────────────────────────────────────────────
// Image generation ↔ JEV (docs/jev.md proposals 28–30).
//
//   jevImageShouldSkip()   conditional mode: is there anything to draw at all?
//   jevCheckImagePrompt()  before ComfyUI: does the prompt match the scene?
//   jevReviewRenderedImage() experimental: the image itself (opt-in, inert by default)
//
// Each returns "the current flow" on off/shadow/low confidence/failure. The
// prompt is never rewritten here — the doc is explicit about that — and no
// rendered image is rejected automatically outside the experimental review.
// ────────────────────────────────────────────────────────────────────────────

import { getContext } from "../../st.js";
import { jevGate, jevJudge } from "../../jev/index.js";
import { featureMode, jevSettings } from "../../jev/settings.js";

/** Strip markup and collapse whitespace. Local to this bridge on purpose: it
 *  must not pull the prompt graph into a module the prompt graph imports. */
function cleanText(text) {
    return String(text ?? "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function clean(text) {
    return cleanText(text);
}

/** The user turn(s) before a reply plus the reply, cleaned. */
export function exchangeAt(index) {
    const chat = getContext()?.chat || [];
    const at = typeof index === "number" ? index : chat.length - 1;
    const reply = chat[at];
    if (!reply || reply.is_user || reply.is_system) return "";
    const users = [];
    for (let i = at - 1; i >= 0 && users.length < 2; i--) {
        if (!chat[i] || chat[i].is_system) continue;
        if (!chat[i].is_user) break;
        users.unshift(chat[i]);
    }
    return `User:\n${users.map(m => clean(m.mes)).join("\n")}\n\nReply:\n${clean(reply.mes)}`;
}

/**
 * Conditional image mode, first half: is a picture even warranted?
 * @returns {Promise<boolean>} true ⇒ skip the writer entirely
 */
export async function jevImageShouldSkip(index) {
    if (featureMode("image.gate") !== "on") return false;
    const exchange = exchangeAt(index);
    if (!exchange) return false;
    const gate = await jevGate("image.gate", { exchange }, { current: "proceed" });
    return Boolean(gate && gate.proceed === false);
}

let _castProvider = null;

/** Injected by index.js once V2 is loaded, so this module never imports it back. */
export function setImageCastProvider(fn) {
    if (typeof fn === "function") _castProvider = fn;
}

function castForPrompt() {
    if (!_castProvider) return [];
    try {
        const cast = _castProvider();
        return (Array.isArray(cast) ? cast : []).slice(0, 4).map(c => ({
            name: String(c.name || c.npcName || "").slice(0, 120),
            look: String(typeof c.look === "string" ? c.look : c.lookText || "").slice(0, 600),
            outfit: String(typeof c.outfit === "string" ? c.outfit : c.outfitText || "").slice(0, 400),
        }));
    } catch (e) {
        return [];
    }
}

/**
 * Before ComfyUI: does this prompt describe this scene?
 * @returns {Promise<{ok: boolean, issues: string[], active: boolean}>}
 */
export async function jevCheckImagePrompt({ prompt, reply, shot = "" }) {
    const judged = await jevJudge("image.prompt", {
        prompt,
        reply,
        cast: castForPrompt(),
        shot,
    });
    if (!judged.ok || judged.mode !== "on" || !judged.route) {
        return { ok: true, issues: [], active: false };
    }
    return { ok: Boolean(judged.route.ok), issues: judged.route.issues || [], active: true };
}

/**
 * Experimental: the rendered image itself. Inert unless the experimental switch
 * is on AND the provider is known to accept image input for the account.
 * @returns {Promise<{ok: boolean, issues: string[], active: boolean}|null>}
 */
export async function jevReviewRenderedImage(prompt, imageDataUrl) {
    if (!jevSettings().vision) return null;
    if (featureMode("image.review") !== "on") return null;
    if (!imageDataUrl || !/^data:image\//i.test(String(imageDataUrl))) return null;
    const judged = await jevJudge("image.review", { prompt, imageDataUrl });
    if (!judged.ok || !judged.route) return null;
    return { ok: judged.route.issues.length === 0, issues: judged.route.issues, active: true };
}
