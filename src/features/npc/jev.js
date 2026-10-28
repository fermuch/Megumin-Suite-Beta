// ────────────────────────────────────────────────────────────────────────────
// NPC Bank ↔ JEV (docs/jev.md proposals 15–18).
//
// Ranking and judging only. Every helper returns "no change" unless its feature
// is ON and the policy was confident; merges and deletions stay user/code-owned.
// ────────────────────────────────────────────────────────────────────────────

import { jevJudge, jevRoute } from "../../jev/index.js";
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

/** Names present in the exchange text, plus the bank's most recent entries. */
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
    if (featureMode("npc.rank") === "off") { rankPlan = { key: "", active: false, conversation: [], visual: [], conflicts: [], at: 0 }; return null; }
    const candidates = npcRankCandidates(exchange);
    if (!candidates.length) return null;
    const key = `${candidates.map(c => c.name).join("|")}#${String(exchange || "").slice(0, 200)}`;
    if (rankPlan.key === key) return rankPlan;

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
export async function npcJevVerifyOps({ reply, npc, dossier, ops, lines, fieldLabel }) {
    if (!Array.isArray(ops) || !ops.length) return null;
    const judged = await jevJudge("npc.updates", {
        reply,
        npc,
        dossier,
        ops: ops.map(o => ({ op: o.op, label: o.label, text: o.text })),
        lines,
        fieldLabel,
    });
    if (!judged.ok || judged.mode !== "on" || !judged.route) return null;
    return { verdicts: judged.route.verdicts || [], target: judged.route.target || null };
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

function removalPool(npc, ops) {
    const removal = ops.find(o => o && o.op === "-");
    if (!removal) return { lines: [], fieldLabel: "" };
    const field = npcUpdatableFields().find(f => String(f.label).toLowerCase() === String(removal.label).toLowerCase());
    if (!field) return { lines: [], fieldLabel: "" };
    const lines = String(npc[field.id] || "").split(/\r?\n/).map(l => l.replace(/^\s*[*,-]\s*/, "").trim()).filter(Boolean);
    return { lines: lines.slice(0, 8), fieldLabel: field.label };
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
        const npc = npcFindByName(update.name);
        if (!npc || !Array.isArray(update.ops) || !update.ops.length) { out.push(update); continue; }
        const pool = removalPool(npc, update.ops);
        const checked = await npcJevVerifyOps({
            reply,
            npc: npc.name,
            dossier: candidateText(npc),
            ops: update.ops,
            lines: pool.lines,
            fieldLabel: pool.fieldLabel,
        });
        if (!checked) { out.push(update); continue; }

        const kept = [];
        update.ops.forEach((op, i) => {
            const verdict = checked.verdicts.find(v => v.index === i);
            if (!verdict || verdict.verdict === "accept") kept.push({ ...op });
        });
        if (!kept.length) {
            console.debug(`[Megumin-Suite] NPC update for "${npc.name}" not applied: the reply did not support it.`);
            continue;
        }
        // A removal target chosen from the existing lines, by index. The parser's
        // own matcher then finds that exact line, so nothing is invented.
        if (checked.target && checked.target.line && /^line\d+$/.test(checked.target.line)) {
            const index = Number(checked.target.line.slice(4)) - 1;
            const line = pool.lines[index];
            if (line) for (const op of kept) if (op.op === "-") op.text = line;
        }
        out.push({ ...update, ops: kept });
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
