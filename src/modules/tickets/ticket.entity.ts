import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { TIMESTAMPTZ_COLUMN_OPTS } from '../../database/column-opts';
import { Project } from '../projects/project.entity';
import { User } from '../users/user.entity';
import { TicketPriority, TicketStatus, TicketType } from './ticket-enums';

@Entity('tickets')
export class Ticket {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 256 })
  title: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'varchar', length: 16 })
  status: TicketStatus;

  @Column({ type: 'varchar', length: 16 })
  priority: TicketPriority;

  @Column({ type: 'varchar', length: 16 })
  type: TicketType;

  @Index()
  @Column({ name: 'project_id', type: 'int' })
  projectId: number;

  @ManyToOne(() => Project, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'project_id' })
  project: Project;

  // assigneeId is nullable. ON DELETE SET NULL: if the assigned user is
  // hard-deleted, the ticket survives with assigneeId=null (matches the
  // Phase 1 UsersService.remove comment).
  @Index()
  @Column({ name: 'assignee_id', type: 'int', nullable: true })
  assigneeId: number | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'assignee_id' })
  assignee: User | null;

  // D10: timestamptz. Nullable — PDF §3.7 says escalation only applies to
  // tickets that have a dueDate set.
  @Column({ ...TIMESTAMPTZ_COLUMN_OPTS, name: 'due_date', nullable: true })
  dueDate: Date | null;

  // PDF §3.7: set to true once a CRITICAL ticket passes its dueDate.
  // Cleared whenever a user manually changes priority via PATCH.
  @Column({ name: 'is_overdue', type: 'boolean', default: false })
  isOverdue: boolean;

  @CreateDateColumn({ ...TIMESTAMPTZ_COLUMN_OPTS, name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ ...TIMESTAMPTZ_COLUMN_OPTS, name: 'updated_at' })
  updatedAt: Date;

  // PDF §3.5: soft-delete only.
  @DeleteDateColumn({ ...TIMESTAMPTZ_COLUMN_OPTS, name: 'deleted_at' })
  deletedAt: Date | null;
}
