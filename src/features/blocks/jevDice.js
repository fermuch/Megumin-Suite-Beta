// ────────────────────────────────────────────────────────────────────────────
// Typed dice assessment (docs/jev.md proposal 26).
//
// The dice add-on asks the story model to decide whether a roll is needed, the
// DC, the modifier, and the verdict — for attempts it has not written yet. JEV
// can do the first three for the ONE attempt the user actually described, before
// the reply exists. Code then rolls exactly as before (`meguminRollD20s`), maps
// the expected difficulty onto the existing DC bands, and hands the model a
// resolved line to put first.
//
// Everything after that first attempt keeps the current story-model judgment:
// later user attempts and every NPC attempt in `dice_all` are not knowable here.
// Arithmetic and RNG never move.
// ────────────────────────────────────────────────────────────────────────────

import { getContext } from "../../st.js";
import { localProfile } from "../../core/state.js";
import { jevRoute, hashText } from "../../jev/index.js";
import { featureMode } from "../../jev/settings.js";

/** Strip markup and collapse whitespace. Local to this bridge on purpose: it
 *  must not pull the prompt graph into a module the prompt graph imports. */
function cleanText(text) {
    return String(text ?? "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// The add-on's own DC ladder ("5 trivial · 10 easy · 15 ordinary · 20 hard ·
// 25 very hard · 30 near-impossible"), indexed by the Score band.
export const DC_BANDS = [5, 10, 15, 20, 25, 30];

// The add-on's modifier rule: "-3..+3, only from competence already established".
const MODIFIERS = { novice: -3, trained: 0, expert: 3 };

let plan = { key: "", active: false, band: 2, competence: "trained", attempt: "", at: 0 };

export function diceJevReset() {
    plan = { key: "", active: false, band: 2, competence: "trained", attempt: "", at: 0 };
}

function diceEnabled() {
    return Boolean(localProfile && Array.isArray(localProfile.addons) && localProfile.addons.includes("dice"));
}

function lastUserTurn() {
    const chat = (getContext()?.chat || []).filter(m => m && !m.is_system);
    for (let i = chat.length - 1; i >= 0; i--) if (chat[i].is_user) return cleanText(chat[i].mes || "");
    return "";
}

/**
 * Decide the primary attempt for the turn being written. Async, before the
 * prompt is assembled.
 */
export async function diceJevPrepare() {
    if (!diceEnabled() || featureMode("dice.assess") === "off") { diceJevReset(); return null; }
    const userTurn = lastUserTurn();
    if (!userTurn) { diceJevReset(); return null; }
    const key = hashText(userTurn);
    if (plan.key === key) return plan;

    const chat = getContext()?.chat || [];
    const scene = chat.slice(-2).map(m => cleanText(m.mes || "")).join(" ").slice(-4000);
    const result = await jevRoute("dice.assess", { userTurn, scene }, { roll: false });
    if (result.source !== "jev" || !result.route || !result.route.roll) {
        plan = { key, active: false, band: 2, competence: "trained", attempt: "", at: Date.now() };
        return plan;
    }
    plan = {
        key,
        active: true,
        band: Math.max(0, Math.min(5, Number(result.route.band) || 0)),
        competence: MODIFIERS[result.route.competence] !== undefined ? result.route.competence : "trained",
        attempt: userTurn.replace(/\s+/g, " ").slice(0, 140),
        at: Date.now(),
    };
    return plan;
}

export function diceJevActive() {
    return Boolean(plan.active);
}

/**
 * Turn the first rolled number into the resolved line.
 * @param {number} roll  the d20 already produced by the shared RNG
 * @returns {null|{line: string, dc: number, mod: number, total: number, verdict: string}}
 */
export function diceJevResolve(roll) {
    if (!plan.active) return null;
    const mod = MODIFIERS[plan.competence] ?? 0;
    const dc = DC_BANDS[plan.band] ?? 15;
    const total = roll + mod;
    let verdict;
    if (roll === 20) verdict = "critical success";
    else if (roll === 1) verdict = "critical failure";
    else if (total >= dc) verdict = "success";
    else if (total >= dc - 2) verdict = "success, at a cost";
    else verdict = "failure, the world moves";
    const sign = mod >= 0 ? `+${mod}` : String(mod);
    return {
        dc, mod, total, verdict,
        line: `<Dice>🎲 ${plan.attempt} — d20${sign} vs DC ${dc} → ${roll}${sign} = ${total} · ${verdict}</Dice>`,
    };
}

/**
 * The instruction the add-on text gets when a primary attempt was resolved.
 * @param {{line: string}} resolved
 */
export function diceJevInstruction(resolved) {
    return `- resolved first attempt: the extension has already rolled {{user}}'s primary attempt this turn. start the reply with exactly this line, unchanged:\n  ${resolved.line}\n  then write the scene it lands in. the numbers below are for LATER attempts only; do not roll {{user}}'s primary attempt again.`;
}
