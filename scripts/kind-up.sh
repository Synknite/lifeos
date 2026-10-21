#!/usr/bin/env bash
# Create the local kind cluster and backing services. Idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER=${CLUSTER:-lifeos}
NS=${NS:-lifeos}

if ! kind get clusters | grep -qx "$CLUSTER"; then
  kind create cluster --config deploy/kind/kind-config.yaml --name "$CLUSTER" --wait 120s
fi
kubectl config use-context "kind-$CLUSTER" >/dev/null

kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NS" apply -f deploy/kind/infra.yaml

# Secrets never live in the chart or the repo. Locally, build them from env.
kubectl -n "$NS" create secret generic lifeos-secrets \
  --from-literal=DATABASE_URL="postgres://lifeos:lifeos@postgres:5432/lifeos" \
  --from-literal=REDIS_URL="redis://valkey:6379" \
  --from-literal=SMTP_URL="smtp://mailpit:1025" \
  --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  --from-literal=OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "$NS" rollout status statefulset/postgres --timeout=180s
kubectl -n "$NS" rollout status deployment/valkey --timeout=120s
echo "kind cluster '$CLUSTER' ready (namespace $NS)"
