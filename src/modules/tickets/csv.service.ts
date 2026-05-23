import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { Repository } from 'typeorm';
import { ProjectsService } from '../projects/projects.service';
import { UsersService } from '../users/users.service';
import { Ticket } from './ticket.entity';
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TYPES,
} from './ticket-enums';

// Documented schema (G2 / D14): 7 columns.
const EXPORT_HEADERS = [
  'id',
  'title',
  'description',
  'status',
  'priority',
  'type',
  'assigneeId',
] as const;
type ExportHeader = (typeof EXPORT_HEADERS)[number];
const HEADER_SET = new Set<string>(EXPORT_HEADERS);

// D35: CSV injection mitigation. Excel / Google Sheets / Numbers all execute
// a cell as a formula if it starts with `=`, `+`, `-`, `@`, TAB, or CR.
// Prefix with `'` (single quote) — the apostrophe is invisible on display
// but neutralizes the formula. OWASP-documented attack class.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
function escapeCsvFormula(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return value;
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

export interface ImportResult {
  created: number;
  failed: number;
  errors: { line: number; reason: string }[];
}

@Injectable()
export class CsvService {
  private readonly logger = new Logger(CsvService.name);

  constructor(
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    private readonly projects: ProjectsService,
    private readonly users: UsersService,
  ) {}

  async export(projectId: number): Promise<string> {
    await this.projects.findById(projectId);
    const rows = await this.tickets.find({ where: { projectId } });
    return stringify(
      rows.map((t) => ({
        // D35: numeric fields stay numeric — only user-supplied strings need
        // the formula-prefix escape.
        id: t.id,
        title: escapeCsvFormula(t.title),
        description: escapeCsvFormula(t.description),
        status: t.status,
        priority: t.priority,
        type: t.type,
        assigneeId: t.assigneeId ?? '',
      })),
      { header: true, columns: [...EXPORT_HEADERS] },
    );
  }

  async import(projectId: number, csv: Buffer): Promise<ImportResult> {
    await this.projects.findById(projectId);

    let records: Record<string, string>[];
    try {
      records = parse(csv, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      });
    } catch (err) {
      return {
        created: 0,
        failed: 0,
        errors: [
          { line: 0, reason: `CSV parse error: ${(err as Error).message}` },
        ],
      };
    }

    if (records.length === 0) {
      return { created: 0, failed: 0, errors: [] };
    }

    // D14: unknown columns silently ignored, log one warning per import.
    const presentHeaders = Object.keys(records[0]);
    const dropped = presentHeaders.filter((h) => !HEADER_SET.has(h));
    if (dropped.length > 0) {
      this.logger.warn(
        `Import (project=${projectId}): ignored columns ${JSON.stringify(dropped)}`,
      );
    }

    const result: ImportResult = { created: 0, failed: 0, errors: [] };
    // Per row implicit txn — partial success is the contract.
    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const line = i + 2; // 1-based + header row
      try {
        const ticket = this.toTicket(projectId, row);
        // Pre-validate assigneeId FK so per-row errors say "User X not found"
        // instead of the raw Postgres FK-violation message. Same posture as
        // TicketsService.create. D24 stance: any role is accepted on manual
        // assignment (CSV import is a manual operation, not auto-assign).
        if (ticket.assigneeId !== null) {
          await this.users.findById(ticket.assigneeId);
        }
        // D6a: save(entity) so subscriber fires for each imported row.
        await this.tickets.save(ticket);
        result.created++;
      } catch (err) {
        result.failed++;
        result.errors.push({
          line,
          reason: (err as Error).message,
        });
      }
    }
    return result;
  }

  private toTicket(projectId: number, row: Record<string, string>): Ticket {
    // D20: hold the import path to the same non-blank rule as the DTO so
    // CSV isn't a back door around validation. csv-parse runs with
    // trim: true, so a whitespace-only value arrives here as "" — we
    // reject it on title/status/priority/type, but allow it on description
    // (Jira-style: ticket with no description is fine).
    const nonBlankRequired: ExportHeader[] = [
      'title',
      'status',
      'priority',
      'type',
    ];
    for (const col of nonBlankRequired) {
      if (!row[col] || row[col].length === 0) {
        throw new Error(`missing or blank required column "${col}"`);
      }
    }
    if (!TICKET_STATUSES.includes(row.status as never)) {
      throw new Error(`invalid status "${row.status}"`);
    }
    if (!TICKET_PRIORITIES.includes(row.priority as never)) {
      throw new Error(`invalid priority "${row.priority}"`);
    }
    if (!TICKET_TYPES.includes(row.type as never)) {
      throw new Error(`invalid type "${row.type}"`);
    }

    const entity = this.tickets.create({
      title: row.title,
      // D20: description may be absent or empty string in the CSV.
      description: row.description ?? '',
      status: row.status as never,
      priority: row.priority as never,
      type: row.type as never,
      projectId, // G2: from form field, applied to every row.
      assigneeId:
        row.assigneeId && row.assigneeId !== '' ? Number(row.assigneeId) : null,
      isOverdue: false,
    });
    return entity;
  }
}
