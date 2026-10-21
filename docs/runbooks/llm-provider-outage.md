# Runbook: LLM provider outage or errors

**Symptoms.** Chat shows "The AI provider is busy" or similar errors. The `llm_calls` error rate rises, and the `gen_ai.client.operation.duration` p95 climbs on the Grafana "LifeOS overview" dashboard.

1. **Confirm scope.**
   ```sql
   select provider, model, error_code, count(*) from llm_calls
   where created_at > now() - interval '15 minutes' group by 1,2,3 order by 4 desc;
   ```
   - `rate_limited` → you're hitting quota: lower `LLM_DAILY_TOKEN_BUDGET`, or request higher limits.
   - `unavailable`/`timeout` → provider incident: check the provider's status page.
   - `auth` → the key was rotated or revoked: update the secret (`kubectl -n lifeos edit secret lifeos-secrets`) and restart the pods.
2. **Fail over.** Set `config.llmProvider` to `openai` or `ollama` (or `LLM_PROVIDER` in compose) and roll out:
   `helm upgrade lifeos … --reuse-values --set config.llmProvider=openai`
   Task, note and reminder features keep working without an LLM. Only capture parsing, chat and briefings degrade.
3. **Afterwards.** Revert the provider and check that briefings missed during the outage were regenerated. The scheduler retries users without a briefing for today every 5 minutes.
