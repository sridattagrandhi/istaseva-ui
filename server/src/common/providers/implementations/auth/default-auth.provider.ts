import jwt from 'jsonwebtoken';
import type { IAuthProvider, AuthenticatedPrincipal } from '../../interfaces/auth-provider.interface.js';
import { config } from '../../../config/index.js';

export class DefaultAuthProvider implements IAuthProvider {
  async verifyAccessToken(token: string): Promise<AuthenticatedPrincipal> {
    const decoded = jwt.verify(token, config.auth.jwt.secret) as any;
    return {
      id: decoded.sub || decoded.id,
      email: decoded.email,
      role: decoded.role || decoded['custom:role'],
      name: decoded.name || decoded.displayName,
    };
  }
}

export const defaultAuthProvider = new DefaultAuthProvider();
