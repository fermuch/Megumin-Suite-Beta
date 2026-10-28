// ────────────────────────────────────────────────────────────────────────────
// Memory Core ↔ JEV (docs/jev.md proposals 5–8).
//
// This file is the only place memory code talks to the decision runtime, and it
// exposes synchronous helpers for the synchronous parts of retrieval:
//
//   memJevPrepareQuery()     async  decide the query strategy for this turn
//   memJevRerankShortlist()  async  rank/drop/flag the retrieved shortlist
//   memJevApplyPlan(list)    sync   filter that shortlist at retrieval time
//   memJevSkipRetrieval()    sync   "this turn needs no memory at all"
//   memJevVerifySummary()    async  verify a summary before it is filed
//   memJevTagArchive()       async  tag a new archive duplicate/conflict (never delete)
//
// Every helper degrades to "do what you did before" on any failure, and shadow
// mode yields exactly that behaviour by construction (jevRoute returns the
// current value with source "shadow").
// ────────────────────────────────────────────────────────────────────────────

import { getContext } from "../../st.js";
import { jevRoute, jevJudge, hashText } from "../../jev/index.js";
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

let queryDecision = { key: "", value: null };

let plan = { key: "", active: false, drop: new Set(), order: [], conflicts: new Set() };

// Retrieval widens only when the JEV pick is actually allowed to act; shadow or
// off keeps the historical three, so a widened pool can never leak into a prompt.
const CANDIDATE_WIDTH = 10;

export function memJevCandidateWidth() {
    return featureMode("memory.pick") === "on" ? CANDIDATE_WIDTH : 3;
}

function clean(text) {
    return cleanText(text);
}

function chatTurn() {
    const chat = (getContext()?.chat || []).filter(m => m && !m.is_system);
    let userIdx = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user) { userIdx = i; break; }
    }
    const latestUser = userIdx >= 0 ? clean(chat[userIdx].mes) : "";
    const recentExchange = chat.slice(-2).map(m => clean(m.mes)).join(" ");
    return { latestUser, recentExchange, key: hashText(`${latestUser}\u0000${recentExchange}`) };
}

/** The strategy the turn's query should use, or null for "the current rule". */
export function memJevStrategyValue() {
    return queryDecision.value;
}

export function memJevSkipRetrieval() {
    return queryDecision.value === "skip_retrieval";
}

export function resetMemJevTurn() {
    queryDecision = { key: "", value: null };
    plan = { key: "", active: false, drop: new Set(), order: [], conflicts: new Set() };
}

/**
 * Decide the query strategy once per user turn and remember it for the sync
 * query builder. Only an ON feature can change anything.
 */
export async function memJevPrepareQuery() {
    if (featureMode("memory.query") === "off") return null;
    const turn = chatTurn();
    if (!turn.latestUser && !turn.recentExchange) return null;
    if (queryDecision.key === turn.key) return queryDecision.value;

    const result = await jevRoute(
        "memory.query",
        { latestUser: turn.latestUser, recentExchange: turn.recentExchange },
        { strategy: "current" },
    );
    queryDecision = {
        key: turn.key,
        value: result.source === "jev" && result.route && result.route.strategy ? result.route.strategy : null,
    };
    return queryDecision.value;
}

/**
 * Re-rank the retrieved shortlist for the turn.
 * @param {() => Array} getShortlist  the memory module's retrieval function
 */
export async function memJevRerankShortlist(getShortlist) {
    if (featureMode("memory.rerank") === "off") return null;
    const turn = chatTurn();
    let list;
    try { list = (getShortlist() || []).filter(x => x && x.id); } catch (e) { return null; }
    if (!list.length) {
        plan = { key: turn.key, active: false, drop: new Set(), order: [], conflicts: new Set() };
        return null;
    }

    // Stage 1 — pick from the wider pool. Off/shadow/failure/unsure keeps the
    // first three, which is exactly what retrieval used to hand over.
    if (featureMode("memory.pick") !== "off" && list.length > 3) {
        const picked = await jevRoute(
            "memory.pick",
            {
                question: turn.latestUser || turn.recentExchange,
                candidates: list.map(m => ({ id: m.id, text: m.text || m.summary || "" })),
            },
            list.slice(0, 3).map(m => m.id),
        );
        if (picked.route && Array.isArray(picked.route.ids)) {
            const byId = new Map(list.map(m => [m.id, m]));
            list = picked.route.ids.map(id => byId.get(id)).filter(Boolean);
            if (!list.length) {
                // A confident "none of these help" is a decision: inject nothing.
                plan = { key: `${turn.key}#picked-none`, active: true, drop: new Set(), order: [], conflicts: new Set() };
                return plan;
            }
        }
    }

    const key = `${turn.key}#${list.map(x => x.id).join(",")}#${featureMode("memory.pick")}/${featureMode("memory.rerank")}`;
    if (plan.key === key) return plan;

    const current = list.map((_, i) => i);
    const result = await jevRoute(
        "memory.rerank",
        {
            question: turn.latestUser || turn.recentExchange,
            memories: list.map(m => ({ id: m.id, text: m.text || m.summary || "" })),
        },
        current,
    );

    if (result.source !== "jev" || !result.route || !Array.isArray(result.route.order)) {
        plan = { key, active: false, drop: new Set(), order: [], conflicts: new Set() };
        return plan;
    }
    plan = {
        key,
        active: true,
        drop: new Set((result.route.drop || []).map(d => list[d.index]?.id).filter(Boolean)),
        order: result.route.order.map(i => list[i]?.id).filter(Boolean),
        conflicts: new Set((result.route.conflicts || []).map(c => list[c.index]?.id).filter(Boolean)),
    };
    return plan;
}

/** Applies the current plan to a retrieval result. Sync, cheap, identity-checked
 *  by the plan key: a stale plan for another turn cannot filter this one. */
export function memJevApplyPlan(list) {
    if (!Array.isArray(list) || !list.length) return list;
    if (!plan.active) {
        // A widened pool that never got a plan must not reach the prompt.
        return list.slice(0, 3);
    }
    if (!plan.order.length) return [];
    const ranked = plan.order.filter(id => list.some(x => x.id === id));
    if (!ranked.length) return [];
    const byId = new Map(list.map(x => [x.id, x]));
    return ranked.map(id => byId.get(id)).filter(x => x && !plan.drop.has(x.id)).slice(0, 3);
}

/** Ids the policy flagged as conflicting or superseded, for prompt labelling. */
export function memJevConflictIds() {
    return plan.active ? plan.conflicts : new Set();
}

/**
 * Verify a generated summary before it is filed.
 * @returns {{verdict: "accept"|"review"|"raw_source", detail: object|null}}
 */
export async function memJevVerifySummary({ source, summary }) {
    const judged = await jevJudge("memory.summary", { source, summary });
    if (!judged.ok || judged.mode !== "on" || !judged.route || !judged.route.verdict) {
        return { verdict: "accept", detail: null };
    }
    return { verdict: judged.route.verdict, detail: judged.route };
}

/**
 * Tag a newly appended archive with what it duplicates or conflicts with.
 * Never merges, never deletes: the doc keeps storage user/code-owned.
 */
export async function memJevTagArchive(chunk, vault) {
    if (!chunk || !Array.isArray(vault) || vault.length < 2) return;
    if (featureMode("memory.archive") === "off") return;
    const text = String(chunk.text || chunk.summary || "");
    if (!text) return;

    // Stage 1 — JEV picks the candidates from recent archives. The old version
    // required a shared four-letter word, so two statements about the same
    // event in different words could never meet.
    const recent = vault
        .filter(v => v && v.id !== chunk.id)
        .slice(-20)
        .reverse();
    if (!recent.length) return;

    // Lexical nearest, used only when the shortlist feature is off/shadow/unsure.
    const words = new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 4));
    const scored = recent
        .map(candidate => {
            const other = String(candidate.text || candidate.summary || "").toLowerCase();
            let hits = 0;
            for (const w of words) if (other.includes(w)) hits++;
            return { candidate, hits };
        })
        .filter(s => s.hits > 0)
        .sort((a, b) => b.hits - a.hits);
    const heuristic = scored.slice(0, 3).map(s => s.candidate.id);

    const picked = await jevRoute(
        "memory.shortlist",
        {
            candidate: text,
            recent: recent.map(v => ({ id: v.id, text: v.text || v.summary || "" })),
        },
        heuristic,
    );
    const ids = picked.route && Array.isArray(picked.route.ids) ? picked.route.ids.slice(0, 3) : heuristic;
    if (!ids.length) return;
    const byId = new Map(recent.map(v => [v.id, v]));
    const nearest = ids.map(id => byId.get(id)).filter(Boolean);
    if (!nearest.length) return;

    // Stage 2 — relation, conflict, supersession on the shortlist.
    const result = await jevRoute(
        "memory.archive",
        {
            candidate: text,
            candidateWhen: chunk.id,
            existing: nearest.map(n => ({ text: n.text || n.summary, when: n.id })),
        },
        { route: "append" },
    );
    if (result.source !== "jev" || !result.route) return;
    const tag = result.route;
    chunk.jev = {
        relation: tag.route,
        conflict: Boolean(tag.conflict >= 0.7 && tag.supersedes >= 0.6),
        sameEvent: tag.relation >= 1.4,
        confidence: result.confidence,
        at: Date.now(),
    };
}
