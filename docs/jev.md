# Megumin Suite JEV Decision Map

## Context

The maintainer asked for a deep, creative report on where Megumin Suite Beta could replace or improve decisions with TypeSafe JEV, grounded in official documentation, public examples, and the actual repository, then requested that the resulting plan be stored at `docs/jev.md`. The accepted completion test is a **complete decision map**: every major subsystem is covered, and each proposal names the concrete decision point, current logic, JEV mechanism, expected benefit, evidence, and validation check. No product code changes are requested.

The report is for the suite maintainer. Every proposal preserves the current client-side SillyTavern extension, requires no backend/framework/runtime migration, remains optional, and keeps a deterministic fallback.

## Approach

Use JEV as a **semantic decision plane beside the existing engine**, not as another narrator and not as a universal replacement for rules.

1. **Establish an optional, gateway-neutral decision runtime.** Use a tiny HTTP adapter, per-user credentials, strict response validation, versioned questions, per-feature policies, and identity-safe caching.
2. **Run every judgment in shadow mode first.** Record the current decision and JEV's proposed decision without changing behavior; collect accept/reject labels locally.
3. **Start with low-blast-radius semantic gaps.** Re-rank memories, detect paraphrased clues, verify parsed updates against prose, triage ban-list candidates, and skip clearly unnecessary conditional work.
4. **Unify per-turn understanding.** Compute one cached user-turn assessment and one cached reply assessment, then reuse them across memory, World State, Blocks, Notebook, NPC, Story Director, images, and dice instead of making independent semantic calls for every feature.
5. **Add higher-level assistance only after the primitives prove themselves.** Context budgeting, configuration recommendations, reply review, swipe ranking, and setup advice remain preview-and-confirm workflows.
6. **Keep experimental vision separate.** Image input and Box localization are Dreamer-only proposals until both the upstream capability and suite-specific evaluation are production-ready.

Every rollout step retains the current behavior as the fallback when JEV is disabled, unavailable, malformed, times out, or falls inside its uncertainty band. A negative semantic verification result is different from a service failure: it follows the safe review/prose/raw-source path specified for that feature.

## How JEV changes the design space

| Primitive | What it returns | Best suite uses |
| --- | --- | --- |
| **Noul** | Probability that a statement is true, 0–1; no separate confidence | Did the reply change world facts? Is this clue revealed? Is this parsed update grounded? Does this action need a roll? |
| **Choice** | One closed-set label, full probabilities, distribution-derived confidence | Query strategy, supported/contradicted/unsupported, scene beat, worker failure kind, configuration options |
| **Score** | Expected position across ordered levels, probabilities, confidence | Memory relevance/utility, arc coverage, difficulty, reply-quality dimensions |
| **Box** *(experimental)* | Normalized image bounds plus confidence | Portrait-face crop assistance, only with a separate presence check |

JEV evaluates text or structured JSON state. Questions sharing a request see the same state independently and in parallel, so the suite should fan out atomic questions rather than make sequential calls. A second request is needed only when an earlier answer changes the later state or options. JEV does **not** generate prose, explain itself, repair prompts, call tools, count reliably, perform exact arithmetic, compare dates reliably, or replace multi-step reasoning. Code continues to own control flow, calculations, thresholds, permissions, state application, and side effects.

Choice and Score confidence summarizes the probability distribution; it is not a guarantee that an individual answer is correct. Noul uncertainty lives around 0.5. Documentation's 0.3/0.7 Noul boundaries and any Choice/Score thresholds are starting points only. The suite must tune thresholds per action against its own labeled English and non-English examples. `other`, `none`, `unsupported`, and `review` options must be explicit so the model is not forced into a confident wrong category.

Current stable documentation identifies `jev-1.14.0`, 64k-token request and 32k-token state-plus-one-question limits, and $0.042 per million input tokens with free outputs. Model versions must be pinned during evaluation and the returned model logged. English has the best documented accuracy; Russian and other supported story languages require their own evaluation sets. Long context is not a substitute for state selection because irrelevant state reduces accuracy.

### Code keeps these decisions

The following are not JEV opportunities: exact parsers and state transitions, dice RNG and arithmetic, token counts, list limits, chunk boundaries, timestamps, identity/hash race guards, preset/slot compatibility rules, explicit connection routing, permissions, deletion, migrations, and user-owned mode/style/update settings. JEV can supply semantic candidates or verify semantic evidence around those rules. It cannot override them.

## Transport and credential decision

Live CORS preflights on 2026-10-28 established the client-only transport choices:

| Route | Observed result | Proposal |
| --- | --- | --- |
| `https://api.typesafe.ai/v1/systemone` | HTTP 400, no allowed requesting origin | Do not depend on direct TypeSafe browser calls unless a future preflight succeeds |
| `https://openrouter.ai/api/v1/systemone` | HTTP 204, `access-control-allow-origin: *`, required headers allowed | **Default:** same System One request/response shape, no SDK or build step |
| `https://ai-gateway.vercel.sh/v1/evaluate` | HTTP 200, requesting origin and required headers allowed | Optional second provider behind a response-normalizing adapter |

OpenRouter's official docs confirm JEV System One access and TypeSafe-compatible shapes; Vercel's docs confirm JEV evaluation with mappable `boolean`/`probability` fields and confidence metadata. The provider adapter must expose one internal Noul/Choice/Score contract and validate every answer rather than letting feature code learn provider quirks.

Use per-user keys only. Default to session-only browser storage; persistent browser-local storage requires an explicit “remember on this browser” choice. Never place keys in source, presets, `extension_settings`, exported profiles, prompt/background logs, decision logs, or error messages. All story content sent to a third party needs a visible opt-in and per-feature data controls. Disabling JEV must not disable any existing suite feature.

# Proposed changes

## 1. Decision runtime, privacy, and evaluation

### 1. Add a browser-native JEV client and provider boundary

- **Now / anchor:** The suite has no JEV client or direct model-key surface; `src/st.js` wraps generative host calls, and `manifest.json` describes a no-build extension.
- **Change:** Add a small `src/jev/client.js` using `fetch` and `AbortController`, defaulting to OpenRouter System One with Vercel as an optional provider. Do not use the Node-oriented SDK or route typed judgments through `generateQuietPrompt`. Pin the evaluated model, validate answer IDs/types/options/probability ranges, and apply per-call deadlines. Each malformed answer falls back independently.
- **Benefit / fallback:** Real JEV decisions without a backend, package manager, or framework. Network/authentication/provider failure leaves the entire current suite path unchanged.
- **Proof:** With a valid user key, one synthetic Noul returns a finite value in `[0,1]`; a missing answer, HTTP 401, and aborted request each select the documented current-behavior fallback without a toast loop or leaked key.

### 2. Create a versioned question and policy registry

- **Now / anchor:** Semantic heuristics are embedded across feature modules; no confidence vocabulary or shared evaluation question sets exist.
- **Change:** Add `src/jev/questions.js` for atomic instructions, structured criteria, state builders, and question-set versions, plus `src/jev/policy.js` for per-feature thresholds, uncertainty bands, and routes. Include `other`/`none` where the taxonomy may be incomplete. Keep arithmetic and final policy in JavaScript. No equivalent registry exists in the repository.
- **Benefit / fallback:** Question wording, option order, model version, and thresholds become reviewable and replayable. Each consumer calls its existing heuristic when its answer is unavailable or uncertain.
- **Proof:** Replaying one saved state with the same provider/model/question version reproduces the recorded policy route; changing a criterion, option order, or model changes the cache/evaluation identity.

### 3. Cache identity-safe user-turn and reply assessments

- **Now / anchor:** `index.js:515-703` starts many post-reply jobs; `src/engine/injection.js:375-384` already refreshes semantic memory before prompt construction; `src/engine/tasks.js` serializes worker jobs and `workerRequest.js:75-82` shows read jobs can hold the next reply.
- **Change:** Add `src/jev/assessments.js` with `getUserTurnAssessment()` and `getReplyAssessment()`. Cache by `meguminActiveDataIdentity`, message UID, swipe, cleaned-text hash, question-set version, provider, and model. Batch all questions that share state; run candidate-specific requests separately. Compute user assessments on the existing user-message debounce where possible instead of adding latency to every prompt build.
- **Benefit / fallback:** One semantic read feeds many features, preventing duplicate calls and inconsistent per-feature interpretations. A miss/timeout simply causes each consumer to run its current logic.
- **Proof:** Two consumers of the same unchanged reply share one network request; editing text, changing swipe, changing model, or switching chat creates a new assessment and no stale write.

### 4. Add a local Decision Inspector, shadow mode, and labeling loop

- **Now / anchor:** `src/engine/bgPrompts.js:99-198` provides a capped local prompt log and preview UI; there is no shipped test/eval harness or decision telemetry.
- **Change:** Reuse the localforage/log pattern for a separate, metadata-only decision log: feature, question-set/model versions, answers/probabilities/confidence, policy route, current route, latency, input tokens, fallback, and user accept/reject label. Raw story text is excluded by default; opt-in fixtures can include it. Add a Global Settings Decision Inspector using the existing popup idiom. Shadow mode logs disagreement without acting.
- **Benefit / fallback:** Every adoption decision gets suite-specific evidence, including calibration, coverage, error cost, and multilingual behavior. Logging off or storage failure has no behavioral effect.
- **Proof:** A forced shadow disagreement changes no prompt, state, or setting; a user label updates that feature's local evaluation counts; exported diagnostics contain no API key or raw story content by default.

## 2. Memory Core

### 5. Replace the 16-character query heuristic with a bounded query-strategy decision

- **Now / anchor:** `src/features/memory/vectordb.js:180-218` uses the newest user message at length ≥16, otherwise the last two messages; comments document earlier retrieval dilution.
- **Change:** Ask one Choice: `latest_user`, `recent_exchange`, or `skip_retrieval`, based on whether the user turn has a specific information need, continues the scene, or is empty/meta. JEV selects among existing query strings; it never writes a query. For semantic search, `latest_user` keeps the current newest-user text, `recent_exchange` keeps the current last-two text, and `skip_retrieval` performs no query. For TF-IDF, the first two choices run the existing keyword extractor over the corresponding selected message set, and `skip_retrieval` returns no memories.
- **Benefit / fallback:** Avoids both arbitrary length thresholds and irrelevant retrieval on “continue” while preserving the fix for long-question dilution. Low confidence or JEV failure uses the current length rule.
- **Proof:** A long direct question chooses `latest_user`; “…” and “continue” choose `recent_exchange`; an explicit settings/OOC request can choose `skip_retrieval`; ambiguous inputs take the current path.

### 6. Re-rank retrieved memories and route conflicts before prompt injection

- **Now / anchor:** Semantic search takes top-K then dedupes to three; TF-IDF takes the top three (`src/features/memory/index.js:1397-1472`). `buildBaseDict.js:615-638` injects the results chronologically.
- **Change:** Keep retrieval as the cheap shortlist. For each candidate, batch Score questions for current relevance and answer utility, plus Nouls for contradiction with newer evidence, supersession by a newer candidate, and embedded instructions attempting to steer the model. Deterministic policy ranks, drops, or places conflicts in a separate labeled block. Confidence gates only; it never multiplies relevance.
- **Benefit / fallback:** Better semantic precision than lexical/cosine rank, fewer prompt-injection and stale-memory artifacts, and explicit rather than silent contradictions. Failure preserves the existing retrieval order and top three.
- **Proof:** The synthetic bridge-warning case ranked the direct answer 3.000/3 versus 0.080 for a lexical decoy and 0.020 for an unrelated memory. A gateway-specific replay set must additionally cover wrong entities, stale facts, paraphrases, no-answer cases, and option-order reversal.

### 7. Verify generated memory summaries before filing them

- **Now / anchor:** `memProcessPendingChunks()` accepts any nonempty summary and appends it at `src/features/memory/index.js:1005-1033`; identity guards already prevent cross-chat writes.
- **Change:** Split the generated summary into candidate claims in code. Ask per-claim whether the source supports it, plus separate questions for wrong-entity attribution, unsupported durable facts, omission of the chunk's central event, and language match. Route to `accept`, `review`, or `raw_source`; never ask JEV to rewrite the summary. A rejected summary leaves the raw chunk available for review or stores it as raw source rather than silently accepting corrupted memory.
- **Benefit / fallback:** Prevents fluent hallucinations from becoming canonical long-term context. JEV failure retains the current summarization behavior; semantic rejection uses review/raw-source rather than acceptance.
- **Proof:** A summary assigning Tomas's action to Maya is rejected; a faithful paraphrase passes; an empty summary follows the existing empty-summary path; no identity check is bypassed.

### 8. Detect duplicate, superseded, and conflicting memory candidates without auto-deletion

- **Now / anchor:** Vault migration and insertion append/chronologically sort entries; retrieval can surface overlapping archives. Vector deletion has deliberate deterministic safety guards in `vectordb.js:136-170`.
- **Change:** For a new archive and its nearest existing candidates, use an ordered Score (`different`, `related/duplicate`, `same event`) and companion Nouls for factual conflict and whether the newer record supersedes the older. Code supplies chronological order. Route to `append`, `link_duplicate`, `show_conflict`, or `review`; never let JEV delete or merge storage directly.
- **Benefit / fallback:** Less redundant context and fewer stale facts presented as simultaneously true. Failure appends exactly as today; merges/deletions remain user/code-owned.
- **Proof:** A changed character preference produces a conflict/superseded label, two tellings of one event link as duplicates, and unrelated same-entity memories remain distinct.

## 3. Reply orchestration, state, Blocks, and Notebook

### 9. Introduce a shared ReplyAssessment instead of independent per-feature semantic guesses

- **Now / anchor:** The post-reply hub starts World State, Blocks, Notebook, image, Story Director, memory, and NPC work independently (`index.js:515-703`).
- **Change:** Add one cached assessment over the cleaned latest exchange with feature-specific Nouls (`world_facts_changed`, `stats_changed`, `notebook_evidence_present`, `dossier_worthy`, `photo_requested`, `stayed_in_fiction`), a scene-beat Choice over the versioned taxonomy `dialogue | action | discovery | relationship | transition | downtime | other`, and a location Choice built from current World State locations plus `other` and `unknown`. Include a five-level tension Score and, only when Story Director is enabled, a five-level active-directive coverage Score. Store all results as derived metadata, never canonical story state.
- **Benefit / fallback:** A consistent semantic scene read can drive gating, retrieval, Story Director, and images. It replaces neither the reply nor the authoritative parsers. Failure produces no assessment and current per-feature logic runs.
- **Proof:** All enabled consumers read the same assessment ID and raw answers; changing a feature toggle does not invalidate unrelated answers; non-English scenes receive separate labeled evaluation.

### 10. Skip unnecessary worker reads, then reuse deterministic combined-call planning

- **Now / anchor:** World/Blocks/Notebook reads run whenever routed; `combinedTurnWanted()` at `src/features/imagegen/combinedTurn.js:67-83` combines at least two currently needed jobs. Worker reads can hold the user's next reply.
- **Change:** Use high-confidence ReplyAssessment negatives to skip a read only when the corresponding state could not have changed. Feed the remaining booleans into the existing `combinedTurnWanted()` plan rather than replacing its combination rule. Manual Read again and forced reads bypass semantic gates.
- **Benefit / fallback:** Fewer Chomusuke calls, shorter queues, and less prompt-preview noise. Low confidence, missing assessment, or any concrete parse signal means “perform the current read.”
- **Proof:** Pure small talk with unchanged location/outfits/stats skips those reads; a new outfit or clue still triggers one; two remaining jobs still combine; manual force always works.

### 11. Verify parsed World State, stat, and Notebook changes against the reply before applying them

- **Now / anchor:** `worldExtractMessage()` parses and records at `src/state/index.js:416-426`; stat parsers accept structured labels/values; Notebook and block workers file parsed output. Format validity does not establish semantic grounding.
- **Change:** After deterministic parsing and arithmetic checks, ask one Choice per proposed delta—`supported`, `contradicted`, `unsupported`—plus targeted Nouls for wrong entity, reversed direction, or knowledge the character does not possess. Apply supported changes, hold contradicted/uncertain changes for review, and retain raw evidence. Never ask JEV to construct the delta.
- **Benefit / fallback:** Stops well-formed hallucinations from corrupting canonical state while preserving exact state transitions. Service failure follows the current parser path; negative verification does not.
- **Proof:** In the synthetic Maya/Tomas case, placing Maya at the chapel returned `contradicted` at confidence 1.0 and `wrong_entity = 0.98`. Also test negation, temporary versus permanent changes, numeric deltas, and paraphrased support.

### 12. Upgrade Notebook clue detection and secret-knowledge tracking

- **Now / anchor:** `clueInProse()` at `src/state/modules/notebook/parse.js:116-152` treats any shared stem as found; `parseUpdateLines()` writes that Boolean onto each clue op at lines 189-194.
- **Change:** Keep the parser synchronous and pure. After it returns newly written clue ops and before state application, run async Noul/Score judgments over `storyProse()` and each new clue: is the same information revealed, merely mentioned, contradicted, or only hinted? Override only the semantic `found` decision on those new ops; no backlog re-evaluation trigger is added. Add separate checks for who actually learned a secret and whether later dialogue leaks knowledge that character lacks. Code still applies all Notebook updates and rewind/history behavior.
- **Benefit / fallback:** Recognizes paraphrase while avoiding false positives from one shared word, without an async refactor of the state-store parsers. Failure uses the parser's original `clueInProse` value; uncertain cases remain pending rather than becoming found.
- **Proof:** “Poison in the blue vial” versus “azure bottle … toxin” returned `revealed = 0.95` and `supports` at confidence 1.0. Add negated, speculative, wrong-character, and merely-mentioned counterexamples.

### 13. Add block-specific semantic acceptance checks after parsing

- **Now / anchor:** `src/features/blocks/worker.js` reads routed Blocks; `src/blocks/treatments.js` and `render.js` deliberately fall back to prose on structural failure. There is no semantic quality gate for valid-looking content.
- **Change:** Verify only the semantics of each parsed block: CYOA choices are distinct, actionable, and do not leak outcomes; Bonds/Sheet deltas are grounded; Inner Chatter uses only knowledge available to that NPC; immersive HTML represents an in-world object the character is reading. Deterministic sanitizers and parsers remain the security/format boundary.
- **Benefit / fallback:** Fewer plausible but wrong cards and less repeated/user-agency-breaking content. Failed semantic checks use existing prose or Read again paths; JEV failure leaves current rendering unchanged.
- **Proof:** Duplicate CYOA choices with different punctuation are flagged; a valid three-way choice passes; an NPC's hidden thought about a secret they never learned is held for review.

### 14. Make Chomusuke failure triage semantic without changing connection routing

- **Now / anchor:** `answerKind()` distinguishes only `empty` and `format`; transport failure becomes `failed` (`src/engine/chomusukeNotice.js`). Recovery is manual Read again or individual fallback. `workerRoute()` is exact settings logic and stays untouched.
- **Change:** For nonempty unusable answers, add a Choice among `wrong_task`, `refusal`, `truncated`, `format_drift`, `prose_only`, and `context_confusion`. Map only high-confidence kinds to existing recovery: individual reread, prose fallback, edit/review, or model guidance. Do not silently add retries or switch profiles.
- **Benefit / fallback:** More accurate recovery than treating every nonempty failure as a format problem. Low confidence or JEV failure uses current `answerKind` text and actions.
- **Proof:** A polite refusal is not labeled format drift; a truncated World Update is not labeled refusal; an ordinary answer to the wrong job cannot mutate state.

## 4. NPC Bank and character continuity

### 15. Re-rank NPC dossiers and image tags by actual scene relevance

- **Now / anchor:** `buildBaseDict.js:747-827` uses keyword scoring plus a name bonus for dossiers; `getRelevantNpcImageTags()` uses keyword overlap and takes three (`src/features/npc/data.js:165-200`).
- **Change:** Keep the lexical shortlist, then Score each candidate for current conversational relevance and separate visual presence. Ask Nouls for present in the current scene versus merely mentioned/remembered and for conflicting identity evidence. Use conversation relevance for `[[npc list]]` and visual presence for image tags.
- **Benefit / fallback:** Reduces irrelevant dossier tokens and prevents absent characters' looks from contaminating images. Failure uses current TF-IDF/name-bonus order.
- **Proof:** A flashback mention can rank for dialogue but not visual tags; an unnamed but physically present known NPC keeps visual tags; two same-name records require review.

### 16. Gate new-dossier generation and assist identity resolution

- **Now / anchor:** New-NPC creation is model-driven; `npcFindByName()` uses exact/prefix matching (`src/features/npc/updates.js:109-121`), and World State already asks “Same person as…” with undoable merge in `src/features/worldstate/card.js:28-56`.
- **Change:** Ask Noul whether the reply introduces a named, speaking, story-relevant character worth a dossier before running a scan. For ambiguous candidate pairs, use an ordered Score (`different`, `related/uncertain`, `same person`) plus field-agreement Nouls. Preselect the existing Same person dropdown only at high confidence; merges always require user confirmation.
- **Benefit / fallback:** Fewer throwaway dossiers and duplicate identities without autonomous merges. Low confidence keeps separate records/current matching behavior.
- **Proof:** “Anna” and “Annabelle” are not auto-merged; a clear nickname/full-name pair is suggested; an unnamed background extra generates no dossier.

### 17. Verify NPC update operations and semantic removal targets

- **Now / anchor:** `npcApplyUpdates()` enforces field/op permissions and history; `findMatchingLine()` uses containment or ≥0.5 word overlap (`src/features/npc/updates.js:80-104`).
- **Change:** Before applying each parsed operation, verify it is supported by the reply and assigned to the correct NPC. When removal matching is ambiguous, give JEV a Choice among the existing lines plus `none`; code still performs the actual operation and changelog. Never let JEV invent a field, value, or removal target.
- **Benefit / fallback:** Fewer hallucinated dossier edits and incorrect deletions while retaining undo. Failure/current no-match behavior remains; uncertain updates are refused or reviewed, not guessed.
- **Proof:** A paraphrased removal selects the right existing line; an unsupported new hobby is rejected; two similar lines produce `none`/review rather than an arbitrary deletion.

### 18. Review NPC portrait and outfit-tag prompts against source facts

- **Now / anchor:** `npcGeneratePfp()` generates a prompt and always offers edit preview (`src/features/npc/pfp.js:77-107`); `renderOutfitTagsPrompt()` requires source-only clothing tags (`src/features/imagegen/v2/looksCore.js:237-263`).
- **Change:** Add text-based verification before ComfyUI: does the prompt preserve dossier identity, current outfit, requested portrait framing, and source-only attributes? For outfit tags, ask separate Nouls for unsupported garments, changed state of dress, and wrong character. Show portrait issues in the existing preview. Rejected outfit tags are not cached or sent; the current outfit text remains authoritative and the user gets a warning rather than a blocking popup.
- **Benefit / fallback:** Catches subtle identity/outfit drift before paid rendering. JEV failure retains the current prompt/tag flow; semantic rejection requires portrait edit/override or leaves the new outfit tags unused.
- **Proof:** A white-hair tag for a black-haired dossier is flagged; a faithful abbreviated tag set passes; a user edit can intentionally override with an audit entry.

## 5. Story Director, prompt engine, and configuration

### 19. Evolve Story Director on semantic arc state, not tracker status alone

- **Now / anchor:** `index.js:589-668` regex-reads `arc_status`/`directive_status`, evolves on `completed`/`pivoted`, and has frequency fallback.
- **Change:** Ask whether the active directive's central event is complete, whether the user redirected the arc, whether the story is stalled, and whether unresolved threads require the current plan. Combine answers in code with the existing tracker and frequency settings. Low confidence holds the plan; manual Generate/Evolve is unchanged.
- **Benefit / fallback:** Handles incorrect or missing tracker prose and avoids premature arcs. Failure retains regex/frequency behavior.
- **Proof:** The synthetic `progressing` tracker with a solved investigation returned `arc_completed = 0.94` and `evolve` at 0.98 confidence. Also test false completion, user pivot, and slow-burn scenes that should hold.

### 20. Verify generated directives before saving them

- **Now / anchor:** `handleDirectiveGeneration()` accepts any output with `<directive>` or `<plot>` and writes `sp.currentPlan` (`src/features/storyplan/ui.js:430-471`).
- **Change:** Before saving, evaluate independent requirements: no control of `{{user}}`, continuity with recent facts, respect for director note/genre/pacing, meaningful future direction, and preservation of unresolved threads. Route to accept or the existing editable directive surface with dimension-level warnings; do not auto-regenerate or rewrite.
- **Benefit / fallback:** Prevents structurally valid but story-breaking blueprints. JEV failure keeps current acceptance; semantic rejection requires edit/override.
- **Proof:** A directive assigning the player's next decision is rejected; a plan honoring the director's note and open clues passes; a low-evidence criticism becomes a warning, not a silent rewrite.

### 21. Add a natural-language configuration compiler over existing registries

- **Now / anchor:** Story Config, styles, direct styles, personas, add-ons, genres, and flavors are explicit closed taxonomies (`src/features/storyconfig/config.js`, `data/`, `src/features/storyplan/ui.js`). Users currently select every option manually.
- **Change:** Add an opt-in assistant that maps a request such as “slow-burn mystery, short replies, dice, warm NPCs” to existing Choices and per-option Nouls. Code enforces max three flavors, exclusive add-ons, compatibility gates, and leaves free-text/custom fields alone. Present a settings diff; only confirmation calls existing writers such as `applyLoadout`/profile saves.
- **Benefit / fallback:** Faster setup without allowing JEV to invent settings or silently take control. Low confidence produces no diff; current manual controls remain authoritative.
- **Proof:** The example selects the expected existing pace, length, dice, and disposition values; an unsupported request maps to `other`/no change; nothing applies before confirmation.

### 22. Add semantic context-budget selection across memory, NPCs, story threads, and add-ons

- **Now / anchor:** `src/core/tokens.js` estimates and displays prompt size but does not allocate a budget; `buildBaseDict.js` assembles all enabled content. Add-on guidance warns that too many systems thin prose.
- **Change:** For optional context candidates, Score current-turn utility and redundancy, and ask Nouls for conflict or embedded instructions. Deterministic code computes candidate tokens and greedily selects value-per-token inside a user-set budget, preserving mandatory engine, user-agency, safety, and compatibility content. Show an add/drop preview in the existing prompt-preview surface.
- **Benefit / fallback:** Turns token pressure into an explicit semantic allocation rather than indiscriminate truncation, reducing context rot while preserving critical clues. Failure uses the current complete assembly.
- **Proof:** With a forced small budget, an irrelevant dossier is dropped before the clue needed for the current question; mandatory content is never dropped; estimated and actual selected payloads are inspectable.

### 23. Turn Model Setup and Writing Style into evidence-informed recommendation surfaces

- **Now / anchor:** `LOADOUTS` contains maintainer-tested static model guidance and `applyLoadout()` applies it (`src/features/modelsetup/loadouts.js`); style generation uses the `styleGen` background route.
- **Change:** Let JEV choose among existing loadouts only from supplied loadout metadata, the user's stated priorities, and observed problems. It must not infer current model capabilities or edit the tested table. For generated writing styles, independently verify character fit, clarity, internal contradictions, and conflicts with Story Config before showing the editor.
- **Benefit / fallback:** Users get a relevant starting point while tested recommendations and human approval remain authoritative. Failure shows the existing static cards/style output.
- **Proof:** A stated speed priority with missing blocks suggests the existing fast/Chomusuke loadout for the stated reason; no recommendation applies automatically; a contradictory style is returned to editing.

### 24. Add continuous add-on and prompt-policy diagnostics

- **Now / anchor:** Add-ons are manually selected with guidance to pick only three or four (`src/ui/tabs/globalAndBlocks.js:148-211`); their behavior is mostly prompt instruction.
- **Change:** During ReplyAssessment, evaluate only enabled add-ons: dice gate compliance, combat consequence consistency, HTML in-world appropriateness, dialogue/narration format, organic NPC introduction, and similar atomic contracts. Use results to suggest—not automatically apply—disabling conflicting add-ons, choosing an existing style, or editing a prompt through the current preview/editor.
- **Benefit / fallback:** Makes prompt bloat and rule conflicts observable instead of asking users to guess which module caused a regression. Failure produces no recommendation.
- **Proof:** A reply with reader-only HTML is linked to the HTML add-on check; disabling it in the preview removes that violation; unrelated prose dimensions are not penalized.

## 6. Dynamic Ban List, dice, and reply quality

### 25. Verify Dynamic Ban List candidates before adding them

- **Now / anchor:** `src/features/banlist/ui.js:235-246` splits the generative response on punctuation and immediately adds every fragment longer than three characters.
- **Change:** First count occurrences in code. For each candidate with real repetition evidence, ask whether it is repetitive phrasing versus necessary story content, whether the proposed span is too broad, and whether it is a name/place/term that would damage continuity if banned. Route to `ban`, `review`, or `keep`; uncertain candidates never auto-add. Show `review` candidates in a new “Suggested phrases” section between the AI Slop Detector and Active Banned Phrases, with Add and Reject controls.
- **Benefit / fallback:** Prevents malformed splits and overbroad bans from silently degrading future replies. JEV service failure uses the current split-and-add behavior; an uncertain JEV verdict goes to review instead of automatic addition.
- **Proof:** A single evocative metaphor is kept; a repeatedly used cliché is banned; a recurring character name is not; punctuation-heavy model output cannot create junk entries.

### 26. Add typed dice assessment for the primary user attempt and verify all outcomes

- **Now / anchor:** `data/addons.js:16-63` asks the story model to decide roll necessity, DC, modifier, and verdict; `src/utils/dice.js` owns fair RNG; `src/blocks/treatments.js:1009-1121` owns parsing/arithmetic and keyword/numeric outcome classification.
- **Change:** Do not ask JEV to enumerate attempts. For the player-only `dice` add-on, ask one Noul whether the user turn contains a primary attempt with meaningful costly failure, then one difficulty Score and one established-competence Choice about that same primary attempt. After the Score confidence gate, code rounds the expected score to the nearest band and clamps it to 0–5, maps it to DC 5/10/15/20/25/30 and the competence Choice to the existing modifier range, rolls exactly as today, and supplies the resolved line. Update the `data/addons.js` contract so that line appears first and the story model judges only later attempts; reserve the first pre-rolled number for the primary attempt and keep subsequent numbers in their existing order. Additional player attempts and every NPC attempt in `dice_all` retain the current story-model judgment. After parsing, JEV can classify unusual verdict wording and check whether every attempt's prose honors its computed outcome; arithmetic never moves to JEV.
- **Benefit / fallback:** More consistent, auditable primary-action decisions without pretending future or unenumerated attempts are knowable. Uncertain/unavailable judgments use the current dice prompt and numeric fallback.
- **Proof:** The collapsing-rooftop leap returned `roll = 0.97` and difficulty 4.43 on the 0–5 six-band scale; an ordinary hug returned 0.47 and therefore takes the uncertainty fallback, not a forced yes/no. Test compound user turns, nat 1/20, success-at-cost, NPC-only attempts, and prose contradicting the roll.

### 27. Add a unified Reply Doctor and on-demand swipe comparison

- **Now / anchor:** Reply validation is distributed across parsers and manual retries; users choose swipes without semantic assistance. Roleplay examples such as `got-jev` demonstrate post-scene typed labels and in-fiction checks.
- **Change:** Batch independent checks for staying in fiction, user agency, POV, enabled style/pacing, repetition, meta/refusal text, NPC knowledge boundaries, and current Story Config. Reply Doctor explains which typed check failed and offers existing actions—keep, Read again, edit prompt, or manually regenerate—without silent changes. On demand, compare existing swipes with the same rubric and display ranked probabilities; the user still picks.
- **Benefit / fallback:** One coherent quality layer replaces disconnected “something went wrong” debugging and creates useful labels for later evaluation. Failure leaves replies/swipes untouched.
- **Proof:** An out-of-character assistant disclaimer is flagged while in-world dark content is not misclassified as a safety problem; a user-agency violation ranks below a compliant swipe with identical formatting.

## 7. Images and experimental vision

### 28. Replace the conditional image prompt's generative NONE decision with a Noul gate

- **Now / anchor:** Conditional mode asks the image-prompt writer to emit `NONE` unless someone takes/sends/shares a picture (`src/features/imagegen/auto.js:29-41,111-117`), spending a generative call before deciding.
- **Change:** Ask Noul whether the latest exchange explicitly depicts or requests a photo-worthy capture/share event. At confident no, skip prompt generation and placeholder creation. At confident yes, use the existing writer. Uncertain/service failure runs the current conditional writer and honors its `NONE` answer.
- **Benefit / fallback:** Avoids unnecessary worker calls, latency, and accidental images while retaining a second opinion in ambiguous cases.
- **Proof:** Pure dialogue with no camera/photo action skips; “she snaps a picture” proceeds; a subtle visual handoff follows the current writer if the gate is uncertain.

### 29. Verify image prompts before submission to ComfyUI

- **Now / anchor:** Manual and automatic paths unwrap a model prompt then call `igGenerateWithComfy()` (`src/features/imagegen/index.js:67-99`, `combinedTurn.js:251-263`). V2 resolves stored looks/outfits deterministically.
- **Change:** Before submission, compare the text prompt with the reply, selected cast, stored look/outfit, requested shot, and style. Ask separate questions for wrong character, wrong outfit, unsupported scene content, contradictory composition, and missing required subject. Route issues to existing preview/edit/manual paths; never let JEV rewrite the prompt.
- **Benefit / fallback:** Prevents semantically wrong but well-formed prompts from consuming renders. JEV failure retains current generation; semantic rejection requires edit or explicit override.
- **Proof:** A prompt using yesterday's outfit after a World State outfit change is stopped; a prompt that correctly omits an absent NPC passes; combined-answer fallback behavior remains intact.

### 30. Prototype rendered-image quality, identity, and crop review as a separate Dreamer feature

- **Now / anchor:** ComfyUI returns image blobs; NPC portraits already become JPEG data URLs (`src/features/npc/pfp.js:163-194`). Official image/Box support is explicitly Dreamer-ready and requires an opt-in header.
- **Change:** In an isolated experimental mode, send PNG/JPEG results with Noul checks for usable render, prompt alignment, outfit consistency, and same-character resemblance to a reference; use Choice to rank candidate swipes. For portraits, pair a face-presence Noul with Box and pad/crop in code. No image is rejected automatically outside this experiment.
- **Benefit / fallback:** Could close the loop from textual prompt checks to actual output quality and identity. Unsupported media/provider capability or uncertainty always keeps the current image and user review.
- **Proof:** A labeled local set includes blank/corrupt renders, wrong character, wrong outfit, good portrait, and absent-face cases. Box is ignored when presence is low, and every result remains manually overridable.

## Adoption order

| Order | Proposals | Reason |
| --- | --- | --- |
| **1 — Foundation** | 1–4 | Transport, privacy, versioned questions, identity-safe caching, and evidence collection are prerequisites for trustworthy automation |
| **2 — Shadow-friendly, low blast radius** | 5–8, 12, 15, 25, 28 | Clear current heuristics and easy A/B comparisons; no autonomous state mutations required to measure value |
| **3 — Correctness and worker savings** | 9–11, 13–14, 16–20, 26 | High potential quality/latency gains, but false accepts and missed reads have greater cost and need larger labeled sets |
| **4 — Deep adaptive assistance** | 21–24, 27, 29 | Builds on the shared assessments and evidence from earlier stages; primarily preview/confirm |
| **5 — Experimental vision** | 30 | Upstream API and accuracy are explicitly not production-ready |

No proposal should skip shadow mode because it appears obviously beneficial. Promote a decision only after its gateway/model/question version meets the feature's chosen quality and coverage targets on suite data.

## Public patterns mapped to suite changes

| Source | Transferable pattern | Proposals |
| --- | --- | --- |
| TypeSafe [simple memory](https://docs.typesafe.ai/cookbooks/basic_memory), [RAG passage classification](https://docs.typesafe.ai/cookbooks/classifying_rag_passages), and [re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe) | Gate memories, score query–candidate pairs, separate conflicts, and keep retrieval/policy in code | 5–8 |
| TypeSafe [entity alignment](https://docs.typesafe.ai/cookbooks/entity_alignment) | Ordered same/related/different judgment plus companion field checks and a curator middle route | 8, 16 |
| TypeSafe [SDE cascade](https://docs.typesafe.ai/cookbooks/sde_cascade) and [citation checking](https://docs.typesafe.ai/cookbooks/citation_check) | Generate or parse first, then verify groundedness per field before accepting | 7, 11, 17, 20, 29 |
| TypeSafe [function calling](https://docs.typesafe.ai/cookbooks/function_calling) and [skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion) | Compile natural language into closed-set actions, with `none`, rejection, and confirmation | 21–23 |
| TypeSafe [Intelliprompter](https://docs.typesafe.ai/cookbooks/intelliprompter) | Score pending clues/arc criteria against the accumulated prose instead of matching words | 12, 19 |
| TypeSafe [smart-home fan-out](https://docs.typesafe.ai/demos/smart-home), [guardrails](https://docs.typesafe.ai/cookbooks/llm_guardrails), and [confidence routing](https://docs.typesafe.ai/patterns/confidence-routing) | One batched assessment per turn, independent checks, and risk-specific action gates | 3, 9, 24, 27 |
| Independent [`got-jev`](https://github.com/phureewat29/got-jev) and [`escape-from-mos-eisley`](https://tpiros.dev/blog/jev-the-model-that-cannot-write/) | Narrator writes; JEV labels scenes/actions; pure code resolves UI, state, rolls, and next prompts | 9, 26–27 |
| Independent [`Jev-Reranker`](https://github.com/uspraveen/Jev-Reranker), [`jev-samples`](https://github.com/aarora79/jev-samples), and [`jev-demo`](https://github.com/gopinav/jev-demo) | Batched candidate questions, confidence as a gate, versioned questions, retrieval-order fallback, and measured baselines | 2, 6, 22 |
| [OpenRouter System One docs](https://openrouter.ai/docs/guides/community/typesafe-sdk) and [Vercel JEV gateway docs](https://vercel.com/kb/guide/typesafe-jev-and-ai-sdk) | Browser-reachable hosted JEV routes with TypeSafe-compatible or normalizable responses | 1 |

Core behavior and limits come from TypeSafe's [introduction](https://docs.typesafe.ai/introduction), [primitives](https://docs.typesafe.ai/primitives), [confidence](https://docs.typesafe.ai/confidence), [models](https://docs.typesafe.ai/models), [JEV 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13), and [workflow guidance](https://docs.typesafe.ai/concepts/how-to-build-with-system-one). Image ideas come from the explicitly experimental [Images](https://docs.typesafe.ai/images) and [Box](https://docs.typesafe.ai/primitives/box) documentation. Third-party benchmark numbers are not used as evidence of suite-specific quality.

## Verification of this analysis

- Official TypeSafe documentation was read across introduction, primitives, state, confidence, model limits, known jaggedness, workflow patterns, HTTP/SDK contracts, images/Box, and relevant cookbooks.
- Four read-only repository scouts mapped core runtime, feature logic, UI workflows, and data/preset registries; key integration anchors and heuristic implementations were then reread directly.
- Public examples inspected include official RAG, memory, entity-alignment, function-calling, skill-suggestion, extraction-verification, citation-checking, and Intelliprompter patterns; independent `got-jev`, `escape-from-mos-eisley`, `Jev-Reranker`, `jev-samples`, and `jev-demo` projects/articles.
- Live transport preflights used `OPTIONS` with a browser `Origin`, `Access-Control-Request-Method: POST`, and required headers. TypeSafe direct rejected; OpenRouter and Vercel allowed the browser request. This proves transport compatibility only, not account access or answer quality.
- Five synthetic `jev-1.14.0` probes exercised memory reranking, paraphrased clue detection, wrong-entity update verification, dice judgments, and semantic arc completion. Results are included at proposals 6, 12, 11, 26, and 19. They are illustrative fit checks, not benchmarks; the selected browser gateway and pinned model must be re-evaluated on real labeled suite fixtures before activation.

## Critical files & anchors

- `src/jev/` *(new)* — provider adapter, question registry, policies, and cached assessments; no equivalent decision runtime exists.
- `index.js:515-703` — post-reply orchestration where a shared ReplyAssessment and semantic work gates connect.
- `src/engine/injection.js` and `src/engine/buildBaseDict.js` — pre-generation assessment, memory/NPC retrieval, context selection, and prompt-preview integration without changing exact envelope construction.
- `src/features/memory/index.js` and `src/features/memory/vectordb.js` — current summarization, query construction, retrieval, fallback, and vault-write boundaries.
- `src/state/index.js` plus the existing feature worker modules — parsed-delta verification and selective worker reads while parsers/state stores remain authoritative.

## Assumptions & contingencies

- **Provider:** Default to OpenRouter System One because its contract matches TypeSafe and its live preflight passed. If the account/model catalog lacks the evaluated version, pin the available JEV version and rerun every threshold evaluation; do not carry thresholds across versions. Vercel remains the alternative through the same internal adapter.
- **Direct TypeSafe:** Reconsider only after a new browser preflight allows the actual SillyTavern origin. If all browser providers fail, JEV stays disabled and the current suite remains complete; no hidden proxy or required backend is introduced.
- **Credentials:** Session-only storage is the default. If a user opts into persistent browser-local storage, the UI must disclose that any script running in the same SillyTavern origin could read it. A shared key is never shipped.
- **Privacy:** Roleplay content is third-party input only after explicit opt-in. Send the minimum fields for each question, not the whole chat by default. Raw decision-state logging is off unless the user deliberately creates an evaluation fixture.
- **Evaluation:** Synthetic probe outcomes do not establish production accuracy. If multilingual or roleplay-specific results are weak, keep that feature in shadow/review mode or retain the existing heuristic permanently.
- **Thresholds:** Start conservative and tune per action. A low-confidence answer always chooses the current behavior or review; it never becomes an automatic deletion, merge, state mutation, settings change, or render rejection.
- **Vision:** If experimental images are unavailable through the selected provider, proposal 30 is omitted without affecting any text-based proposal. If image/Box support changes contract, isolate the breakage in the experimental provider adapter.

## Documentation delivery

Create the missing `docs/` directory and write this complete report verbatim to `docs/jev.md`; `docs/jev.md` and its parent directory do not currently exist. Do not modify any other working-tree file. Read the created file back and verify that it begins with `# Megumin Suite JEV Decision Map`, contains all 30 numbered proposals, and ends with the complete **Assumptions & contingencies** section.
