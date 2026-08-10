import { SetMetadata } from '@nestjs/common';

export type UserRole =
  | 'super_admin'
  | 'merchandiser'
  | 'support_agent'
  | 'customer';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
