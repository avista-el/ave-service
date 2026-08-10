import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  // Returns true even when no token is present — used for cart/catalog
  // endpoints that work for both guests and authenticated users.
  handleRequest<T>(_err: unknown, user: T): T {
    return user;
  }
}
