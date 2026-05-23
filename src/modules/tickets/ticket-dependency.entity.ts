import { Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Ticket } from './ticket.entity';

// Composite PK: a ticket can be blocked by many others, but each (ticket,
// blocker) pair is unique. Both columns are FKs that CASCADE-delete with
// the underlying tickets (which themselves soft-delete; FK fires only on
// rare hard deletes).
@Entity('ticket_dependencies')
export class TicketDependency {
  @PrimaryColumn({ name: 'ticket_id', type: 'int' })
  ticketId: number;

  @PrimaryColumn({ name: 'blocker_id', type: 'int' })
  blockerId: number;

  @ManyToOne(() => Ticket, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticket_id' })
  ticket: Ticket;

  @ManyToOne(() => Ticket, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'blocker_id' })
  blocker: Ticket;
}
