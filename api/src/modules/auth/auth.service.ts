import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { getPool } from '../../lib/mysql';
import { env } from '../../config/env';
import { AppError } from '../../middleware/errorHandler.middleware';
import { RegisterInput, LoginInput, AuthResponse } from './auth.types';
import crypto from 'crypto';

export const authService = {
  async register(input: RegisterInput): Promise<AuthResponse> {
    const { email, password, name } = input;
    const pool = getPool();

    // 1. Check if user already exists
    const [existingUsers]: any = await pool.query('SELECT * FROM tbl_user WHERE email = ?', [email.toLowerCase()]);
    if (existingUsers.length > 0) {
      throw new AppError('Email is already registered', 409);
    }

    // 2. Hash password
    const passwordHash = await bcrypt.hash(password, 10);
    const userId = crypto.randomUUID();

    // 3. Create user
    await pool.query(
      'INSERT INTO tbl_user (id, email, passwordHash, name, plan) VALUES (?, ?, ?, ?, ?)',
      [userId, email.toLowerCase(), passwordHash, name || null, 'FREE']
    );

    // 4. Generate JWT
    const token = jwt.sign(
      { userId, email: email.toLowerCase(), plan: 'FREE' },
      env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return {
      token,
      user: {
        id: userId,
        email: email.toLowerCase(),
        name: name || null,
        plan: 'FREE',
      },
    };
  },

  async login(input: LoginInput): Promise<AuthResponse> {
    const { email, password } = input;
    const pool = getPool();

    // 1. Find user
    const [users]: any = await pool.query('SELECT * FROM tbl_user WHERE email = ?', [email.toLowerCase()]);
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
    const token = jwt.sign(
      { userId: user.id, email: user.email, plan: user.plan },
      env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: user.plan,
      },
    };
  },
};
