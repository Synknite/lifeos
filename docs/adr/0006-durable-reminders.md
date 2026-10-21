# 6. Reminders: Postgres as source of truth, queue as fast path

**Status:** accepted

**Decision.** A reminder is a row. BullMQ delayed jobs deliver it on time. A one-minute sweeper re-enqueues overdue pending rows. Delivery claims the row with a conditional UPDATE (exactly-once) and releases it on failure.

**Consequences.** Losing Redis delays reminders by at most one sweep interval. Duplicate jobs are harmless. Delivery lag is measured and alerted on (SLO: p95 < 60 s).
