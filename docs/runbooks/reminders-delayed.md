# Runbook: reminders delayed (SLO breach: p95 lag > 60 s)

1. **Is the worker running?** `kubectl -n lifeos get pods -l app.kubernetes.io/component=worker` and check `/readyz`.
2. **Is the queue backed up?** The "Background jobs by outcome" panel shows whether `send-reminder` errors are rising, for example SMTP failures:
   ```sql
   select status, count(*), max(attempts), max(last_error) from reminders
   where remind_at > now() - interval '1 hour' group by 1;
   ```
3. **SMTP failing.** Rows bounce back to `pending` with `last_error`. Fix `SMTP_URL`; the sweeper redelivers automatically.
4. **Redis lost jobs.** No action needed. The sweeper re-enqueues pending reminders more than 30 s overdue every minute. Watch the worker log line `re-enqueued overdue reminders`.
5. **Throughput.** Raise `worker.concurrency` or the number of replicas.
