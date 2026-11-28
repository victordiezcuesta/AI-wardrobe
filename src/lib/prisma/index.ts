import { neonConfig, type PoolConfig } from "@neondatabase/serverless";
import { PrismaNeon } from "@prisma/adapter-neon";
import ws from "ws";
import { PrismaClient } from "@/generated/prisma/client";

// El driver serverless de Neon usa WebSockets; Node < 22 no trae WebSocket global.
if (typeof WebSocket === "undefined") neonConfig.webSocketConstructor = ws;

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Pool de la app. Sin `connectionTimeoutMillis` el pool del driver espera indefinidamente cuando se agota o la conexión no
 * llega a establecerse, y la petición queda colgada hasta el límite de la función. Con tiempo máximo falla rápido (500 con
 * log) y el pool se recupera. `max` se deja en el valor del driver (10 por proceso) mientras no haya medidas en Neon.
 */
export const APP_POOL_OPTIONS = { connectionTimeoutMillis: 10_000 } as const;

/**
 * Crea un PrismaClient con el adaptador serverless de Neon (WebSocket, pensado para el runtime de Vercel). Cada cliente
 * abre su PROPIO pool al conectar: la app solo debe crear uno por proceso (ver `prisma` más abajo). `pool` permite ajustar
 * ese pool (`max`, `connectionTimeoutMillis`…) y es lo que usan las pruebas de integración.
 */
export function createPrismaClient(connectionString: string, pool: Omit<PoolConfig, "connectionString"> = {}): PrismaClient {
  return new PrismaClient({ adapter: new PrismaNeon({ ...pool, connectionString }) });
}

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL no está definida");
  return createPrismaClient(connectionString, APP_POOL_OPTIONS);
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_t, prop) {
    const client = (globalForPrisma.prisma ??= createClient());
    return Reflect.get(client, prop, client);
  },
});
