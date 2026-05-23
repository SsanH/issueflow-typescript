// PDF §2.4 enums + ordering for the forward-only state machine (D12).
export const TICKET_STATUSES = [
  'TODO',
  'IN_PROGRESS',
  'IN_REVIEW',
  'DONE',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

// D12: lenient forward-only — index(new) > index(current) is OK (skipping
// allowed). index(new) < index(current) is the backward case → 409.
// index(new) === index(current) is the no-op case (D11a) → 200, no audit row.
export const STATUS_ORDER: Record<TicketStatus, number> = {
  TODO: 0,
  IN_PROGRESS: 1,
  IN_REVIEW: 2,
  DONE: 3,
};

export const TICKET_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

// PDF §3.7 auto-escalation: LOW → MEDIUM → HIGH → CRITICAL.
export const PRIORITY_ORDER: Record<TicketPriority, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

export const TICKET_TYPES = ['BUG', 'FEATURE', 'TECHNICAL'] as const;
export type TicketType = (typeof TICKET_TYPES)[number];
