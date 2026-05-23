import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { TIMESTAMPTZ_COLUMN_OPTS } from '../../database/column-opts';
import { Ticket } from '../tickets/ticket.entity';
import { User } from '../users/user.entity';

@Entity('comments')
export class Comment {
  @PrimaryGeneratedColumn()
  id: number;

  // Comments cascade-delete with their ticket (hard delete only ever happens
  // via raw SQL since tickets soft-delete; CASCADE is the defensive default).
  @Index()
  @Column({ name: 'ticket_id', type: 'int' })
  ticketId: number;

  @ManyToOne(() => Ticket, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'ticket_id' })
  ticket: Ticket;

  // RESTRICT: a user with any comment cannot be hard-deleted — preserves
  // authorship (matches Phase 1 UsersService.remove FK contract).
  @Index()
  @Column({ name: 'author_id', type: 'int' })
  authorId: number;

  @ManyToOne(() => User, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'author_id' })
  author: User;

  @Column({ type: 'text' })
  content: string;

  @CreateDateColumn({ ...TIMESTAMPTZ_COLUMN_OPTS, name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ ...TIMESTAMPTZ_COLUMN_OPTS, name: 'updated_at' })
  updatedAt: Date;
}
