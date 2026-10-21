# 4. Human confirmation for every model-initiated write

**Status:** accepted

**Context.** Prompt injection can't be fully prevented by prompting. Notes are user-authored but can contain pasted or untrusted text.

**Decision.**

- Tools are classified `read` or `write`. The agent loop executes reads but never writes.
- Writes become `pending_actions`. The user approves or declines them on a card that shows a server-generated summary of the exact operation, with dates resolved.
- Execution happens in a separate request, gated by a compare-and-set on the run, and is audit-logged with `actor=agent`.

**Consequences.** One extra click per change. In return, a manipulated model can propose but never act. A future opt-in "auto-approve low-risk writes" setting can relax this per user.
