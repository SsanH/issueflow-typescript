import { BadRequestException } from '@nestjs/common';

// D28 + D35: shared helper for query-string integer parsing on optional
// numeric params. Returns undefined for missing/empty values, throws 400
// for anything that's not a positive integer.
//
// Why not NestJS's ParseIntPipe({ optional: true })? D28 found it finicky
// when combined with @Query() in Nest 10 — bare-string params went through
// inconsistently. Explicit parsing is unambiguous and uniform across
// controllers.
export function parsePositiveInt(
  raw: string | undefined,
  name: string,
): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new BadRequestException(`${name} must be a positive integer`);
  }
  return n;
}
