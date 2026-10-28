// ─────────────────────────────────────────────────────────────────────────────
// The JEV settings section and the Decision Inspector (docs/jev.md proposal 4).
//
// The panel is deliberately blunt about two things:
//   • turning JEV on sends story text to a third party — the consent switch says
//     so, and nothing is sent until it is on;
//   • the key is kept in this user's server-side settings, like every other JEV
//     setting, so it follows the account across sessions — and the panel says
//     plainly that this is plaintext in settings.json and its backups.
//
// The inspector shows what was asked, what came back, what code did with it, and
// whether it agreed with the current behaviour — the shadow-mode evidence the doc
// requires before any feature is promoted to "on".
// ─────────────────────────────────────────────────────────────────────────────

import { Popup, POPUP_TYPE, saveSettingsDebounced } from "../st.js";
import { extensionName } from "../core/constants.js";
import { FEATURES, featureIdsByStage } from "./policy.js";
import { clearDecisions, exportBundle, labelDecision, readDecisions, summarise } from "./log.js";
import {
    MODES, clearJevKey, featureMode, getJevKey, jevSettings, keyHint,
    migrateBrowserKeyToServer, setFeatureMode, setJevKey,
} from "./settings.js";
import { jevProviderList } from "./client.js";
import { jevLastError } from "./index.js";
import { openSetupAssistant, openLoadoutSuggestion, openAddonDiagnostics, openReplyDoctor, openContextBudgetPreview } from "./tools.js";

const esc = v => $("<span>").text(String(v ?? "")).html();
const SHORT = v => {
    try { return JSON.stringify(v); } catch (e) { return String(v); }
};
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

const timeOf = at => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

const STORAGE_NOTE = "Plaintext in this user's server-side settings.json (globalSettings.jev.key). Synced across sessions and browsers; readable by anyone with access to the SillyTavern data directory or its settings backups.";

function statusLine() {
    const err = jevLastError();
    const tail = err && Date.now() - err.at < 300000 ? ` · last error: ${err.message}` : "";
    if (!jevSettings().enabled) return "Off. Nothing is sent anywhere.";
    if (!jevSettings().optIn) return `Waiting for consent: story text is not sent until you turn consent on.${tail}`;
    if (!getJevKey()) return `Waiting for a key.${tail}`;
    return `Ready · ${keyHint()} · kept in server settings · ${jevSettings().shadow ? "every feature is in shadow mode" : "per-feature modes apply"}${tail}`;
}

// ── The settings section ────────────────────────────────────────────────────

/** Appends the whole JEV block to the Global Settings content column and wires it. */
export function appendJevSettings($content) {
    // One-time: a key left in this browser by the earlier localStorage mode is
    // moved into the server settings so it syncs like everything else.
    if (migrateBrowserKeyToServer()) saveSettingsDebounced();
    const s = jevSettings();
    const providers = jevProviderList();
    $content.append(`<div class="wstyle-section-head blue" style="margin-top:8px;"><i class="fa-solid fa-brain"></i> JEV decisions</div>`);
    $content.append(`
        <div class="mtab-toggle-row ${s.enabled ? "active" : ""}" id="gs_toggle_jev" style="cursor:pointer; ${s.enabled ? "border-color:#38bdf8;" : ""}">
            <div class="toggle-info">
                <div class="toggle-label"><i class="fa-solid fa-brain" style="color:#38bdf8;"></i> JEV decision runtime</div>
                <div class="toggle-desc">Lets a System One model answer small yes/no, choice, and score questions beside the existing engine. It never writes prose, never replaces a parser, and never acts while a feature is in shadow mode. <b>Off:</b> the suite behaves exactly as it does today.</div>
            </div>
            <div class="ps-switch" style="${s.enabled ? "background:#38bdf8;" : ""}"></div>
        </div>
        <div class="mtab-toggle-row ${s.optIn ? "active" : ""}" id="gs_toggle_jev_consent" style="cursor:pointer; ${s.optIn ? "border-color:#f59e0b;" : ""}">
            <div class="toggle-info">
                <div class="toggle-label"><i class="fa-solid fa-shield-halved" style="color:#f59e0b;"></i> Send story text to a third party</div>
                <div class="toggle-desc">Required before any request. Only the fields a question needs are sent: a scene excerpt, a memory, a parsed change, a prompt. Not your whole chat, not your character card, not your key's neighbours. Disabling this stops every call immediately.</div>
            </div>
            <div class="ps-switch" style="${s.optIn ? "background:#f59e0b;" : ""}"></div>
        </div>
        <div class="mtab-panel" style="margin:0; padding:12px 16px;">
            <div class="mtab-setting-row" style="padding:0 0 10px 0; border:none;">
                <div class="set-info">
                    <div class="set-label"><i class="fa-solid fa-key" style="color:var(--gold);"></i> Provider key</div>
                    <div class="set-desc">Yours. Choose where it is kept below. It is never copied into extension profiles, presets, the decision log, diagnostics exports or error text.</div>
                </div>
                <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
                    <input type="password" id="jev_key" class="ps-modern-input" style="width:220px;" placeholder="${getJevKey() ? esc(keyHint()) : "paste a key"}" autocomplete="off" />
                    <button type="button" id="jev_key_save" class="menu_button" style="width:auto; margin:0;">Save</button>
                    <button type="button" id="jev_key_clear" class="menu_button" style="width:auto; margin:0;">Forget</button>
                </div>
            </div>
            <div class="mtab-setting-row" style="padding:4px 0 12px 0; border:none;">
                <div class="set-info">
                    <div class="set-label"><i class="fa-solid fa-database" style="color:#f59e0b;"></i> Stored on the server</div>
                    <div class="set-desc">${STORAGE_NOTE}</div>
                </div>
            </div>
            <div class="mtab-setting-row" style="padding:0; border:none;">
                <div class="set-info">
                    <div class="set-label"><i class="fa-solid fa-route" style="color:#38bdf8;"></i> Provider</div>
                    <div class="set-desc">OpenRouter is the default because its browser preflight passes and its System One shape matches TypeSafe's. Vercel's gateway is the alternative, behind the same validation.</div>
                </div>
                <select id="jev_provider" class="ps-modern-input" style="width:230px; cursor:pointer;">
                    ${providers.map(p => `<option value="${p.id}" ${s.provider === p.id ? "selected" : ""}>${esc(p.label)}</option>`).join("")}
                </select>
            </div>
            <div class="mtab-setting-row" style="padding:10px 0 0 0; border:none;">
                <div class="set-info">
                    <div class="set-label"><i class="fa-solid fa-tag" style="color:#38bdf8;"></i> Model</div>
                    <div class="set-desc">Bare System One ids (<code>jev-1.13</code>) or a prefixed one (<code>typesafe/jev-1.13</code>). The response reports the exact model that served it, and every decision row logs that. Changing it changes every cache identity.</div>
                </div>
                <input type="text" id="jev_model" class="ps-modern-input" style="width:230px;" value="${esc(s.model)}" />
            </div>
        </div>
        <div class="mtab-toggle-row ${s.shadow ? "active" : ""}" id="gs_toggle_jev_shadow" style="cursor:pointer; ${s.shadow ? "border-color:#a855f7;" : ""}">
            <div class="toggle-info">
                <div class="toggle-label"><i class="fa-solid fa-eye" style="color:#a855f7;"></i> Shadow mode</div>
                <div class="toggle-desc">On: every judgment is made, compared, and logged, and <b>nothing changes</b>. Turn it off only after a feature's Inspector rows agree with what you would have chosen on your own chats.</div>
            </div>
            <div class="ps-switch" style="${s.shadow ? "background:#a855f7;" : ""}"></div>
        </div>
        <div class="mtab-panel" style="margin:0; padding:12px 16px;">
            <div class="mtab-setting-row" style="padding:0 0 8px 0; border:none;">
                <div class="set-info">
                    <div class="set-label"><i class="fa-solid fa-list-check" style="color:#10b981;"></i> Features</div>
                    <div class="set-desc" id="jev_status">${esc(statusLine())}</div>
                </div>
                <button type="button" id="jev_features" class="menu_button" style="width:auto; margin:0; white-space:nowrap;"><i class="fa-solid fa-sliders"></i> Modes</button>
            </div>
            <div class="mtab-setting-row" style="padding:0; border:none;">
                <div class="set-info">
                    <div class="set-label"><i class="fa-solid fa-clipboard-list" style="color:var(--gold);"></i> Decision Inspector</div>
                    <div class="set-desc">Metadata only: feature, versions, model, answers, policy route, current route, latency, and your accept/reject label. Story text is not stored unless you enable fixtures.</div>
                </div>
                <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;">
                    <button type="button" id="jev_inspector" class="menu_button" style="width:auto; margin:0;"><i class="fa-solid fa-magnifying-glass-chart"></i> Open</button>
                    <button type="button" id="jev_export" class="menu_button" style="width:auto; margin:0;"><i class="fa-solid fa-download"></i> Export</button>
                </div>
            </div>
            <div class="mtab-setting-row" style="padding:10px 0 0 0; border:none;">
                <div class="set-info">
                    <div class="set-label"><i class="fa-solid fa-toolbox" style="color:#a855f7;"></i> Tools</div>
                    <div class="set-desc">Each one proposes and shows its proposal; nothing is applied until you confirm.</div>
                </div>
                <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;">
                    <button type="button" id="jev_tool_setup" class="menu_button" style="width:auto; margin:0;">Setup assistant</button>
                    <button type="button" id="jev_tool_loadout" class="menu_button" style="width:auto; margin:0;">Model loadout</button>
                    <button type="button" id="jev_tool_addons" class="menu_button" style="width:auto; margin:0;">Add-on check</button>
                    <button type="button" id="jev_tool_doctor" class="menu_button" style="width:auto; margin:0;">Reply Doctor</button>
                    <button type="button" id="jev_tool_budget" class="menu_button" style="width:auto; margin:0;">Context budget</button>
                </div>
            </div>
            <label class="gs-bgjob" style="display:flex; align-items:center; gap:8px; margin-top:10px;">
                <input type="checkbox" id="jev_log_raw" ${s.logRaw ? "checked" : ""} />
                Keep the exact text sent (fixtures) <span class="set-desc" style="margin:0;">Off by default. Turns the log into story content.</span>
            </label>
            <label class="gs-bgjob" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                <input type="checkbox" id="jev_vision" ${s.vision ? "checked" : ""} />
                Experimental image input <span class="set-desc" style="margin:0;">Off by default. Rendered-image review stays inert until the provider capability is confirmed for your account.</span>
            </label>
        </div>
    `);

    // ── Wiring ─────────────────────────────────────────────────────────────
    const repaint = () => {
        const st = jevSettings();
        $content.find("#gs_toggle_jev").toggleClass("active", st.enabled).css("border-color", st.enabled ? "#38bdf8" : "var(--border-color)")
            .find(".ps-switch").css("background", st.enabled ? "#38bdf8" : "");
        $content.find("#gs_toggle_jev_consent").toggleClass("active", st.optIn).css("border-color", st.optIn ? "#f59e0b" : "var(--border-color)")
            .find(".ps-switch").css("background", st.optIn ? "#f59e0b" : "");
        $content.find("#gs_toggle_jev_shadow").toggleClass("active", st.shadow).css("border-color", st.shadow ? "#a855f7" : "var(--border-color)")
            .find(".ps-switch").css("background", st.shadow ? "#a855f7" : "");
        $content.find("#jev_status").text(statusLine());
    };

    $content.find("#gs_toggle_jev").on("click", () => {
        const st = jevSettings();
        st.enabled = !st.enabled;
        saveSettingsDebounced();
        repaint();
    });
    $content.find("#gs_toggle_jev_consent").on("click", () => {
        const st = jevSettings();
        st.optIn = !st.optIn;
        saveSettingsDebounced();
        repaint();
    });
    $content.find("#gs_toggle_jev_shadow").on("click", () => {
        const st = jevSettings();
        st.shadow = !st.shadow;
        saveSettingsDebounced();
        repaint();
        if (!st.shadow) toastr.info("Shadow mode is off. Only features set to \"on\" will act; everything else keeps its current behaviour.", "Megumin Suite");
    });

    $content.find("#jev_key_save").on("click", () => {
        const value = String($content.find("#jev_key").val() || "").trim();
        if (!value) { toastr.warning("Paste a key first.", "Megumin Suite"); return; }
        setJevKey(value);
        saveSettingsDebounced();
        $content.find("#jev_key").val("").attr("placeholder", keyHint());
        repaint();
        toastr.success("Key stored in this user's SillyTavern settings.", "Megumin Suite");
    });
    $content.find("#jev_key_clear").on("click", () => {
        clearJevKey();
        saveSettingsDebounced();
        $content.find("#jev_key").val("").attr("placeholder", "paste a key");
        repaint();
        toastr.info("Key removed.", "Megumin Suite");
    });
    $content.find("#jev_provider").on("change", function () {
        jevSettings().provider = $(this).val();
        saveSettingsDebounced();
        repaint();
    });
    $content.find("#jev_model").on("change", function () {
        jevSettings().model = String($(this).val() || "").trim() || "jev-1.13";
        saveSettingsDebounced();
    });
    $content.find("#jev_log_raw").on("change", function () {
        jevSettings().logRaw = this.checked;
        saveSettingsDebounced();
    });
    $content.find("#jev_vision").on("change", function () {
        jevSettings().vision = this.checked;
        saveSettingsDebounced();
    });
    $content.find("#jev_features").on("click", () => openFeatureModes());
    $content.find("#jev_tool_setup").on("click", () => openSetupAssistant());
    $content.find("#jev_tool_loadout").on("click", () => openLoadoutSuggestion());
    $content.find("#jev_tool_addons").on("click", () => openAddonDiagnostics());
    $content.find("#jev_tool_doctor").on("click", () => openReplyDoctor());
    $content.find("#jev_tool_budget").on("click", () => openContextBudgetPreview());
    $content.find("#jev_inspector").on("click", () => openDecisionInspector());
    $content.find("#jev_export").on("click", async () => {
        const list = await readDecisions();
        download(exportBundle(list, { includeRaw: jevSettings().logRaw }), "megumin-jev-decisions.json");
    });
}

// ── Feature modes ───────────────────────────────────────────────────────────

async function openFeatureModes() {
    const $root = $(`<div class="bgp"></div>`);
    $root.append(`<div class="bgp-head"><div><b>Which decisions JEV may improve</b></div>
        <div class="bgp-meta">Shadow: judged and logged, never acted on. On: acted on when the policy is confident; otherwise the current behaviour runs. Off: never asked.</div></div>`);
    const s = jevSettings();
    for (const [stage, ids] of featureIdsByStage()) {
        $root.append(`<div class="wstyle-section-head blue" style="margin-top:10px;"><i class="fa-solid fa-layer-group"></i> Stage ${stage}</div>`);
        for (const id of ids) {
            const meta = FEATURES[id];
            const own = s.features[id] || "shadow";
            $root.append(`
                <div class="bgp-msg" style="display:flex; gap:10px; align-items:center; justify-content:space-between;">
                    <div>
                        <div><b>${esc(meta.label)}</b> <span class="bgp-meta">${esc(id)}</span></div>
                        <div class="bgp-meta">${esc(meta.summary)}</div>
                    </div>
                    <select class="ps-modern-input jev-mode" data-feature="${esc(id)}" style="width:120px;">
                        ${MODES.map(m => `<option value="${m}" ${own === m ? "selected" : ""}>${m}</option>`).join("")}
                    </select>
                </div>`);
        }
    }
    $root.on("change", ".jev-mode", function () {
        setFeatureMode($(this).data("feature"), $(this).val());
        saveSettingsDebounced();
    });
    if (s.shadow) $root.append(`<div class="bgp-meta" style="margin-top:10px;">Shadow mode is on, so every "on" still behaves as "shadow" until you turn it off in Settings.</div>`);
    await new Popup($root, POPUP_TYPE.TEXT, "", { wide: true, large: true, allowVerticalScrolling: true, okButton: "Close" }).show();
}

// ── Decision Inspector ──────────────────────────────────────────────────────

export async function openDecisionInspector() {
    const $root = $(`<div class="bgp"></div>`);
    let onlyDisagreements = false;

    const draw = async () => {
        const list = await readDecisions();
        $root.empty();
        $root.append(`<div class="bgp-head"><div><b>Decision Inspector</b></div>
            <div class="bgp-meta">${list.length} recorded judgment${list.length === 1 ? "" : "s"}. Metadata only. Labelling a shadow decision is what builds this feature's local accept/reject counts.</div></div>`);

        const rows = summarise(list);
        if (rows.length) {
            const $table = $(`<table class="bgp-list" style="width:100%; border-collapse:collapse;"><thead><tr>
                <th style="text-align:left;">Feature</th><th>Rows</th><th>Agree</th><th>Disagree</th><th>Fallback</th><th>Accept</th><th>Reject</th>
            </tr></thead><tbody></tbody></table>`);
            rows.forEach(r => {
                $table.find("tbody").append(`<tr>
                    <td style="text-align:left;">${esc(FEATURES[r.feature]?.label || r.feature)}</td>
                    <td style="text-align:center;">${r.total}</td>
                    <td style="text-align:center;">${r.agreed}</td>
                    <td style="text-align:center;">${r.disagreed}</td>
                    <td style="text-align:center;">${r.fallback}</td>
                    <td style="text-align:center;">${r.accept}</td>
                    <td style="text-align:center;">${r.reject}</td>
                </tr>`);
            });
            $root.append($table);
        }

        const $tools = $(`<div style="display:flex; gap:8px; align-items:center; margin:10px 0;">
            <label style="display:flex; align-items:center; gap:6px;"><input type="checkbox" id="jev_only_diff" ${onlyDisagreements ? "checked" : ""}/> Only disagreements</label>
            <button type="button" class="menu_button" id="jev_exp" style="width:auto; margin:0;"><i class="fa-solid fa-download"></i> Export</button>
            <button type="button" class="menu_button" id="jev_clear" style="width:auto; margin:0;"><i class="fa-solid fa-trash"></i> Clear</button>
        </div>`);
        $root.append($tools);

        const shown = onlyDisagreements
            ? list.filter(r => r.route !== null && JSON.stringify(r.route) !== JSON.stringify(r.current))
            : list;
        if (!shown.length) {
            $root.append(`<div class="bgp-meta">Nothing recorded yet. Judgments appear after a reply while JEV is enabled.</div>`);
        }
        shown.slice(0, 120).forEach(row => {
            const agrees = row.route !== null && JSON.stringify(row.route) === JSON.stringify(row.current);
            const tag = row.fallback ? `<span class="bgp-tag off">fallback: ${esc(row.fallback)}</span>`
                : agrees ? `<span class="bgp-tag">agrees</span>` : `<span class="bgp-tag">differs</span>`;
            const $row = $(`<details class="bgp-entry">
                <summary><b>${esc(FEATURES[row.feature]?.label || row.feature)}</b> ${tag}
                    <span class="bgp-meta">${timeOf(row.at)} · ${esc(row.mode)} · v${row.version} · ${esc(row.model || row.provider || "")}${row.confidence !== null ? ` · conf ${Number(row.confidence).toFixed(2)}` : ""}${row.latencyMs !== null ? ` · ${row.latencyMs} ms` : ""}</span>
                </summary>
                <div class="bgp-entry-body">
                    <div class="bgp-meta">Reason: ${esc(row.reason || "—")}${row.usage && row.usage.input_tokens ? ` · in ${row.usage.input_tokens} tok` : ""}</div>
                    <div class="bgp-meta">JEV: ${esc(clip(SHORT(row.route), 400))}</div>
                    <div class="bgp-meta">Current: ${esc(clip(SHORT(row.current), 300))}</div>
                    <details><summary class="bgp-meta">Answers</summary><pre class="bgp-pre"></pre></details>
                    <div style="display:flex; gap:6px; margin-top:8px;">
                        <button type="button" class="menu_button jev-accept" style="width:auto; margin:0;" ${row.label === "accept" ? "disabled" : ""}><i class="fa-solid fa-check"></i> Accept</button>
                        <button type="button" class="menu_button jev-reject" style="width:auto; margin:0;" ${row.label === "reject" ? "disabled" : ""}><i class="fa-solid fa-xmark"></i> Reject</button>
                        <span class="bgp-meta jev-label">${row.label ? `labelled: ${esc(row.label)}` : ""}</span>
                    </div>
                </div>
            </details>`);
            $row.find(".bgp-pre").text(SHORT(row.answers));
            $row.find(".jev-accept").on("click", async () => { await labelDecision(row.id, "accept"); draw(); });
            $row.find(".jev-reject").on("click", async () => { await labelDecision(row.id, "reject"); draw(); });
            $root.append($row);
        });

        $root.find("#jev_only_diff").on("change", function () { onlyDisagreements = this.checked; draw(); });
        $root.find("#jev_exp").on("click", () => download(exportBundle(list, { includeRaw: jevSettings().logRaw }), "megumin-jev-decisions.json"));
        $root.find("#jev_clear").on("click", async () => { await clearDecisions(); draw(); });
    };

    await draw();
    await new Popup($root, POPUP_TYPE.TEXT, "", { wide: true, large: true, allowVerticalScrolling: true, okButton: "Close" }).show();
}

function download(value, filename) {
    try {
        const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toastr.success("Exported. It contains no API key.", "Megumin Suite");
    } catch (e) {
        console.error(`[${extensionName}] Could not export the decision log.`, e);
        toastr.error("The browser blocked the download.", "Megumin Suite");
    }
}
