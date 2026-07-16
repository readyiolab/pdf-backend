import bcrypt from 'bcrypt';
import { getPool } from '../../lib/mysql';
import { env } from '../../config/env';
import { signToken } from '../../lib/jwt';
import { AppError } from '../../middleware/errorHandler.middleware';
import { RegisterInput, LoginInput, AuthResponse } from './auth.types';
import crypto from 'crypto';

export const authService = {
  async register(input: RegisterInput): Promise<AuthResponse> {
    const { email, password, name } = input;
    const pool = getPool();
    const normalizedEmail = email.toLowerCase();

    // 1. Check if user already exists
    const [existingUsers]: any = await pool.query(
      'SELECT id FROM tbl_user WHERE email = ?',
      [normalizedEmail]
    );
    if (existingUsers.length > 0) {
      throw new AppError('Email is already registered', 409);
    }

    // 2. Hash password
    const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);
    const userId = crypto.randomUUID();

    // 3. Create user
    await pool.query(
      'INSERT INTO tbl_user (id, email, passwordHash, name, plan) VALUES (?, ?, ?, ?, ?)',
      [userId, normalizedEmail, passwordHash, name || null, 'FREE']
    );

    // 4. Generate JWT
    const token = signToken({ userId, email: normalizedEmail, plan: 'FREE' });

    return {
      token,
      user: { id: userId, email: normalizedEmail, name: name || null, plan: 'FREE' },
    };
  },

  async login(input: LoginInput): Promise<AuthResponse> {
    const { email, password } = input;
    const pool = getPool();

    // 1. Find user
    const [users]: any = await pool.query(
      'SELECT id, email, passwordHash, name, plan FROM tbl_user WHERE email = ?',
      [email.toLowerCase()]
    );
    const user = users[0];

    if (!user) {
      throw new AppError('Invalid email or password', 401);
    }

    // 2. Verify password
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      throw new AppError('Invalid email or password', 401);
    }

    // 3. Generate JWT
    const token = signToken({ userId: user.id, email: user.email, plan: user.plan });

    return {
      token,
      user: { id: user.id, email: user.email, name: user.name, plan: user.plan },
    };
  },

  /**
   * Creates a real, short-lived anonymous session. Unlike the old client-side
   * "guest" (which registered accounts with weak, guessable passwords), this
   * provisions a server-side user with an unusable random credential and a
   * guest-scoped token. Guest rows use the @guest.local domain for later cleanup.
   */
  async guest(): Promise<AuthResponse> {
    const pool = getPool();
    const userId = crypto.randomUUID();
    const email = `guest-${userId}@guest.local`;
    // Random, unrecoverable hash — guests authenticate only via their token.
    const passwordHash = await bcrypt.hash(
      crypto.randomBytes(32).toString('hex'),
      env.BCRYPT_ROUNDS
    );

    await pool.query(
      'INSERT INTO tbl_user (id, email, passwordHash, name, plan) VALUES (?, ?, ?, ?, ?)',
      [userId, email, passwordHash, 'Guest', 'FREE']
    );

    const token = signToken({ userId, email, plan: 'FREE', isGuest: true });

    return {
      token,
      user: { id: userId, email, name: 'Guest', plan: 'FREE', isGuest: true },
    };
  },
};
