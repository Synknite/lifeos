import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { type Database, schema } from '@lifeos/db';
import { isValidTimeZone } from '@lifeos/domain';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ConflictError, isUniqueViolation, UnauthorizedError, ValidationError } from './errors.js';

const { users, sessions } = schema;

export const signupSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(10, 'Password must be at least 10 characters').max(200),
  displayName: z.string().trim().min(1).max(80),
  timezone: z.string().default('UTC'),
});
export type SignupInput = z.input<typeof signupSchema>;

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
});

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  timezone: z.string().optional(),
  briefingEnabled: z.boolean().optional(),
  briefingTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM')
    .optional(),
});

export const userSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  timezone: z.string(),
  briefingEnabled: z.boolean(),
  briefingTime: z.string(),
});
export type User = z.infer<typeof userSchema>;

// OWASP-recommended argon2id parameters (19 MiB, t=2).
const ARGON_OPTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
// Verified against when the email is unknown, to keep login timing uniform.
const DUMMY_HASH = await hash('timing-equalizer', ARGON_OPTS);

function toUser(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    timezone: row.timezone,
    briefingEnabled: row.briefingEnabled,
    briefingTime: row.briefingTime,
  };
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly sessionTtlDays = 30,
  ) {}

  async signup(input: SignupInput): Promise<User> {
    const data = signupSchema.parse(input);
    if (!isValidTimeZone(data.timezone)) throw new ValidationError(`Unknown timezone "${data.timezone}"`);
    try {
      const [row] = await this.db
        .insert(users)
        .values({
          email: data.email.toLowerCase(),
          passwordHash: await hash(data.password, ARGON_OPTS),
          displayName: data.displayName,
          timezone: data.timezone,
        })
        .returning();
      return toUser(row!);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('An account with that email already exists');
      throw err;
    }
  }

  async verifyCredentials(email: string, password: string): Promise<User> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
    const ok = await verify(row?.passwordHash ?? DUMMY_HASH, password);
    if (!row || !ok) throw new UnauthorizedError('Invalid email or password');
    return toUser(row);
  }

  async createSession(userId: string, meta: { userAgent?: string; ip?: string } = {}) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.sessionTtlDays * 86_400_000);
    await this.db.insert(sessions).values({
      id: hashToken(token),
      userId,
      expiresAt,
      userAgent: meta.userAgent?.slice(0, 300),
      ip: meta.ip,
    });
    return { token, expiresAt };
  }

  /**
   * Resolve a session token to its user. Sessions slide: once less than half
   * the TTL remains, expiry is pushed out and `renewedUntil` is returned so the
   * caller can refresh the cookie.
   */
  async validateSession(token: string): Promise<{ user: User; renewedUntil?: Date } | null> {
    const id = hashToken(token);
    const [row] = await this.db
      .select({ user: users, expiresAt: sessions.expiresAt })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())));
    if (!row) return null;

    const ttlMs = this.sessionTtlDays * 86_400_000;
    if (row.expiresAt.getTime() - Date.now() < ttlMs / 2) {
      const renewedUntil = new Date(Date.now() + ttlMs);
      await this.db.update(sessions).set({ expiresAt: renewedUntil }).where(eq(sessions.id, id));
      return { user: toUser(row.user), renewedUntil };
    }
    return { user: toUser(row.user) };
  }

  async revokeSession(token: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.id, hashToken(token)));
  }

  async purgeExpiredSessions(): Promise<number> {
    const rows = await this.db
      .delete(sessions)
      .where(lt(sessions.expiresAt, new Date()))
      .returning({ id: sessions.id });
    return rows.length;
  }

  async getUser(userId: string): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId));
    return row ? toUser(row) : null;
  }

  async updateProfile(userId: string, input: z.input<typeof updateProfileSchema>): Promise<User> {
    const data = updateProfileSchema.parse(input);
    if (data.timezone && !isValidTimeZone(data.timezone)) {
      throw new ValidationError(`Unknown timezone "${data.timezone}"`);
    }
    const [row] = await this.db.update(users).set(data).where(eq(users.id, userId)).returning();
    return toUser(row!);
  }
}
