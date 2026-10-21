# 3. Provider-agnostic LLM layer

**Status:** accepted

**Context.** We want Claude's quality, OpenAI as an alternative, local models for privacy and keyless demos, and fully deterministic tests.

**Decision.** Define our own small interface (`ChatProvider`, `EmbeddingProvider`) with neutral message types. Each adapter maps to its vendor SDK. Cross-cutting concerns (spans, metrics, usage rows, budgets) live in one decorator (`instrumentChat`), not in the adapters. A router picks providers from config (`auto` falls back to mock). Embeddings are a separate axis and always 768-dimensional.

**Consequences.**

- Switching vendors is a config change.
- Vendor-specific features stay inside adapters: Claude's thinking-block replay, prompt caching and server-side fallback live in `providers/anthropic.ts`, carried through neutral types as `providerRaw`.
- We give up a generic framework's breadth, but the surface is small and fully tested.
