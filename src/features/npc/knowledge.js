// ────────────────────────────────────────────────────────────────────────────
// Per-NPC knowledge boundaries (docs/jev.md proposal 12 extension).
//
// The Notebook already records, per live truth, who it is hidden from. This
// module turns that into two things:
//
//   1. a short "does NOT know" line appended to an NPC's dossier in the prompt,
//      so the story model is told the boundary before it writes; and
//   2. a JEV check after the reply, asking whether a named NPC stated, used, or
//      implied a truth they were never told. It reports; it never rewrites.
//
// The snapshot is identity-tagged: a chat switch cannot leak the previous
// chat's secrets into this one's prompt.
// ────────────────────────────────────────────────────────────────────────────

import { localProfile } from "../../core/state.js";
import { meguminActiveDataIdentity } from "../../core/keys.js";
import { jevJudge } from "../../jev/index.js";
import { featureMode } from "../../jev/settings.js";

let snapshot = { identity: "", truths: [] };

/** Called after the Notebook state changes (reply, edit, chat load). */
export function setNpcKnowledgeTruths(truths) {
    snapshot = {
        identity: meguminActiveDataIdentity(),
        truths: Array.isArray(truths) ? truths : [],
    };
}

const sameName = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

/** Live truths this character is still hidden from. */
export function npcUnknownTruths(name, truths = snapshot.truths) {
    return truths.filter(t => (t.hiddenFrom || []).some(n => sameName(n, name)));
}

/** Prompt line for a dossier, or "" when the character is not excluded from anything. */
export function npcKnowledgeLine(name) {
    const unknown = npcUnknownTruths(name).slice(0, 3);
    if (!unknown.length) return "";
    return `Knowledge boundary: does NOT know — ${unknown.map(t => `"${String(t.truth).slice(0, 160)}"`).join("; ")}. Do not have this character recall, state, or act on these unless the scene tells them.`;
}

/**
 * After a reply: did a named NPC use something they were never told?
 * @returns {Promise<{issues: string[]}|null>}
 */
export async function verifyNpcKnowledge(reply) {
    if (featureMode("npc.knowledge") === "off") return null;
    if (!snapshot.truths.length || snapshot.identity !== meguminActiveDataIdentity()) return null;

    const text = String(reply || "");
    if (!text) return null;
    const npcs = (localProfile?.npcBank?.npcs || []).filter(n => n && n.name && !n.imageOnly);
    const named = npcs
        .filter(n => text.toLowerCase().includes(String(n.name).toLowerCase()))
        .slice(0, 3);
    const targets = named
        .map(n => ({
            name: n.name,
            unknown: npcUnknownTruths(n.name).slice(0, 2).map(t => String(t.truth).slice(0, 200)),
        }))
        .filter(t => t.unknown.length);
    if (!targets.length) return null;

    const judged = await jevJudge("npc.knowledge", { reply: text, npcs: targets });
    if (!judged.ok || judged.mode !== "on" || !judged.route) return null;
    const issues = judged.route.issues || [];
    if (issues.length) {
        console.warn("[Megumin-Suite] NPC knowledge boundary:", issues);
        if (typeof toastr !== "undefined") {
            toastr.warning(`Knowledge check: ${issues.join(" · ")}. Nothing was changed.`, "Megumin Suite", { timeOut: 9000 });
        }
    }
    return judged.route;
}
