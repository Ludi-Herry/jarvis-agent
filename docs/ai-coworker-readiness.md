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

## Explicit Non-Goals

- Do not build a Glean-style enterprise context graph.
- Do not add 100+ workplace connectors.
- Do not auto-learn long-term memory from every interaction.
- Do not make cron daemon auto-resume, auto-merge, or auto-cleanup.
- Do not let the GUI status layer grant completion or bypass `decideVerdict`.
- Do not introduce broad agent identity / permission abstractions before the GUI has a real workflow that needs them.

## Trigger To Reopen

Reopen this note only when one of these becomes true:

- The GUI has a stable first workflow and needs a visible agent timeline.
- Luis needs the same Jarvis run to be resumed, inspected, or steered from multiple surfaces.
- Local knowledge-base / repo-doc context is repeatedly being gathered by hand.
- A long-running cron / loop workflow needs a user-facing kill switch and audit view.
- The project starts defining multiple durable agent roles with different memory and tool access.

Until then, keep this as a product radar item.
