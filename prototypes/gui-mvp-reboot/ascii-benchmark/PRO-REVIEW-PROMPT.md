# Copy-ready Prompt for ChatGPT gpt-5.6-sol Pro

```text
You are the final independent product-design adjudicator. Use gpt-5.6-sol in Pro reasoning mode. You cannot access local files or run code; the complete evidence packet follows this prompt.

Objective:
Choose the single strongest information architecture for Jarvis-Agent's desktop conversation GUI. Jarvis is a local coding-agent harness for one user. The winning architecture must support sustained conversation, task supervision, human approval, artifact/diff review, pause/resume/terminate/recovery, and honest completion authority.

This is a blind review:
- Candidates are A, B, and C.
- Do not infer or discuss which model authored them.
- Ignore implementation maturity; judge the proposed product architecture and interaction contract.
- Candidate self-scores and rejected alternatives have been removed.

Evaluation weights:
- AI conversation-product fit: 25%
- Current goal/state comprehensibility: 15%
- Human takeover and approval efficiency: 15%
- Artifact/diff/verification workflow: 15%
- Long-session and multi-session scalability: 10%
- 1280×800 resilience: 10%
- Interaction stability and implementation risk: 5%
- Originality with coherence: 5%

Required method:
1. Restate the actual product decision in no more than 5 lines.
2. Steelman each candidate before criticizing it.
3. Score every candidate from 0–10 on every weighted dimension and calculate a weighted total.
4. Run one adversarial scenario against each:
   - a long session with many messages;
   - a pending approval that remains unresolved for several minutes;
   - switching from approval to verification and then to failure;
   - use at 1280×800.
5. Identify any architecture-level failure that would be expensive to repair after implementation.
6. Select exactly one winner. A tie is not allowed; resolve close scores using lower user effort, clearer authority, and lower structural risk.
7. You may name at most 3 transplantable ideas from the losing candidates. These additions must not replace or blur the winner's core architecture.

Do not:
- invent a fourth candidate;
- redesign everything from scratch;
- recommend multi-agent markets, plugins, model routing, cloud collaboration, or other frozen scope;
- ask for screenshots, source code, or additional context;
- reward visual color/font choices that ASCII cannot prove;
- return a generic list of pros and cons without a decision.

Output exactly this structure:

## Decision restatement
[max 5 lines]

## Blind scoring
| Dimension | Weight | Candidate A | Candidate B | Candidate C |
|---|---:|---:|---:|---:|
[rows]
| Weighted total | 100% | X.XX | X.XX | X.XX |

## Steelman and failure audit
### Candidate A
- Strongest case:
- Failure under stress:
- Expensive-to-repair risk:

### Candidate B
- Strongest case:
- Failure under stress:
- Expensive-to-repair risk:

### Candidate C
- Strongest case:
- Failure under stress:
- Expensive-to-repair risk:

## Final verdict
VERDICT: Candidate [A|B|C]
CONFIDENCE: [High|Medium|Low]

Why this candidate wins:
1. ...
2. ...
3. ...

## Allowed transplants
1. [source candidate → concrete idea → why it does not change the winner's architecture]
2. ...
3. ...

## Do not merge
[name the tempting combination that would dilute the winner]

## First implementation proof
[the single highest-value interactive prototype test to run before committing to React]

Read the full packet before answering. Return one decisive verdict.
```
