# 1. Monorepo with pnpm workspaces and Turborepo

**Status:** accepted

**Context.** Three deployables (api, worker, web) share domain schemas, services and LLM code. Separate repos would force versioned internal packages and lockstep releases.

**Decision.** One repo using pnpm workspaces, with Turborepo for task orchestration and caching. Internal packages export TypeScript source ("just-in-time" packages); apps bundle them with tsup, so there's no per-package build step. Docker builds use `turbo prune --docker` and `pnpm deploy --prod` for minimal contexts and runtime dependencies.

**Consequences.** One PR can change the schema, the services and the UI atomically. Builds stay fast. Internal packages can't be published as-is, which is fine since they're private.
