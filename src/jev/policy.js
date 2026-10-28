// ─────────────────────────────────────────────────────────────────────────────
// Per-feature policy: thresholds, uncertainty bands, and the route each answer
// maps onto.
//
// JEV answers questions; this file is the code that decides. It is pure and
// deterministic: the same answers always produce the same route, which is what
// makes the decision log replayable. Nothing here calls the network, mutates
// state, or reads the settings object for anything except an optional threshold
// override.
//
// Shape of a policy result:
//   { route, confidence, reason }
//   route: null  ⇒ not confident enough (or not answerable): caller uses its
//                  current behaviour. This is the ONLY way a low-confidence
//                  answer can end up, by design — never a silent mutation.
// ─────────────────────────────────────────────────────────────────────────────

import { thresholdFor } from "./settings.js";

// ── The registry ────────────────────────────────────────────────────────────
// `stage` follows the adoption order in docs/jev.md. `summary` appears in the
// settings panel, so it says what turning this on would change.

export const FEATURES = {
    "memory.query": { stage: 2, label: "Memory query", summary: "Choose latest question, recent exchange, or no retrieval." },
    "memory.rerank": { stage: 2, label: "Memory re-ranking", summary: "Rank, drop, and separate conflicting retrieved memories." },
    "memory.summary": { stage: 2, label: "Memory summaries", summary: "Check a generated summary against its source chunk before filing it." },
    "memory.archive": { stage: 2, label: "Archive duplicates", summary: "Link, flag, or route duplicate and superseded archives." },
    "notebook.clue": { stage: 2, label: "Notebook clues", summary: "Decide whether prose reveals a clue or only mentions it." },
    "notebook.secret": { stage: 2, label: "Secret knowledge", summary: "Check who learned a secret, and whether someone leaks what they never knew." },
    "npc.shortlist": { stage: 2, label: "NPC shortlist", summary: "Pick which of the whole bank is worth a full dossier ranking." },
    "npc.rank": { stage: 2, label: "NPC relevance", summary: "Rank the shortlisted dossiers and image tags by this scene." },
    "npc.dossier": { stage: 3, label: "New NPC gate", summary: "Only create a dossier for a named, recurring character." },
    "npc.identity": { stage: 3, label: "Identity merge", summary: "Suggest, never apply, when two NPC records look like one person." },
    "npc.updates": { stage: 3, label: "NPC updates", summary: "Check a dossier change against the reply, and resolve removal targets." },
    "npc.prompt": { stage: 3, label: "Portrait prompts", summary: "Review a portrait prompt and outfit tags before rendering." },
    "director.arc": { stage: 3, label: "Story arc", summary: "Judge whether the directive is complete, stalled, or redirected." },
    "director.directive": { stage: 3, label: "Directives", summary: "Check a generated directive before it is saved." },
    "config.compiler": { stage: 4, label: "Setup assistant", summary: "Map a written request onto existing setup options, as a diff." },
    "context.budget": { stage: 4, label: "Context budget", summary: "Choose which optional context earns its tokens." },
    "setup.loadout": { stage: 4, label: "Model loadouts", summary: "Suggest one of the existing tested loadouts." },
    "addons.diagnose": { stage: 4, label: "Add-on diagnostics", summary: "Spot which enabled add-on a reply broke." },
    "banlist.candidate": { stage: 2, label: "Ban list", summary: "Triage suggested phrases into ban, review, or keep." },
    "dice.assess": { stage: 3, label: "Dice", summary: "Decide whether the user's primary attempt needs a roll, and its difficulty." },
    "reply.doctor": { stage: 4, label: "Reply Doctor", summary: "Explain which quality check a reply failed." },
    "reply.swipes": { stage: 4, label: "Swipe ranking", summary: "Rank existing swipes with the same rubric, without choosing." },
    "image.gate": { stage: 2, label: "Image gate", summary: "Skip the image writer when nothing photo-worthy happened." },
    "image.prompt": { stage: 4, label: "Image prompts", summary: "Check an image prompt against the reply, cast, and outfit." },
    "image.review": { stage: 5, label: "Rendered images (experimental)", summary: "Review the rendered image itself. Needs image input from the provider." },
    "reply.assess": { stage: 3, label: "Reply assessment", summary: "One shared read of each reply, reused by every feature." },
    "turn.assess": { stage: 3, label: "Turn assessment", summary: "One shared read of each user turn." },
    "state.verify": { stage: 3, label: "State changes", summary: "Check parsed World State and stat changes against the reply." },
    "blocks.verify": { stage: 3, label: "Blocks", summary: "Check parsed cards for meaning, after the format checks." },
    "worker.triage": { stage: 3, label: "Worker failures", summary: "Say why a Chomusuke answer was unusable." },
};

export function featureMeta(id) {
    return FEATURES[id] || { stage: 9, label: id, summary: "" };
}

export function featureIdsByStage() {
    const stages = new Map();
    for (const [id, meta] of Object.entries(FEATURES)) {
        if (!stages.has(meta.stage)) stages.set(meta.stage, []);
        stages.get(meta.stage).push(id);
    }
    return [...stages.entries()].sort((a, b) => a[0] - b[0]);
}

// ── Reading answers ─────────────────────────────────────────────────────────

const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
const clamp01 = v => Math.max(0, Math.min(1, v));

function noul(answers, id) {
    const a = answers[id];
    return a && a.type === "noul" ? a.noul : null;
}

function pick(answers, id) {
    const a = answers[id];
    return a && a.type === "choice" ? a.choice : null;
}

function choiceConfidence(answers, id) {
    const a = answers[id];
    return a && a.type === "choice" ? a.confidence : 0;
}

function scoreValue(answers, id) {
    const a = answers[id];
    return a && a.type === "score" ? a.score : null;
}

function scoreConfidence(answers, id) {
    const a = answers[id];
    return a && a.type === "score" ? a.confidence : 0;
}

/** A Noul's distance from undecided, 0 at 0.5 and 1 at 0 or 1. */
const certainty = p => (p === null ? 0 : Math.abs(p - 0.5) * 2);

/** True when every required answer exists. */
const have = (answers, ids) => ids.every(id => answers && answers[id]);

/** Aggregate confidence for a multi-flag assessment. A Noul inside the 0.3–0.7
 *  dead zone is a deliberate "unknown": the consumer treats that flag as no gate,
 *  so it is excluded instead of dragging the whole reading down. At least 60% of
 *  the answers must still be decided. */
function assessmentConfidence(answers, ids) {
    const certs = [];
    let decided = 0;
    for (const id of ids) {
        const a = answers[id];
        if (!a) return 0;
        if (a.type === "noul") {
            if (a.noul > 0.3 && a.noul < 0.7) continue;
            certs.push(certainty(a.noul));
            decided += 1;
        } else {
            certs.push(a.confidence);
            if (a.confidence >= 0.5) decided += 1;
        }
    }
    if (!certs.length || decided / ids.length < 0.6) return 0;
    return clamp01(certs.reduce((sum, v) => sum + v, 0) / certs.length);
}

/** Composite confidence: the weakest link, so one split answer cannot carry a route. */
function weakest(answers, ids) {
    let low = 1;
    for (const id of ids) {
        const a = answers[id];
        if (!a) return 0;
        low = Math.min(low, a.type === "noul" ? certainty(a.noul) : a.confidence);
    }
    return clamp01(low);
}

function above(id, fallback = 0.6) {
    return thresholdFor(id, fallback);
}

// ── Policies ────────────────────────────────────────────────────────────────
// Each returns { route, confidence, reason } or { route: null, confidence, reason }.

const POLICIES = {

    "memory.query": (answers) => {
        const strategy = pick(answers, "strategy");
        if (!strategy) return { route: null, confidence: 0, reason: "no answer" };
        const confidence = choiceConfidence(answers, "strategy");
        if (confidence < above("memory.query", 0.55)) return { route: null, confidence, reason: "split" };
        return { route: { strategy }, confidence, reason: strategy };
    },

    "memory.rerank": (answers, ctx) => {
        const memories = (ctx.memories || []).slice(0, 3);
        if (!memories.length) return { route: null, confidence: 0, reason: "nothing to rank" };
        const ids = [];
        memories.forEach((_, i) => ids.push(`r${i}_relevance`, `r${i}_utility`));
        if (!have(answers, ids)) return { route: null, confidence: 0, reason: "incomplete" };

        const scored = [];
        const conflicts = [];
        const drop = [];
        memories.forEach((_, i) => {
            const relevance = num(scoreValue(answers, `r${i}_relevance`)) ?? 0;
            const utility = num(scoreValue(answers, `r${i}_utility`)) ?? 0;
            const injection = noul(answers, `r${i}_injection`) ?? 0;
            const contradicts = noul(answers, `r${i}_contradicts`) ?? 0;
            const supersedes = noul(answers, `r${i}_supersedes`) ?? 0;
            const value = (relevance / 2) * 0.6 + (utility / 2) * 0.4;
            // Code owns the threshold and the arithmetic; JEV only supplied the parts.
            if (injection >= 0.7) { drop.push({ index: i, why: "injection" }); return; }
            if (contradicts >= 0.8) { drop.push({ index: i, why: "contradicted" }); return; }
            if (contradicts >= 0.6 || supersedes >= 0.7) conflicts.push({ index: i, supersedes: supersedes >= 0.7 });
            if (value > 0 && relevance >= 0.5) scored.push({ index: i, value: Number(value.toFixed(3)) });
        });

        const confidence = weakest(answers, ids);
        if (!scored.length) return { route: { order: [], drop, conflicts }, confidence, reason: "nothing worth keeping" };
        scored.sort((a, b) => b.value - a.value || a.index - b.index);
        return {
            route: { order: scored.map(s => s.index), values: scored, drop, conflicts },
            confidence,
            reason: "ranked",
        };
    },

    "memory.summary": (answers) => {
        if (!have(answers, ["grounded", "wrong_entity", "unsupported"])) return { route: null, confidence: 0, reason: "incomplete" };
        const grounded = noul(answers, "grounded");
        const wrongEntity = noul(answers, "wrong_entity");
        const unsupported = noul(answers, "unsupported");
        const omits = noul(answers, "omits_event") ?? 0;
        const language = noul(answers, "language_match") ?? 1;

        // A rejection needs ONE strong reason; acceptance needs every check to
        // pass. Confidence follows that asymmetry, or an obviously wrong summary
        // would be held back by its least decisive answer.
        const rejects = [];
        if (grounded < 0.4) rejects.push(certainty(grounded));
        if (wrongEntity >= 0.6) rejects.push(certainty(wrongEntity));
        if (unsupported >= 0.6) rejects.push(certainty(unsupported));
        if (language < 0.3) rejects.push(certainty(language));
        const accepts = grounded >= 0.7 && wrongEntity < 0.3 && unsupported < 0.35 && omits < 0.6 && language >= 0.5;

        let verdict = "review";
        let confidence = clamp01(Math.min(certainty(grounded), certainty(wrongEntity), certainty(unsupported)));
        if (rejects.length) {
            verdict = "raw_source";
            confidence = clamp01(Math.max(...rejects));
        } else if (accepts) {
            verdict = "accept";
            confidence = clamp01(Math.min(certainty(grounded), certainty(wrongEntity), certainty(unsupported)));
        }
        return { route: { verdict, grounded, wrongEntity, unsupported, omits, language }, confidence, reason: verdict };
    },

    "memory.archive": (answers) => {
        const relation = num(scoreValue(answers, "relation"));
        if (relation === null || !have(answers, ["conflict", "supersedes"])) return { route: null, confidence: 0, reason: "incomplete" };
        const conflict = noul(answers, "conflict") ?? 0;
        const supersedes = noul(answers, "supersedes") ?? 0;
        const confidence = clamp01(Math.min(scoreConfidence(answers, "relation"), certainty(conflict)));
        let route = "append";
        if (conflict >= 0.7 && supersedes >= 0.6) route = "show_conflict";
        else if (relation >= 1.4) route = "link_duplicate";
        else if (relation >= 0.6) route = "link_duplicate";
        return { route: { route, relation, conflict, supersedes }, confidence, reason: route };
    },

    "notebook.clue": (answers, ctx) => {
        const clues = (ctx.clues || []).slice(0, 8);
        if (!clues.length) return { route: null, confidence: 0, reason: "no clues" };
        const ids = [];
        clues.forEach((_, i) => ids.push(`c${i}_relation`, `c${i}_revealed`));
        if (!have(answers, ids)) return { route: null, confidence: 0, reason: "incomplete" };

        let low = 1;
        const verdicts = clues.map((_, i) => {
            const relation = pick(answers, `c${i}_relation`);
            const revealed = noul(answers, `c${i}_revealed`) ?? 0;
            const confidence = clamp01(Math.min(choiceConfidence(answers, `c${i}_relation`), certainty(revealed)));
            low = Math.min(low, confidence);
            let found = null;
            if ((relation === "revealed" && revealed >= 0.7) || revealed >= 0.8) found = true;
            else if (relation === "contradicted" || relation === "mentioned" || relation === "hinted" || relation === "other" || revealed <= 0.3) found = false;
            return { index: i, found, relation, revealed, confidence };
        });
        // Each clue stands on its own: a decided one is applied even when another
        // is still ambiguous, and the ambiguous one keeps the parser's value.
        const decided = verdicts.filter(v => v.found !== null);
        if (!decided.length) return { route: null, confidence: low, reason: "uncertain" };
        const confidence = Math.min(...decided.map(v => v.confidence));
        return { route: { clues: verdicts }, confidence, reason: "checked" };
    },

    "notebook.secret": (answers) => {
        if (!have(answers, ["leak", "new_learner"])) return { route: null, confidence: 0, reason: "incomplete" };
        const leak = noul(answers, "leak");
        const learned = noul(answers, "new_learner");
        const knows = noul(answers, "speaker_knows");
        // A leak is the prose using the secret WITHOUT anyone learning it here.
        // Without a named speaker, "who knew it" is not answerable; "was it
        // learned in this exchange" is, and that is what the route needs.
        const leakFlag = leak >= 0.7 && learned < 0.5;
        const confidence = clamp01(Math.min(certainty(leak), certainty(learned)));
        return {
            route: { leak: leakFlag, learned: learned >= 0.7, speakerKnows: knows !== null ? knows >= 0.7 : null },
            confidence,
            reason: leakFlag ? "leak" : "ok",
        };
    },

    "npc.shortlist": (answers, ctx) => {
        const roster = (ctx.roster || []).slice(0, 20);
        if (!roster.length) return { route: null, confidence: 0, reason: "no roster" };
        const ids = [];
        roster.forEach((_, i) => ids.push(`c${i}_relevant`, `c${i}_present`));
        if (!have(answers, ids)) return { route: null, confidence: 0, reason: "incomplete" };

        const rows = roster.map((c, i) => {
            const relevant = noul(answers, `c${i}_relevant`) ?? 0;
            const present = noul(answers, `c${i}_present`) ?? 0;
            return {
                name: c.name || c.id,
                relevant,
                present,
                value: Math.max(relevant, present),
                cert: Math.max(certainty(relevant), certainty(present)),
            };
        });
        const keep = rows.filter(r => r.value >= 0.5).sort((a, b) => b.value - a.value).slice(0, 5);
        const certainNone = rows.every(r => r.value <= 0.3);
        if (!keep.length && !certainNone) return { route: null, confidence: 0, reason: "uncertain" };
        const used = keep.length ? keep : rows;
        const confidence = clamp01(used.reduce((sum, r) => sum + r.cert, 0) / used.length);
        return { route: { names: keep.map(r => r.name), rows }, confidence, reason: keep.length ? "shortlisted" : "none" };
    },

    "npc.rank": (answers, ctx) => {
        const candidates = (ctx.candidates || []).slice(0, 5);
        if (!candidates.length) return { route: null, confidence: 0, reason: "no candidates" };
        const ids = [];
        candidates.forEach((_, i) => ids.push(`c${i}_relevant`, `c${i}_present`));
        if (!have(answers, ids)) return { route: null, confidence: 0, reason: "incomplete" };
        const rows = candidates.map((c, i) => ({
            name: c.name,
            relevance: num(scoreValue(answers, `c${i}_relevant`)) ?? 0,
            presence: num(scoreValue(answers, `c${i}_present`)) ?? 0,
            conflict: noul(answers, `c${i}_identity_conflict`) ?? 0,
        }));
        const confidence = weakest(answers, ids);
        const conversation = rows.filter(r => r.relevance >= 0.5).sort((a, b) => b.relevance - a.relevance);
        const visual = rows.filter(r => r.presence >= 1.5 && r.relevance >= 0.5).sort((a, b) => b.presence - a.presence || b.relevance - a.relevance);
        const conflicts = rows.filter(r => r.conflict >= 0.7).map(r => r.name);
        return { route: { conversation, visual, conflicts, rows }, confidence, reason: "ranked" };
    },

    "npc.dossier": (answers) => {
        if (!have(answers, ["named_speaking", "worth_dossier", "already_exists"])) return { route: null, confidence: 0, reason: "incomplete" };
        const named = noul(answers, "named_speaking");
        const worth = noul(answers, "worth_dossier");
        const exists = noul(answers, "already_exists");
        const confidence = weakest(answers, ["named_speaking", "worth_dossier", "already_exists"]);
        const create = named >= 0.7 && worth >= 0.75 && exists < 0.5;
        const suggest = named >= 0.7 && worth >= 0.75 && exists >= 0.5 && exists < 0.8;
        return { route: { create, suggestExisting: suggest, named, worth, exists }, confidence, reason: create ? "create" : suggest ? "existing" : "skip" };
    },

    "npc.identity": (answers) => {
        const relation = num(scoreValue(answers, "relation"));
        if (relation === null || !have(answers, ["field_agree"])) return { route: null, confidence: 0, reason: "incomplete" };
        const agree = noul(answers, "field_agree") ?? 0;
        const confidence = clamp01(Math.min(scoreConfidence(answers, "relation"), certainty(agree)));
        let verdict = "different";
        if (relation >= 1.5 && agree >= 0.6) verdict = "same";
        else if (relation >= 0.75) verdict = "uncertain";
        return { route: { verdict, relation, agree }, confidence, reason: verdict };
    },

    "npc.updates": (answers, ctx) => {
        const ops = (ctx.ops || []).slice(0, 10);
        if (!ops.length) return { route: null, confidence: 0, reason: "no operations" };
        const ids = [];
        ops.forEach((_, i) => ids.push(`o${i}_support`));
        if (!have(answers, ids)) return { route: null, confidence: 0, reason: "incomplete" };
        const verdicts = ops.map((o, i) => {
            const support = pick(answers, `o${i}_support`);
            const wrong = noul(answers, `o${i}_wrong_entity`) ?? 0;
            const confidence = clamp01(Math.min(choiceConfidence(answers, `o${i}_support`), certainty(wrong)));
            const accept = support === "supported" && wrong < 0.6;
            const hold = support === "contradicted" || wrong >= 0.6;
            return { index: i, verdict: accept ? "accept" : hold ? "hold" : "review", support, wrong, confidence };
        });
        const target = answers.remove_target && answers.remove_target.type === "choice"
            ? { line: answers.remove_target.choice, confidence: answers.remove_target.confidence }
            : null;
        return {
            route: { verdicts, target },
            confidence: verdicts.length ? Math.min(...verdicts.map(v => v.confidence)) : 0,
            reason: "checked",
        };
    },

    "npc.prompt": (answers) => {
        const ids = ["identity_ok", "outfit_ok", "unsupported_garment", "wrong_character"];
        if (!have(answers, ids)) return { route: null, confidence: 0, reason: "incomplete" };
        const identity = noul(answers, "identity_ok");
        const outfit = noul(answers, "outfit_ok");
        const garment = noul(answers, "unsupported_garment");
        const wrong = noul(answers, "wrong_character");
        const issues = [];
        if (identity < 0.5) issues.push("identity");
        if (outfit < 0.5) issues.push("outfit");
        if (garment >= 0.7) issues.push("unsupported_garment");
        if (wrong >= 0.5) issues.push("wrong_character");
        const confidence = clamp01(Math.min(certainty(identity), certainty(outfit), certainty(garment), certainty(wrong)));
        return { route: { issues, ok: issues.length === 0 }, confidence, reason: issues.join(",") || "ok" };
    },

    "director.arc": (answers) => {
        const ids = ["arc_completed", "user_redirect", "stalled", "needs_current_plan"];
        if (!have(answers, ids)) return { route: null, confidence: 0, reason: "incomplete" };
        const completed = noul(answers, "arc_completed");
        const redirect = noul(answers, "user_redirect");
        const stalled = noul(answers, "stalled");
        const needed = noul(answers, "needs_current_plan");
        const confidence = clamp01(Math.min(certainty(completed), certainty(redirect)));
        let action = null;
        if (redirect >= 0.75) action = "evolve";
        else if (completed >= 0.7 && redirect < 0.5) action = "evolve";
        else if (stalled >= 0.7) action = "stalled";
        else if (needed >= 0.7) action = "hold";
        if (!action) return { route: null, confidence, reason: "no clear signal" };
        return { route: { action, completed, redirect, stalled, needed }, confidence, reason: action };
    },

    "director.directive": (answers) => {
        const ids = ["controls_user", "continuity", "respects_note", "future_direction", "keeps_threads"];
        if (!have(answers, ids)) return { route: null, confidence: 0, reason: "incomplete" };
        const control = noul(answers, "controls_user");
        const continuity = noul(answers, "continuity");
        const note = noul(answers, "respects_note");
        const future = noul(answers, "future_direction");
        const threads = noul(answers, "keeps_threads");
        const warnings = [];
        if (continuity < 0.4) warnings.push("continuity");
        if (note < 0.4) warnings.push("note");
        if (future < 0.4) warnings.push("future");
        if (threads < 0.4) warnings.push("threads");
        const confidence = clamp01(Math.min(certainty(control), certainty(continuity)));
        const verdict = control >= 0.7 ? "reject" : warnings.length ? "review" : "accept";
        return { route: { verdict, warnings, values: { control, continuity, note, future, threads } }, confidence, reason: verdict };
    },

    "config.compiler": (answers, ctx) => {
        const options = ctx.options || {};
        const diffs = {};
        let low = 1;
        let any = false;
        for (const dim of Object.keys(options)) {
            const a = answers[dim];
            if (!a || a.type !== "choice") continue;
            low = Math.min(low, a.confidence);
            if (a.choice === "none" || a.confidence < 0.55) continue;
            diffs[dim] = a.choice;
            any = true;
        }
        if (!any) return { route: null, confidence: low, reason: "nothing recognised" };
        return { route: { diffs }, confidence: clamp01(low), reason: "diff" };
    },

    "context.budget": (answers, ctx) => {
        const candidates = (ctx.candidates || []).slice(0, 12);
        if (!candidates.length) return { route: null, confidence: 0, reason: "no candidates" };
        const ids = [];
        candidates.forEach((_, i) => ids.push(`c${i}_utility`));
        if (!have(answers, ids)) return { route: null, confidence: 0, reason: "incomplete" };
        const rows = candidates.map((c, i) => {
            const utility = num(scoreValue(answers, `c${i}_utility`)) ?? 0;
            const redundant = noul(answers, `c${i}_redundant`) ?? 0;
            const conflicts = noul(answers, `c${i}_conflicts`) ?? 0;
            const injection = noul(answers, `c${i}_injection`) ?? 0;
            const drop = injection >= 0.7 || conflicts >= 0.7 || (redundant >= 0.7 && utility <= 1);
            return { index: i, id: c.id, tokens: c.tokens, utility, drop, value: utility / 2 };
        });
        const keep = rows.filter(r => !r.drop && r.utility >= 0.5).sort((a, b) => b.value - a.value || a.index - b.index);
        const drop = rows.filter(r => r.drop || r.utility < 0.5);
        return {
            route: { keep: keep.map(r => r.id), drop: drop.map(r => r.id), rows },
            confidence: weakest(answers, ids),
            reason: "budgeted",
        };
    },

    "setup.loadout": (answers) => {
        const loadout = pick(answers, "loadout");
        if (!loadout) return { route: null, confidence: 0, reason: "no answer" };
        const confidence = choiceConfidence(answers, "loadout");
        if (loadout === "none" || confidence < above("setup.loadout", 0.6)) return { route: null, confidence, reason: "none" };
        return { route: { loadout }, confidence, reason: loadout };
    },

    "addons.diagnose": (answers, ctx) => {
        const addons = (ctx.addons || []).slice(0, 12);
        const flagged = [];
        addons.forEach((a, i) => {
            const p = noul(answers, `a${i}_violated`);
            if (p !== null && p >= 0.75) flagged.push({ id: a.id, label: a.label, p });
        });
        if (!flagged.length) return { route: { flagged: [] }, confidence: 1, reason: "clean" };
        return { route: { flagged }, confidence: clamp01(Math.max(...flagged.map(f => certainty(f.p)))), reason: "flagged" };
    },

    "banlist.candidate": (answers, ctx) => {
        const ids = ["repetitive", "too_broad", "continuity_term"];
        if (!have(answers, ids)) return { route: null, confidence: 0, reason: "incomplete" };
        const repetitive = noul(answers, "repetitive");
        const broad = noul(answers, "too_broad");
        const term = noul(answers, "continuity_term");
        const occurrences = Number(ctx.occurrences) || 0;
        // Confidence belongs to the ACTION, not to the weakest answer. "Keep
        // Maya" is a confident decision when the phrase is clearly a setting
        // term, even if "is it a tic" is split.
        const protect = Math.max(term, broad);
        let action = "keep";
        let confidence = clamp01(protect);
        if (occurrences >= 2 && repetitive >= 0.75 && broad < 0.4 && term < 0.4) {
            action = "ban";
            confidence = clamp01(Math.min(certainty(repetitive), certainty(broad), certainty(term)));
        } else if (occurrences >= 2 && protect >= 0.7) {
            action = "keep";
            confidence = clamp01(protect);
        } else if (occurrences >= 2 && repetitive >= 0.5) {
            action = "review";
            confidence = clamp01(certainty(repetitive));
        }
        return { route: { action, repetitive, broad, term }, confidence, reason: action };
    },

    "dice.assess": (answers) => {
        const attempt = noul(answers, "attempt");
        const difficulty = num(scoreValue(answers, "difficulty"));
        const competence = pick(answers, "competence");
        if (attempt === null || difficulty === null || !competence) return { route: null, confidence: 0, reason: "incomplete" };
        const confidence = clamp01(Math.min(certainty(attempt), scoreConfidence(answers, "difficulty"), choiceConfidence(answers, "competence")));
        // The uncertainty band around 0.5 is the documented Noul dead zone. A hug
        // at 0.47 is not a "no": it is "ask the old prompt".
        if (attempt >= 0.3 && attempt <= 0.7) return { route: null, confidence, reason: "uncertain" };
        if (attempt < 0.3) return { route: { roll: false }, confidence, reason: "no roll" };
        const band = Math.max(0, Math.min(5, Math.round(difficulty)));
        return { route: { roll: true, band, competence, attempt, difficulty }, confidence, reason: "roll" };
    },

    "reply.doctor": (answers, ctx) => {
        const ids = ["in_fiction", "user_agency", "pov", "style_fit", "repetition", "meta_text", "npc_knowledge"];
        const withDice = Boolean(ctx && ctx.diceLines && ctx.diceLines.length);
        if (withDice) ids.push("dice_honored");
        if (!have(answers, ids)) return { route: null, confidence: 0, reason: "incomplete" };
        const issues = [];
        const add = (id, test, label) => { if (test) issues.push(label); };
        add("in_fiction", (noul(answers, "in_fiction") ?? 1) < 0.5, "broke the fiction");
        add("user_agency", (answers.user_agency?.noul ?? 0) >= 0.6, "spoke for the user");
        add("pov", (noul(answers, "pov") ?? 1) < 0.5, "wrong point of view");
        add("style_fit", (noul(answers, "style_fit") ?? 1) < 0.5, "style or length");
        add("repetition", (noul(answers, "repetition") ?? 0) >= 0.7, "repetition");
        add("meta_text", (noul(answers, "meta_text") ?? 0) >= 0.6, "meta or refusal text");
        add("npc_knowledge", (noul(answers, "npc_knowledge") ?? 0) >= 0.7, "knowledge boundary");
        if (withDice) add("dice_honored", (noul(answers, "dice_honored") ?? 1) < 0.5, "dice line vs prose");
        const confidence = weakest(answers, ids);
        return { route: { issues, clean: issues.length === 0 }, confidence, reason: issues.join(",") || "clean" };
    },

    "reply.swipes": (answers, ctx) => {
        const swipes = (ctx.swipes || []).slice(0, 6);
        if (!swipes.length) return { route: null, confidence: 0, reason: "no swipes" };
        const rows = swipes.map((_, i) => ({ index: i, score: num(scoreValue(answers, `s${i}_quality`)) ?? 0 }));
        if (rows.some(r => r.score === 0 && scoreValue(answers, `s${r.index}_quality`) === null)) return { route: null, confidence: 0, reason: "incomplete" };
        const confidence = Math.min(...rows.map(r => scoreConfidence(answers, `s${r.index}_quality`)));
        const order = [...rows].sort((a, b) => b.score - a.score || a.index - b.index);
        return { route: { order: order.map(r => r.index), scores: rows }, confidence: clamp01(confidence), reason: "ranked" };
    },

    "image.gate": (answers) => {
        if (!have(answers, ["photo_event"])) return { route: null, confidence: 0, reason: "incomplete" };
        const photo = noul(answers, "photo_event");
        const moment = noul(answers, "visual_moment") ?? 0;
        const confidence = clamp01(Math.min(certainty(photo), certainty(moment)));
        if (photo <= 0.3 && moment <= 0.3) return { route: { proceed: false }, confidence, reason: "skip" };
        if (photo >= 0.7 || moment >= 0.8) return { route: { proceed: true }, confidence, reason: "proceed" };
        return { route: null, confidence, reason: "uncertain" };
    },

    "image.prompt": (answers) => {
        const ids = ["wrong_character", "wrong_outfit", "unsupported_scene", "contradictory_composition", "missing_subject"];
        if (!have(answers, ids)) return { route: null, confidence: 0, reason: "incomplete" };
        const issues = [];
        if ((noul(answers, "wrong_character") ?? 0) >= 0.6) issues.push("wrong_character");
        if ((noul(answers, "wrong_outfit") ?? 0) >= 0.6) issues.push("wrong_outfit");
        if ((noul(answers, "unsupported_scene") ?? 0) >= 0.7) issues.push("unsupported_scene");
        if ((noul(answers, "contradictory_composition") ?? 0) >= 0.7) issues.push("composition");
        if ((noul(answers, "missing_subject") ?? 0) >= 0.7) issues.push("missing_subject");
        const confidence = weakest(answers, ids);
        return { route: { issues, ok: issues.length === 0 }, confidence, reason: issues.join(",") || "ok" };
    },

    "image.review": (answers) => {
        const ids = ["usable", "prompt_alignment", "outfit_consistent", "same_character", "face_present"];
        if (!have(answers, ids)) return { route: null, confidence: 0, reason: "incomplete" };
        const values = Object.fromEntries(ids.map(id => [id, noul(answers, id)]));
        const issues = [];
        if (values.usable < 0.5) issues.push("unusable");
        if (values.prompt_alignment < 0.5) issues.push("prompt");
        if (values.outfit_consistent < 0.5) issues.push("outfit");
        if (values.same_character < 0.5) issues.push("identity");
        if (values.face_present < 0.5) issues.push("no_face");
        return { route: { issues, values }, confidence: weakest(answers, ids), reason: issues.join(",") || "ok" };
    },

    "reply.assess": (answers, ctx) => {
        const base = ["world_facts_changed", "stats_changed", "notebook_evidence_present", "dossier_worthy", "photo_requested", "stayed_in_fiction"];
        const ids = [...base, "scene_beat", "tension", "location"];
        if (ctx.directorEnabled) ids.push("directive_coverage");
        if (!have(answers, ids)) return { route: null, confidence: 0, reason: "incomplete" };

        const flag = (p) => (p >= 0.7 ? true : p <= 0.3 ? false : null);
        const values = {
            worldFactsChanged: flag(noul(answers, "world_facts_changed")),
            statsChanged: flag(noul(answers, "stats_changed")),
            notebookEvidence: flag(noul(answers, "notebook_evidence_present")),
            dossierWorthy: flag(noul(answers, "dossier_worthy")),
            photoRequested: flag(noul(answers, "photo_requested")),
            stayedInFiction: flag(noul(answers, "stayed_in_fiction")),
            sceneBeat: pick(answers, "scene_beat"),
            location: pick(answers, "location"),
            tension: num(scoreValue(answers, "tension")),
            directiveCoverage: ctx.directorEnabled ? num(scoreValue(answers, "directive_coverage")) : null,
        };
        return {
            route: { values, answers },
            confidence: assessmentConfidence(answers, ids),
            reason: "assessed",
        };
    },

    "turn.assess": (answers) => {
        const ids = ["information_need", "continues_scene", "meta_request"];
        if (!have(answers, ids)) return { route: null, confidence: 0, reason: "incomplete" };
        const flag = (p) => (p >= 0.7 ? true : p <= 0.3 ? false : null);
        return {
            route: {
                informationNeed: flag(noul(answers, "information_need")),
                continuesScene: flag(noul(answers, "continues_scene")),
                metaRequest: flag(noul(answers, "meta_request")),
            },
            confidence: weakest(answers, ids),
            reason: "assessed",
        };
    },

    "state.verify": (answers, ctx) => {
        const deltas = (ctx.deltas || []).slice(0, 12);
        if (!deltas.length) return { route: null, confidence: 0, reason: "no deltas" };
        const ids = deltas.map((_, i) => `d${i}_support`);
        if (!have(answers, ids)) return { route: null, confidence: 0, reason: "incomplete" };
        const verdicts = deltas.map((d, i) => {
            const support = pick(answers, `d${i}_support`);
            const wrongEntity = noul(answers, `d${i}_wrong_entity`) ?? 0;
            const reversed = noul(answers, `d${i}_reversed`) ?? 0;
            const forbidden = noul(answers, `d${i}_forbidden_knowledge`) ?? 0;
            const confidence = clamp01(Math.min(choiceConfidence(answers, `d${i}_support`), certainty(wrongEntity), certainty(reversed)));
            let verdict = "review";
            if (support === "supported" && wrongEntity < 0.6 && reversed < 0.6 && forbidden < 0.6) verdict = "accept";
            else if (support === "contradicted" || wrongEntity >= 0.7 || reversed >= 0.7 || forbidden >= 0.6) verdict = "hold";
            return { index: i, verdict, support, wrongEntity, reversed, forbidden, confidence };
        });
        return { route: { verdicts }, confidence: Math.min(...verdicts.map(v => v.confidence)), reason: "checked" };
    },

    "blocks.verify": (answers, ctx) => {
        const kind = String(ctx.kind || "");
        const need = kind === "cyoa" ? ["distinct", "actionable", "leaks_outcome"]
            : kind === "bonds" || kind === "sheet" ? ["grounded", "direction_ok"]
                : kind === "inner" ? ["knowledge_ok", "in_voice"]
                    : kind === "html" ? ["in_world", "no_commands"]
                        : ["valid"];
        if (!have(answers, need)) return { route: null, confidence: 0, reason: "incomplete" };
        const issues = [];
        const p = id => noul(answers, id) ?? 0;
        if (kind === "cyoa") {
            if (p("distinct") < 0.6) issues.push("duplicate choices");
            if (p("actionable") < 0.6) issues.push("not actionable");
            if (p("leaks_outcome") >= 0.5) issues.push("leaks outcome");
        } else if (kind === "bonds" || kind === "sheet") {
            if (p("grounded") < 0.6) issues.push("ungrounded");
            if (p("direction_ok") < 0.6) issues.push("direction");
        } else if (kind === "inner") {
            if (p("knowledge_ok") < 0.6) issues.push("knowledge");
            if (p("in_voice") < 0.5) issues.push("voice");
        } else if (kind === "html") {
            if (p("in_world") < 0.6) issues.push("not in-world");
            if (p("no_commands") < 0.7) issues.push("commands");
        } else if (p("valid") < 0.6) issues.push("invalid");
        return {
            route: { ok: issues.length === 0, issues },
            confidence: weakest(answers, need),
            reason: issues.join(",") || "ok",
        };
    },

    "worker.triage": (answers) => {
        const kind = pick(answers, "kind");
        if (!kind) return { route: null, confidence: 0, reason: "no answer" };
        const confidence = choiceConfidence(answers, "kind");
        if (confidence < 0.6 || kind === "other") return { route: null, confidence, reason: "unsure" };
        return { route: { kind }, confidence, reason: kind };
    },
};

/**
 * Apply a feature's policy to validated answers.
 * @returns {{route: any, confidence: number, reason: string}} route === null ⇒ current behaviour
 */
export function decide(feature, answers, ctx) {
    const policy = POLICIES[feature];
    if (!policy || !answers) return { route: null, confidence: 0, reason: "no policy" };
    try {
        const result = policy(answers || {}, ctx || {});
        const out = result || { route: null, confidence: 0, reason: "empty" };
        // A route at or below the feature's floor is treated as "not confident":
        // the threshold is the gate, not a tie-breaker.
        if (out.route !== null && out.confidence < above(feature, 0.6)) {
            return { route: null, confidence: out.confidence, reason: `${out.reason} (below threshold)` };
        }
        return { route: out.route, confidence: clamp01(out.confidence || 0), reason: out.reason || "" };
    } catch (e) {
        console.warn(`[Megumin-Suite] JEV policy "${feature}" failed.`, e);
        return { route: null, confidence: 0, reason: "policy error" };
    }
}

/** The labels a policy understands for a feature, for the inspector. */
export function featureLabel(feature) {
    return featureMeta(feature).label;
}
