// ─────────────────────────────────────────────────────────────────────────────
// Preview-and-confirm tools (docs/jev.md proposals 21–24 and 27).
//
// These are the stage-4 surfaces: they propose, show the proposal, and only the
// user's confirmation calls an existing writer. Nothing here auto-applies, and
// no tool can invent an option that is not already in the suite's registries.
//
//   Setup assistant   natural language → existing Story Config options (diff)
//   Model loadout     stated priorities → one of the maintainer's loadouts
//   Context budget    which optional context earns its tokens, with totals
//   Add-on diagnostics which enabled add-on a reply broke
//   Reply Doctor      which quality checks the last reply failed
//   Swipe ranking     the same rubric across the swipes already in the chat
// ─────────────────────────────────────────────────────────────────────────────

import { getContext, Popup, POPUP_TYPE, saveSettingsDebounced } from "../st.js";
import { localProfile } from "../core/state.js";
import { saveProfileToMemory } from "../core/profile.js";
import { hardcodedLogic } from "../../data/database.js";
import { jevJudge } from "./index.js";
import { jevSettings } from "./settings.js";
import { storyConfigFields } from "../features/storyconfig/config.js";
import { LOADOUTS } from "../features/modelsetup/loadouts.js";
import { applyLoadoutForCharacter } from "../features/modelsetup/ui.js";
import { contextJevPrepare, estimateTokens } from "../engine/contextJev.js";
import { memGetRelevantVaultEntries } from "../features/memory/index.js";
import { npcJevRankPlan } from "../features/npc/jev.js";
import { npcBuildTextFromData } from "../features/npc/data.js";

const esc = v => $("<span>").text(String(v ?? "")).html();
const clip = (s, n) => (String(s || "").length > n ? `${String(s).slice(0, n)}…` : String(s || ""));

function lastReply() {
    const chat = getContext()?.chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && !m.is_user && !m.is_system) return { message: m, index: i, text: String(m.mes || "") };
    }
    return null;
}

function configSummary() {
    const cfg = localProfile?.storyConfig || {};
    const parts = [];
    for (const field of storyConfigFields) {
        const value = cfg[field.key];
        if (value === undefined || value === "" || value === null) continue;
        parts.push(`${field.label}: ${Array.isArray(value) ? value.join(", ") : value}`);
    }
    return parts.join("; ").slice(0, 800);
}

function diceLines(text) {
    return [...String(text || "").matchAll(/<Dice>([\s\S]*?)<\/Dice>/gi)].map(m => m[1].trim()).slice(0, 6);
}

async function popup($root, title, { okButton = "Close" } = {}) {
    $root.prepend(`<div class="bgp-head"><div><b>${esc(title)}</b></div></div>`);
    await new Popup($root, POPUP_TYPE.TEXT, "", { wide: true, large: true, allowVerticalScrolling: true, okButton }).show();
}

// ── 21. Setup assistant ─────────────────────────────────────────────────────

export async function openSetupAssistant() {
    const $root = $(`<div class="bgp"></div>`);
    $root.append(`
        <div class="bgp-head">
            <div><b>Describe the story you want</b></div>
            <div class="bgp-meta">Maps your words onto the options this suite already has. It never invents a setting, and nothing is applied until you press Apply.</div>
        </div>
        <textarea class="ps-modern-input" id="jev_setup_request" rows="3" style="width:100%;" placeholder="slow-burn mystery, short replies, dice, warm NPCs"></textarea>
        <div style="margin:10px 0;"><button type="button" class="menu_button" id="jev_setup_run" style="width:auto;margin:0;">Suggest settings</button></div>
        <div id="jev_setup_diff"></div>
    `);
    const $diff = $root.find("#jev_setup_diff");

    $root.find("#jev_setup_run").on("click", async () => {
        const request = String($root.find("#jev_setup_request").val() || "").trim();
        if (!request) { toastr.warning("Write what you want first.", "Megumin Suite"); return; }
        $diff.html(`<div class="bgp-meta">Reading…</div>`);

        const options = {};
        for (const field of storyConfigFields) {
            const chips = Array.isArray(field.chips) ? field.chips.slice(0, 12) : [];
            if (!chips.length) continue;
            options[field.key] = {};
            chips.forEach(chip => { options[field.key][chip] = `${field.label}: ${chip}`; });
        }
        if (!Object.keys(options).length) { $diff.html(`<div class="bgp-meta">No closed option lists are available to map onto.</div>`); return; }

        const judged = await jevJudge("config.compiler", { request, options });
        if (!judged.ok) { $diff.html(`<div class="bgp-meta">JEV is not available (${esc(judged.reason)}).</div>`); return; }
        if (!judged.route || !Object.keys(judged.route.diffs || {}).length) {
            $diff.html(`<div class="bgp-meta">Nothing in that request maps onto an existing option.</div>`);
            return;
        }

        const diffs = judged.route.diffs;
        $diff.empty();
        $diff.append(`<div class="bgp-meta">Proposed changes (confidence ${Number(judged.confidence).toFixed(2)}):</div>`);
        const $rows = $(`<div></div>`);
        for (const [key, value] of Object.entries(diffs)) {
            const field = storyConfigFields.find(f => f.key === key);
            const current = Array.isArray(localProfile?.storyConfig?.[key]) ? localProfile.storyConfig[key].join(", ") : (localProfile?.storyConfig?.[key] ?? "");
            const $row = $(`<div class="bgp-msg"><div><b>${esc(field?.label || key)}</b><div class="bgp-meta"></div></div></div>`);
            $row.find(".bgp-meta").text(`${current || "(empty)"} → ${value}`);
            $rows.append($row);
        }
        $diff.append($rows);
        const canApply = judged.mode === "on";
        if (!canApply) $diff.append(`<div class="bgp-meta">Preview only: shadow mode is on (or the feature is in shadow). Turn shadow mode off and set the feature to on to apply.</div>`);
        const $apply = $(`<button type="button" class="menu_button" style="width:auto;margin:8px 0;">Apply these settings</button>`);
        $apply.prop("disabled", !canApply);
        $apply.on("click", () => {
            if (!localProfile.storyConfig) localProfile.storyConfig = {};
            for (const [key, value] of Object.entries(diffs)) localProfile.storyConfig[key] = value;
            saveProfileToMemory();
            toastr.success("Story settings applied. Every value came from the existing option list.", "Megumin Suite");
            $apply.prop("disabled", true);
        });
        $diff.append($apply);
    });

    await popup($root, "Setup assistant");
}

// ── 23. Model loadout suggestion ────────────────────────────────────────────

export async function openLoadoutSuggestion() {
    const $root = $(`<div class="bgp"></div>`);
    $root.append(`
        <div class="bgp-head">
            <div><b>Which tested loadout fits?</b></div>
            <div class="bgp-meta">Chooses only among the loadouts in the Model Setup tab. The table itself is never edited, and nothing is applied without you.</div>
        </div>
        <textarea class="ps-modern-input" id="jev_loadout_wants" rows="2" style="width:100%;" placeholder="I want speed, and my replies keep failing on Blocks"></textarea>
        <div style="margin:10px 0;"><button type="button" class="menu_button" id="jev_loadout_run" style="width:auto;margin:0;">Suggest</button></div>
        <div id="jev_loadout_out"></div>
    `);
    $root.find("#jev_loadout_run").on("click", async () => {
        const wants = String($root.find("#jev_loadout_wants").val() || "").trim();
        const $out = $root.find("#jev_loadout_out");
        if (!wants) { toastr.warning("Say what you want first.", "Megumin Suite"); return; }
        const judged = await jevJudge("setup.loadout", {
            priorities: wants,
            problems: "",
            loadouts: LOADOUTS.map(l => ({ id: l.id, label: l.name, notes: l.why || l.name })),
        });
        $out.empty();
        if (!judged.ok || !judged.route) {
            $out.html(`<div class="bgp-meta">No confident match${judged.ok ? "" : ` (${esc(judged.reason)})`}. Nothing to apply.</div>`);
            return;
        }
        const loadout = LOADOUTS.find(l => l.id === judged.route.loadout);
        if (!loadout) { $out.html(`<div class="bgp-meta">That loadout is no longer in the table.</div>`); return; }
        $out.append(`<div class="bgp-msg"><div><b>${esc(loadout.name)}</b><div class="bgp-meta">${esc(clip(loadout.why || "", 400))}</div></div></div>`);
        const canApply = judged.mode === "on";
        if (!canApply) $out.append(`<div class="bgp-meta">Preview only: shadow mode is on (or the feature is in shadow).</div>`);
        const $apply = $(`<button type="button" class="menu_button" style="width:auto;margin:8px 0;">Apply to this character</button>`);
        $apply.prop("disabled", !canApply);
        $apply.on("click", () => {
            if (applyLoadoutForCharacter(loadout)) $apply.prop("disabled", true);
        });
        $out.append($apply);
    });
    await popup($root, "Model loadout");
}

// ── 24. Add-on diagnostics ──────────────────────────────────────────────────

export async function openAddonDiagnostics() {
    const reply = lastReply();
    const $root = $(`<div class="bgp"></div>`);
    if (!reply) { $root.append(`<div class="bgp-meta">There is no reply to check yet.</div>`); return popup($root, "Add-on diagnostics"); }

    const enabled = (localProfile?.addons || [])
        .map(id => hardcodedLogic.addons.find(a => a.id === id))
        .filter(Boolean)
        .map(a => ({ id: a.id, label: a.label, contract: String(a.content || "").slice(0, 400) }));

    const judged = await jevJudge("addons.diagnose", { reply: reply.text, addons: enabled });
    $root.append(`<div class="bgp-meta">Checking ${enabled.length} enabled add-on${enabled.length === 1 ? "" : "s"} against the last reply.</div>`);
    if (!judged.ok) {
        $root.append(`<div class="bgp-meta">JEV is not available (${esc(judged.reason)}).</div>`);
        return popup($root, "Add-on diagnostics");
    }
    const flagged = (judged.route && judged.route.flagged) || [];
    if (!flagged.length) {
        $root.append(`<div class="bgp-meta">No enabled add-on was broken by this reply.</div>`);
    } else {
        $root.append(`<div class="bgp-meta">These add-ons look broken by this reply. Nothing was changed; open the add-ons tab to adjust them.</div>`);
        flagged.forEach(f => {
            $root.append(`<div class="bgp-msg"><div><b>${esc(f.label)}</b><div class="bgp-meta">${esc(f.id)} · confidence ${Number(f.p).toFixed(2)}</div></div></div>`);
        });
    }
    await popup($root, "Add-on diagnostics");
}

// ── 27. Reply Doctor and swipe ranking ─────────────────────────────────────

export async function openReplyDoctor() {
    const reply = lastReply();
    const $root = $(`<div class="bgp"></div>`);
    if (!reply) { $root.append(`<div class="bgp-meta">There is no reply to check yet.</div>`); return popup($root, "Reply Doctor"); }

    const dice = diceLines(reply.text);
    const judged = await jevJudge("reply.doctor", { reply: reply.text, config: configSummary(), diceLines: dice });
    if (!judged.ok) {
        $root.append(`<div class="bgp-meta">JEV is not available (${esc(judged.reason)}).</div>`);
        return popup($root, "Reply Doctor");
    }
    const issues = (judged.route && judged.route.issues) || [];
    if (!issues.length) {
        $root.append(`<div class="bgp-meta">No typed check failed on this reply.</div>`);
    } else {
        $root.append(`<div class="bgp-meta">Typed checks that failed (confidence ${Number(judged.confidence).toFixed(2)}). Nothing was changed; use Read again, or edit the reply.</div>`);
        issues.forEach(issue => $root.append(`<div class="bgp-msg"><div><b>${esc(issue)}</b></div></div>`));
    }

    const swipes = Array.isArray(reply.message.swipes) && reply.message.swipes.length > 1 ? reply.message.swipes : null;
    if (swipes) {
        const $rank = $(`<button type="button" class="menu_button" style="width:auto;margin:8px 0;">Rank the ${swipes.length} swipes</button>`);
        const $out = $(`<div></div>`);
        $rank.on("click", async () => {
            const ranked = await jevJudge("reply.swipes", { swipes, config: configSummary() });
            $out.empty();
            if (!ranked.ok || !ranked.route) { $out.append(`<div class="bgp-meta">No confident ranking.</div>`); return; }
            ranked.route.order.forEach((index, place) => {
                const score = ranked.route.scores.find(s => s.index === index);
                $out.append(`<div class="bgp-msg"><div><b>#${place + 1} · swipe ${index + 1}</b><div class="bgp-meta">score ${Number(score?.score ?? 0).toFixed(2)}</div></div></div>`);
            });
            $out.append(`<div class="bgp-meta">The choice is still yours; swipe in the chat to pick one.</div>`);
        });
        $root.append($rank, $out);
    }

    await popup($root, "Reply Doctor");
}

// ── 22. Context budget preview ──────────────────────────────────────────────

export async function openContextBudgetPreview() {
    const $root = $(`<div class="bgp"></div>`);
    const s = jevSettings();
    $root.append(`
        <div class="bgp-head">
            <div><b>Optional context budget</b></div>
            <div class="bgp-meta">Memory and NPC dossiers only. Engine instructions, agency and safety content are never candidates. Tokens are estimated at four characters each, the same as the counter.</div>
        </div>
        <label class="bgp-meta" style="display:flex; gap:8px; align-items:center;">Budget (tokens)
            <input type="number" id="jev_budget" class="ps-modern-input" style="width:110px;" min="150" step="50" value="${Number(s.contextBudget) || 900}" />
        </label>
        <div style="margin:10px 0; display:flex; gap:8px;">
            <button type="button" class="menu_button" id="jev_budget_preview" style="width:auto;margin:0;">Preview</button>
            <button type="button" class="menu_button" id="jev_budget_save" style="width:auto;margin:0;">Use this budget</button>
        </div>
        <div id="jev_budget_out"></div>
    `);
    $root.find("#jev_budget_preview").on("click", async () => {
        const budget = Math.max(150, Number($root.find("#jev_budget").val()) || 900);
        const chat = getContext()?.chat || [];
        const lastUser = [...chat].reverse().find(m => m && m.is_user);
        const list = [];
        for (const m of memGetRelevantVaultEntries() || []) {
            const text = String(m.text || m.summary || "");
            list.push({ id: `memory:${m.id}`, kind: "memory", text, tokens: estimateTokens(text), ref: m.id });
        }
        const npcPlan = npcJevRankPlan();
        const byName = new Map((localProfile?.npcBank?.npcs || []).map(n => [n.name, n]));
        for (const name of npcPlan.conversation || []) {
            const npc = byName.get(name);
            if (!npc) continue;
            const text = npcBuildTextFromData(npc);
            list.push({ id: `npc:${name}`, kind: "npc", text, tokens: estimateTokens(text), ref: name });
        }
        const plan = await contextJevPrepare(String(lastUser?.mes || ""), list, { budget });
        const $out = $root.find("#jev_budget_out");
        $out.empty();
        if (!plan) { $out.append(`<div class="bgp-meta">Nothing to allocate: the feature is off, or there is no optional context this turn.</div>`); return; }
        if (!plan.rows.length) { $out.append(`<div class="bgp-meta">No plan this turn; the full assembly stays.</div>`); return; }
        $out.append(`<div class="bgp-meta">${plan.used} of ${plan.budget} tokens selected.</div>`);
        plan.rows.forEach(row => {
            $out.append(`<div class="bgp-msg"><div><b>${esc(row.id)}</b><div class="bgp-meta">${row.tokens} tokens · ${row.keep ? "kept" : "dropped"}</div></div></div>`);
        });
    });
    $root.find("#jev_budget_save").on("click", () => {
        jevSettings().contextBudget = Math.max(150, Number($root.find("#jev_budget").val()) || 900);
        saveSettingsDebounced();
        toastr.success("Budget saved. It applies from the next prompt build.", "Megumin Suite");
    });
    await popup($root, "Context budget");
}
