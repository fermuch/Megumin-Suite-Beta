// ────────────────────────────────────────────────────────────────────────────
// Dynamic Ban List triage (docs/jev.md proposal 25).
//
// The scan used to ban every punctuation-split fragment longer than 3 chars.
// Occurrence counts are computed in code (JEV must not count); JEV only says
// whether a phrase that really does repeat is a verbal tic, whether the span is
// too broad, and whether it is a name or setting term.
//
// ban    → the current behaviour (added to the list)
// review → shown as a suggestion with Add / Reject, never auto-added
// keep   → dropped
// ────────────────────────────────────────────────────────────────────────────

import { jevJudge } from "../../jev/index.js";
import { featureMode } from "../../jev/settings.js";

/** Case-insensitive occurrence count, capped so a huge chat stays cheap. */
export function countOccurrences(text, phrase, cap = 999) {
    const hay = String(text || "").toLowerCase();
    const needle = String(phrase || "").toLowerCase().trim();
    if (!needle) return 0;
    let count = 0;
    let at = 0;
    while (count < cap) {
        const found = hay.indexOf(needle, at);
        if (found < 0) break;
        count += 1;
        at = found + needle.length;
    }
    return count;
}

/**
 * @returns {Promise<"ban"|"review"|"keep">} "review" is also the safe answer
 *          when the runtime is off, shadowed, or unsure — never an auto-ban.
 */
export async function jevTriageBanCandidate({ phrase, occurrences, sample }) {
    if (featureMode("banlist.candidate") === "off") return "ban";
    const judged = await jevJudge("banlist.candidate", { phrase, occurrences, sample });
    // A failed or unavailable call keeps the old split-and-add behaviour.
    if (!judged.ok || judged.mode !== "on") return "ban";
    // Answered, but not confidently enough to act: never auto-add, never
    // auto-drop. A human decides in the Suggested phrases list.
    if (!judged.route) return "review";
    return judged.route.action === "ban" || judged.route.action === "review" ? judged.route.action : "keep";
}
