import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { TIMESTAMPTZ_COLUMN_OPTS } from '../../database/column-opts';
import { Ticket } from '../tickets/ticket.entity';

@Entity('attachments')
export class Attachment {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ name: 'ticket_id', type: 'int' })
  ticketId: number;

  @ManyToOne(() => Ticket, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'ticket_id' })
  ticket: Ticket;

  @Column({ type: 'varchar', length: 256 })
  filename: string;

  @Column({ name: 'content_type', type: 'varchar', length: 64 })
  contentType: string;

  @Column({ name: 'size_bytes', type: 'int' })
  sizeBytes: number;

  @Column({ name: 'storage_path', type: 'varchar', length: 512 })
  storagePath: string;

  @CreateDateColumn({ ...TIMESTAMPTZ_COLUMN_OPTS, name: 'created_at' })
  createdAt: Date;
}
