import { Prisma } from "@/generated/prisma/client";
import { parseOpaqueAssetId, type DetailedDetection, type MediaCandidate } from "@/services/media-reconcile.service";

/**
 * Fase 19.6.3 — persistencia del ciclo de vida de MediaAsset a partir de una detección COMPLETA.
 *
 * Se ejecuta SOLO con el cliente transaccional que recibe (el de `finishWith`): o se guardan todos los cambios y la
 * ejecución se cierra COMPLETED, o se deshace todo. No adquiere, renueva ni libera el lease, no borra nada de Cloudinary
 * y nunca borra filas (CLEARED las conserva).
 *
 * Orden de bloqueos (el mismo que accountService.delete: User → MediaAsset):
 *   lock → ejecución (los vuelve a bloquear y valida el lease: dentro de finishWith ya son suyos) → propietarios (FOR KEY SHARE, ordenados) → filas de MediaAsset (FOR UPDATE, ordenadas
 *   por delivery y publicId) → escrituras por lotes.
 * Con los propietarios bloqueados, una cuenta no puede borrarse a mitad: si el borrado llegó antes, se espera a que
 * termine y su usuario ya no existe; si llega después, espera a esta transacción y elimina también las filas nuevas.
 */

export const MAX_CANDIDATES = 10_000;
export const BATCH_SIZE = 500;
const INT4_MAX = 2_147_483_647;

export type MediaAssetErrorCode =
  | "INVALID_ARGUMENT" | "INCOMPLETE_DETECTION" | "TOO_MANY_CANDIDATES" | "RUN_NOT_ACTIVE" | "STALE_RUN" | "CONCURRENT_MODIFICATION";
/** Errores propios (mensajes sin identificadores). Los de PostgreSQL se propagan tal cual: nunca se ocultan. */
export class MediaAssetError extends Error {
  constructor(readonly code: MediaAssetErrorCode) { super(`Persistencia de MediaAsset: ${code}`); this.name = "MediaAssetError"; }
}

type Tx = Prisma.TransactionClient;
type Delivery = "UPLOAD" | "AUTHENTICATED";
type Kind = "WARDROBE" | "PERSONAL" | "TRY_ON";
export type AssetState = "CANDIDATE" | "CONFIRMED" | "CLEARED";

const NOW = Prisma.sql`(clock_timestamp() AT TIME ZONE 'UTC')`;
const utc = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
const DELIVERY: Record<MediaCandidate["delivery"], Delivery> = { upload: "UPLOAD", authenticated: "AUTHENTICATED" };
const KIND: Record<MediaCandidate["kind"], Kind> = { wardrobe: "WARDROBE", personal: "PERSONAL", "try-on": "TRY_ON" };
/** Mismo formato que exige la base de datos (MediaAsset_publicId_check y el detector). */
const PATH = /^ai-wardrobe\/([A-Za-z0-9-][A-Za-z0-9_-]{0,63})\/(wardrobe|personal|try-on)\/[^/]+$/;

/** Candidata validada, con los valores de la base de datos. */
export interface AssetObservation {
  publicId: string; delivery: Delivery; kind: Kind; ownerUserId: string; assetId: string;
  version: number | null; bytes: number | null; format: string | null; resourceCreatedAt: Date;
  /** Lo que vio el detector (la persistencia lo revalida). */
  detectorOwnerMissing: boolean;
}
/** Fila existente, tal como se leyó bloqueada. */
export interface AssetRow {
  id: string; publicId: string; delivery: Delivery; assetId: string; state: AssetState;
  firstCandidateAt: Date; lastCandidateAt: Date; firstCandidateRunId: string; lastCandidateRunId: string;
  sightings: number; rowVersion: number;
}
export interface AssetValues {
  assetId: string; version: number | null; bytes: number | null; format: string | null; resourceCreatedAt: Date;
  state: "CANDIDATE" | "CONFIRMED"; firstCandidateAt: Date; lastCandidateAt: Date;
  firstCandidateRunId: string; lastCandidateRunId: string; sightings: number; ownerMissing: boolean;
}
export type Plan =
  | { op: "insert"; values: AssetValues }
  | { op: "update"; kind: "reset" | "observed" | "confirmed"; values: AssetValues }
  | { op: "noop" };
export interface PlanContext {
  runId: string; startedAt: Date; graceMs: number; ownerMissing: boolean;
  /** Si la PRIMERA ejecución del ciclo de la fila terminó COMPLETED. */
  firstRunCompleted: boolean;
}

/**
 * Transición PURA de una candidata observada en la ejecución `runId` (sin E/S; la usa la persistencia y se prueba sola):
 * - sin fila → CANDIDATE nueva (primera y última observación = esta ejecución, sightings 1);
 * - CLEARED o assetId distinto → ciclo NUEVO (fechas, ejecuciones y sightings reiniciados; nada del ciclo anterior);
 * - ya observada en ESTA ejecución → nada (idempotente);
 * - CANDIDATE/CONFIRMED en una ejecución posterior → sightings + 1 y última observación = esta; una CANDIDATE pasa a
 *   CONFIRMED si desde la primera observación ha pasado al menos el periodo de gracia y su primera ejecución terminó
 *   COMPLETED. Los metadatos y ownerMissing se actualizan siempre que se escribe.
 */
export function planObservation(row: AssetRow | null, obs: AssetObservation, ctx: PlanContext): Plan {
  const meta = { assetId: obs.assetId, version: obs.version, bytes: obs.bytes, format: obs.format, resourceCreatedAt: obs.resourceCreatedAt, ownerMissing: ctx.ownerMissing };
  const fresh: AssetValues = {
    ...meta, state: "CANDIDATE", firstCandidateAt: ctx.startedAt, lastCandidateAt: ctx.startedAt,
    firstCandidateRunId: ctx.runId, lastCandidateRunId: ctx.runId, sightings: 1,
  };
  if (!row) return { op: "insert", values: fresh };
  // Repetir la observación de ESTA ejecución (mismo activo, ciclo activo) no cambia nada.
  if (row.lastCandidateRunId === ctx.runId && row.state !== "CLEARED" && row.assetId === obs.assetId) return { op: "noop" };
  // Una ejecución anterior a la última observación no puede escribir la fila (ni reiniciar su ciclo ni retroceder sus
  // fechas): error, nunca se ignora.
  if (ctx.startedAt.getTime() < row.lastCandidateAt.getTime()) throw new MediaAssetError("STALE_RUN");
  if (row.state === "CLEARED" || row.assetId !== obs.assetId) return { op: "update", kind: "reset", values: fresh };
  const confirm = row.state === "CONFIRMED"
    || (ctx.firstRunCompleted && ctx.startedAt.getTime() - row.firstCandidateAt.getTime() >= ctx.graceMs);
  return {
    op: "update", kind: row.state === "CANDIDATE" && confirm ? "confirmed" : "observed",
    values: {
      ...meta, state: confirm ? "CONFIRMED" : "CANDIDATE", firstCandidateAt: row.firstCandidateAt, lastCandidateAt: ctx.startedAt,
      firstCandidateRunId: row.firstCandidateRunId, lastCandidateRunId: ctx.runId, sightings: row.sightings + 1,
    },
  };
}

const optInt = (v: unknown, min: number) => v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= INT4_MAX);
/** Valida una candidata del detector contra las mismas reglas que la base de datos; cualquier anomalía → INVALID_ARGUMENT. */
function observation(c: MediaCandidate): AssetObservation {
  const bad = () => new MediaAssetError("INVALID_ARGUMENT");
  if (!c || typeof c !== "object") throw bad();
  const m = typeof c.publicId === "string" && c.publicId.length <= 1024 ? PATH.exec(c.publicId) : null;
  if (!m || c.ownerUserId !== m[1] || c.kind !== m[2] || !(c.kind in KIND)) throw bad();
  if (DELIVERY[c.delivery] !== (c.kind === "wardrobe" ? "UPLOAD" : "AUTHENTICATED")) throw bad();
  if (typeof c.assetId !== "string" || parseOpaqueAssetId(c.assetId) !== c.assetId) throw bad();
  if (!optInt(c.version, 1) || !optInt(c.bytes, 0)) throw bad();
  if (c.format !== null && !(typeof c.format === "string" && c.format.length >= 1 && c.format.length <= 16)) throw bad();
  if (!(c.resourceCreatedAt instanceof Date) || Number.isNaN(c.resourceCreatedAt.getTime()) || typeof c.ownerMissing !== "boolean") throw bad();
  return {
    publicId: c.publicId, delivery: DELIVERY[c.delivery], kind: KIND[c.kind], ownerUserId: c.ownerUserId, assetId: c.assetId,
    version: c.version, bytes: c.bytes, format: c.format, resourceCreatedAt: new Date(c.resourceCreatedAt.getTime()),
    detectorOwnerMissing: c.ownerMissing,
  };
}

const keyOf = (delivery: Delivery, publicId: string) => `${delivery}\u0000${publicId}`;
const DELIVERY_ORDER: Record<Delivery, number> = { UPLOAD: 0, AUTHENTICATED: 1 }; // orden del enum en PostgreSQL
/** Orden determinista (delivery y publicId byte a byte, igual que COLLATE "C"): el mismo en todos los lotes. */
function byKey(a: { delivery: Delivery; publicId: string }, b: { delivery: Delivery; publicId: string }) {
  return DELIVERY_ORDER[a.delivery] - DELIVERY_ORDER[b.delivery] || Buffer.compare(Buffer.from(a.publicId), Buffer.from(b.publicId));
}
const bytewise = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
function batches<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) out.push(items.slice(i, i + BATCH_SIZE));
  return out;
}

export interface PersistSummary {
  created: number; reset: number; observed: number; confirmed: number; unchanged: number; cleared: number;
  /** Candidatas sin propietario según el detector y según PostgreSQL (se persisten con ownerMissing = true). */
  ownerMissing: number;
  /** El propietario existía al detectar y ya no al persistir (cuenta borrada durante la ejecución): no se escribe nada. */
  skippedOwnerDeleted: number;
}

/**
 * Persiste una detección COMPLETA dentro de la transacción `tx` (la de finishWith). Solo usa `tx`.
 * Una detección incompleta (o incoherente) se rechaza ANTES de cualquier consulta: no puede modificar nada.
 */
export async function persistMediaCandidates(tx: Tx, input: { runId: string; startedAt: Date; detection: DetailedDetection }): Promise<PersistSummary> {
  // ── 1. Validación (sin E/S) ─────────────────────────────────────────────────────────────────────────────────────
  if (!input || typeof input !== "object") throw new MediaAssetError("INVALID_ARGUMENT");
  const { runId, startedAt, detection } = input;
  if (typeof runId !== "string" || runId.length < 1 || runId.length > 128) throw new MediaAssetError("INVALID_ARGUMENT");
  if (!(startedAt instanceof Date) || Number.isNaN(startedAt.getTime())) throw new MediaAssetError("INVALID_ARGUMENT");
  const report = detection?.report;
  if (!report || !Array.isArray(detection.candidates)) throw new MediaAssetError("INVALID_ARGUMENT");
  if (report.complete !== true || report.inventoryStatus !== "COMPLETE" || report.inventoryComplete?.upload !== true
    || report.inventoryComplete?.authenticated !== true || report.errors?.length !== 0) throw new MediaAssetError("INCOMPLETE_DETECTION");
  if (detection.candidates.length > MAX_CANDIDATES) throw new MediaAssetError("TOO_MANY_CANDIDATES");
  if (detection.candidates.length !== report.byCategory?.ORPHAN_CANDIDATE) throw new MediaAssetError("INVALID_ARGUMENT");
  // La detección debe haberse clasificado con el startedAt de ESTA ejecución (el detector lo copia en report.startedAt).
  if (typeof report.startedAt !== "string" || report.startedAt !== startedAt.toISOString()) throw new MediaAssetError("INVALID_ARGUMENT");
  const at = new Date(startedAt.getTime());
  const unique = new Map<string, AssetObservation>();
  for (const c of detection.candidates) {
    const o = observation(c);
    const k = keyOf(o.delivery, o.publicId);
    const prev = unique.get(k);
    if (prev && JSON.stringify(prev) !== JSON.stringify(o)) throw new MediaAssetError("INVALID_ARGUMENT"); // misma clave, datos distintos
    unique.set(k, o);
  }
  const observations = [...unique.values()].sort(byKey);

  // ── 2. Lease vigente de ESTA ejecución, comprobado en la propia transacción (no solo por el llamador) ──────────────
  // Orden lock → ejecución (el de finishWith, que ya los tiene: ahí no hay espera). Primero se BLOQUEA y, en otra
  // sentencia, se comprueba la caducidad con el reloj de PostgreSQL: una espera por la fila no deja usar una validación
  // anterior a ella.
  await tx.$queryRaw`SELECT 1 FROM "MediaReconcileLock" WHERE "name" = 'media-reconcile' FOR UPDATE`;
  const [lease] = await tx.$queryRaw<{ holder: string | null; token: number; live: boolean }[]>`
    SELECT "holderRunId" AS "holder", "fencingToken" AS "token", ("leaseExpiresAt" > ${NOW}) IS TRUE AS "live"
    FROM "MediaReconcileLock" WHERE "name" = 'media-reconcile'`;
  const [run] = await tx.$queryRaw<{ status: string; startedAt: Date; graceHours: number; token: number }[]>`
    SELECT "status"::text AS "status", "startedAt", "graceHours", "fencingToken" AS "token"
    FROM "MediaReconcileRun" WHERE "id" = ${runId} FOR UPDATE`;
  if (!lease || !run || lease.holder !== runId || Number(lease.token) !== Number(run.token) || lease.live !== true || run.status !== "RUNNING") {
    throw new MediaAssetError("RUN_NOT_ACTIVE");
  }
  if (run.startedAt.getTime() !== at.getTime()) throw new MediaAssetError("INVALID_ARGUMENT");
  const graceMs = Number(run.graceHours) * 3_600_000;

  // ── 3. Filas activas ausentes de esta detección completa (se leerán bloqueadas después) ─────────────────────────────
  const delivs = observations.map((o) => o.delivery);
  const pubs = observations.map((o) => o.publicId);
  const absent = await tx.$queryRaw<{ ownerUserId: string; delivery: Delivery; publicId: string }[]>`
    SELECT a."ownerUserId", a."delivery"::text AS "delivery", a."publicId" FROM "MediaAsset" a
    WHERE a."state" IN ('CANDIDATE', 'CONFIRMED') AND NOT EXISTS (
      SELECT 1 FROM unnest(${delivs}::text[], ${pubs}::text[]) AS c(d, p) WHERE a."delivery"::text = c.d AND a."publicId" = c.p)`;

  // ── 4. Propietarios: FOR KEY SHARE, ordenados, por lotes (antes de tocar ninguna fila de MediaAsset) ──────────────
  const owners = [...new Set([...observations.map((o) => o.ownerUserId), ...absent.map((a) => a.ownerUserId)])].sort(bytewise);
  const existing = new Set<string>();
  for (const batch of batches(owners)) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "User" WHERE "id" = ANY(${batch}::text[]) ORDER BY "id" COLLATE "C" FOR KEY SHARE`;
    for (const r of rows) existing.add(r.id);
  }

  // ── 5. Propietario revalidado: el borrado de una cuenta durante la ejecución no recrea sus filas ───────────────────
  const summary: PersistSummary = { created: 0, reset: 0, observed: 0, confirmed: 0, unchanged: 0, cleared: 0, ownerMissing: 0, skippedOwnerDeleted: 0 };
  const toWrite: { obs: AssetObservation; ownerMissing: boolean }[] = [];
  for (const obs of observations) {
    const ownerExists = existing.has(obs.ownerUserId);
    if (!ownerExists && !obs.detectorOwnerMissing) { summary.skippedOwnerDeleted++; continue; }
    if (!ownerExists) summary.ownerMissing++;
    toWrite.push({ obs, ownerMissing: !ownerExists });
  }

  // ── 6. Filas de MediaAsset: FOR UPDATE, en orden (delivery, publicId), por lotes ──────────────────────────────────
  const candidateKeys = new Set(observations.map((o) => keyOf(o.delivery, o.publicId)));
  const lockedActiveAbsent: AssetRow[] = [];
  const rowsByKey = new Map<string, AssetRow>();
  const lockKeys = toWrite.map((w) => ({ delivery: w.obs.delivery, publicId: w.obs.publicId }));
  // Candidatas y ausentes se bloquean juntas, en el mismo orden global. Una ausente cuyo propietario se borró mientras
  // se esperaba su bloqueo ya no aparece (la eliminó el borrado de la cuenta) y no se toca.
  const allKeys = [...lockKeys, ...absent.map((a) => ({ delivery: a.delivery, publicId: a.publicId }))].sort(byKey);
  for (const batch of batches(allKeys)) {
    const rows = await tx.$queryRaw<AssetRow[]>`
      SELECT a."id", a."publicId", a."delivery"::text AS "delivery", a."assetId", a."state"::text AS "state",
        a."firstCandidateAt", a."lastCandidateAt", a."firstCandidateRunId", a."lastCandidateRunId", a."sightings", a."rowVersion"
      FROM "MediaAsset" a JOIN unnest(${batch.map((k) => k.delivery)}::text[], ${batch.map((k) => k.publicId)}::text[]) AS k(d, p)
        ON a."delivery"::text = k.d AND a."publicId" = k.p
      ORDER BY a."delivery", a."publicId" COLLATE "C" FOR UPDATE OF a`;
    for (const r of rows) {
      const k = keyOf(r.delivery, r.publicId);
      if (candidateKeys.has(k)) rowsByKey.set(k, r);
      else if (r.state === "CANDIDATE" || r.state === "CONFIRMED") lockedActiveAbsent.push(r);
    }
  }

  // ── 7. Primeras ejecuciones COMPLETED (solo las de filas que pueden confirmarse) ────────────────────────────────
  const firstRuns = [...new Set(toWrite.flatMap(({ obs }) => {
    const r = rowsByKey.get(keyOf(obs.delivery, obs.publicId));
    return r && r.state === "CANDIDATE" && r.assetId === obs.assetId && r.lastCandidateRunId !== runId ? [r.firstCandidateRunId] : [];
  }))].sort(bytewise);
  const completedRuns = new Set<string>();
  for (const batch of batches(firstRuns)) {
    for (const r of await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "MediaReconcileRun" WHERE "id" = ANY(${batch}::text[]) AND "status" = 'COMPLETED'`) completedRuns.add(r.id);
  }

  // ── 8. Plan (puro) y escrituras por lotes ─────────────────────────────────────────────────────────────────────
  const inserts: (AssetObservation & { values: AssetValues })[] = [];
  const updates: { id: string; rowVersion: number; values: AssetValues }[] = [];
  for (const { obs, ownerMissing } of toWrite) {
    const row = rowsByKey.get(keyOf(obs.delivery, obs.publicId)) ?? null;
    const plan = planObservation(row, obs, { runId, startedAt: at, graceMs, ownerMissing, firstRunCompleted: !!row && completedRuns.has(row.firstCandidateRunId) });
    if (plan.op === "noop") summary.unchanged++;
    else if (plan.op === "insert") { summary.created++; inserts.push({ ...obs, values: plan.values }); }
    else { summary[plan.kind]++; updates.push({ id: row!.id, rowVersion: row!.rowVersion, values: plan.values }); }
  }

  for (const batch of batches(inserts)) {
    const n = await tx.$executeRaw`
      INSERT INTO "MediaAsset" ("id", "publicId", "delivery", "kind", "ownerUserId", "assetId", "version", "bytes", "format",
        "resourceCreatedAt", "state", "firstCandidateAt", "lastCandidateAt", "firstCandidateRunId", "lastCandidateRunId",
        "sightings", "ownerMissing", "rowVersion", "createdAt", "updatedAt")
      SELECT gen_random_uuid()::text, c.p, c.d::"MediaDelivery", c.k::"MediaAssetKind", c.o, c.a, c.v, c.b, c.f,
        (c.rc::timestamptz AT TIME ZONE 'UTC'), 'CANDIDATE', ${utc(at)}, ${utc(at)}, ${runId}, ${runId}, 1, c.om, 0, ${NOW}, ${NOW}
      FROM unnest(${batch.map((i) => i.publicId)}::text[], ${batch.map((i) => i.delivery)}::text[], ${batch.map((i) => i.kind)}::text[],
        ${batch.map((i) => i.ownerUserId)}::text[], ${batch.map((i) => i.assetId)}::text[], ${batch.map((i) => i.version)}::int4[],
        ${batch.map((i) => i.bytes)}::int4[], ${batch.map((i) => i.format)}::text[], ${batch.map((i) => i.resourceCreatedAt.toISOString())}::text[],
        ${batch.map((i) => i.values.ownerMissing)}::boolean[]) AS c(p, d, k, o, a, v, b, f, rc, om)`;
    if (n !== batch.length) throw new MediaAssetError("CONCURRENT_MODIFICATION");
  }

  const iso = (d: Date) => d.toISOString();
  for (const batch of batches(updates)) {
    const v = batch.map((u) => u.values);
    const n = await tx.$executeRaw`
      UPDATE "MediaAsset" AS a SET "assetId" = c.a, "version" = c.v, "bytes" = c.b, "format" = c.f,
        "resourceCreatedAt" = (c.rc::timestamptz AT TIME ZONE 'UTC'), "state" = c.s::"MediaAssetState",
        "firstCandidateAt" = (c.fa::timestamptz AT TIME ZONE 'UTC'), "lastCandidateAt" = (c.la::timestamptz AT TIME ZONE 'UTC'),
        "firstCandidateRunId" = c.fr, "lastCandidateRunId" = c.lr, "sightings" = c.n, "ownerMissing" = c.om,
        "rowVersion" = a."rowVersion" + 1, "updatedAt" = ${NOW}
      FROM unnest(${batch.map((u) => u.id)}::text[], ${batch.map((u) => u.rowVersion)}::int4[], ${v.map((x) => x.assetId)}::text[],
        ${v.map((x) => x.version)}::int4[], ${v.map((x) => x.bytes)}::int4[], ${v.map((x) => x.format)}::text[],
        ${v.map((x) => iso(x.resourceCreatedAt))}::text[], ${v.map((x) => x.state)}::text[], ${v.map((x) => iso(x.firstCandidateAt))}::text[],
        ${v.map((x) => iso(x.lastCandidateAt))}::text[], ${v.map((x) => x.firstCandidateRunId)}::text[], ${v.map((x) => x.lastCandidateRunId)}::text[],
        ${v.map((x) => x.sightings)}::int4[], ${v.map((x) => x.ownerMissing)}::boolean[])
        AS c(id, rv, a, v, b, f, rc, s, fa, la, fr, lr, n, om)
      WHERE a."id" = c.id AND a."rowVersion" = c.rv`;
    if (n !== batch.length) throw new MediaAssetError("CONCURRENT_MODIFICATION");
  }

  // ── 9. Ausentes de una detección completa → CLEARED (sin borrar la fila ni tocar sus fechas) ────────────────────
  lockedActiveAbsent.sort(byKey);
  for (const batch of batches(lockedActiveAbsent)) {
    const n = await tx.$executeRaw`
      UPDATE "MediaAsset" AS a SET "state" = 'CLEARED', "rowVersion" = a."rowVersion" + 1, "updatedAt" = ${NOW}
      FROM unnest(${batch.map((r) => r.id)}::text[], ${batch.map((r) => r.rowVersion)}::int4[]) AS c(id, rv)
      WHERE a."id" = c.id AND a."rowVersion" = c.rv AND a."state" IN ('CANDIDATE', 'CONFIRMED')`;
    if (n !== batch.length) throw new MediaAssetError("CONCURRENT_MODIFICATION");
    summary.cleared += n;
  }
  return summary;
}

export const mediaAssetService = { persistMediaCandidates, planObservation, MAX_CANDIDATES, BATCH_SIZE };
