import type { NextAuthConfig } from "next-auth";

/**
 * 401 de las rutas /api/* sin sesión, con el mismo formato que `toResponse(unauthorized())` de src/lib/errors
 * (un test comprueba que coinciden). Se construye aquí, sin importar ese módulo, para mantener el proxy ligero y edge.
 */
export function apiUnauthorizedResponse(): Response {
  return Response.json(
    { error: { code: "UNAUTHORIZED", message: "No autenticado" } },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

/** Configuración compatible con edge (sin Prisma): la usa el proxy para proteger rutas. */
export const authConfig = {
  pages: { signIn: "/login" },
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 14 },
  providers: [],
  callbacks: {
    /**
     * Sin sesión: las páginas redirigen a /login (devolver false) y las APIs responden 401 JSON (devolver una Response,
     * que next-auth respeta tal cual en lugar de redirigir). El proxy solo comprueba el JWT; una sesión revocada pasa
     * esta barrera y la rechaza `requireUserId()` en el Route Handler con el mismo 401.
     */
    authorized({ auth, request }) {
      const path = request.nextUrl.pathname;
      const isPublic = ["/login", "/register", "/forgot-password", "/reset-password", "/verify-email"].some((p) => path.startsWith(p));
      if (path === "/") return true;
      if (isPublic) return true;
      if (auth?.user) return true;
      return path.startsWith("/api/") ? apiUnauthorizedResponse() : false;
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
