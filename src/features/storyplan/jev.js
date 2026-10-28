// ────────────────────────────────────────────────────────────────────────────
// Story Director ↔ JEV (docs/jev.md proposals 19 and 20).
//
// The tracker is parsed by regex and the frequency fallback is a count; both
// stay authoritative. These helpers only add a semantic reading of whether the
// arc has actually moved, and check a generated directive before it is saved.
// A directive is never rewritten: a rejected one goes back to the editor.
// ────────────────────────────────────────────────────────────────────────────

import { jevJudge } from "../../jev/index.js";
import { featureMode } from "../../jev/settings.js";

/**
 * Should the directive evolve, hold, or is the arc stalled?
 * @returns {Promise<null|{action: "evolve"|"hold"|"stalled", ...}>}
 */
export async function jevArcSignal({ tracker, directive, exchange }) {
    if (featureMode("director.arc") === "off" || !directive) return null;
    const judged = await jevJudge("director.arc", { tracker, directive, exchange }, { current: { action: "hold" } });
    // Only a confident ON answer is allowed to overrule the regex/frequency.
    if (!judged.ok || judged.mode !== "on" || !judged.route) return null;
    return judged.route;
}

/**
 * Check a generated directive before saving it.
 * @returns {Promise<null|{verdict: "accept"|"review"|"reject", warnings: string[]}>}
 */
export async function jevCheckDirective({ directive, recent, note, genre, unresolved }) {
    const judged = await jevJudge("director.directive", { directive, recent, note, genre, unresolved });
    if (!judged.ok || judged.mode !== "on" || !judged.route) return null;
    return judged.route;
}

export function directiveWarningText(result) {
    if (!result || result.verdict === "accept") return "";
    const map = {
        continuity: "it conflicts with recent events",
        note: "it ignores the director's note or the genre",
        future: "it does not open a meaningful next step",
        threads: "it drops unresolved threads",
    };
    const why = (result.warnings || []).map(w => map[w] || w);
    return `The directive was not saved: ${why.length ? why.join("; ") : "it takes control of the player's character"}.`;
}
