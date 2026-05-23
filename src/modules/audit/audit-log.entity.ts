import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { TIMESTAMPTZ_COLUMN_OPTS } from '../../database/column-opts';

export type AuditAction =
  | 'CREATE'
  | 'UPDATE'
  | 'SOFT_DELETE' // soft-delete via @DeleteDateColumn (Project, Ticket)
  | 'DELETE' // hard-delete via repository.remove() (User, Comment, Attachment, etc.)
  | 'RESTORE'
  | 'AUTO_ASSIGN'
  | 'PRIORITY_ESCALATED';

// D28 actor semantics:
//   USER       — CLS has a real user (id + ADMIN/DEVELOPER role)
//   SYSTEM     — CLS has user.role === 'SYSTEM' (scheduler/auto-assign wrap)
//                OR an explicit AuditService.recordSystemAction call
//   ANONYMOUS  — no CLS user (public-route caller, e.g. POST /users)
//                OR any path where CLS context was lost
export type AuditActor = 'USER' | 'SYSTEM' | 'ANONYMOUS';

@Entity('audit_logs')
@Index(['entityType', 'entityId'])
@Index(['action'])
export class AuditLog {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 32 })
  action: AuditAction;

  @Column({ name: 'entity_type', type: 'varchar', length: 64 })
  entityType: string;

  @Column({ name: 'entity_id', type: 'int', nullable: true })
  entityId: number | null;

  @Column({ name: 'performed_by', type: 'int', nullable: true })
  performedBy: number | null;

  @Column({ type: 'varchar', length: 16 })
  actor: AuditActor;

  @Column({ type: 'jsonb', nullable: true })
  before: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  after: Record<string, unknown> | null;

  @CreateDateColumn({ ...TIMESTAMPTZ_COLUMN_OPTS, name: 'timestamp' })
  timestamp: Date;
}
