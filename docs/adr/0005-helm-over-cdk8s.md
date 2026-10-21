# 5. Helm chart (not cdk8s/Kustomize) for Kubernetes delivery

**Status:** accepted

**Decision.** Ship a Helm chart with a strict `values.schema.json`, published as an OCI artifact to GHCR. Migrations run as a pre-install/pre-upgrade hook Job. Gateway API `HTTPRoute` is the primary exposure option, with classic Ingress as a fallback. ingress-nginx was retired in March 2026, so the chart doesn't assume it.

**Why not cdk8s.** Typed manifests are attractive, but the output is still YAML that consumers must adopt. Helm is what platform teams and GitOps tools (Argo CD, Flux) consume directly, and it brings lint, test hooks, schema validation and packaging.

**Consequences.** Templating is less type-safe. We compensate with `helm lint --strict`, kubeconform against the Kubernetes 1.32 and CRD schemas, and `helm test` on a kind cluster in CI.
