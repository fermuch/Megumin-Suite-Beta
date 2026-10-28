// ────────────────────────────────────────────────────────────────────────────
// Semantic context budgeting (docs/jev.md proposal 22).
//
// Token accounting already lives in src/core/tokens.js; what did not exist was a
// way to choose WHICH optional context earns its tokens. This module makes that
// choice: JEV scores the optional candidates, deterministic code does the
// arithmetic and the greedy fill inside the user's budget.
//
// The caller supplies the candidates, deliberately: injection.js already owns
// retrieval and the NPC shortlist, and importing those back here would put this
// module inside the prompt graph's import cycle for no benefit.
//
// Optional means optional: engine instructions, the user's agency, safety and
// compatibility blocks are never candidates, and a plan that would fit none of
// the candidates leaves the assembly exactly as it is.
// ────────────────────────────────────────────────────────────────────────────

import { jevRoute } from "../jev/index.js";
import { featureMode, jevSettings } from "../jev/settings.js";

// Same estimator the token counter uses (characters / 4), so the preview and the
// footer agree to within rounding.
export const estimateTokens = text => Math.ceil(String(text || "").length / 4);

let plan = { key: "", active: false, dropMemory: new Set(), dropNpc: new Set(), rows: [], budget: 0, used: 0, at: 0 };

export function contextJevPlan() {
    return plan;
}

export function contextJevDroppedMemoryIds() {
    return plan.active ? plan.dropMemory : new Set();
}

export function contextJevDroppedNpcNames() {
    return plan.active ? plan.dropNpc : new Set();
}

export function contextJevReset() {
    plan = { key: "", active: false, dropMemory: new Set(), dropNpc: new Set(), rows: [], budget: 0, used: 0, at: 0 };
}

/**
 * Score and pack the optional context for this turn.
 * @param {string} question  the user's current turn
 * @param {Array<{id: string, kind: "memory"|"npc", text: string, ref: string}>} list
 * @param {{ budget?: number }} [opts]
 */
export async function contextJevPrepare(question, list, { budget } = {}) {
    if (featureMode("context.budget") !== "on") { contextJevReset(); return null; }
    const limit = Math.max(150, Number(budget ?? jevSettings().contextBudget) || 900);
    const candidates = (list || []).filter(c => c && c.text);
    if (!candidates.length) { contextJevReset(); return null; }

    const key = `${candidates.map(c => c.id).join(",")}#${limit}`;
    if (plan.key === key) return plan;

    const result = await jevRoute(
        "context.budget",
        {
            question,
            candidates: candidates.map(c => ({
                id: c.id, kind: c.kind, text: c.text,
                tokens: c.tokens || estimateTokens(c.text),
            })),
        },
        candidates.map(c => c.id),
    );
    if (result.source !== "jev" || !result.route) {
        plan = { key, active: false, dropMemory: new Set(), dropNpc: new Set(), rows: [], budget: limit, used: 0, at: Date.now() };
        return plan;
    }
    const values = new Map((result.route.rows || []).map(r => [r.id, r.value ?? 0]));
    const dropped = new Set(result.route.drop || []);

    // Greedy value-per-token inside the budget, after the policy's own drops.
    const ranked = candidates
        .filter(c => !dropped.has(c.id))
        .map(c => ({ ...c, tokens: c.tokens || estimateTokens(c.text), value: values.get(c.id) ?? 0 }))
        .sort((a, b) => b.value - a.value || a.tokens - b.tokens);
    let used = 0;
    const keep = new Set();
    for (const candidate of ranked) {
        if (used + candidate.tokens > limit) continue;
        keep.add(candidate.id);
        used += candidate.tokens;
    }
    // Nothing fits: do not starve the prompt. Fall back to the full assembly.
    if (!keep.size) {
        plan = { key, active: false, dropMemory: new Set(), dropNpc: new Set(), rows: [], budget: limit, used: 0, at: Date.now() };
        return plan;
    }

    const dropMemory = new Set();
    const dropNpc = new Set();
    for (const candidate of candidates) {
        if (keep.has(candidate.id)) continue;
        if (candidate.kind === "memory") dropMemory.add(candidate.ref);
        if (candidate.kind === "npc") dropNpc.add(candidate.ref);
    }
    plan = {
        key,
        active: dropMemory.size + dropNpc.size > 0,
        dropMemory,
        dropNpc,
        rows: candidates.map(c => ({ id: c.id, kind: c.kind, tokens: c.tokens || estimateTokens(c.text), keep: keep.has(c.id) })),
        budget: limit,
        used,
        at: Date.now(),
    };
    return plan;
}
