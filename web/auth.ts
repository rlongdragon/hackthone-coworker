import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db } from "@/db";
import { employees } from "@/db/schema";

// Best-effort brute-force throttle (per process; enough for a single-node
// deploy — swap for Redis if we ever scale out).
const loginFails = new Map<string, { count: number; resetAt: number }>();
const MAX_FAILS = 10;
const LOCK_WINDOW_MS = 15 * 60 * 1000;

function isLockedOut(email: string): boolean {
  const e = loginFails.get(email);
  if (!e) return false;
  if (Date.now() > e.resetAt) {
    loginFails.delete(email);
    return false;
  }
  return e.count >= MAX_FAILS;
}

function recordFailure(email: string): void {
  const e = loginFails.get(email);
  if (!e || Date.now() > e.resetAt) {
    loginFails.set(email, { count: 1, resetAt: Date.now() + LOCK_WINDOW_MS });
  } else {
    e.count += 1;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Short-lived sessions: role/permission checks are DB-fresh (lib/authz.ts),
  // but a stolen cookie should still die quickly.
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (creds) => {
        const email = String(creds?.email ?? "").toLowerCase().trim();
        const password = String(creds?.password ?? "");
        if (!email || !password) return null;
        if (isLockedOut(email)) return null;
        const [u] = await db
          .select()
          .from(employees)
          .where(eq(employees.email, email))
          .limit(1);
        if (!u) {
          recordFailure(email);
          return null;
        }
        const ok = await bcrypt.compare(password, u.passwordHash);
        if (!ok) {
          recordFailure(email);
          return null;
        }
        // Deactivated (departed) accounts can't sign in (FR-P-08 P3).
        if (!u.active) return null;
        loginFails.delete(email);
        return { id: u.id, email: u.email, name: u.name, role: u.role };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id as string;
        token.role = (user as { role?: string }).role;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
      }
      return session;
    },
  },
});
