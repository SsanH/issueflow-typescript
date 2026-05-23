import {
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { Project } from '../projects/project.entity';
import { Ticket } from './ticket.entity';
import { TicketDependency } from './ticket-dependency.entity';
import { TicketsService } from './tickets.service';

// Stripped shape per README (G4) — just id, title, status.
export interface DependencyView {
  id: number;
  title: string;
  status: string;
}

@Injectable()
export class DependenciesService {
  constructor(
    @InjectRepository(TicketDependency)
    private readonly deps: Repository<TicketDependency>,
    @InjectRepository(Ticket)
    private readonly tickets: Repository<Ticket>,
    @InjectDataSource() private readonly dataSource: DataSource,
    // D31: forwardRef because TicketsService already forwardRefs back to us.
    @Inject(forwardRef(() => TicketsService))
    private readonly ticketsService: TicketsService,
  ) {}

  // D29: wrap add in a transaction that takes a pessimistic_write lock on
  // the parent ticket first. Concurrent "add a dep to X" + "transition X to
  // DONE" both lock X and serialize — no race window where the DONE check
  // sees no blockers while a new dep is being inserted in another tx.
  async add(ticketId: number, blockerId: number): Promise<void> {
    if (ticketId === blockerId) {
      throw new ConflictException('A ticket cannot block itself');
    }

    await this.dataSource.transaction(async (manager) => {
      // Lock the parent ticket. Serializes against TicketsService.update.
      const ticket = await manager.findOne(Ticket, {
        where: { id: ticketId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!ticket) {
        throw new NotFoundException(`Ticket ${ticketId} not found`);
      }
      // D31: parent-project-visibility check inside the same transaction.
      // Same 404 message ("Ticket not found") — don't leak whether the
      // project exists.
      const ticketProject = await manager.findOne(Project, {
        where: { id: ticket.projectId },
      });
      if (!ticketProject) {
        throw new NotFoundException(`Ticket ${ticketId} not found`);
      }

      // Blocker just needs to exist + be in the same project. No lock needed
      // (the blocker's own write paths don't touch dependency rows for
      // ticketId).
      const blocker = await manager.findOne(Ticket, {
        where: { id: blockerId },
      });
      if (!blocker) {
        throw new NotFoundException(`Ticket ${blockerId} not found`);
      }
      // D31: blocker's parent project must also be visible. Same shape.
      const blockerProject = await manager.findOne(Project, {
        where: { id: blocker.projectId },
      });
      if (!blockerProject) {
        throw new NotFoundException(`Ticket ${blockerId} not found`);
      }
      if (ticket.projectId !== blocker.projectId) {
        throw new ConflictException(
          'Dependencies must connect tickets in the same project',
        );
      }

      // D29: cycle check via single recursive CTE — O(1) round-trips
      // regardless of dependency-graph depth.
      if (await this.wouldCreateCycle(ticketId, blockerId, manager)) {
        throw new ConflictException(
          `Dependency would create a cycle (ticket ${blockerId} already transitively depends on ${ticketId})`,
        );
      }

      const depsRepo = manager.getRepository(TicketDependency);
      const existing = await depsRepo.findOne({
        where: { ticketId, blockerId },
      });
      if (existing) return; // idempotent

      // D6a: save(entity) on manager-scoped repo so subscriber fires inside
      // the transaction.
      await depsRepo.save(depsRepo.create({ ticketId, blockerId }));
    });
  }

  // D29: dep rows are cascade-cleaned on ticket soft-delete (see
  // TicketsService.softDelete), so list reflects the dep table verbatim.
  // No need to filter soft-deleted blockers here — they no longer have
  // dep rows pointing at them.
  //
  // D31: route through ticketsService.findById so the project-visibility
  // gate fires uniformly.
  async list(ticketId: number): Promise<DependencyView[]> {
    await this.ticketsService.findById(ticketId);

    const rows = await this.deps.find({ where: { ticketId } });
    if (rows.length === 0) return [];

    const blockerIds = rows.map((r) => r.blockerId);
    const blockers = await this.tickets.find({
      where: { id: In(blockerIds) },
    });
    return blockers.map((b) => ({
      id: b.id,
      title: b.title,
      status: b.status,
    }));
  }

  async remove(ticketId: number, blockerId: number): Promise<void> {
    // D31: project-visibility gate via the chokepoint.
    await this.ticketsService.findById(ticketId);

    const row = await this.deps.findOne({
      where: { ticketId, blockerId },
    });
    if (!row) {
      throw new NotFoundException(
        `Dependency (${ticketId} blocked by ${blockerId}) not found`,
      );
    }
    // D6a: remove(entity) so subscriber fires.
    await this.deps.remove(row);
  }

  // D29: accepts an optional EntityManager. When called from inside a
  // transaction (TicketsService.update locking the ticket), pass the
  // manager so the read sees the transaction's snapshot — same isolation
  // as the locked ticket update. Soft-deleted blockers count as resolved
  // (cascade-clean keeps dep rows in sync with visible tickets, but we
  // defensively filter on status here too in case any stale row exists).
  async hasUnresolvedBlockers(
    ticketId: number,
    manager?: EntityManager,
  ): Promise<boolean> {
    const depsRepo = manager
      ? manager.getRepository(TicketDependency)
      : this.deps;
    const ticketsRepo = manager ? manager.getRepository(Ticket) : this.tickets;

    const rows = await depsRepo.find({ where: { ticketId } });
    if (rows.length === 0) return false;
    const blockerIds = rows.map((r) => r.blockerId);
    // Default find filters soft-deleted; that matches D29 "deleted = resolved".
    const blockers = await ticketsRepo.find({
      where: { id: In(blockerIds) },
    });
    return blockers.some((b) => b.status !== 'DONE');
  }

  // D29: cycle check as a single recursive CTE. One query, O(graph-size)
  // server-side instead of O(graph-size) round-trips.
  //
  // Logic: starting from blockerId, walk the "what does this transitively
  // depend on" graph. If we reach ticketId, adding the edge would close a
  // cycle.
  private async wouldCreateCycle(
    ticketId: number,
    blockerId: number,
    manager?: EntityManager,
  ): Promise<boolean> {
    const runner = manager ?? this.dataSource;
    const rows: { hit: number }[] = await runner.query(
      `
        WITH RECURSIVE downstream AS (
          SELECT blocker_id FROM ticket_dependencies WHERE ticket_id = $1
          UNION
          SELECT d.blocker_id
            FROM ticket_dependencies d
            JOIN downstream ds ON d.ticket_id = ds.blocker_id
        )
        SELECT 1 AS hit FROM downstream WHERE blocker_id = $2 LIMIT 1
      `,
      [blockerId, ticketId],
    );
    return rows.length > 0;
  }
}

// Used by TicketsService.update when status === 'DONE' to enforce
// blocker-resolution per PDF §3.2. Kept here so the dependency rule stays
// owned by the dependencies module.
export class TicketHasUnresolvedBlockersError extends ConflictException {
  constructor(ticketId: number) {
    super(
      `Cannot transition ticket ${ticketId} to DONE while it has unresolved blockers`,
    );
  }
}

// Helper for symmetry with the rest of the codebase — throws BadRequest if
// someone passes a non-positive ID via path. Currently unused but available.
export function assertPositiveId(id: number, name: string): void {
  if (!Number.isInteger(id) || id < 1) {
    throw new BadRequestException(`${name} must be a positive integer`);
  }
}
