import {
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Not, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { Project } from '../projects/project.entity';
import { ProjectsService } from '../projects/projects.service';
import { WorkloadQuery } from '../projects/workload-query';
import { UsersService } from '../users/users.service';
import { DependenciesService } from './dependencies.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { STATUS_ORDER, TicketStatus } from './ticket-enums';
import { Ticket } from './ticket.entity';

// D34: feature tag for the per-project auto-assign advisory lock. Uses the
// pg_advisory_xact_lock(int4, int4) two-arg variant, which lives in a
// separate lock space from the bigint variant used by EscalationService
// (D19) — so escalation and auto-assign can hold locks concurrently without
// any chance of collision.
const AUTO_ASSIGN_LOCK_TAG = 0x1cebf201;

@Injectable()
export class TicketsService {
  constructor(
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly projects: ProjectsService,
    private readonly users: UsersService,
    private readonly workload: WorkloadQuery,
    private readonly audit: AuditService,
    @Inject(forwardRef(() => DependenciesService))
    private readonly dependencies: DependenciesService,
  ) {}

  // D31: project-visibility gate. If the parent project is soft-deleted,
  // the ticket is hidden from non-ADMIN routes. ADMIN routes (listDeleted,
  // restore) bypass this gate explicitly.
  async findByProject(projectId: number): Promise<Ticket[]> {
    // projects.findById auto-filters soft-deleted → 404 propagates.
    await this.projects.findById(projectId);
    return this.tickets.find({ where: { projectId } });
  }

  // D31: chokepoint for "is this ticket visible right now."
  // Two queries: load the ticket (auto-filters its own soft-delete), then
  // load the parent project (also auto-filters). Either gone → 404 with
  // the SAME message ("Ticket not found"), so we don't leak parent state.
  async findById(id: number): Promise<Ticket> {
    const t = await this.tickets.findOne({ where: { id } });
    if (!t) throw new NotFoundException(`Ticket ${id} not found`);
    const project = await this.dataSource
      .getRepository(Project)
      .findOne({ where: { id: t.projectId } });
    if (!project) throw new NotFoundException(`Ticket ${id} not found`);
    return t;
  }

  async create(dto: CreateTicketDto): Promise<Ticket> {
    // Validate FKs before insert so the user gets a clear 404 instead of a
    // generic DB constraint error.
    await this.projects.findById(dto.projectId);

    // D24 tri-state: undefined → auto-assign (transactional, see D34);
    // null → explicit unassigned; numeric → assign as supplied (any role,
    // manual assignment is not DEVELOPER-restricted per strict-scope §3.8).
    if (dto.assigneeId === undefined) {
      return this.createWithAutoAssign(dto);
    }
    if (dto.assigneeId !== null) {
      await this.users.findById(dto.assigneeId);
    }
    const entity = this.tickets.create({
      title: dto.title,
      description: dto.description,
      status: dto.status,
      priority: dto.priority,
      type: dto.type,
      projectId: dto.projectId,
      assigneeId: dto.assigneeId,
      dueDate: dto.dueDate ?? null,
      isOverdue: false,
    });
    // D6a: save(entity) so AuditSubscriber fires (afterInsert → CREATE).
    return this.tickets.save(entity);
  }

  // D34: auto-assign path is wrapped in a transaction with a per-project
  // Postgres advisory lock so concurrent POSTs (no assigneeId) against the
  // same project serialize and pick distinct candidates. The two-int variant
  // pg_advisory_xact_lock(int4, int4) uses a separate lock space from the
  // bigint variant the escalation cron uses (D19) — no collision.
  // Different projects don't contend.
  private async createWithAutoAssign(dto: CreateTicketDto): Promise<Ticket> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [
        AUTO_ASSIGN_LOCK_TAG,
        dto.projectId,
      ]);

      // Workload query goes through `manager` so it sees the post-lock,
      // post-prior-tx-commit snapshot.
      const candidates = await this.workload.forProject(dto.projectId, manager);
      const assigneeId = candidates.length > 0 ? candidates[0].userId : null;
      const autoAssigned = assigneeId !== null;

      const entity = manager.create(Ticket, {
        title: dto.title,
        description: dto.description,
        status: dto.status,
        priority: dto.priority,
        type: dto.type,
        projectId: dto.projectId,
        assigneeId,
        dueDate: dto.dueDate ?? null,
        isOverdue: false,
      });
      // D6a: save(entity) on the manager-bound repo so the subscriber
      // fires inside the transaction.
      const saved = await manager.save(entity);

      if (autoAssigned && saved.assigneeId !== null) {
        // D33 + D34: AUTO_ASSIGN audit row goes through the same manager
        // so it's atomic with the ticket insert.
        await this.audit.recordSystemAction(
          'AUTO_ASSIGN',
          'Ticket',
          saved.id,
          { assigneeId: saved.assigneeId },
          manager,
        );
      }

      return saved;
    });
  }

  // D2: pessimistic lock on PATCH. Two concurrent PATCHes serialize on
  // `SELECT ... FOR UPDATE` — the second observes the result of the first
  // and re-validates state-machine rules (DONE-is-terminal, forward-only).
  async update(id: number, dto: UpdateTicketDto): Promise<Ticket> {
    return this.dataSource.transaction(async (manager) => {
      // ─── 1. LOAD + LOCK ───────────────────────────────────────────────
      const ticket = await manager.findOne(Ticket, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!ticket) throw new NotFoundException(`Ticket ${id} not found`);

      // D31: parent-project-visibility gate, same isolation as the locked
      // ticket. Same 404 message — don't leak whether the project exists.
      const project = await manager.findOne(Project, {
        where: { id: ticket.projectId },
      });
      if (!project) throw new NotFoundException(`Ticket ${id} not found`);

      // ─── 2. VALIDATE EVERYTHING (no mutations yet, D24) ───────────────
      // D11: DONE is terminal — reject any PATCH on a DONE ticket. 409.
      if (ticket.status === 'DONE') {
        throw new ConflictException(
          'Ticket is DONE — no further updates allowed',
        );
      }

      // D12: status transition is forward-only with skipping. Same status
      // is a no-op (subscriber's zero-diff filter D11a drops the audit row).
      const willChangeStatus =
        dto.status !== undefined && dto.status !== ticket.status;
      if (willChangeStatus) {
        this.assertForwardTransition(ticket.status, dto.status as TicketStatus);
        // PDF §3.2 + D29: cannot transition to DONE while any blocker is
        // non-DONE. Pass the transaction's manager so the blocker check
        // sees the same isolation snapshot as the locked ticket — and
        // serializes with DependenciesService.add (which locks the parent
        // ticket too, closing the "add-dep + transition-DONE" race window).
        if (dto.status === 'DONE') {
          const blocked = await this.dependencies.hasUnresolvedBlockers(
            ticket.id,
            manager,
          );
          if (blocked) {
            throw new ConflictException(
              `Cannot transition ticket ${ticket.id} to DONE while it has unresolved blockers`,
            );
          }
        }
      }

      // D24: validate the FK BEFORE any mutation. assigneeId is tri-state:
      //   undefined → leave untouched
      //   null      → set to null (no FK to validate)
      //   numeric   → assert the user exists (any role; manual assignment
      //               is not DEVELOPER-restricted, per PDF §3.8 scope).
      if (dto.assigneeId !== undefined && dto.assigneeId !== null) {
        await this.users.findById(dto.assigneeId);
      }

      // ─── 3. MUTATE (all checks above passed) ──────────────────────────
      if (willChangeStatus) ticket.status = dto.status as TicketStatus;

      // PDF §3.7: manual priority change clears isOverdue.
      if (dto.priority !== undefined && dto.priority !== ticket.priority) {
        ticket.priority = dto.priority;
        ticket.isOverdue = false;
      }

      if (dto.title !== undefined) ticket.title = dto.title;
      if (dto.description !== undefined) ticket.description = dto.description;
      if (dto.assigneeId !== undefined) ticket.assigneeId = dto.assigneeId;
      if (dto.dueDate !== undefined) {
        ticket.dueDate = dto.dueDate;
        // D33: manual dueDate change resets the auto-escalation state, by
        // symmetry with PDF §3.7's priority-change reset. Without this, a
        // ticket that was marked overdue (isOverdue=true at CRITICAL) and
        // whose dueDate is then moved to the future keeps isOverdue=true
        // forever — the next escalation pass doesn't pick it up because
        // its WHERE clause requires dueDate < now(). Clearing here lets
        // the next pass re-derive from the new state.
        ticket.isOverdue = false;
      }

      // ─── 4. SAVE ──────────────────────────────────────────────────────
      // D6a + D11a: save(entity); subscriber filters zero-diff.
      return manager.save(ticket);
    });
  }

  private assertForwardTransition(
    current: TicketStatus,
    next: TicketStatus,
  ): void {
    if (STATUS_ORDER[next] < STATUS_ORDER[current]) {
      // D12 + D11: backward → 409.
      throw new ConflictException(
        `Backward status transition not allowed: ${current} → ${next}`,
      );
    }
    // STATUS_ORDER[next] === STATUS_ORDER[current] is the no-op case; never
    // reached here (caller filters same-status before invoking).
  }

  async softDelete(id: number): Promise<void> {
    const ticket = await this.findById(id);
    // D29: cascade-clean ticket_dependencies rows where this ticket appears
    // as ticketId OR blockerId. Pair atomically with the softRemove so a
    // failure in either rolls back both. Dep rows aren't audited
    // individually — the parent ticket's SOFT_DELETE row in audit_logs
    // captures the intent. The DELETE uses raw query because TicketDependency
    // is a join table without an entity-instance lifecycle worth auditing.
    await this.dataSource.transaction(async (manager) => {
      // eslint-disable-next-line no-restricted-syntax -- raw delete on a non-audited join table; D29 documented
      await manager.query(
        'DELETE FROM ticket_dependencies WHERE ticket_id = $1 OR blocker_id = $1',
        [id],
      );
      // D6a: softRemove(entity) on the manager-bound repo so the subscriber
      // fires with the transaction's actor + the row is locked under the
      // same isolation snapshot as the dep delete above.
      await manager.softRemove(ticket);
    });
  }

  // ADMIN only per D13.
  listDeleted(projectId: number): Promise<Ticket[]> {
    return this.tickets.find({
      withDeleted: true,
      where: { projectId, deletedAt: Not(IsNull()) },
    });
  }

  // ADMIN only per D13.
  async restore(id: number): Promise<Ticket> {
    const ticket = await this.tickets.findOne({
      where: { id },
      withDeleted: true,
    });
    if (!ticket) throw new NotFoundException(`Ticket ${id} not found`);
    if (!ticket.deletedAt) {
      throw new BadRequestException(`Ticket ${id} is not deleted`);
    }
    // D31: reject restore if the parent project is still soft-deleted.
    // Restoring a child while the parent is hidden creates the invariant
    // violation "live ticket inside a deleted project" — force the ADMIN
    // to restore the project first.
    const parent = await this.dataSource
      .getRepository(Project)
      .findOne({ where: { id: ticket.projectId } });
    if (!parent) {
      throw new ConflictException(
        `Cannot restore ticket ${id}: parent project is soft-deleted; restore the project first`,
      );
    }
    return this.tickets.recover(ticket);
  }
}
