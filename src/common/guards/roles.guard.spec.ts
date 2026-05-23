import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

// D23: RolesGuard authorizes only; missing user → 401, not 403.
// Unit test because the end-to-end stack always runs JwtAuthGuard first,
// so req.user is never realistically missing in an e2e scenario. This
// pins the semantic against a future guard reorder.
describe('RolesGuard (D23)', () => {
  function makeGuard(requiredRoles: string[] | undefined): {
    guard: RolesGuard;
    context: (user: unknown) => ExecutionContext;
  } {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(requiredRoles);
    const guard = new RolesGuard(reflector);
    const context = (user: unknown): ExecutionContext =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ user }),
          getResponse: () => ({}),
          getNext: () => ({}),
        }),
        getHandler: () => () => undefined,
        getClass: () => class {},
      }) as unknown as ExecutionContext;
    return { guard, context };
  }

  it('passes through when no @Roles metadata is set', () => {
    const { guard, context } = makeGuard(undefined);
    expect(guard.canActivate(context({ role: 'DEVELOPER' }))).toBe(true);
  });

  it('passes through when the @Roles array is empty', () => {
    const { guard, context } = makeGuard([]);
    expect(guard.canActivate(context({ role: 'DEVELOPER' }))).toBe(true);
  });

  it('throws UnauthorizedException (401) when req.user is missing', () => {
    const { guard, context } = makeGuard(['ADMIN']);
    expect(() => guard.canActivate(context(undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it('throws ForbiddenException (403) when user role does not match', () => {
    const { guard, context } = makeGuard(['ADMIN']);
    expect(() => guard.canActivate(context({ role: 'DEVELOPER' }))).toThrow(
      ForbiddenException,
    );
  });

  it('returns true when user role matches required', () => {
    const { guard, context } = makeGuard(['ADMIN']);
    expect(guard.canActivate(context({ role: 'ADMIN' }))).toBe(true);
  });
});
