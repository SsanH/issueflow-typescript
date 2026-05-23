import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AuditAction, AuditActor, AuditLog } from './audit-log.entity';

export interface AuditFilters {
  entityType?: string;
  entityId?: number;
  action?: string;
  actor?: string;
  page?: number;
  pageSize?: number;
}

export interface AuditPage {
  data: AuditLog[];
  total: number;
  page: number;
  pageSize: number;
}

const DEFAULT_PAGE_SIZE = 50;

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLog) private readonly logs: Repository<AuditLog>,
  ) {}

  async list(filters: AuditFilters): Promise<AuditPage> {
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(
      200,
      Math.max(1, filters.pageSize ?? DEFAULT_PAGE_SIZE),
    );

    const qb = this.logs.createQueryBuilder('a').orderBy('a.timestamp', 'DESC');
    if (filters.entityType) {
      qb.andWhere('a.entity_type = :et', { et: filters.entityType });
    }
    if (filters.entityId !== undefined) {
      qb.andWhere('a.entity_id = :eid', { eid: filters.entityId });
    }
    if (filters.action) {
      qb.andWhere('a.action = :act', { act: filters.action });
    }
    if (filters.actor) {
      qb.andWhere('a.actor = :actor', { actor: filters.actor });
    }
    qb.skip((page - 1) * pageSize).take(pageSize);

    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, pageSize };
  }

  // Public API for explicit named events that aren't tied to a single ORM
  // write (AUTO_ASSIGN, PRIORITY_ESCALATED). Used by Phase 6e and 6f.
  //
  // D33: optional EntityManager. When the caller is already inside a
  // transaction (e.g. EscalationService.runOnce), pass the manager so the
  // audit row is part of the same tx — atomic with the ticket UPDATEs.
  // Previously the class-level repo committed the row independently, so a
  // mid-loop rollback left PRIORITY_ESCALATED rows pointing at tickets
  // whose state shows no escalation actually happened.
  async recordSystemAction(
    action: Extract<AuditAction, 'AUTO_ASSIGN' | 'PRIORITY_ESCALATED'>,
    entityType: string,
    entityId: number,
    payload?: Record<string, unknown>,
    manager?: EntityManager,
  ): Promise<void> {
    const actor: AuditActor = 'SYSTEM';
    const repo = manager ? manager.getRepository(AuditLog) : this.logs;
    const row = repo.create({
      action,
      entityType: entityType.toUpperCase(),
      entityId,
      performedBy: null,
      actor,
      before: null,
      after: payload ?? null,
    });
    await repo.save(row);
  }
}
