import { type Database, schema } from '@lifeos/db';

export type Actor = 'user' | 'agent' | 'system';

export interface AuditEntry {
  userId: string;
  actor: Actor;
  action: string;
  entityType: string;
  entityId?: string | null;
  detail?: Record<string, unknown>;
  pendingActionId?: string | null;
}

/** Append-only record of who changed what, including agent-initiated writes. */
export class AuditService {
  constructor(private readonly db: Database) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.db.insert(schema.auditLog).values({
      userId: entry.userId,
      actor: entry.actor,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      detail: entry.detail ?? null,
      pendingActionId: entry.pendingActionId ?? null,
    });
  }
}
