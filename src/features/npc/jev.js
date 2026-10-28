// ────────────────────────────────────────────────────────────────────────────
// NPC Bank ↔ JEV (docs/jev.md proposals 15–18).
//
// Ranking and judging only. Every helper returns "no change" unless its feature
// is ON and the policy was confident; merges and deletions stay user/code-owned.
// ────────────────────────────────────────────────────────────────────────────

import { jevJudge, jevRoute, hashText } from "../../jev/index.js";
import { featureMode } from "../../jev/settings.js";
import { localProfile } from "../../core/state.js";
import { npcFindByName } from "./updates.js";
import { npcUpdatableFields } from "./fields.js";

let rankPlan = { key: "", active: false, conversation: [], visual: [], conflicts: [], at: 0 };

/** The plan `buildBaseDict` and the image tags apply synchronously. */
export function npcJevRankPlan() {
    return rankPlan;
}

function candidateText(n) {
    if (!n) return "";
    return [n.name, n.description, n.appearance, n.personality, n.notes, n.imageTags]
        .filter(Boolean).join(" ").slice(0, 1200);
}

function briefOf(npc) {
    return [npc.description, npc.appearance, npc.personality, npc.notes, npc.imageTags]
        .filter(Boolean).join(" ").slice(0, 240);
}

/** The bank in roster form. Above 20 entries, names in the exchange and the most
 *  recent fill the roster; at or below that, every NPC is judged. */
function npcRoster(exchange) {
    const npcs = (localProfile?.npcBank?.npcs || []).filter(n => n && n.name && !n.imageOnly);
    const lower = String(exchange || "").toLowerCase();
    const named = npcs.filter(n => lower.includes(String(n.name).toLowerCase()));
    const rest = npcs.filter(n => !named.includes(n)).sort((a, b) => (b.messageIndex || 0) - (a.messageIndex || 0));
    return [...named, ...rest].slice(0, 20);
}

/** Lexical fallback only: used when the shortlist feature is off/shadow/unsure. */
export function npcRankCandidates(exchange) {
    const npcs = (localProfile?.npcBank?.npcs || []).filter(n => n && n.name && !n.imageOnly);
    const lower = String(exchange || "").toLowerCase();
    const named = npcs.filter(n => lower.includes(String(n.name).toLowerCase()));
    const rest = npcs.filter(n => !named.includes(n)).sort((a, b) => (b.messageIndex || 0) - (a.messageIndex || 0));
    return [...named, ...rest].slice(0, 3);
}

/**
 * Rank dossiers for the conversation and for the image prompt.
 * @param {string} exchange  cleaned latest exchange
 */
export async function npcJevPrepareRanking(exchange) {
    const mode = featureMode("npc.rank");
    if (mode === "off") { rankPlan = { key: "", active: false, conversation: [], visual: [], conflicts: [], at: 0 }; return null; }
    const roster = npcRoster(exchange);
    if (!roster.length) return null;

    const key = `${hashText(String(exchange || ""))}#${roster.map(n => n.name).join("|")}#${featureMode("npc.shortlist")}/${mode}`;
    if (rankPlan.key === key) return rankPlan;

    // Stage 1 — JEV chooses the shortlist from the whole roster. Off, shadow,
    // failure, or an unsure answer falls back to the lexical shortlist.
    const heuristic = npcRankCandidates(exchange).map(n => n.name);
    const picked = await jevRoute(
        "npc.shortlist",
        { exchange, roster: roster.map(n => ({ name: n.name, brief: briefOf(n) })) },
        heuristic,
    );
    const names = picked.route && Array.isArray(picked.route.names) ? picked.route.names.slice(0, 5) : heuristic;
    const byName = new Map(roster.map(n => [n.name, n]));
    const candidates = names.map(name => byName.get(name)).filter(Boolean);

    if (!candidates.length) {
        // A confident "nobody here" is a decision: no dossiers, no image tags.
        rankPlan = { key, active: true, conversation: [], visual: [], conflicts: [], at: Date.now() };
        return rankPlan;
    }

    // Stage 2 — full dossiers for the survivors.
    const result = await jevRoute("npc.rank", {
        exchange,
        candidates: candidates.map(c => ({ name: c.name, dossier: candidateText(c) })),
    }, candidates.map(c => c.name));

    if (result.source !== "jev" || !result.route) {
        rankPlan = { key, active: false, conversation: [], visual: [], conflicts: [], at: Date.now() };
        return rankPlan;
    }
    rankPlan = {
        key,
        active: true,
        conversation: (result.route.conversation || []).map(r => r.name),
        visual: (result.route.visual || []).map(r => r.name),
        conflicts: (result.route.conflicts || []).map(String),
        at: Date.now(),
    };
    return rankPlan;
}

export function resetNpcJevRanking() {
    rankPlan = { key: "", active: false, conversation: [], visual: [], conflicts: [], at: 0 };
}

/** Should this reply create a dossier at all? null ⇒ no confident answer. */
export async function npcJevWorthDossier(reply, existingNames) {
    const judged = await jevJudge("npc.dossier", { reply, existingNames });
    if (!judged.ok || judged.mode !== "on" || !judged.route) return null;
    return Boolean(judged.route.create);
}

/** Same person? Suggestion only; the merge stays a user action. */
export async function npcJevIdentity(left, right) {
    const judged = await jevJudge("npc.identity", {
        leftName: left?.name, leftDossier: candidateText(left),
        rightName: right?.name, rightDossier: candidateText(right),
    });
    if (!judged.ok || judged.mode !== "on" || !judged.route) return null;
    return judged.route;
}

/**
 * Verify parsed dossier operations against the reply.
 * @returns {Promise<null|{verdicts: object[], target: object|null}>}
 */
export async function npcJevVerifyOps({ reply, npc, dossier, ops, removals }) {
    if (!Array.isArray(ops) || !ops.length) return null;
    const judged = await jevJudge("npc.updates", {
        reply,
        npc,
        dossier,
        ops: ops.map(o => ({ op: o.op, label: o.label, text: o.text })),
        removals,
    });
    if (!judged.ok || judged.mode !== "on" || !judged.route) return null;
    return { verdicts: judged.route.verdicts || [], targets: judged.route.targets || [] };
}

/**
 * Portrait prompt / outfit-tag review, before anything is rendered or cached.
 * @returns {Promise<{issues: string[], active: boolean}>}
 */
export async function npcJevCheckPrompt({ name, dossier, outfit, prompt, framing }) {
    const judged = await jevJudge("npc.prompt", { name, dossier, outfit, prompt, framing });
    if (!judged.ok || judged.mode !== "on" || !judged.route) return { issues: [], active: false };
    return { issues: judged.route.issues || [], active: true };
}

/** One pool per removal op, so every "-" is resolved against its own field. */
function removalPools(npc, ops) {
    const fields = npcUpdatableFields();
    const pools = [];
    ops.forEach((op, index) => {
        if (!op || op.op !== "-") return;
        const field = fields.find(f => String(f.label).toLowerCase() === String(op.label).toLowerCase());
        if (!field) return;
        const lines = String(npc[field.id] || "")
            .split(/\r?\n/)
            .map(l => l.replace(/^\s*[*,-]\s*/, "").trim())
            .filter(Boolean);
        pools.push({ index, fieldLabel: field.label, lines: lines.slice(0, 8) });
    });
    return pools;
}

/** Resolve an update addressed to a name the bank does not have, via identity. */
export async function npcJevResolveName(name) {
    if (featureMode("npc.match") === "off") return null;
    const npcs = (localProfile?.npcBank?.npcs || []).filter(n => n && n.name);
    const lower = String(name || "").toLowerCase().trim();
    if (!lower) return null;
    const candidates = npcs.filter(n => {
        const other = String(n.name).toLowerCase();
        return other !== lower && (other.startsWith(lower.slice(0, 3)) || lower.startsWith(other.slice(0, 3)) || other.includes(lower) || lower.includes(other));
    }).slice(0, 3);
    if (!candidates.length) return null;
    const judged = await jevJudge("npc.match", {
        name,
        candidates: candidates.map(n => ({ name: n.name, brief: briefOf(n) })),
    });
    if (!judged.ok || judged.mode !== "on" || !judged.route) return null;
    return judged.route.name || null;
}

/**
 * Verify parsed dossier operations against the reply before anything is
 * written. Only ops the reply supports survive; a removal's target is picked
 * from the EXISTING lines (code still performs the removal), never invented.
 * @returns {Promise<Array>} the updates that may be applied
 */
export async function npcFilterUpdates(updates, reply) {
    if (!Array.isArray(updates) || !updates.length) return updates;
    if (featureMode("npc.updates") === "off") return updates;
    const out = [];
    for (const update of updates) {
        let npc = npcFindByName(update.name);
        let resolvedName = update.name;
        if (!npc) {
            const resolved = await npcJevResolveName(update.name);
            if (resolved) { npc = npcFindByName(resolved); resolvedName = resolved; }
        }
        if (!npc || !Array.isArray(update.ops) || !update.ops.length) { out.push(update); continue; }
        const removals = removalPools(npc, update.ops);
        const checked = await npcJevVerifyOps({
            reply,
            npc: npc.name,
            dossier: candidateText(npc),
            ops: update.ops,
            removals,
        });
        if (!checked) {
            out.push(resolvedName !== update.name ? { ...update, name: resolvedName } : update);
            continue;
        }

        const kept = [];
        update.ops.forEach((op, i) => {
            const verdict = checked.verdicts.find(v => v.index === i);
            if (!verdict || verdict.verdict === "accept") kept.push({ op: { ...op }, index: i });
        });
        if (!kept.length) {
            console.debug(`[Megumin-Suite] NPC update for "${npc.name}" not applied: the reply did not support it.`);
            continue;
        }

        // Every removal is resolved from that field's existing lines. "none"
        // means the line is not there and the op is dropped; a chosen line is
        // rewritten to its exact text, so the parser's matcher cannot guess.
        const targets = new Map((checked.targets || []).map(t => [t.index, t]));
        const finalOps = [];
        for (const { op, index } of kept) {
            if (op.op === "-") {
                const target = targets.get(index);
                if (target && target.none) continue;
                if (target && target.line) op.text = target.line;
            }
            finalOps.push(op);
        }
        if (!finalOps.length) continue;
        out.push({ ...update, name: resolvedName, ops: finalOps });
    }
    return out;
}

/**
 * Outfit tags: keep only the sets the source outfit supports. Rejected tags are
 * NOT cached or sent; the current outfit text stays authoritative, and the user
 * gets a warning rather than a blocking popup.
 * @returns {Promise<string>} the answer with rejected blocks removed
 */
function outfitBlocks(raw) {
    return [...String(raw || "").matchAll(/<Outfit_Tags\b[^>]*?name=["']?([^"'>]+)["']?[^>]*>([\s\S]*?)<\/Outfit_Tags\s*>/gi)]
        .map(m => ({ name: m[1].trim(), tags: m[2].replace(/\s+/g, " ").trim() }))
        .filter(b => b.name && b.tags);
}

export async function npcJevFilterOutfitTags(stale, raw) {
    if (featureMode("npc.prompt") === "off") return raw;
    const blocks = outfitBlocks(raw);
    if (!blocks.length) return raw;
    const kept = [];
    const rejected = [];
    for (const block of blocks) {
        const target = (stale || []).find(x => [x.name, ...(x.aliases || [])].some(a => String(a).toLowerCase() === block.name.toLowerCase()));
        if (!target) { kept.push(block); continue; }
        const judged = await jevJudge("npc.prompt", {
            name: block.name,
            dossier: "",
            outfit: target.outfitText,
            prompt: block.tags,
            framing: "clothing tags",
        });
        if (!judged.ok || judged.mode !== "on" || !judged.route) { kept.push(block); continue; }
        if (!judged.route.issues.length) kept.push(block);
        else rejected.push({ name: block.name, issues: judged.route.issues });
    }
    if (!rejected.length) return raw;
    if (typeof toastr !== "undefined") {
        toastr.warning(
            `Outfit tags were not used for ${rejected.map(r => r.name).join(", ")}: ${rejected[0].issues.join(", ")}. The current outfit text is used instead.`,
            "Megumin Suite",
        );
    }
    return kept.map(b => `<Outfit_Tags name="${b.name}">${b.tags}</Outfit_Tags>`).join("\n");
}

/**
 * Preselect the existing "Same person as…" control when two records are very
 * likely one person. The merge still needs the user's click.
 * @returns {Promise<string|null>} the existing name to preselect
 */
export async function npcJevPickSamePerson(newName, others) {
    if (featureMode("npc.identity") === "off") return null;
    const npcs = localProfile?.npcBank?.npcs || [];
    const left = npcs.find(n => n.name === newName) || { name: newName };
    for (const other of (others || []).slice(0, 6)) {
        const right = npcs.find(n => n.name === other) || { name: other };
        const verdict = await npcJevIdentity(left, right);
        if (verdict && verdict.verdict === "same") return other;
    }
    return null;
}
