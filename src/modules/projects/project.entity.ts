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
import { User } from '../users/user.entity';

@Entity('projects')
export class Project {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 256 })
  name: string;

  @Column({ type: 'text' })
  description: string;

  // ownerId is NOT NULL — every project has an owner. FK uses RESTRICT so a
  // user who still owns a project cannot be hard-deleted (preserves the FK
  // invariant; matches the Phase 1 pattern for comments.authorId).
  @Index()
  @Column({ name: 'owner_id', type: 'int' })
  ownerId: number;

  @ManyToOne(() => User, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'owner_id' })
  owner: User;

  @CreateDateColumn({ ...TIMESTAMPTZ_COLUMN_OPTS, name: 'created_at' })
  createdAt: Date;

  // D23: symmetric with Ticket and Comment, which both track updates.
  // Mutated by save() on every PATCH /projects/:id.
  @UpdateDateColumn({ ...TIMESTAMPTZ_COLUMN_OPTS, name: 'updated_at' })
  updatedAt: Date;

  // PDF §3.5: projects are soft-deleted only. @DeleteDateColumn enables
  // softRemove() / recover() and makes find() automatically exclude rows
  // where deleted_at IS NOT NULL.
  @DeleteDateColumn({ ...TIMESTAMPTZ_COLUMN_OPTS, name: 'deleted_at' })
  deletedAt: Date | null;
}
