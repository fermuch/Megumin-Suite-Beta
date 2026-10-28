// ────────────────────────────────────────────────────────────────────────────
// Dice lines vs the prose (docs/jev.md proposal 26, after parsing).
//
// Arithmetic, the d20 and the DC ladder stay in code. This only checks that the
// verdict the model wrote is the outcome the numbers produced, and that the
// prose then acts on that result. A mismatch is reported, never rewritten.
// ────────────────────────────────────────────────────────────────────────────

import { parseDice } from "../../blocks/treatments.js";
import { jevJudge } from "../../jev/index.js";

/**
 * @param {string} reply  the raw reply text
 * @returns {Promise<{issues: string[]}|null>} null when there is nothing to check
 */
export async function verifyDiceReply(reply) {
    const blocks = [...String(reply || "").matchAll(/<Dice\b[^>]*>([\s\S]*?)<\/Dice\s*>/gi)].map(m => m[1]);
    if (!blocks.length) return null;

    const rolls = [];
    for (const body of blocks) {
        const parsed = parseDice(body);
        if (!parsed) continue;
        for (const r of parsed.rolls) {
            rolls.push({
                line: `${r.attempt} — d20 ${r.roll} vs DC ${r.dc} = ${r.total} · ${r.verdict}`,
                verdict: r.verdict,
                outcome: r.outcome,
            });
        }
    }
    if (!rolls.length) return null;

    const judged = await jevJudge("dice.verify", { reply, rolls });
    if (!judged.ok || judged.mode !== "on" || !judged.route) return null;
    const issues = judged.route.issues || [];
    if (issues.length) {
        console.warn("[Megumin-Suite] Dice lines vs prose:", issues);
        if (typeof toastr !== "undefined") {
            toastr.warning(`Dice check: ${issues.join(" · ")}. Nothing was changed.`, "Megumin Suite", { timeOut: 8000 });
        }
    }
    return judged.route;
}
