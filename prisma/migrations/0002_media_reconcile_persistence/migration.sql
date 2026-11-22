-- Persistencia de la reconciliación de medios de Cloudinary (fases 19.2.2 y 19.2.3). Solo añade: no modifica tablas
-- existentes. Tablas, índices y claves foráneas generados con `prisma migrate diff --from-schema <0001>
-- --to-schema prisma/schema.prisma --script` (sin conexión a ninguna base de datos). Las restricciones CHECK y la fila
-- inicial del lease son manuales (Prisma no modela CHECK): son las ÚNICAS sentencias manuales autorizadas, enumeradas
-- una a una en tests/unit/repo-hygiene.test.ts.
-- Las columnas `updatedAt` no tienen DEFAULT (las rellena Prisma Client): el SQL directo debe asignarlas.

-- CreateEnum
CREATE TYPE "MediaReconcileRunKind" AS ENUM ('DETECT');

-- CreateEnum
CREATE TYPE "MediaReconcileRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'INCOMPLETE', 'FAILED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "MediaDelivery" AS ENUM ('UPLOAD', 'AUTHENTICATED');

-- CreateEnum
CREATE TYPE "MediaAssetKind" AS ENUM ('WARDROBE', 'PERSONAL', 'TRY_ON');

-- CreateEnum
CREATE TYPE "MediaAssetState" AS ENUM ('CANDIDATE', 'CONFIRMED', 'CLEARED');

-- CreateTable
CREATE TABLE "MediaReconcileLock" (
    "name" TEXT NOT NULL,
    "fencingToken" INTEGER NOT NULL DEFAULT 0,
    "holderRunId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaReconcileLock_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "MediaReconcileRun" (
    "id" TEXT NOT NULL,
    "kind" "MediaReconcileRunKind" NOT NULL DEFAULT 'DETECT',
    "status" "MediaReconcileRunStatus" NOT NULL DEFAULT 'RUNNING',
    "fencingToken" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "inventoryComplete" BOOLEAN NOT NULL DEFAULT false,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "graceHours" DOUBLE PRECISION NOT NULL,
    "summary" JSONB,
    "errorCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "codeVersion" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaReconcileRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "delivery" "MediaDelivery" NOT NULL,
    "kind" "MediaAssetKind" NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "version" INTEGER,
    "bytes" INTEGER,
    "format" TEXT,
    "resourceCreatedAt" TIMESTAMP(3) NOT NULL,
    "state" "MediaAssetState" NOT NULL DEFAULT 'CANDIDATE',
    "firstCandidateAt" TIMESTAMP(3) NOT NULL,
    "lastCandidateAt" TIMESTAMP(3) NOT NULL,
    "firstCandidateRunId" TEXT NOT NULL,
    "lastCandidateRunId" TEXT NOT NULL,
    "sightings" INTEGER NOT NULL DEFAULT 1,
    "ownerMissing" BOOLEAN NOT NULL DEFAULT false,
    "rowVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaReconcileRun_fencingToken_key" ON "MediaReconcileRun"("fencingToken");

-- CreateIndex
CREATE INDEX "MediaReconcileRun_kind_startedAt_idx" ON "MediaReconcileRun"("kind", "startedAt");

-- CreateIndex
CREATE INDEX "MediaReconcileRun_status_heartbeatAt_idx" ON "MediaReconcileRun"("status", "heartbeatAt");

-- CreateIndex
CREATE UNIQUE INDEX "MediaReconcileRun_id_fencingToken_key" ON "MediaReconcileRun"("id", "fencingToken");

-- CreateIndex
CREATE INDEX "MediaAsset_state_lastCandidateAt_idx" ON "MediaAsset"("state", "lastCandidateAt");

-- CreateIndex
CREATE INDEX "MediaAsset_lastCandidateRunId_idx" ON "MediaAsset"("lastCandidateRunId");

-- CreateIndex
CREATE INDEX "MediaAsset_firstCandidateRunId_idx" ON "MediaAsset"("firstCandidateRunId");

-- CreateIndex
CREATE INDEX "MediaAsset_ownerUserId_idx" ON "MediaAsset"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_delivery_publicId_key" ON "MediaAsset"("delivery", "publicId");

-- AddForeignKey
ALTER TABLE "MediaReconcileLock" ADD CONSTRAINT "MediaReconcileLock_holderRunId_fencingToken_fkey" FOREIGN KEY ("holderRunId", "fencingToken") REFERENCES "MediaReconcileRun"("id", "fencingToken") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_firstCandidateRunId_fkey" FOREIGN KEY ("firstCandidateRunId") REFERENCES "MediaReconcileRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_lastCandidateRunId_fkey" FOREIGN KEY ("lastCandidateRunId") REFERENCES "MediaReconcileRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─────────────────────────── Restricciones CHECK (segunda barrera de integridad) ───────────────────────────

-- AddCheckConstraint
-- Lock singleton: una sola fila, la del reconciliador.
ALTER TABLE "MediaReconcileLock" ADD CONSTRAINT "MediaReconcileLock_name_check" CHECK ("name" = 'media-reconcile');
ALTER TABLE "MediaReconcileLock" ADD CONSTRAINT "MediaReconcileLock_fencingToken_check" CHECK ("fencingToken" >= 0);
-- Con dueño ⇔ con expiración (nunca un lease vigente sin dueño); con dueño, heartbeat registrado y no posterior a la expiración.
ALTER TABLE "MediaReconcileLock" ADD CONSTRAINT "MediaReconcileLock_lease_check" CHECK ((("holderRunId" IS NULL) = ("leaseExpiresAt" IS NULL)) AND ("holderRunId" IS NULL OR ("heartbeatAt" IS NOT NULL AND "heartbeatAt" <= "leaseExpiresAt")));

-- AddCheckConstraint
-- graceHours: mínimo del detector (1 h) y máximo razonable (1 año); también rechaza NaN e Infinity.
ALTER TABLE "MediaReconcileRun" ADD CONSTRAINT "MediaReconcileRun_fencingToken_check" CHECK ("fencingToken" > 0);
ALTER TABLE "MediaReconcileRun" ADD CONSTRAINT "MediaReconcileRun_graceHours_check" CHECK ("graceHours" >= 1 AND "graceHours" <= 8760);
-- Solo una ejecución en curso no tiene fecha de fin; el heartbeat queda entre el inicio y el fin.
ALTER TABLE "MediaReconcileRun" ADD CONSTRAINT "MediaReconcileRun_finished_check" CHECK ((("status" = 'RUNNING') = ("finishedAt" IS NULL)) AND ("finishedAt" IS NULL OR "finishedAt" >= "startedAt") AND "heartbeatAt" >= "startedAt" AND ("finishedAt" IS NULL OR "heartbeatAt" <= "finishedAt"));
-- COMPLETED si y solo si la ejecución fue completa; una ejecución completa exige inventario completo.
ALTER TABLE "MediaReconcileRun" ADD CONSTRAINT "MediaReconcileRun_complete_check" CHECK (("complete" = ("status" = 'COMPLETED')) AND (NOT "complete" OR "inventoryComplete"));
ALTER TABLE "MediaReconcileRun" ADD CONSTRAINT "MediaReconcileRun_codeVersion_check" CHECK ("codeVersion" IS NULL OR char_length("codeVersion") BETWEEN 1 AND 64);
ALTER TABLE "MediaReconcileRun" ADD CONSTRAINT "MediaReconcileRun_errorCodes_check" CHECK ("errorCodes" IS NULL OR cardinality("errorCodes") <= 64);

-- AddCheckConstraint
-- assetId opaco: mismo límite que parseOpaqueAssetId (128 unidades UTF-16 ⇒ ≤ 128 code points). Sin normalizar.
-- Segunda barrera (parcial) frente a espacios, controles y caracteres invisibles: C0, DEL, C1, NBSP, guion discrecional,
-- espacios Unicode, ancho cero, marcas y aislamientos bidi, separadores de línea y párrafo, BOM. La primera barrera,
-- completa, es parseOpaqueAssetId.
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_assetId_check" CHECK (char_length("assetId") BETWEEN 1 AND 128 AND "assetId" !~ '[\u0001-\u0020\u007F-\u00A0\u00AD\u1680\u180E\u2000-\u200F\u2028-\u202F\u205F-\u206F\u3000\uFEFF]');
-- Formato EXACTO del detector (APP_PATH): ai-wardrobe/<propietario>/<wardrobe|personal|try-on>/<nombre>.
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_publicId_check" CHECK (char_length("publicId") <= 1024 AND "publicId" ~ '^ai-wardrobe/[A-Za-z0-9-][A-Za-z0-9_-]{0,63}/(wardrobe|personal|try-on)/[^/]+$');
-- El propietario es EXACTAMENTE el segmento de la ruta (no un prefijo).
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_ownerUserId_check" CHECK ("ownerUserId" = split_part("publicId", '/', 2));
-- El tipo coincide con la carpeta de la ruta y la entrega con el tipo (WARDROBE → UPLOAD; PERSONAL y TRY_ON → AUTHENTICATED).
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_kind_check" CHECK (split_part("publicId", '/', 3) = CASE "kind" WHEN 'WARDROBE' THEN 'wardrobe' WHEN 'PERSONAL' THEN 'personal' WHEN 'TRY_ON' THEN 'try-on' END);
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_delivery_check" CHECK (("kind" = 'WARDROBE') = ("delivery" = 'UPLOAD'));
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_metadata_check" CHECK (("version" IS NULL OR "version" >= 1) AND ("bytes" IS NULL OR "bytes" >= 0) AND ("format" IS NULL OR char_length("format") BETWEEN 1 AND 16));
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_counters_check" CHECK ("sightings" >= 1 AND "rowVersion" >= 0 AND "lastCandidateAt" >= "firstCandidateAt");
-- Una sola observación ⇔ la primera y la última ejecución son la misma; varias ⇒ ejecuciones distintas.
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_sightings_runs_check" CHECK (("sightings" = 1) = ("firstCandidateRunId" = "lastCandidateRunId"));
-- CONFIRMED exige al menos dos ejecuciones distintas separadas, como mínimo, por el periodo de gracia MÍNIMO (1 h). El
-- periodo de gracia configurado, que las ejecuciones estén COMPLETED y el mismo assetId los garantiza el servicio.
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_confirmed_check" CHECK ("state" <> 'CONFIRMED' OR ("sightings" >= 2 AND "lastCandidateAt" - "firstCandidateAt" >= INTERVAL '1 hour'));

-- ─────────────────────────── Fila inicial del lease (idempotente) ───────────────────────────

-- SeedLock
INSERT INTO "MediaReconcileLock" ("name", "fencingToken", "createdAt", "updatedAt")
VALUES ('media-reconcile', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;
