import type { NextAuthConfig } from "next-auth";

/** Configuración compatible con edge (sin Prisma): la usa el proxy para proteger rutas. */
export const authConfig = {
  pages: { signIn: "/login" },
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 14 },
  providers: [],
  callbacks: {
    authorized({ auth, request }) {
      const path = request.nextUrl.pathname;
      const isPublic = ["/login", "/register", "/forgot-password", "/reset-password", "/verify-email"].some((p) => path.startsWith(p));
      if (path === "/") return true;
      if (isPublic) return true;
      return !!auth?.user;
    },
    jwt({ token, user }) {
      if (user?.id) token.sub = user.id;
      return token;
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
} satisfies NextAuthConfig;
