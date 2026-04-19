import { UserRole } from '../../user/user.entity';

export interface AuthenticatedUser {
  sub: string;
  email: string;
  role: UserRole;
}
