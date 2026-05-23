import { IsInt, Min } from 'class-validator';

// README: POST body is { blockedBy }.
export class AddDependencyDto {
  @IsInt()
  @Min(1)
  blockedBy: number;
}
