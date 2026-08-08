# LangChain ecosystem reference

> Status: direction note only. Research snapshot from 2026-08-08: four read-only passes over the official repos and docs (deepagents, langchain, langgraph, langchain-academy, langgraph-101, docs.langchain.com, docs.smith.langchain.com, pricing). Not part of the current implementation plan. Feeds A0 design and future post-v1 evaluation only; the "no external framework / platform" verdict stands.

## Conclusion

- **No adoption, re-verified with current facts.** LangSmith free tier is cloud-only (trace data leaves the machine); self-hosted is an Enterprise paid add-on. "Data stays on-machine" and "zero budget" are mutually exclusive under current LangSmith pricing. The earlier exclusion was memory-based; it is now evidence-based.
- **Roadmap verdict D→A→C→B is unchanged.** It is driven by internal project state (zero real production samples), not by anything in these materials.
- **A0 gets four concrete design inputs** from the Building Reliable Agents companion repo (`langchain-ai/lca-reliable-agents`, code actually read).
- **deepagents comparison confirms architectural convergence.** Jarvis has equivalents for every main component and is stricter in three places. Four absent items are recorded as future reference points; three items are excluded as negative-value for a safety-first local coding agent.

## 1. Product map (2026-08-08)

- **LangChain 1.x** (1.0 LTS released 2025-10-22, together with LangGraph 1.0; PyPI latest at snapshot: langchain 1.3.14, langgraph 1.2.10). The 1.x main package centers on a single abstraction, `create_agent`, with **middleware as the only extension primitive**; the returned agent is a compiled LangGraph StateGraph. Legacy chains/LCEL moved to `langchain-classic`.
- **LangGraph 1.x**: low-level orchestration runtime (usable without LangChain). Three pillars: **checkpointer** (full state snapshot per superstep, keyed by `thread_id`, supports time travel; InMemory/Sqlite/Postgres savers), **durable execution** (resume replays from the start of the interrupted node, so side effects must be wrapped in idempotent `@task`s), **interrupt** (suspends the whole graph, persists state, resumes via `Command(resume=...)` across process restarts).
- **Deep Agents** (`langchain-ai/deepagents`): "batteries-included agent harness" on LangChain agents + LangGraph runtime — planning todos, virtual filesystem, subagents, context offloading/summarization, long-term memory, skills, HITL.
- **LangSmith**: closed-source companion platform (observability, evals, deployment, plus newer Fleet/Engine/Sandboxes/LLM Gateway lines), decoupled from the OSS libraries and usable with non-LangChain stacks.

## 2. LangSmith exclusion, re-verified

| Mode | Data flow | Gate |
|---|---|---|
| Cloud SaaS (Developer, free) | Traces (full prompts, tool I/O, file contents) stored in LangChain cloud (US/EU). 5,000 base traces/month hard cap without a payment method; 14-day base retention; datasets permanent | Free |
| Hybrid | SaaS control plane + self-hosted data plane | Enterprise |
| Self-hosted (K8s/Helm) | Trace content stays on own infrastructure; official text: "store all information locally and will never send sensitive information outside of your network" | **Enterprise paid add-on**, sales-issued license key, no free self-hosted tier |

Self-hosted still has egress exceptions: `beacon.langchain.com` for license validation + usage metering (telemetry can be disabled; an offline mode exists as an exception path).

Conclusion: for a single-user, zero-budget, data-never-leaves-the-machine project, LangSmith is structurally unavailable. Sources: langchain.com/pricing, docs.smith.langchain.com/self_hosting (+ /egress), docs.langchain.com/langsmith/usage-and-billing.

## 3. deepagents component mapping

| Component | Mechanism | Jarvis status |
|---|---|---|
| `write_todos` planning | State-machine task list (pending/in_progress/completed) persisted in agent state; opt-in since v0.7 | **Absent** — reference point |
| Virtual filesystem | ls/read/write/edit/glob/grep/execute over pluggable backends (state / disk / store / composite by path prefix) | Equivalent (safe-path tools + `data/tool-results/` offload) |
| FS permissions | Declarative glob rule table, first-match-wins, default allow on no match | Equivalent + stricter (RuleResolver + PermissionGate deny-first) |
| Subagents / context quarantine | `task` tool, fresh isolated context, report-only return; per-subagent tools/model/prompt/skills | Equivalent + stricter (capability intersection, depth/budget rails) |
| Async + dynamic subagents | Long-running handles with steering/cancel; QuickJS in-process fan-out from code | **Excluded** — widens attack surface, weakens deterministic audit |
| Context offloading | Tool call/result >20k tokens written to backend, pointer + 10-line preview kept; pointers replace old calls past 85% window | Equivalent (ContextManager threshold compression + tool-result disk offload) |
| Summarization | Past 85% `max_input_tokens`, LLM summary replaces history; raw transcript written to disk; ContextOverflowError → immediate summarize+retry | Equivalent (Jarvis lacks the raw-transcript full-fidelity twin, has crash-safe JSONL instead) |
| Long-term memory | Files-as-memory (`AGENTS.md`-style), CompositeBackend routes `/memories/` to LangGraph Store; namespace scoping (assistant/user/org); **full injection into system prompt**; hot-path agent edits + background consolidation agent | **Deliberately excluded** (automatic long-term memory is on the no-do list; low admission bar is the exact inverse of the propose_skill defer rationale) |
| Skills | SKILL.md progressive disclosure (frontmatter at boot, full text on match) | Equivalent (SkillRegistry three-level disclosure) |
| HITL | `interrupt_on` by tool name via LangGraph interrupts; approve/edit/reject | Equivalent + stricter (deterministic command parser, per-command granularity, no self-reported side effects) |
| `response_format` | Subagent returns structured JSON to the parent instead of free text | **Absent** — reference point |
| Episodic memory | Past threads become a searchable resource via a search tool over checkpoints | **Absent** — reference point (Jarvis has JSONL + resume; missing only the agent-callable search layer) |
| Security model | Official stance: "trust the LLM"; enforcement lives at the tool/sandbox layer | Jarvis is the opposite: never trust model self-report; deterministic permission root + completion-authority chain |

## 4. LangChain 1.x concept mapping

- **middleware vs Jarvis Hooks**: middleware wraps both model calls and tool calls (can rewrite requests, swap models, short-circuit, retry) and can read/write agent state. Jarvis Hooks sit only around tool execution (PreToolUse deny-only, PostToolUse advisory) and never touch model calls. The narrower surface is deliberate: fewer rewrite paths, simpler audit.
- **checkpointer vs SessionStore JSONL**: full snapshots with time travel vs append-only event log with replay. Jarvis's log model favors audit and crash-safety; snapshot time travel solves problems Jarvis does not have.
- **interrupt vs PermissionGate Approver**: cross-process graph suspension with replay-from-node-start (idempotency constraints) vs in-process synchronous injected callback. Jarvis approvals are simpler and sufficient for a single-user local CLI/GUI.
- **graph topology vs runAgent**: LangGraph offers arbitrary typed state graphs; Jarvis's hardcoded model→tools loop is intentionally fixed. `create_agent` itself has the same fixed topology — arbitrary graphs are for orchestration Jarvis does not need.

## 5. Inputs to A0 (eval corpus + read-only runner)

From the Building Reliable Agents companion repo (code read; platform-only parts noted):

1. **Trajectory-level evaluation.** Their code-based evaluator takes the full run — extracting the tool-call sequence and checking ordering constraints (`schema_before_query`: schema inspection must precede data queries) — not just the final answer. For A0: the runner should evaluate the full goal-round JSONL (claim + checks + tool trajectory), not only the recorded verdict.
2. **Deliberate out-of-scope coverage.** Their dataset is single-column inputs with no reference outputs, intentionally mixing out-of-scope questions. This converges with the verdict's `valid/tampered/ambiguous` case taxonomy; A0's corpus should guarantee all three classes.
3. **Pairwise discipline (for A1).** `randomize_order=True` to cancel position bias; judge prompts pin the criterion and block shortcuts ("more concise but must keep key information — shorter is not better"); cheap model as judge.
4. **Scorer contract.** `score` 0/1 + `comment` explaining the failure; N/A convention passes inapplicable cases (score=1 when the checked behavior never occurred). Deterministic, zero-LLM-cost, regression-friendly.

Platform-bound items noted but not transferable: online evals (server-side rules over live traces), Insights Agent (batch failure-mode mining over traces), Automations. Methodology takeaway only: **production traces are the eval raw material** — Jarvis's `data/` JSONL already is that material.

## 6. Future reference points (record only, no current action)

- **Structured subagent output contract** — revisit if verifier/judge output parsing from free text becomes a misjudgment source.
- **In-session todo list (write_todos-style)** — pure state, no new execution surface; aligns with the R6 "正在跑" attention zone; revisit when the GUI needs "what does the agent think it is doing".
- **Episodic memory search layer** over `data/sessions` — revisit when debugging/history recall becomes frequent; needs a secret-redaction boundary before any agent-callable search.
- **Async subagents with mid-run steering/cancel** — revisit when long child tasks need human intervention mid-flight; EventBus already carries the needed events.

Explicitly excluded (negative value for a safety-first local coding agent): in-process QuickJS interpreter, model-driven dynamic subagent fan-out, background memory consolidation (same rationale as the propose_skill defer).

## 7. Sources

- github.com/langchain-ai/deepagents + docs.langchain.com/oss/python/deepagents/{overview,memory,subagents,context-engineering}
- github.com/langchain-ai/langchain, github.com/langchain-ai/langgraph + docs.langchain.com/oss/python/{langchain,langgraph} (middleware, persistence, durable-execution, interrupts pages)
- github.com/langchain-ai/langchain-academy, github.com/langchain-ai/langgraph-101, github.com/langchain-ai/lca-reliable-agents (eval lessons 4–6 code)
- academy.langchain.com course outline pages (login-walled content; outline only)
- docs.smith.langchain.com/self_hosting (+/egress), docs.langchain.com/langsmith/usage-and-billing, langchain.com/pricing
