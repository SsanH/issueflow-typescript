import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Ticket } from '../tickets/ticket.entity';
import { User } from '../users/user.entity';

export interface WorkloadRow {
  userId: number;
  username: string;
  openTicketCount: number;
}

// §6e (Polish B): single helper used by both auto-assign and
// GET /projects/:id/workload to prevent drift between the two paths.
// D17 + G1: DEVELOPER-only candidate pool, per-project open-ticket count,
// ordered by (count ASC, created_at ASC, id ASC).
// D34: accepts an optional EntityManager — when called from inside a
// transaction (TicketsService.create's auto-assign branch), the lookup
// runs through the same connection and reads the post-lock snapshot.
@Injectable()
export class WorkloadQuery {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
  ) {}

  async forProject(
    projectId: number,
    manager?: EntityManager,
  ): Promise<WorkloadRow[]> {
    // LEFT JOIN: include DEVELOPERs with zero open tickets in this project.
    // Filter on the join condition (not WHERE) so users with no rows still
    // appear with count = 0.
    const runner = manager ?? this.users.manager;
    const rows: {
      user_id: string;
      username: string;
      open_count: string;
    }[] = await runner.query(
      `
        SELECT u.id          AS user_id,
               u.username    AS username,
               COUNT(t.id)::text AS open_count
          FROM users u
          LEFT JOIN tickets t
                 ON t.assignee_id = u.id
                AND t.project_id = $1
                AND t.status != 'DONE'
                AND t.deleted_at IS NULL
         WHERE u.role = 'DEVELOPER'
      GROUP BY u.id, u.username, u.created_at
      ORDER BY open_count ASC, u.created_at ASC, u.id ASC
      `,
      [projectId],
    );

    return rows.map((r) => ({
      userId: Number(r.user_id),
      username: r.username,
      openTicketCount: Number(r.open_count),
    }));
  }
}
