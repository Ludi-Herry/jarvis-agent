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

Only revisit these after the GUI shell is useful for Luis' day-to-day work.

1. **AgentIdentity**
   - A first-class label for a running agent persona or role.
   - Captures allowed tools, memory scope, audit stream, and stop policy.
   - Starts local and personal; no department / enterprise abstraction until a real use case appears.

2. **Shared Work Surface**
   - A GUI timeline where the user can see what the agent is doing, what it has already tried, and what needs human input.
   - The near-term version is single-user visibility, not team collaboration.

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

6. **Read-Only Generative Artifact Panel** (from OpenUI, 2026-07-30)
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
- Do not generate emergency-stop, approval, verdict, completion, or merge controls with OpenUI.
- Do not let OpenUI `toolProvider`, MCP, or browser-side actions bypass Jarvis permission, audit, verification, or completion authority.
- Do not replace canonical Jarvis events or persisted state with OpenUI Lang.

## Trigger To Reopen

Reopen this note only when one of these becomes true:

- The GUI has a stable first workflow and needs a visible agent timeline.
- Luis needs the same Jarvis run to be resumed, inspected, or steered from multiple surfaces.
- Local knowledge-base / repo-doc context is repeatedly being gathered by hand.
- A long-running cron / loop workflow needs a user-facing kill switch and audit view.
- The project starts defining multiple durable agent roles with different memory and tool access.
- Completed runs repeatedly need task-specific reports, tables, charts, forms, or dashboards that fixed cards cannot express cleanly.

Until then, keep this as a product radar item.
