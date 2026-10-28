// ────────────────────────────────────────────────────────────────────────────
// Parsed-state verification (docs/jev.md proposals 11–13).
//
// Format validity is not truth. These helpers take what the deterministic
// parsers produced and ask whether the reply actually supports it. The rule the
// doc insists on is enforced here: JEV can only REMOVE a parsed change or flip a
// semantic "found" flag. It never invents a change, never rewrites a value, and
// code still applies everything that survives.
//
// Every helper returns the input unchanged unless the feature is ON and the
// policy is confident. Shadow mode therefore costs one call and changes nothing.
// ────────────────────────────────────────────────────────────────────────────

import { jevJudge, jevRoute } from "../jev/index.js";
import { featureMode } from "../jev/settings.js";

/** A human-readable line for one parsed World State change. */
export function describeWorldChange(change) {
    if (!change) return "";
    switch (change.type) {
        case "field": return `${change.who}'s ${change.field} becomes "${change.value}"`;
        case "scene": return `${change.key} is now "${change.value}"`;
        case "phase": return `${change.key} is now "${change.value}"`;
        case "list": return change.op === "remove"
            ? `"${change.value}" is removed from ${change.list}`
            : `"${change.value}" is added to ${change.list}`;
        case "leave": return `${change.who} leaves ${change.where}`;
        case "offscreen": return `${change.who || "a character"} is off-screen: ${change.value}`;
        case "pcname": return `the player character is named "${change.name}"`;
        default: return JSON.stringify(change).slice(0, 300);
    }
}

/**
 * Verify parsed World State changes against the reply.
 * @returns {{parsed: object, held: string[], active: boolean}}
 */
export async function jevFilterWorldParsed(parsed, replyText) {
    if (!parsed || !Array.isArray(parsed.changes) || !parsed.changes.length) {
        return { parsed, held: [], active: false };
    }

    // Names run even when state.verify is off: a label is a naming problem, not
    // a truth problem. It reports; the cast entry is not renamed or dropped.
    if (featureMode("entity.name") !== "off") {
        const names = [...new Set(parsed.changes.map(c => c && c.who).filter(Boolean))].slice(0, 6);
        if (names.length) {
            const named = await jevJudge("entity.name", { names });
            if (named.ok && named.mode === "on" && named.route && (named.route.problems || []).length) {
                const labels = named.route.problems.map(p => p.name);
                console.warn("[Megumin-Suite] World State uses label names:", labels);
                if (typeof toastr !== "undefined") {
                    toastr.info(`World State uses label names: ${labels.join(", ")}. Give them a full name before they matter.`, "Megumin Suite", { timeOut: 8000 });
                }
            }
        }
    }

    if (featureMode("state.verify") === "off") return { parsed, held: [], active: false };

    const pairs = parsed.changes
        .map((change, index) => ({ change, index }))
        .filter(p => p.change && p.change.type !== "block");
    if (!pairs.length) return { parsed, held: [], active: false };

    const judged = await jevJudge("state.verify", {
        reply: replyText,
        deltas: pairs.map(p => ({ describe: describeWorldChange(p.change) })),
    }, { current: "apply" });
    if (!judged.ok || judged.mode !== "on" || !judged.route || !Array.isArray(judged.route.verdicts)) {
        return { parsed, held: [], active: false };
    }

    const held = new Set();
    for (const verdict of judged.route.verdicts) {
        if (verdict.verdict !== "accept") held.add(pairs[verdict.index]?.index);
    }
    if (!held.size) return { parsed, held: [], active: true };

    const kept = parsed.changes.filter((_, i) => !held.has(i));
    const reasons = judged.route.verdicts
        .filter(v => v.verdict !== "accept")
        .map(v => `${describeWorldChange(pairs[v.index]?.change)} → ${v.verdict}`);
    return { parsed: { ...parsed, changes: kept }, held: reasons, active: true };
}

/**
 * Override only the semantic "found" decision on newly written clue ops.
 * @returns {{parsed: object, changed: string[], active: boolean}}
 */
export async function jevFilterNotebookParsed(parsed, prose) {
    if (!parsed || !Array.isArray(parsed.ops)) return { parsed, changed: [], active: false };
    if (featureMode("notebook.clue") === "off") return { parsed, changed: [], active: false };

    const clues = parsed.ops
        .map((op, index) => ({ op, index }))
        .filter(p => p.op && p.op.op === "clue" && p.op.text);
    if (!clues.length) return { parsed, changed: [], active: false };

    const judged = await jevJudge("notebook.clue", {
        prose,
        clues: clues.map(c => c.op.text),
    }, { current: clues.map(c => Boolean(c.op.found)) });
    if (!judged.ok || judged.mode !== "on" || !judged.route || !Array.isArray(judged.route.clues)) {
        return { parsed, changed: [], active: false };
    }

    const ops = parsed.ops.map(op => ({ ...op }));
    const changed = [];
    for (const verdict of judged.route.clues) {
        const target = clues[verdict.index];
        if (!target || verdict.found === null || verdict.found === undefined) continue;
        const op = ops[target.index];
        if (op.found === verdict.found) continue;
        op.found = verdict.found;
        changed.push(`${op.id} "${String(op.text).slice(0, 80)}" → ${verdict.found ? "revealed" : "not revealed"}`);
    }
    return { parsed: changed.length ? { ...parsed, ops } : parsed, changed, active: true };
}

/**
 * Does the reply let someone reveal a secret they do not know?
 * Reports only: the Notebook's own learned/op handling stays authoritative.
 * @returns {Promise<string[]>} leak descriptions
 */
export async function jevCheckSecretLeaks(prose, truths) {
    if (featureMode("notebook.secret") === "off") return [];
    const live = (truths || []).filter(t => t && t.truth && Array.isArray(t.hiddenFrom) && t.hiddenFrom.length);
    if (!live.length) return [];
    const leaks = [];
    for (const truth of live.slice(0, 2)) {
        const judged = await jevJudge("notebook.secret", {
            prose,
            secret: truth.truth,
            speaker: "",
            knownBy: [],
        });
        if (judged.ok && judged.mode === "on" && judged.route && judged.route.leak) {
            leaks.push(String(truth.truth).slice(0, 160));
        }
    }
    return leaks;
}

/**
 * Semantic acceptance for one parsed block. Structure/security stay with the
 * sanitizers; this only asks whether the content means what it claims.
 * @returns {{ok: boolean, issues: string[], active: boolean}}
 */
export async function jevVerifyBlock(kind, content, replyText) {
    const judged = await jevJudge("blocks.verify", { kind, content, reply: replyText });
    if (!judged.ok || judged.mode !== "on" || !judged.route) {
        return { ok: true, issues: [], active: false };
    }
    return { ok: Boolean(judged.route.ok), issues: judged.route.issues || [], active: true };
}

/**
 * Chomusuke failure triage: a nonempty answer the job could not use.
 * @returns {Promise<string|null>} a failure kind, or null for "use the old copy"
 */
export async function jevTriageAnswer(job, raw) {
    const judged = await jevJudge("worker.triage", { job, raw });
    if (!judged.ok || judged.mode !== "on" || !judged.route) return null;
    return judged.route.kind || null;
}
