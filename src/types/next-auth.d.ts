import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: { id: string } & DefaultSession["user"];
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    /** Identificador de la sesión individual (fila `Session`, guardada como SHA-256). Nunca se expone al cliente. */
    sid?: string;
  }
}
