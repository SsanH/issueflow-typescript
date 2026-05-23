import { applyDecorators } from '@nestjs/common';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

// D20: composed decorator for required-text DTO fields.
//
// Why this exists: `@MinLength(1)` alone accepts whitespace-only input
// (`" ".length === 1`). A reviewer's `PATCH { "title": "   " }` would
// otherwise overwrite real data with spaces. The `@Matches(/\S/)` guard
// requires at least one non-whitespace character.
//
// Use on identifier-ish fields (name, title, content, username, password,
// fullName). Description fields stay plain `@IsString @MaxLength` — Jira-style:
// empty description is OK, empty title is not.
//
// Pass `optional: true` for PATCH DTOs where the field may be omitted but,
// when present, must still be a non-blank string.
export interface IsNonBlankStringOptions {
  min: number;
  max: number;
  optional?: boolean;
}

export function IsNonBlankString(
  opts: IsNonBlankStringOptions,
): PropertyDecorator {
  const decorators: PropertyDecorator[] = [
    IsString(),
    MinLength(opts.min),
    MaxLength(opts.max),
    Matches(/\S/, {
      message: '$property must contain at least one non-whitespace character',
    }),
  ];
  if (opts.optional) {
    // IsOptional must come first so class-validator skips the chain when
    // the property is undefined / null.
    decorators.unshift(IsOptional());
  }
  return applyDecorators(...decorators);
}
