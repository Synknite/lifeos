# 2. Fastify + Drizzle + Postgres (with pgvector)

**Status:** accepted

**Decision.**

- **Fastify 5** with a zod type provider: one schema validates requests, types handlers, and generates OpenAPI. NestJS would add a DI framework the codebase doesn't need.
- **Drizzle ORM:** SQL-first, plain SQL migration files reviewable in PRs, native `vector` type, and no query-engine binary.
- **Postgres + pgvector** instead of a separate vector database: one system to back up and secure; transactional consistency between notes and their chunks; full-text and vector search in one place for hybrid ranking.

**Consequences.** Vector search scales to millions of chunks with HNSW. Very large corpora would justify a dedicated vector store later.
