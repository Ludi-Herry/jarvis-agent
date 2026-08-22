# AI coworker readiness

> Status: direction note only. This document records what the Claude Tag / Glean independent-agent pattern means for Jarvis-Agent. It is not part of the current implementation plan.

## Conclusion

Jarvis should keep its current narrow product shape: a local coding-agent harness with strong safety, verification, loop, cron, and handoff primitives.

The article is useful as a future product lens, mainly for the GUI phase. It should not pull the project into enterprise search, broad connectors, automatic long-term memory, or a Glean-style organizational platform.

## Source Signal

The useful claim in the article:

- Agent UX is moving from private single-user chats toward shared work surfaces.
- A production agent needs identity, memory, proactivity, accountability, and a permission-aware context layer.
- Claude Tag demonstrates the "one agent per channel" pattern: visible work, shared continuity, and team steering.
- Glean frames independent agents as provisioned identities with scoped access, traceable actions, proactive work, and an emergency stop.

For Jarvis, this maps to product readiness questions, not immediate feature scope.

## Source Signal: Tutti (2026-07-08)

[Tutti](https://github.com/tutti-os/tutti) is an open-source local "Agent OS": a shared workspace layer that glues existing black-box agent CLIs (Claude Code, Codex) together. Local clipping: `H:\LLM本地知识库\采集\clippings\可算找到一个能统一管理所有Agent还不用额外订阅的开源项目了！.md`. Its mechanisms reduce to three ideas:

- **Addressable, referenceable artifacts**: any agent's conversation, files, or task output can be `@`-referenced by the next agent, so the next agent enters the actual work scene. Summarized handoff documents lose detail; direct scene entry keeps it.
- **Attention-first control center**: everything that needs the human (pending approvals, stuck tasks, review queues) is surfaced in one screen, ordered by what needs a decision.
- **Goal-to-tasks with human review**: a goal is decomposed into subtasks and assigned to agents, with the human approving the plan before execution.

Tutti and Jarvis are complementary layers. Tutti orchestrates black-box agents it cannot verify; Jarvis owns every layer of one agent loop and can verify completion. The useful transfer is Tutti's workspace UX; its product shape (multi-agent workbench) stays out of Jarvis scope. Because of the day-1 EventBus + JSONL decisions, Jarvis already has the raw material Tutti needs a daemon for: `data/` is already one structured shared workspace and `observe` already aggregates it. The gap is experience-level (referencing and attention ordering), captured in the concepts below.

## Source Signal: OpenUI (2026-07-30)

[OpenUI](https://www.openui.com/docs/openui-lang) fills the Generative UI component-protocol and rendering layers. A registered component library produces model instructions; the model streams compact OpenUI Lang; the Renderer validates each node and maps it to real components. Reactive state, queries, and mutations can then run through a function map or MCP provider without regenerating the full interface on every interaction.

This layer can connect directly to Jarvis. Pi is optional: OpenUI's official [Pi harness example](https://www.openui.com/docs/openui-lang/examples/harnesses/pi-agent-harness) proves the Agent-runtime-to-Renderer bridge, while the same transport boundary can adapt Jarvis `message_delta` / final text into an OpenUI Lang stream. Official examples also pair OpenUI with [shadcn/ui](https://www.openui.com/docs/openui-lang/examples/shadcn-chat), Vercel AI SDK, LangGraph, and React Native. AI Elements can supply React components behind `defineComponent` and Zod contracts; this is an architectural fit, with no official adapter confirmed in the reviewed docs.

The Jarvis boundary:

- Keep the attention-first control center deterministic. Emergency stop, approvals, human review, verdict, completion state, and merge controls retain fixed placement and fixed semantics.
- Use OpenUI only for dynamic result artifacts: reports, diff / verification summaries, tables, charts, forms, and dashboards where the required composition genuinely varies by task.
- Keep EventBus, JSONL, PermissionGate, trusted requirements, and `decideVerdict` canonical. OpenUI Lang is presentation output and carries no completion authority.
- Route every `toolProvider` / MCP action through a Jarvis server endpoint that still enforces permission and audit policy. Browser-side tools never gain a direct mutation path.
- Finish R6 first. A future OpenUI spike starts read-only and dependency-isolated; current Jarvis gains no user value from changing its fixed vanilla-JS control surface during release closeout.

## What Jarvis Already Does Better

- **Verification discipline**: completion comes from `runGoal` / `decideVerdict`, with independent verifier paths and `cannotVerify -> park`.
- **Safety boundary**: unattended bash remains fail-closed; trusted verifier / hook / cron maps must live outside cwd.
- **Auditability**: session, goal, loop, cron, finalize, and shadow-git records already create a strong local evidence trail.
- **Controlled finalization**: merge and cleanup require explicit human confirmation and fresh scans.
- **Proactive primitive**: `cron` / `cron:daemon` already provide bounded time-triggered work without background service creep.

These are the hard parts for a coding agent. They should stay the core.

## Future Concepts To Keep

Only revisit these after the GUI shell is useful for Ludi' day-to-day work.

1. **AgentIdentity**
   - A first-class label for a running agent persona or role.
   - Captures allowed tools, memory scope, audit stream, and stop policy.
   - Starts local and personal; no department / enterprise abstraction until a real use case appears.

2. **Shared Work Surface**
   - A GUI timeline where the user can see what the agent is doing, what it has already tried, and what needs human input.
   - The near-term version is single-user visibility, not team collaboration.
   - Order the surface by attention priority: needs-a-decision first (approvals, parked human reviews, halted goals), running progress second, finished-awaiting-review third, full timeline last. This became the R6 design input recorded in `docs/handoff-release.md` slice 4 (2026-07-08).

3. **Context Connector**
   - A small connector contract for user-approved local sources such as repo docs, handoff docs, and the personal LLM knowledge base.
   - Avoid broad SaaS connectors unless a concrete workflow repeatedly needs them.

4. **Read-Only Status / Usage / Audit UI**
   - A GUI or CLI view over existing JSONL state.
   - It can explain turns, token use, halt reason, verdict, approvals, hooks, cron attempts, and finalize state.
   - It must stay observational and never authorize completion.

5. **Emergency Stop**
   - A visible stop control that prevents new agent actions immediately.
   - For current local Jarvis, this can map to stopping the active run / daemon and preserving logs.
   - Stronger cross-process or system-wide stop behavior belongs to a separate safety design.

6. **Cross-Primitive Context Reference** (from Tutti, 2026-07-08)
   - Let a new goal / session objective reference an existing session / goal / loop record as read-only starting context, so the next run enters the previous run's scene directly.
   - `loadSession` / `loadGoal` / `loadLoop` already exist; this is wiring work, no new abstraction.
   - Referenced history may only feed the builder context. It can never enter verifier reports, trusted routes, or `decideVerdict` — same invariant as "cwd content is never authority".

7. **Goal-to-Tasks as a Usage Pattern** (from Tutti, 2026-07-08)
   - Decomposing a big objective into an `objectives.txt` draft is an attended dev-session or skill output that a human reviews before running `npm run loop`.
   - No runtime decomposition, no automatic assignment, no fifth trusted map, no new scheduler abstraction. The quality backstop is the human review of the draft, which matches Tutti's own confirm-before-execute flow.

8. **Read-Only Generative Artifact Panel** (from OpenUI, 2026-07-30)
   - After R6, a bounded spike may transform an audited `ObservationReport` or completed result through a separate presentation adapter: `Jarvis result -> OpenUI Lang -> Renderer -> registered component library`.
   - The first spike has no `toolProvider`, MCP, mutation, or write action. It must render malformed output safely, preserve a fixed-text fallback, and leave Jarvis authority fields untouched.
   - Use shadcn/ui, AI Elements, or the product design system behind the component contracts. Adopt the layer only if varying task results repeatedly need richer composition than fixed cards.

## Explicit Non-Goals

- Do not build a Glean-style enterprise context graph.
- Do not add 100+ workplace connectors.
- Do not auto-learn long-term memory from every interaction.
- Do not make cron daemon auto-resume, auto-merge, or auto-cleanup.
- Do not let the GUI status layer grant completion or bypass `decideVerdict`.
- Do not introduce broad agent identity / permission abstractions before the GUI has a real workflow that needs them.
- Do not turn Jarvis into a Tutti-style multi-agent workbench; that is Tutti's lane, and a workbench like Tutti could plug Jarvis in as one of its agents instead.
- Do not build skill-as-app visual surfaces; approvals plus GUI human-review already cover the intervene-mid-run need.
- Do not adopt Tutti VM-style cross-device / cross-user collaboration (already covered by the non-goals above).
- Do not generate emergency-stop, approval, verdict, completion, or merge controls with OpenUI.
- Do not let OpenUI `toolProvider`, MCP, or browser-side actions bypass Jarvis permission, audit, verification, or completion authority.
- Do not replace canonical Jarvis events or persisted state with OpenUI Lang.

## Trigger To Reopen

Reopen this note only when one of these becomes true:

- The GUI has a stable first workflow and needs a visible agent timeline.
- Ludi needs the same Jarvis run to be resumed, inspected, or steered from multiple surfaces.
- Local knowledge-base / repo-doc context is repeatedly being gathered by hand.
- A long-running cron / loop workflow needs a user-facing kill switch and audit view.
- The project starts defining multiple durable agent roles with different memory and tool access.
- Completed runs repeatedly need task-specific reports, tables, charts, forms, or dashboards that fixed cards cannot express cleanly.

Until then, keep this as a product radar item.
