import { instanceToPlain } from 'class-transformer';
import { ClsServiceManager } from 'nestjs-cls';
import {
  EntitySubscriberInterface,
  EventSubscriber,
  InsertEvent,
  RecoverEvent,
  RemoveEvent,
  SoftRemoveEvent,
  UpdateEvent,
} from 'typeorm';
import {
  AuditAction,
  AuditActor,
  AuditLog,
} from '../../modules/audit/audit-log.entity';

// D28: deny-list of field names that must never reach audit_logs payloads.
// instanceToPlain honors @Exclude() decorators (User.passwordHash etc.); the
// deny-list is belt-and-suspenders for future entities that forget @Exclude
// or that name a sensitive field outside the @Exclude convention.
const SENSITIVE_KEYS = new Set(['password', 'passwordhash', 'authorization']);

// D6: TypeORM subscriber that auto-records CREATE / UPDATE / SOFT_DELETE /
// DELETE / RESTORE for every audited entity. Pulls actor out of CLS (set
// inside JwtStrategy.validate for user requests; inside cls.run() wrappers
// for scheduled jobs).
//
// Constraints baked in:
//   - D6a: only fires on entity-instance writes (save / softRemove / recover
//     / remove). Repository.update / Repository.delete / QueryBuilder
//     mutations are silent. ESLint rule D6b blocks those at lint time.
//   - Recursion guard: never audit the AuditLog entity itself.
//   - D11a: skip zero-diff updates (afterUpdate where deep-equal before/after).
//     Defensive null check on databaseEntity — fail open with before=null.
//   - D28: snapshots are stripped of sensitive fields; afterRemove writes
//     DELETE (not SOFT_DELETE); no-CLS-user resolves to ANONYMOUS.
@EventSubscriber()
export class AuditSubscriber implements EntitySubscriberInterface {
  async afterInsert(event: InsertEvent<unknown>): Promise<void> {
    if (this.isSkippedEntity(event.metadata.targetName)) return;
    await this.write(event, 'CREATE', null, this.snapshot(event.entity));
  }

  async afterUpdate(event: UpdateEvent<unknown>): Promise<void> {
    if (this.isSkippedEntity(event.metadata.targetName)) return;

    const before = this.snapshot(event.databaseEntity);
    const after = this.snapshot(event.entity);

    // D11a: zero-diff filter. If we have both snapshots and they're equal, skip.
    if (before !== null && this.deepEqual(before, after)) return;

    await this.write(event, 'UPDATE', before, after);
  }

  async afterSoftRemove(event: SoftRemoveEvent<unknown>): Promise<void> {
    if (this.isSkippedEntity(event.metadata.targetName)) return;
    await this.write(event, 'SOFT_DELETE', this.snapshot(event.entity), null);
  }

  async afterRecover(event: RecoverEvent<unknown>): Promise<void> {
    if (this.isSkippedEntity(event.metadata.targetName)) return;
    await this.write(event, 'RESTORE', null, this.snapshot(event.entity));
  }

  // D28: HARD removes (repository.remove(entity)) write DELETE, not
  // SOFT_DELETE. Soft vs hard is a meaningful lifecycle distinction; a
  // reviewer scanning audit_logs can tell recoverable Tickets apart from
  // permanently-removed Comments.
  async afterRemove(event: RemoveEvent<unknown>): Promise<void> {
    if (this.isSkippedEntity(event.metadata.targetName)) return;
    await this.write(
      event,
      'DELETE',
      this.snapshot(event.databaseEntity),
      null,
    );
  }

  private async write(
    event:
      | InsertEvent<unknown>
      | UpdateEvent<unknown>
      | SoftRemoveEvent<unknown>
      | RecoverEvent<unknown>
      | RemoveEvent<unknown>,
    action: AuditAction,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
  ): Promise<void> {
    // Normalize to UPPERCASE to match README contract (e.g., "TICKET").
    const entityType = event.metadata.targetName.toUpperCase();
    const entityId = this.extractId(event);
    const { actor, performedBy } = this.resolveActor();

    const auditRepo = event.manager.getRepository(AuditLog);
    const row = auditRepo.create({
      action,
      entityType,
      entityId,
      performedBy,
      actor,
      before,
      after,
    });
    await auditRepo.save(row);
  }

  // D28 actor resolution. The three legitimate cases:
  //   USER       — CLS has a user object with a real id and ADMIN/DEVELOPER role
  //   SYSTEM     — CLS has user.role === 'SYSTEM' (scheduler wrap)
  //   ANONYMOUS  — no CLS user (public route) OR CLS access failed
  // ANONYMOUS is intentionally distinct from SYSTEM so a reviewer can
  // distinguish "a public registration happened" from "the scheduler ran."
  private resolveActor(): {
    actor: AuditActor;
    performedBy: number | null;
  } {
    try {
      const cls = ClsServiceManager.getClsService();
      const user = cls.get<{ id?: number; role?: string }>('user');
      if (!user) return { actor: 'ANONYMOUS', performedBy: null };
      if (user.role === 'SYSTEM') return { actor: 'SYSTEM', performedBy: null };
      if (
        typeof user.id === 'number' &&
        (user.role === 'ADMIN' || user.role === 'DEVELOPER')
      ) {
        return { actor: 'USER', performedBy: user.id };
      }
      return { actor: 'ANONYMOUS', performedBy: null };
    } catch {
      return { actor: 'ANONYMOUS', performedBy: null };
    }
  }

  // D28: serialize via class-transformer so @Exclude() is honored
  // (e.g. User.passwordHash). Then defensively strip a deny-list of
  // sensitive key names from the result — covers future entities that
  // forget @Exclude.
  private snapshot(entity: unknown): Record<string, unknown> | null {
    if (!entity || typeof entity !== 'object') return null;
    // instanceToPlain runs class-transformer's serialization, which respects
    // @Exclude({ toPlainOnly: true }) and @Exclude().
    const plain = instanceToPlain(entity) as Record<string, unknown>;
    return this.stripSensitive(plain);
  }

  private stripSensitive(
    obj: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) continue;
      out[k] = v;
    }
    return out;
  }

  private deepEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  private extractId(event: {
    entity?: unknown;
    databaseEntity?: unknown;
    entityId?: unknown;
  }): number | null {
    // D28: `repository.remove(entity)` clears `entity.id` after the delete,
    // so for RemoveEvent we have to read `event.entityId` (TypeORM captures
    // it before clearing). Fall back to entity / databaseEntity for the
    // other event types.
    if (typeof event.entityId === 'number') return event.entityId;
    const candidate =
      (event.entity as { id?: unknown }) ??
      (event.databaseEntity as { id?: unknown });
    const id = candidate?.id;
    return typeof id === 'number' ? id : null;
  }

  // D6 + D32: skip list. AuditLog is the recursion guard (audit rows must
  // not themselves produce audit rows). CommentMention is a sub-entity of
  // Comment — the parent Comment's CREATE/UPDATE audit row already captures
  // the mention diff via its content snapshot, so emitting per-mention rows
  // is just noise (5 mentions = 5 redundant rows otherwise).
  private static readonly SKIPPED_ENTITIES = new Set<string>([
    'AuditLog',
    'CommentMention',
  ]);

  private isSkippedEntity(targetName: string | undefined): boolean {
    return (
      targetName !== undefined &&
      AuditSubscriber.SKIPPED_ENTITIES.has(targetName)
    );
  }
}
