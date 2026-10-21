#!/usr/bin/env bash
# Build images, side-load them into kind, install the chart, run helm test.
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER=${CLUSTER:-lifeos}
NS=${NS:-lifeos}
TAG=${TAG:-local}

for app in api worker; do
  docker build -q -f docker/node-app.Dockerfile --build-arg APP="$app" -t "lifeos/lifeos-$app:$TAG" . >/dev/null &
done
docker build -q -f docker/web.Dockerfile -t "lifeos/lifeos-web:$TAG" . >/dev/null &
wait
echo "images built"

kind load docker-image --name "$CLUSTER" "lifeos/lifeos-api:$TAG" "lifeos/lifeos-worker:$TAG" "lifeos/lifeos-web:$TAG"

helm upgrade --install lifeos deploy/helm/lifeos -n "$NS" \
  -f deploy/helm/lifeos/values-kind.yaml --set imageTag="$TAG" \
  --wait --timeout 5m

helm test lifeos -n "$NS" --logs --timeout 2m
echo
echo "Open the app:  kubectl -n $NS port-forward svc/lifeos-web 8080:80   ->  http://localhost:8080"
