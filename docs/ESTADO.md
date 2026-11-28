# Estado real del proyecto

Este documento dice con franqueza qué está **comprobado**, qué **depende de credenciales o servicios que no se pudieron probar** y qué **limitaciones** tiene el producto. Léelo antes de desplegar.

> **Nota de lectura.** El documento es un registro cronológico por fases. Donde una sección antigua contradiga a una posterior, **prevalecen el «Resumen consolidado» siguiente y las secciones más recientes**. Las frases que han quedado superadas llevan una marca «(superado: …)» o «(histórico: …)»; no se han borrado para conservar el rastro de lo que se sabía en cada momento.

## Resumen consolidado — cierre de la Fase I (28-nov-2026)

**Veredicto de la auditoría final: APROBADO CON OBSERVACIONES.** Sin defectos críticos ni altos abiertos; las observaciones están en «Cierre de la Fase I: auditoría final».

| Categoría | Qué incluye |
|---|---|
| **Validado en entorno local** (PGlite, PostgreSQL 17.12 y 18.7 en Docker aislado, proxy WebSocket de Neon) | Suite completa **129/129 archivos y 3.216/3.216 pruebas, 0 omitidas** con PostgreSQL 18.7 + proxy (código actual, sin cambios de código posteriores). Sin PostgreSQL: **124 archivos y 5 omitidos; 3.121 pruebas correctas y 95 omitidas** (repetido en el cierre). `lint`, `tsc` y `git diff --check` sin errores; build de producción aislado con variables ficticias, exit 0. Migraciones `0001`+`0002` desde cero y sobre una base con `0001` y datos; `migrate diff` sin diferencias; atomicidad, fallo a mitad y reversión; 25 comprobaciones de CHECK/FK en 18.7. Concurrencia, autenticación, rate limit, borrado de cuentas y adaptador `@prisma/adapter-neon` (vía proxy local). Accesibilidad H.5–H.9 con pruebas automatizadas (jsdom) y Chrome real por CDP en copia aislada |
| **Validado contra servicios reales** (Neon de producción y Cloudinary, con autorización expresa) | Neon: conexión pooled y directa, esquema e integridad (0 huérfanas), PostgreSQL 18.7. **`0002` aplicada en producción** (atómica con `psql`, registrada con `resolve --applied`; `migrate status` al día, `migrate diff` vacío, checksums correctos). PrismaNeon por el pooler (lecturas). **`accountService.delete` probado** con un usuario de prueba, con Cloudinary real (subida pública y privada y borrado por prefijo), `MediaAsset` y limpieza por id exacto; los 2 usuarios preexistentes quedaron idénticos. Forma real de `asset_id`: 32 caracteres hexadecimales |
| **Orca O-1 y O-6** | **APROBADOS**, por validación del responsable del proyecto posterior a las sesiones de la Fase I. No se repitieron en las fases siguientes ni se presentan como pendientes |
| **Pendiente de validar** | Ruta HTTP `DELETE /api/account`, login con cookies reales, CSRF y rate limit por usuario en producción; envío de correo (SMTP no configurado); Vercel (despliegue, cron, `maxDuration`, `VERCEL=1` para el límite por IP); OpenRouter, Pollinations, Open-Meteo y Awin; revisión visual de la interfaz; concurrencia y carga reales contra Neon y PgBouncer; borrado de cuentas con muchas imágenes y cuentas OAuth; ventana de restauración de Neon de tu plan |
| **Riesgos residuales abiertos** (su aceptación queda a decisión del responsable; ninguno ha sido aceptado formalmente) | `'unsafe-inline'` en `script-src`; sin token CSRF propio; causa no confirmada del fallo intermitente (1 vez) de `neon-adapter-pg`; `migrate deploy` no es atómico (procedimiento atómico documentado); retención en `DRY_RUN` y cron de reconciliación sin programar; las suites PostgreSQL no se ejecutan en `npm test` (la CI las ejecuta con un PostgreSQL temporal) y el **workflow de CI existe pero aún no ha tenido ninguna ejecución real en GitHub** (ver «Fase 1: integración continua») |

## Fase 1: integración continua (GitHub Actions)

**Estado: workflow creado, endurecido (Fase 1.1) y reproducido localmente; SIN validar en GitHub.** No hay ninguna ejecución real en GitHub Actions: hasta que exista una satisfactoria, la CI no debe darse por validada.

**Archivos.** `.github/workflows/ci.yml` y `scripts/ci/assert-no-skipped.mjs` (comprueba los informes JSON de Vitest). Se añade `vitest-*.json` a `.gitignore`. No cambia ninguna funcionalidad, prueba, esquema Prisma ni migración.

**Activación.** `push` y `pull_request` sobre `main`. Permisos: solo `contents: read`. Concurrencia por rama: un push nuevo cancela la ejecución anterior de un PR, pero nunca la de `main`. Sin secretos, sin despliegues, sin tokens y sin conexión a Neon ni a ningún proveedor: las variables del build son ficticias (`DATABASE_URL` apunta a un puerto cerrado a propósito).

**Entorno.** `ubuntu-latest`, Node.js 22 (`engines`: ≥ 20.9), PostgreSQL **18.7** (`postgres:18.7-alpine` fijado por digest, contenedor de servicio con datos en tmpfs, publicado en `127.0.0.1:55433`, que es lo que exige `rate-limit-purge-pg`) y el proxy WebSocket oficial de Neon (`ghcr.io/neondatabase/wsproxy`, fijado por digest, `ALLOW_ADDR_REGEX` limitado a ese PostgreSQL) para la suite de `PrismaNeon`. La contraseña de PostgreSQL es una credencial desechable del propio contenedor y va por `PGPASSWORD`: `repo-hygiene` no admite cadenas de conexión con contraseña en el repositorio.

**Endurecimiento (Fase 1.1).** Acciones fijadas por SHA de commit, verificados contra los repositorios oficiales (`git ls-remote` y la API de releases de `actions/*`; ambas releases estables, no prerelease): `actions/checkout@11d5960a326750d5838078e36cf38b85af677262` (v4.4.0) y `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020` (v4.4.0); en ambos casos el SHA coincide con la etiqueta móvil `v4`, así que no cambia la versión mayor ni el comportamiento. La imagen de PostgreSQL se fija por el digest de su índice (`sha256:0115267a…`, comprobado con `docker buildx imagetools inspect`). `defaults.run.shell: bash` (con `-eo pipefail`). `assert-no-skipped.mjs` comprueba además que entre los informes están **todos** los archivos `tests/**/*.test.ts(x)`, cada uno una sola vez. Auditoría de aislamiento: ver «Limitaciones».

**Comprobaciones, por orden.** `npm ci` (su `postinstall` ejecuta `prisma generate`), `npm run typecheck`, `npm run lint`, arranque del proxy, Vitest, comprobación de que no hay pruebas omitidas ni fallidas y `npm run build`. Vitest se ejecuta en **dos pasos que juntos cubren toda la suite, sin excluir ninguna prueba**: (1) todo salvo las suites de PostgreSQL real, en paralelo; (2) las suites que leen `TEST_PG_URL` (siete archivos), una detrás de otra con `--no-file-parallelism`. Motivo: en paralelo con el resto fallaban de forma intermitente por timeouts de 5 s (en una prueba local, 6 fallos en una ejecución y 0 en la siguiente, con el mismo código); es la misma fragilidad ya documentada (E2). Serializarlas cambia cómo se ejecutan, no qué se ejecuta. `assert-no-skipped.mjs` hace fallar la CI si queda **cualquier** prueba omitida, pendiente o fallida (un archivo opt-in sin su variable de entorno ya no puede dar un verde engañoso). Las migraciones no se aplican en un paso aparte: cada suite crea su propia base temporal (`race_*`, `neonad_*`), aplica las migraciones del proyecto y la elimina al terminar.

**Resultado de la reproducción local** (copia aislada del repositorio, sin `.env`, entorno vacío, PostgreSQL 18.7 y proxy en Docker): `typecheck` y `lint` sin errores; paso 1: 122 archivos y 3.047 pruebas correctas; paso 2: 7 archivos y 169 pruebas correctas; **total 129 archivos y 3.216/3.216 pruebas, 0 omitidas ni fallidas**; `npm run build` con variables ficticias, exit 0. La guarda se comprobó en negativo (sin `TEST_PG_URL`, 49 pruebas omitidas → exit 1).

**Reproducción local tras el endurecimiento (Fase 1.1):** mismo resultado (129 archivos y 3.216/3.216 pruebas, 0 omitidas; `typecheck`, `lint` y `build` en verde), con la imagen de PostgreSQL por digest. La guarda se probó con informes alterados: falla ante pruebas fallidas, omitidas, pendientes (todo), `success: false`, archivos ausentes o repetidos, informe inexistente y falta de argumentos.

**Reproducir localmente.** Con Docker (puertos 55433 y 5488 libres; sustituye `172.17.0.1` por la pasarela de `docker network inspect bridge`):

```bash
docker run -d --name aiw-ci-pg -e POSTGRES_PASSWORD=ci-throwaway-password -p 127.0.0.1:55433:5432 -p 172.17.0.1:55433:5432 --tmpfs /var/lib/postgresql postgres:18.7-alpine@sha256:0115267ab5a509022df9319c77be365cef335adb71556c75f60f5360ee247e71
docker run -d --name neon-wsproxy --add-host host.docker.internal:host-gateway -p 127.0.0.1:5488:80 \
  -e 'ALLOW_ADDR_REGEX=^host\.docker\.internal:55433$' ghcr.io/neondatabase/wsproxy@sha256:7f2e2149aa6a57ba382a140102fba44f5053f3e44389ccc18adcecf896054efb
export TEST_PG_URL=postgresql://postgres@127.0.0.1:55433/postgres PGPASSWORD=ci-throwaway-password \
       TEST_NEON_WSPROXY=127.0.0.1:5488 TEST_NEON_PG_ADDR=host.docker.internal:55433
PG=$(grep -rl TEST_PG_URL tests --include='*.test.ts' | sort); EX=(); for f in $PG; do EX+=(--exclude "$f"); done
npm test -- "${EX[@]}" --reporter=default --reporter=json --outputFile.json=vitest-main.json
npm test -- --no-file-parallelism $PG --reporter=default --reporter=json --outputFile.json=vitest-pg.json
node scripts/ci/assert-no-skipped.mjs vitest-main.json vitest-pg.json
docker rm -f aiw-ci-pg neon-wsproxy
```

**Limitaciones conocidas (pendientes de validar en GitHub).**
- Ninguna ejecución real: no se ha comprobado que `ubuntu-latest` resuelva `host.docker.internal` con `host-gateway`, que `--tmpfs /var/lib/postgresql` funcione en el contenedor de servicio, que el tiempo total (≈ 5 min en local) quepa holgado en los 30 min del job ni que las pruebas de tiempos ajustados pasen en un runner más pequeño (2 vCPU en repositorios privados).
- `npm ci` no se pudo reproducir sin red (la caché local está incompleta): en la copia aislada se usó una copia de `node_modules` y `prisma generate`. La consistencia entre `package-lock.json` y `package.json` la comprobará GitHub.
- Las acciones están fijadas por SHA (v4.4.0), pero no hay actualización automática (p. ej. Dependabot): hay que revisarlas a mano.
- El servicio PostgreSQL se publica en todas las interfaces del runner (VM efímera) porque el proxy de Neon, desde su contenedor, lo alcanza por la pasarela del host; el proxy solo se publica en `127.0.0.1:5488` y su `ALLOW_ADDR_REGEX` solo admite `host.docker.internal:55433`. Ninguna variable del workflow apunta a un destino externo y las suites rechazan hosts no locales.
- Las suites se descubren con `grep TEST_PG_URL`: incluye dos archivos (`auth-token-atomicity`, `media-lease`) que solo lo mencionan en comentarios; se ejecutan en el paso serie sin inconveniente.
- El proxy de Neon usa una imagen `latest` fijada por digest; hay que actualizar el digest a mano.
- No se han tocado las reglas de protección de la rama: la CI no bloquea ningún merge. Sigue sin probarse nada contra Neon real (la CI no lo intenta).

## Cómo se ha verificado

| Comprobación | Resultado |
|---|---|
| `npm run typecheck` (TypeScript estricto, `noUncheckedIndexedAccess`) | Sin errores |
| `npm run lint` | Sin errores ni avisos |
| `npm test` — 129 archivos | **Sin PostgreSQL local** (`npm run check`): 124 archivos en verde y 5 omitidos; 3.121 pruebas pasan y 95 se omiten. **Con PostgreSQL local y proxy WebSocket** (ver «Estabilización técnica final» y «Revisión y validación de la migración 0002»): 129/129 archivos y 3.216/3.216 pruebas, 0 omitidas, también sobre PostgreSQL 18.7. Recuentos de la estabilización final; los de las fases 20–22 más abajo son históricos |
| `npm run build` | Correcto (exit 0) en la fase 21.1, ejecutado en una copia temporal aislada con variables de entorno ficticias (ver «Verificación de estabilidad y build (fase 21.1)»). Verifica la **compilación**, no el funcionamiento en runtime ni la integración con servicios reales. Repetido con éxito (exit 0, 40 páginas) en el cierre de la Fase I |
| Migraciones SQL (`0001_init` y `0002_media_reconcile_persistence`) | Las aplica la suite de integración sobre PGlite. Además, en la fase 22.1 se aplicaron con `psql` (`ON_ERROR_STOP=1`) sobre PostgreSQL 17.12 real y local: `0001` crea 21 tablas y 19 claves foráneas y `0002` añade 3 tablas y 3 claves foráneas, hasta 24 tablas, 22 claves foráneas, 68 índices y 11 enums, sin errores SQL (ver «Verificación con PostgreSQL real (fase 22.1)»). ~~No se ha comprobado el drift completo frente a `prisma migrate`~~ (superado: sin drift en local desde la Fase I y también en Neon real tras aplicar `0002`) |

(Histórico, fase 20.4: hoy son 5 archivos y 95 pruebas omitidas sin PostgreSQL; ver la tabla superior y el «Resumen consolidado».) Estado de la verificación en la última revisión de este documento (fase 20.4, tras la 20.3): `npm run lint`, `tsc --noEmit` y `npx vitest run` sin errores (el recuento anterior corresponde a la última ejecución completa de `npx vitest run`; una ejecución previa, lanzada en la misma sesión, mostró 2 fallos puntuales que no se identificaron; ver la sección de la fase 21.1, donde el incidente queda clasificado como no reproducible). Los **2 archivos omitidos** son `tests/integration/pg-concurrency.test.ts` y `tests/integration/rate-limit-purge-pg.test.ts`: sus bloques usan `describe.skipIf(!ADMIN_URL)` y solo se ejecutan con un PostgreSQL local aislado y su URL de administración configurada (concurrencia real de conexiones, lease del reconciliador y purga con bloqueos). Sin ese entorno **no se ejecutan en la suite general** (aparecen como omitidos). Su verificación contra PostgreSQL 17.12 local se hizo en la fase 22.1 (ver más abajo).

Los **tests de integración** usan el Prisma Client real contra PostgreSQL real (PGlite) con la migración del proyecto. Solo se simulan los proveedores externos. Durante su escritura aparecieron y se corrigieron fallos reales: columnas de lista `NOT NULL` sin valor por defecto (habrían roto todo registro), un `INSERT … unnest` que fallaba con arrays de `enum`, errores de la IA mostrados al usuario como «datos no válidos» (422) en vez de 502, y una respuesta de IA con un solo id mal formado que descartaba los conjuntos buenos.

## Verificación de estabilidad y build (fase 21.1)

**Vitest.** Se hicieron 10 ejecuciones completas y secuenciales de `npx vitest run`, con PGlite en memoria, sin servicios externos y sin carga artificial. Las 10 terminaron con exit code 0 y el mismo resultado: 79 archivos correctos y 2 omitidos; 2.483 tests correctos, 60 omitidos y 0 fallidos. Los dos archivos omitidos requieren un PostgreSQL local (`pg-concurrency` y `rate-limit-purge-pg`) y no se ejecutaron en esta fase (se verificaron después, en la 22.1).

- **Incidente de la fase 20.4:** no se reprodujeron los 2 fallos observados en la primera ejecución. Su origen **sigue siendo desconocido** y el incidente queda clasificado como **no reproducible**. Si reaparece, conviene conservar la salida completa de esa ejecución para identificarlo.
- No se modificaron timeouts, workers ni configuración de Vitest, porque no hubo evidencia que lo justificara.

**Build.** `npm run build` terminó correctamente (exit 0), con la compilación y la comprobación de TypeScript correctas. Se ejecutó en una copia temporal aislada, fuera del repositorio, que se eliminó después; se excluyeron `.env*`, `.git`, `.next`, `.vitest` y `tsconfig.tsbuildinfo`. Se usaron exclusivamente variables de entorno ficticias: no se usaron credenciales reales ni se conectó deliberadamente a proveedores externos ni a Neon. Esta prueba verifica la compilación; **no** verifica el funcionamiento en runtime ni la integración con servicios reales.

**Otras comprobaciones.** `tsc --noEmit`, ESLint y `git diff --check` correctos. `.vitest/` se añadió a `.gitignore`, sin modificar ni eliminar su contenido.

## Verificación con PostgreSQL real (fase 22.1)

Se usó un contenedor temporal con PostgreSQL 17.12, accesible solo desde `127.0.0.1`, con datos en `tmpfs` y contraseña aleatoria. No se usó `.env`, Neon ni ningún proveedor externo.

**Migraciones.** Se aplicó el SQL original con `psql` y `ON_ERROR_STOP=1`, una migración tras otra, sobre una base exclusiva:

| Migración | Resultado | Tablas | Claves foráneas | Índices | Enums |
|---|---|---|---|---|---|
| `0001_init` | Correcta, sin errores | 21 | 19 | 56 | 6 |
| `0002_media_reconcile_persistence` | Correcta, sin errores | 24 | 22 | 68 | 11 |

`0002` añade 3 tablas (`MediaAsset`, `MediaReconcileLock` y `MediaReconcileRun`) y 3 claves foráneas.

**Tests PostgreSQL-only.** Cada archivo se ejecutó 3 veces consecutivas con `TEST_PG_URL` apuntando a ese contenedor. Cada ejecución creó su propia base `race_*`, aplicó las migraciones del proyecto y la eliminó al terminar; al acabar no quedaba ninguna `race_*` y el contenedor se eliminó.

| Archivo | Tests por ejecución | Ejecuciones | Resultado |
|---|---|---|---|
| `tests/integration/pg-concurrency.test.ts` | 49 | 3 | 49 pasados en cada una |
| `tests/integration/rate-limit-purge-pg.test.ts` | 11 | 3 | 11 pasados en cada una |

En total, 60 tests ejecutados y superados en las seis ejecuciones. **Siguen apareciendo como omitidos en la suite general** (`npm test`, `npm run check`) cuando no se configura `TEST_PG_URL`; `npm run check` sin esa variable repitió el resultado anterior (79 archivos correctos y 2 omitidos; 2.483 tests correctos y 60 omitidos).

**Lo que esta verificación NO demuestra:**
- El comportamiento contra **Neon**, ni el adaptador `adapter-neon` ni el pooler de Neon (los tests usan `adapter-pg` contra un PostgreSQL local).
- La ausencia absoluta de condiciones de carrera: tres ejecuciones consecutivas son una verificación repetida, no una demostración formal.
- ~~La ausencia de drift mediante `prisma migrate`~~: comprobada en la fase I (ver al final).

**Observación técnica menor.** Vite muestra un aviso porque `vitest.config.ts` usa sintaxis ESM y se carga como CommonJS (no hay `"type": "module"` ni extensión `.mjs`). No ha provocado fallos y no se ha modificado la configuración.

## Comprobado solo en local (PGlite y simulaciones)

Todo lo de la sección «Lo que está implementado» y «Seguridad y robustez» está cubierto por las pruebas anteriores con PostgreSQL en memoria (PGlite) y proveedores simulados. **Nada de ello se ha probado en producción ni contra Neon.** Una prueba local no demuestra el comportamiento con la latencia, la concurrencia ni la configuración real de Vercel.

## Qué NO se ha podido comprobar (hazlo tú en la primera puesta en marcha)

Ninguna de estas integraciones se ha ejecutado contra el servicio real. El código sigue su documentación oficial y está probado con respuestas simuladas, pero el primer contacto puede revelar diferencias:

| Integración | Qué comprobar |
|---|---|
| **Neon** | Comprobado en la estabilización final, en «Aplicación de 0002 en producción» y en «Prueba de borrado de cuenta en producción»: conexión pooled y directa, esquema e integridad correctos, migraciones aplicadas y `accountService.delete` probado con una cuenta de prueba. Registro/login reales contra Neon (HTTP, cookies, correo) **no** se han probado. |
| **Migración** | Generada con un script propio (no con `prisma migrate`). Aplicada sin errores a PostgreSQL 17.12 local (fase 22.1). **(Superado: después se comparó con `prisma migrate` —sin drift— y `0001`+`0002` se aplicaron en Neon real; ver «Aplicación de 0002 en producción».)** |
| **Cloudinary** | Subida firmada, tipo `authenticated`, URLs de descarga firmadas con caducidad (`private_download_url`) y borrado por prefijo. Comprueba que las imágenes privadas se ven en `<img>` con tu cuenta. **Verificado con Cloudinary real** (ver «Prueba de borrado de cuenta en producción»): subida pública y `authenticated` con `uploadBuffer` y `uploadPrivate`, y borrado por prefijo. El `asset_id` real son 32 caracteres hexadecimales en minúsculas; el código sigue tratándolo como **opaco** (`parseOpaqueAssetId`). **Siguen sin probarse** las URLs firmadas de descarga y la ejecución real del inventario de reconciliación (consume cuota de la Admin API; no se ejecutó). |
| **OpenRouter** | Los modelos por defecto son orientativos. Confirma que existen, que el de visión es multimodal y que admiten salida estructurada (si no, el cliente reintenta sin `response_format`). |
| **Pollinations** | Modelo por defecto, créditos y **calidad real del parecido**. No hay garantía de conservar identidad ni detalles de las prendas. Prueba con tus propias fotos y compara modelos. |
| **Open-Meteo** | Funciona sin clave; su plan gratuito es **solo no comercial**. |
| **Awin** | URL de `feedList` y nombres de columna según su documentación; no se ha visto un feed real de ninguna tienda. El mapeo es configurable. Requiere cuenta de publisher y aprobación de cada anunciante. |
| **SMTP** | Verificación de email y recuperación de contraseña envían por Nodemailer; no probado contra un servidor real. |
| **Vercel** | Despliegue, `maxDuration = 300`, cron y límites de tu plan. Además: `CRON_SECRET` (≥16 caracteres) definido, o los cron responden siempre 401; y la opción **Enable access to System Environment Variables** activada, porque los límites por IP solo confían en `x-forwarded-for` si `VERCEL === "1"` (ver README §13). Ninguna de las dos cosas se ha comprobado en un despliegue real. |
| **Interfaz** | **(Parcialmente superado)** En la Fase I se auditó la accesibilidad con Chrome 148 real por CDP sobre una copia aislada de la app (árbol de accesibilidad, foco, diálogos). Sigue **sin revisarse visualmente** el diseño, los espaciados responsive y las animaciones: revisa cada pantalla en móvil y escritorio. |

## Lo que está implementado (y dónde)

- **Autenticación** (Auth.js v5 beta): registro, login, verificación de email, recuperación, rutas protegidas, perfil. *Auth.js v5 sigue publicándose como beta; es la rama compatible con Next 16.*
- **Onboarding y perfil** completos, editables, con ciudad habitual.
- **Armario:** subida individual, múltiple, cámara móvil, foto con varias prendas (recortes por cuadro delimitador), alta manual, edición, favoritas, disponibilidad, filtros y búsqueda, revisión de datos inciertos. Si la IA falla, la prenda se guarda marcada «por revisar», sin atributos inventados.
- **Estilista:** clima (Open-Meteo, caché 1 h), 3–5 conjuntos, **validación en servidor de que cada prenda es real, del usuario y disponible**, alternativas, favoritos, historial, valoraciones y aprendizaje de preferencias.
- **Probador virtual:** consentimiento explícito exigido en servidor, fotos privadas, generación asíncrona con estados y reintentos, historial, descarga, favoritas, borrado.
- **Completa tu armario:** detección de huecos con IA, productos reales de un catálogo importado, ranking con IA y respaldo determinista, filtros por tienda/marca/precio, distinción visual entre *sugerencia de IA*, *producto encontrado* y *no disponible*.
- **Dashboard:** saludo, clima de hoy, recomendación del día (si ya existe, sin llamar a la IA), resumen del armario, conjuntos recientes y huecos.
- **Cambio de contraseña desde el perfil (fase 20.3):** panel en el perfil y `POST /api/account/password`. Exige contraseña actual y nueva; la confirmación se comprueba solo en cliente y no llega al servidor. Conserva la sesión actual y revoca las demás. Detalle en «Seguridad y robustez».
- **Cuenta:** exportación de datos (JSON) y eliminación definitiva con reautenticación (borra también Cloudinary; si eso falla no borra nada). La eliminación también limpia las filas de reconciliación de medios del usuario (`MediaAsset`).

## Seguridad y robustez (implementado y probado localmente)

Detalle y valores exactos en el README («Seguridad y privacidad»). Resumen de lo que existe hoy:

- **Rate limiting en PostgreSQL** (tabla `RateLimit`, válido entre instancias serverless), sin dependencias externas:
  - **Por IP** en `register`, `forgot-password`, `reset-password` y `verify-email`, y en el login (ventanas de 1 y 15 minutos más un contador de fallos por IP), con un resolutor de IP de cliente de confianza (`src/lib/net`). Sin IP fiable, esos límites no se aplican y, donde existe, solo cuenta el límite por email: registro, recuperación y login. `reset-password` y `verify-email` solo tienen límite por IP.
  - **Por email** en registro, recuperación e inicio de sesión: 3 solicitudes por hora en los dos primeros y 10 intentos cada 15 minutos en el login. Se cuentan tras validar el cuerpo, exista o no la cuenta.
  - **Pseudonimización:** las claves por email son un HMAC derivado de `AUTH_SECRET`; la tabla no guarda el email en claro. Las filas `login:<email>` anteriores no se migran y las elimina la purga.
  - **Por usuario** en mutaciones autenticadas (borrar o editar prendas, borrar o marcar favorita una generación del probador, favorito de conjuntos, consentimiento), antes de validar el cuerpo o tocar datos. **Fail-closed:** si el almacenamiento del limitador falla, la operación se rechaza. `POST /api/auth/logout` no tiene límite.
  - **Purga diaria** de filas caducadas (`/api/cron/rate-limit-purge`, 04:30 UTC, en `vercel.json`): lotes acotados, idempotente y solo con `CRON_SECRET`.
- **Entrada de autenticación:** email de hasta 254 caracteres (medidos tras recortar y pasar a minúsculas), tokens de verificación y restablecimiento de 20 a 64 caracteres y contraseñas nuevas de hasta 72 bytes UTF-8 (límite real de bcrypt; se rechazan, no se truncan). El **inicio de sesión no aplica el límite de 72 bytes** para no bloquear cuentas existentes y mantiene su máximo de 128 caracteres.
- **Cambio de contraseña (20.3):** `POST /api/account/password` aplica, por este orden, autenticación, rate limit `account-password:<userId>` (**5 intentos por hora**, contados también para 422 y contraseñas incorrectas, fail-closed), validación, recuperación del `sid` de la sesión actual (401 si no se obtiene) y servicio. La contraseña **actual** solo se limita a 128 caracteres (para no bloquear credenciales antiguas válidas, como el login); la **nueva** usa el esquema completo, con **72 bytes UTF-8** como tope. La nueva debe diferir de la actual. El hash nuevo se genera fuera de la transacción; después, una transacción hace una **actualización compare-and-set** del hash (409 `CONFLICT` si cambió entretanto) y **revoca las demás sesiones** en la misma transacción, conservando la actual. Errores: 401, 403 `BAD_PASSWORD`, 409 `NO_LOCAL_PASSWORD`, 409 `CONFLICT`, 422 (validación o `SAME_PASSWORD`) y 429.
- **Autenticación y rutas:** sesiones JWT con `Session` revocable en base de datos (la revocación se comprueba en cada `auth()`), login bloqueado hasta verificar el email, y `proxy.ts` que protege las rutas excepto `api/auth`, `api/health`, `api/cron` y estáticos (los cron se autentican con `CRON_SECRET`).
- **Ciclo de vida de imágenes (reconciliación de medios):** detector de huérfanos de **solo lectura** (`/api/cron/media-reconcile`) y reconciliación **persistente** (`/api/cron/media-reconcile/run`, con lease y registro de ejecuciones y de candidatas `MediaAsset`). Respuestas agregadas, sin identificadores ni URLs. **Ninguna de las dos rutas está programada en `vercel.json`** y la reconciliación **no borra nada en Cloudinary**. La retención está en modo `DRY_RUN` y el borrado (`APPLY`) está desactivado en el código (`RETENTION_APPLY_ENABLED = false`); de activarse, borraría exclusivamente filas de seguimiento (`MediaAsset` y `MediaReconcileRun`) en la base de datos, nunca archivos de Cloudinary; activarlo exigiría una fase aprobada expresamente. Estas rutas no se han ejecutado contra Cloudinary real.

## Limitaciones conocidas

- **Verificación de la fase 20.3 (no son defectos bloqueantes):** se añadieron `tests/integration/account-password.test.ts`, `tests/unit/change-password.test.ts` y `tests/unit/password-panel.test.ts`, y se ampliaron `tests/unit/validations.test.ts`. Pendiente: no hay pruebas de interacción React en un entorno DOM (el panel se prueba por su lógica y su renderizado, no con eventos de usuario); no se ha hecho validación visual en navegador; `next build` se verificó después, en la fase 21.1; las pruebas de concurrencia del cambio de contraseña son deterministas por inyección, no peticiones paralelas reales; la cookie `__Secure-` se comprobó con una sonda puntual, sin prueba de integración persistente específica; y las 60 pruebas omitidas siguen requiriendo un PostgreSQL local.

- **Inditex:** no hay API pública de catálogo; sus marcas solo aparecerán con un feed autorizado.
- **Tallas y género** no se usan para filtrar productos.
- **Probador virtual:** recreación con IA, sin garantía de fidelidad; la generación consume créditos de Pollinations.
- **Detección de varias prendas** por cuadros delimitadores del modelo, no segmentación píxel a píxel; si el recuadro es dudoso, la prenda se guarda con la foto completa y marcada para revisión.
- **Progreso de generación:** el proveedor no informa de porcentaje; se muestra tiempo transcurrido.
- **Catálogo:** los precios y la disponibilidad son los de la última sincronización (diaria); la interfaz lo advierte.
- **Rendimiento de la búsqueda del catálogo (fase 20.1, cerrada sin cambios):** se hizo un benchmark **sintético** con PGlite y catálogos de hasta 100.000 productos sobre las consultas reales de `catalogRepository.search`. Con categoría y color el coste es bajo; las consultas solo por categoría o sin color son más costosas a volúmenes altos, porque se lee toda la categoría y se ordena antes del límite. Un índice trigram sobre el nombre empeoró los escenarios medidos. **No se justifican optimizaciones por ahora y no se han cambiado consultas, índices ni migraciones.** Los tiempos de PGlite (WASM) **no son extrapolables a Neon** ni son métricas de producción; el tamaño real del catálogo en producción no se ha consultado. Si el catálogo crece mucho, conviene volver a medir (el `shopping.service` puede lanzar hasta 3 consultas por hueco y hasta 6 huecos por petición).
- **CSP** con `'unsafe-inline'` en scripts (necesario para la hidratación de Next sin nonce).
- **Sin** tests end-to-end de navegador, auditoría de accesibilidad completa, internacionalización (solo español), panel de administración ni cambio de email (el cambio de contraseña sí existe desde el perfil).
- **Datos sensibles:** el perfil guarda edad, altura y fotos. Revisa tu política de privacidad y las bases legales (RGPD) antes de lanzar; el proyecto ofrece las herramientas (consentimiento, exportación, borrado) pero no sustituye asesoría legal.

## Fase I — Auditoría técnica integral (Neon, PrismaNeon, drift, concurrencia, navegador/Orca)

Entorno: PostgreSQL 17 local y desechable en Docker (127.0.0.1:55433, datos en `tmpfs`), proxy WebSocket oficial de Neon (`ghcr.io/neondatabase/wsproxy`) para ejecutar el adaptador real, Chrome 148 con CDP y Orca 46.1. No se usó `.env`, ni Neon, ni datos reales.

**Neon real: BLOQUEADO** *(histórico de la Fase I; superado: ver «Aplicación de 0002 en producción» y «Prueba de borrado de cuenta en producción»)*. `.env` solo apunta a un Neon (pooled y directa) y no existe una base de pruebas aislada; no se tocó. Qué falta: una rama/proyecto de Neon desechable y sus dos URLs (pooled y directa) exportadas como variables de entorno en la sesión de pruebas. Pendiente contra Neon real: latencia, límites del pooler PgBouncer, `connectionTimeoutMillis` frente a cold starts, y el comportamiento en Vercel.

**PrismaNeon (7.10.1 + @neondatabase/serverless 1.2.1): verificado con proxy local** (`tests/integration/neon-adapter-pg.test.ts`, 11 pruebas, opt-in con `TEST_PG_URL`, `TEST_NEON_WSPROXY` y `TEST_NEON_PG_ADDR`): lectura/escritura y tipos, 40 incrementos concurrentes sin pérdidas, transacciones (commit y rollback), 12 transacciones con un pool de 3 sin interbloqueo ni exceder el máximo, recuperación tras cortar todas las conexiones y tras cortar una consulta en vuelo, pool agotado (falla rápido), `$disconnect`, y las formas de error que el código reconoce por estructura (único del email, `lock_timeout` 55P03, `statement_timeout` 57014; antes solo comprobadas con `adapter-pg`).
- Corregido: el pool no tenía `connectionTimeoutMillis` (espera indefinida si se agotaba o la conexión se colgaba). Ahora 10 s (`APP_POOL_OPTIONS`); `max` queda en el valor del driver hasta medir en Neon.
- Corregido: `prisma.config.ts` caía a `DATABASE_URL` (pooler) para migrar si faltaba `DIRECT_URL`. Ahora `migrationUrl()` (`src/lib/prisma/migration-url.ts`) nunca usa una URL del pooler (host `-pooler`) y devuelve un marcador que falla claramente.
- `createPrismaClient()` se exporta para poder probar el mismo camino de producción. El cliente de la app sigue siendo único por proceso (`globalThis`).

**Drift: sin drift.** Con `prisma migrate deploy` sobre una base vacía: ambas migraciones aplicadas, `_prisma_migrations` correcta, `migrate status` al día, `migrate diff` vacío en ambos sentidos (BD real ↔ `schema.prisma`) y contra shadow database (migraciones → esquema), y el esquema resultante (`pg_dump -s`) es idéntico al que construyen los tests aplicando el SQL directamente (salvo la tabla `_prisma_migrations`). Limitación: `migrate diff` solo ve lo que Prisma modela; restricciones o índices manuales (p. ej. parciales) no representados en `schema.prisma` no se detectan por esa vía (aquí coinciden porque ambos caminos ejecutan el mismo SQL).

**Concurrencia real (PostgreSQL 17, varias conexiones):** se ejecutaron las suites existentes (`pg-concurrency`, `pg-token-concurrency`, `rate-limit-purge-pg`: 60/60) y se añadió `tests/integration/pg-auth-concurrency.test.ts` (8 pruebas): `rateLimit` (60 llamadas, límite 25 → 25 pasan, contador exacto), cuota diaria de IA, registro simultáneo (una cuenta, un correo), restablecer contraseña con 5 usos del mismo token, cambio de contraseña simultáneo (CAS + revocación de sesiones), cambio frente a restablecimiento, borrado doble de cuenta y borrado frente a cambio.
- Defecto confirmado y corregido (medio-bajo): dos borrados simultáneos de la misma cuenta hacían que el segundo fallara con `P2025` (500). `account.service.ts` usa ahora `user.deleteMany` (idempotente). Regresión en `pg-auth-concurrency` y en `account-deletion-hygiene`.
- Carrera borrado de cuenta / consumo de token (continuación): `consume` borra el token en autocommit y después `markVerified`/`setPassword` hacían `update`; si la cuenta se borraba en medio, la petición terminaba en `P2025` (500). Reproducida de forma determinista (fila de usuario retenida, token consumido, cuenta borrada y liberada) y corregida: `updateMany` + `count === 0` → el mismo `INVALID_TOKEN` (400) que un enlace muerto. Sin impacto en integridad ni seguridad (solo cambiaba 500 por 400); sin cambio de contrato. Regresión: 2 pruebas en `pg-auth-concurrency`.

**Navegador real (Chrome 148 por CDP) sobre una copia aislada de la app:** sin nombres accesibles vacíos ni ids duplicados en `/dashboard`, `/wardrobe`, `/stylist`, `/try-on`, `/shopping`, `/profile`; landmarks y encabezados correctos; orden de Tab lógico, skip link visible al recibir foco, indicador de foco en todos los controles (los `date`/`time` lo muestran en sus subcampos nativos); el error de login recibe el foco; los diálogos (añadir prendas, eliminar cuenta) son modales (`aria-modal`, nombre, resto inerte), atrapan Tab/Shift+Tab, cierran con Escape y devuelven el foco al botón. **O-6 comprobado:** dos conjuntos con el mismo nombre salen como «Look casual (del historial 1 de 2)» y «… 2 de 2» en el árbol de accesibilidad. **O-1 comprobado a nivel de DOM y AT-SPI:** dos generaciones terminadas con texto idéntico insertan cada una un nodo nuevo en la región `role="status"`, y Orca recibió ambas inserciones por AT-SPI.

**Orca — actualización (2.ª sesión): PARCIAL.** Distinción: *eventos AT-SPI recibidos* sí (inserciones y `children-changed` de la región `role="status"` y `window:activate` de Chrome); *eventos aceptados por Orca* para foco y carga, sí; para las regiones vivas, **no**: Orca los descarta con «Live region source is not in active tab» (`get_active_window` = None), porque el arnés usa emulación de foco de CDP y la ventana no está realmente activa para el compositor. *Locución audible confirmada:* **O-6 sí** (Orca pronunció «Favorito: Look casual (del historial 1 de 2) toggle button no pulsado», «… 2 de 2» y las demás acciones de cada tarjeta, al tabular en `/stylist`); **O-1 no** (ningún anuncio de generación fue pronunciado). Pendiente: ejecutar `scripts/a11y-browser/orca-check.sh` y hacer el clic en Chrome. Arrancar Orca antes que Chrome (como hace el script) es necesario para que Orca vea `window:activate`. *Texto histórico de la 1.ª sesión:* **Orca: PARCIAL / BLOQUEADO por interacción física.** Orca 46.1 arrancó (con preferencias y speech-dispatcher privados, sin sonido) y ve Chrome, pero descarta sus eventos mientras Chrome no sea la ventana activa del compositor («not from active app»), y ninguna herramienta disponible puede activar una ventana de Wayland sin que alguien haga clic. Por tanto **no hay confirmación auditiva (`SPEECH OUTPUT`) de O-1/O-6**. Para completarla: arrancar Chrome y Orca como indica `scripts/a11y-browser/README.md`, hacer clic en la ventana de Chrome y ejecutar `tryon.mjs`. Observación a verificar con voz real: en el 2.º inicio de generación idéntico, Chrome emitió `children-changed:add` con un hijo inválido y sin `text-changed`, así que Orca podría no repetir «Generando tu imagen…» (el anuncio de finalización sí llegó con nodo de texto válido). Tampoco se validaron manualmente tabs, radios, toasts, tooltips ni el selector de ubicación (los radios del probador solo aparecen con consentimiento concedido y datos reales).

**Timeout E2 (`rate-limit-purge-pg`):** clasificado como **contención de recursos + fragilidad del test**, no regresión funcional. El lote 1 borra 5.000 filas con un trigger por fila; en aislado tarda ~480 ms (3/3), y el fallo duró 5,5 s ≈ `statement_timeout` (5 s) con 128 archivos en paralelo. El test aceptaba cualquier error, así que un timeout se confundía con el fallo inyectado; ahora exige el error del gancho (`/fallo controlado del lote/`). No se tocó ningún límite. **Ejecución completa verde con PostgreSQL habilitado:** `npm run check` con `TEST_PG_URL` + proxy: lint y tipos sin errores, 128/128 archivos y 3.210/3.210 tests, 0 omitidos. Una sola ejecución limpia (la reproducibilidad se repite en la sección final de este informe).

**Neon aislado — instrucciones para desbloquear (sin pegar nada en el chat).** No existe una base de pruebas autorizada y `.env` apunta a una sola base; no se usó. Para desbloquearlo: en la consola de Neon crea una **rama desechable** (o un proyecto de pruebas) y copia sus dos cadenas (pooled `…-pooler…` y directa). Expórtalas **solo en tu terminal**, sin pasarlas como argumento de ningún comando, p. ej. `read -rs NEON_TEST_POOLED_URL; read -rs NEON_TEST_DIRECT_URL; export NEON_TEST_POOLED_URL NEON_TEST_DIRECT_URL`, y avísame. Con ellas se ejecutaría: conexión pooled y directa por separado, las pruebas del adaptador PrismaNeon sin proxy, `migrate deploy` solo con la directa y la comprobación de que `migrationUrl()` rechaza la pooled. No hay ningún fichero versionado que contenga URLs. **Neon real: NO probado.**

**Estado global de la Fase I: APROBADO CON BLOQUEOS EXPLÍCITOS** — pendiente Neon real (recurso externo no autorizado) y la locución de O-1 con Orca (requiere un clic en la ventana). No se declara la fase completamente aprobada. *(Histórico: Neon real se comprobó después y O-1/O-6 constan como aprobados por validación del responsable; el veredicto vigente está en el «Resumen consolidado».)*

## Estabilización técnica final

Resultado: **APROBADO CON BLOQUEOS EXPLÍCITOS** (ver «Qué falta»). *(Estado a la fecha de esta sección: el bloqueo de `0002` se resolvió después; ver «Aplicación de 0002 en producción».)* No se hicieron commits, push, migraciones ni escrituras en producción.

### Qué se inspeccionó
Rama `main` (HEAD `c6a0f6b`) con los cambios de la Fase I sin commitear (preservados), `package.json`, Prisma 7, PrismaNeon, autenticación, cron, cabeceras y suites de pruebas. Entorno de pruebas: PostgreSQL 17.12 local y desechable (Docker, `127.0.0.1:55433`, datos en `tmpfs`, contraseña aleatoria) y el proxy WebSocket oficial de Neon con `ALLOW_ADDR_REGEX` restringido a la IP de ese PostgreSQL (no puede alcanzar otros destinos). Ambos contenedores se eliminaron al terminar.

### Defectos confirmados y corregidos
| # | Defecto | Reproducción | Corrección | Regresión |
|---|---|---|---|---|
| 1 | `migrationUrl()` aceptaba un `DIRECT_URL` del pooler (solo filtraba el respaldo `DATABASE_URL`) | Prueba unitaria roja antes de corregir | Ambas variables se descartan si son del pooler; sin ninguna válida se devuelve el marcador que falla | `tests/unit/prisma-urls.test.ts` |
| 2 | `/api/cron/catalog-sync` tenía su propia autorización: comparaba longitudes en **caracteres**; una cabecera con la misma longitud y distinta en bytes lanzaba `RangeError` → **500** en vez de 401 | Prueba roja (`RangeError: Input buffers must have the same byte length`) | Usa `isAuthorizedCron` (como los demás cron) | `tests/unit/cron-catalog-sync-auth.test.ts` (3) |
| 3 | `media-reconcile`: un `setTimeout` puede disparar ~1 ms antes del plazo según `Date.now()` (medido: 45 de 3.000). Tras agotar el presupuesto en `upload`, el inventario `authenticated` seguía leyendo. El informe salía igualmente incompleto (ninguna candidata, sin riesgo de borrado), pero el recuento de retenidas era no determinista. Provocó un fallo real e intermitente (1 de 6 ejecuciones completas) | Determinista, simulando `Date.now` (2 en vez de 1) | El `TIME_BUDGET` es definitivo para los tipos siguientes (`inventory()`) | Prueba nueva en `tests/integration/media-reconcile.test.ts` |

### Mitigación basada en hipótesis (causa NO confirmada)
En la primera ejecución completa falló una vez `neon-adapter-pg` («pool agotado») con un `P2028` sin capturar; no se reprodujo en 3 ejecuciones aisladas ni con CPU saturada, y no se conservó la salida. Hipótesis: los titulares de transacción usan el `maxWait` por defecto de Prisma (2 s) y bajo la carga de la suite completa el handshake WebSocket tarda más. Se acotó `maxWait` a 20 s, se captura el fallo del titular y se exige que no haya ocurrido. No reduce cobertura. Tras ello, las ejecuciones completas 3, 5 y 6 pasaron y la 4 falló por otra causa (defecto 3); esto **no demuestra** que la causa fuera la hipótesis.

### Pruebas ejecutadas (resultados exactos)
- `npm run lint` y `npm run typecheck`: sin errores.
- Con PostgreSQL local + proxy: 6 ejecuciones completas de `vitest run`, en este orden: 1) **1 fallo** (`neon-adapter-pg`, ver arriba; 3.214 pruebas); 2) verde (129/129, 3.214); endurecimiento del test de `neon-adapter-pg`; 3) verde; 4) **1 fallo** (`media-reconcile`, defecto 3); corrección del defecto 3; 5) y 6) verdes (**129/129 archivos, 3.215/3.215 pruebas**, 0 omitidas). Los dos fallos aparecieron en ejecuciones completas y no en las aisladas; solo las ejecuciones 5 y 6 corresponden al código final, así que la reproducibilidad del estado final se apoya en **2** ejecuciones completas (más 3 de `neon-adapter-pg` y 2 de `media-reconcile` aisladas), no en una demostración estadística.
- `npm run check` **sin** PostgreSQL: 124 archivos correctos y 5 omitidos; 3.120 pruebas correctas y 95 omitidas (a esa fecha; 3.121 desde la fase de `0002`). Los 5 omitidos son `pg-concurrency`, `pg-token-concurrency`, `pg-auth-concurrency`, `rate-limit-purge-pg` y `neon-adapter-pg`. **Omitidas no significa aprobadas**: solo cuentan como verificadas en las ejecuciones con PostgreSQL.
- `npm run build` en copia aislada (sin `.env`, variables ficticias): exit 0. Verifica compilación, no runtime.
- `git diff --check`: limpio. Sin secretos añadidos al diff.

### Neon de producción (solo lectura)
Sesión `READ ONLY`, sin imprimir URLs ni hosts, solo catálogos del sistema y recuentos de integridad:
- **Configuración:** `DATABASE_URL` es del pooler y `DIRECT_URL` es directa (distintas); ambas con `sslmode=require`.
- **PostgreSQL 18.7** en producción, frente a 17.12 en las pruebas locales (diferencia de versión mayor no cubierta por las pruebas).
- **Esquema:** 21 tablas, 56 índices de aplicación, 19 claves foráneas, 21 claves primarias, 6 enums, 0 índices inválidos. Integridad referencial: 19 FK comprobadas, **0 filas huérfanas**.
- **Migraciones: solo `0001_init` aplicada** *(a esa fecha; superado)*. `prisma migrate diff` (BD real → `schema.prisma`) produce exactamente el contenido de `0002_media_reconcile_persistence` (3 tablas, 5 enums, índices, 3 FK; los CHECK y la fila semilla del lease no los modela Prisma). **Producción estaba atrasada una migración** (resuelto después: ver «Aplicación de 0002 en producción»).
- **PrismaNeon por el pooler** con el cliente real de la app: conexión correcta, `SELECT 1` ≈ 31 ms, primera consulta con conexión ≈ 370–390 ms, 15 consultas concurrentes con pool de 10 sin errores, transacción interactiva `READ ONLY` correcta y error de tabla inexistente con el código esperado (`P2010`).
- **Impacto de la migración pendiente:** `accountService.delete` ejecuta `mediaAsset.deleteMany` en la misma transacción, así que **el borrado de cuenta falla en producción** hasta aplicar `0002`. Los cron de reconciliación no están programados en `vercel.json`, por lo que no se ven afectados.
- **No probado en Neon:** escrituras, concurrencia, rate limiting, borrado de cuentas y transacciones bajo carga (por seguridad, solo en PostgreSQL local).

### Diferencias entre local y producción
PostgreSQL 17.12 frente a 18.7; `adapter-pg` / proxy WebSocket local frente al pooler PgBouncer de Neon (latencia, límites de conexiones y cold starts reales sin medir); `0002` aplicada en local y no en producción.

### Auditorías H.5–H.9 (reconstruidas desde Git y las pruebas)
H.5–H.9 son las fases de accesibilidad (commits `22c79d5`, `40c6a09`, `77c657b`, `8d7e8b6`, `c6a0f6b`). Identificadores recuperados, todos con prueba de regresión que **pasa**: H5-01 a H5-04 (avisos), H6-01 (`--toast-inset`), H7-02, H7-04 y H7-05 (contraste), H8-01 a H8-06 (tooltips, enlaces de compra, estilista, anuncios). **No se pudieron recuperar** los identificadores H7-01, H7-03 ni H6-02/H6-03 como tales (aparecen solo como secciones en `globals.css`), ni el informe de H.9 como documento; no se asume que estén resueltos más allá de lo que cubren las pruebas. Limitación ya documentada en las propias pruebas: jsdom no es un lector de pantalla.

### Orca O-1 y O-6: APROBADOS
Por validación del responsable del proyecto posterior a las sesiones de la Fase I. No se repitió Orca ni `orca-check.sh` en esta fase. Esto sustituye el «PARCIAL / pendiente de O-1» de la Fase I; esa aprobación procede de la validación manual indicada, no de una ejecución de esta fase.

### Seguridad revisada (sin defectos adicionales confirmados)
- **Cron:** los 4 cron usan ahora `isAuthorizedCron` (tiempo constante, sobre bytes, sin secreto → siempre denegado).
- **Cabeceras:** CSP, HSTS, `X-Frame-Options`, `nosniff`, `Referrer-Policy` y `Permissions-Policy` presentes; API sin caché. Persiste `'unsafe-inline'` en `script-src` (ya documentado).
- **CSRF/cookies (riesgo teórico, sin cambios):** no hay token CSRF propio; se confía en las cookies de Auth.js (SameSite=Lax, HttpOnly) y en que las mutaciones son JSON. No se verificó el valor de las cookies en un despliegue real.
- **Rutas y secretos:** `proxy.ts` excluye solo `api/auth`, `api/health`, `api/cron` y estáticos; los secretos no se copiaron a archivos versionados.

### Riesgos abiertos
1. ~~`0002` sin aplicar en producción~~ *(superado: aplicada y verificada)*.
2. Neon real sin pruebas de escritura/concurrencia (falta una rama desechable de Neon) y PostgreSQL 18 sin cubrir por las pruebas locales.
3. La causa del fallo intermitente de `neon-adapter-pg` no está confirmada.
4. `'unsafe-inline'` en CSP; ausencia de CSRF explícito.
5. Aviso de Vite por `vitest.config.ts` (ESM cargado como CJS), sin impacto.

### Qué falta para cerrar la estabilización *(histórico; ver «Resumen consolidado»)*
Aplicar `0002` en producción (tras tu confirmación), idealmente probándola antes en una rama de Neon desechable; ejecutar entonces las pruebas del adaptador sin proxy y el borrado de cuenta con datos de prueba; y, si se desea, probar con PostgreSQL 18 local.

## Revisión y validación de la migración 0002 (fase adicional)

**Estado histórico de esta sección: 0002 aún no estaba aplicada en producción cuando se escribió** (se aplicó después; ver «Aplicación de 0002 en producción»). En Neon solo se hicieron lecturas. Todo lo siguiente se ejecutó en PostgreSQL 18.7 (la versión de producción) local y desechable.

### Qué hace `0002_media_reconcile_persistence` (revisada íntegra)
Un único `migration.sql` de 10 KB, sin sentencias `DROP`, `ALTER` de tablas existentes, `UPDATE` ni `DELETE`. Crea:
- **5 enums:** `MediaReconcileRunKind`, `MediaReconcileRunStatus`, `MediaDelivery`, `MediaAssetKind`, `MediaAssetState`.
- **3 tablas:** `MediaReconcileLock`, `MediaReconcileRun`, `MediaAsset`.
- **12 índices** (9 `CREATE INDEX`, 4 de ellos únicos, más las 3 claves primarias de las tablas) y **3 claves foráneas**, todas entre tablas nuevas (`MediaAsset` → `MediaReconcileRun` ×2 y `MediaReconcileLock` → `MediaReconcileRun`). `MediaAsset.ownerUserId` **no** tiene FK a `User` (a propósito).
- **18 restricciones CHECK** manuales (3 en `Lock`, 6 en `Run`, 9 en `MediaAsset`).
- **1 `INSERT`:** la fila semilla del lease (`name='media-reconcile'`, `fencingToken=0`, sin dueño), con `ON CONFLICT DO NOTHING`.

### Entorno de validación y su aislamiento
Contenedor `postgres:18.7-alpine` con `--network none` (solo interfaz `lo`; sin acceso a Internet comprobado con `wget`), sin puertos publicados, sin volúmenes, `privileged=false` y datos en `tmpfs`. PostgreSQL escuchaba solo en `127.0.0.1` del propio contenedor y se accedía desde el host con un puente local (`docker exec … nc`) en `127.0.0.1`. Los comandos de Prisma usaron una configuración propia que **no carga `.env`** y con las variables `DATABASE_URL` y `DIRECT_URL` desactivadas. Para las suites de pruebas de la aplicación, que necesitan alta concurrencia, se usó otro contenedor 18.7 en bridge publicado solo en `127.0.0.1:55433`, sin montajes ni credenciales de Neon (este sí tiene red de salida). Todos los contenedores, puentes y contraseñas se eliminaron al terminar.

### Resultados
| Escenario | Resultado |
|---|---|
| **A. Base vacía**, `prisma migrate deploy` | 0001 y 0002 aplicadas sin errores: 24 tablas, 68 índices, 22 FK, 11 enums, 18 CHECK, 0 índices inválidos, fila semilla presente (`fencingToken=0`). `migrate status`: al día |
| **A. `migrate diff`** (con `--exit-code`) | Sin diferencias (código 0) en los 4 sentidos: BD → `schema.prisma`, `schema.prisma` → BD, migraciones → `schema.prisma` (shadow DB) y BD → migraciones |
| **A. SQL directo con `psql`** (`ON_ERROR_STOP`) | Sin errores; `pg_dump -s` **idéntico** al de la ruta Prisma (538 líneas, sin `_prisma_migrations`) |
| **A. Comportamiento de los CHECK en 18.7** | 25 comprobaciones dentro de una transacción revertida (2 inserciones válidas por tipo y 23 violaciones: formato de `publicId`, propietario, tipo/carpeta, entrega, `graceHours` NaN/0,5/9000, caracteres invisibles `U+200B`, estados `COMPLETED`/`CONFIRMED`, duplicados, FK, `RESTRICT`…): todas se comportan como se espera. Mi script esperaba `23503` para `ON DELETE RESTRICT` y PostgreSQL 18 devuelve `23001`; el borrado sí se bloquea |
| **B. Estado de producción**: solo `0001` + datos sintéticos (50 usuarios, 50 perfiles, 500 prendas, 200 filas de `RateLimit`), luego `migrate deploy` | Aplica **solo** `0002`. Datos preexistentes **idénticos** (recuento y md5 por tabla), columnas e índices de las tablas existentes idénticos, inventario igual que en A, `migrate status` al día y los 3 `migrate diff` sin diferencias |
| **Bloqueos** | Medidos dentro de una transacción revertida: **0 bloqueos sobre objetos existentes** (39 sobre objetos nuevos). La migración no espera ni bloquea a los usuarios |
| **Checksum de 0001 en producción** (lectura) | Coincide con el archivo actual (`true`); sin migraciones fallidas, sin sesiones activas ni bloqueos en espera |

### Transaccionalidad y fallos a mitad (hallazgo)
- **`prisma migrate deploy` NO ejecutó `0002` de forma atómica.** Con un error inyectado al final del SQL (`SELECT 1/0`, después de la fila semilla) quedaron **todos** los objetos creados (3 tablas, 5 enums, 12 índices, 3 FK, 18 CHECK y la semilla), la migración quedó registrada como fallida (`finished_at` nulo) y el siguiente `deploy` se negó a continuar (**P3009**). Lo mismo con `psql --single-transaction` dejó **0** objetos.
- **Recuperación probada (ruta Prisma):** aplicar `DROP TABLE`/`DROP TYPE` de los objetos de 0002 (script de abajo) y `prisma migrate resolve --rolled-back 0002_media_reconcile_persistence`, y luego `migrate deploy`: aplicó 0002, `status` al día, `migrate diff` sin diferencias y datos previos intactos. `_prisma_migrations` conserva la fila del intento fallido, marcada como revertida (3 filas en total).
- **Reejecución:** el SQL **no es idempotente** salvo la semilla: ejecutarlo sobre una base que ya tiene `0002` falla en la primera sentencia (`type "MediaReconcileRunKind" already exists`) sin efectos. Prisma no lo reejecuta mientras figure como aplicada.
- **Alternativa atómica probada:** `psql -1 -v ON_ERROR_STOP=1 -f 0002…/migration.sql` + `prisma migrate resolve --applied 0002_media_reconcile_persistence`. El checksum registrado es **idéntico** (`29bb5808…fe6f4`) al de `migrate deploy`, `status` queda al día y `migrate diff` sin diferencias. Con un fallo inyectado no deja restos.

### Defecto confirmado y corregido: SQLSTATE de `ON DELETE RESTRICT` en PostgreSQL 18
Medido con la misma sentencia mínima en 17.12 y 18.7: una violación de `ON DELETE RESTRICT` devuelve `23503` en 17.12 y **`23001` (`restrict_violation`) en 18.7**; `NO ACTION` devuelve `23503` en ambas. `classifyRetentionError` (`src/services/media-retention.service.ts`) solo reconocía `23503`, así que en producción una violación de FK de la retención se habría informado como `retention/DB_ERROR` en vez de `retention/FK_VIOLATION`. Efecto limitado a la etiqueta del error: el lote se deshacía igualmente (`STOPPED`, 0 borradas) y el borrado real (`APPLY`) sigue desactivado en el código. Detectado porque la prueba de `pg-concurrency` falló solo en 18.7. Corregido aceptando también `23001`; regresión en `tests/unit/media-retention-public.test.ts` (falla sin la corrección, pasa con ella). Además, `rate-limit-purge-pg` fijaba la versión `17`; ahora acepta 17 o 18.

### Pruebas en PostgreSQL 18.7 de la aplicación
- Suites PG-only (`pg-concurrency`, `pg-token-concurrency`, `pg-auth-concurrency`, `rate-limit-purge-pg`, `test-db-migrations`): **97/97**, dos ejecuciones consecutivas. Antes de la corrección había 2 fallos (el 17 fijado y el `23001`).
- Suite completa con PG 18.7 y el proxy WebSocket (adaptador `@prisma/adapter-neon`): **129/129 archivos y 3.216/3.216 pruebas**, 0 omitidas. Sin PG: 124 archivos y 5 omitidos; 3.121 pruebas pasan y 95 se omiten. `lint` y `tsc` sin errores.
- Un primer intento con un puente `docker exec` sobre el contenedor sin red dio timeouts por lentitud del puente (no es un resultado válido y se descartó; no se usó para ninguna conclusión).

### Limitaciones de esta validación
- No se ha comprobado contra Neon real (ni siquiera una rama de Neon): PgBouncer, latencia y límites del pooler siguen sin probar con escrituras. La migración usa solo DDL estándar y se comporta igual en 17.12 y 18.7, pero Neon podría tener restricciones propias (extensiones, roles, `statement_timeout`) no reproducidas aquí.
- Los datos de la prueba B son sintéticos y pequeños (800 filas): no miden duración con datos reales. `0002` no escanea tablas existentes, así que su coste no depende de su tamaño.

### Procedimiento propuesto para aplicar 0002 en producción *(propuesto aquí; **ejecutado después**, ver «Aplicación de 0002 en producción»)*
Recomendado: **ruta atómica**, porque `migrate deploy` no es transaccional.
1. **Punto de restauración:** crear en la consola de Neon una rama (o anotar la marca de tiempo para restauración) del estado actual. No modifica datos.
2. **Comprobar el estado (lectura):** `migrate status` debe mostrar solo `0002` pendiente y ninguna migración fallida; checksum de `0001` ya verificado.
3. **Aplicar el SQL en una transacción** con la **conexión directa** (nunca el pooler): `psql "$DIRECT_URL" -v ON_ERROR_STOP=1 --single-transaction -f prisma/migrations/0002_media_reconcile_persistence/migration.sql`. Si falla, no queda nada y no hay que recuperar nada.
4. **Registrarla en Prisma:** `npx prisma migrate resolve --applied 0002_media_reconcile_persistence` (una única escritura en `_prisma_migrations`).
5. **Verificar (lectura):** `migrate status` al día; `migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` = 0; recuentos 24 tablas, 22 FK, 68 índices, 11 enums, 18 CHECK, 0 índices inválidos y la fila semilla.
6. **Probar el borrado de cuenta** con una cuenta de prueba creada para ello (decisión tuya; implica escrituras de un usuario de prueba).
- **Si usas `migrate deploy` en vez de la ruta atómica y falla a mitad:** aplicar el script de reversión siguiente, `prisma migrate resolve --rolled-back 0002_media_reconcile_persistence`, y reintentar.

```sql
-- Reversión de 0002 (probada en PG 18.7): solo elimina objetos que 0002 crea.
BEGIN;
DROP TABLE IF EXISTS "MediaReconcileLock";
DROP TABLE IF EXISTS "MediaAsset";
DROP TABLE IF EXISTS "MediaReconcileRun";
DROP TYPE IF EXISTS "MediaAssetState";
DROP TYPE IF EXISTS "MediaAssetKind";
DROP TYPE IF EXISTS "MediaDelivery";
DROP TYPE IF EXISTS "MediaReconcileRunStatus";
DROP TYPE IF EXISTS "MediaReconcileRunKind";
COMMIT;
```
Esa reversión solo es segura **antes** de que la aplicación o los cron escriban en esas tablas: después contendría datos.

### Riesgos residuales
1. ~~0002 sigue sin aplicar~~ *(superado: aplicada; el borrado de cuenta se probó en producción)*.
2. Sin prueba contra Neon real con escrituras (ni PgBouncer ni rama desechable).
3. `migrate deploy` no es atómico (mitigado con la ruta recomendada).
4. Otras diferencias entre PostgreSQL 17 y 18 pueden existir fuera de lo cubierto por las pruebas; se detectó una (`23001`) y se corrigió.

## Aplicación de 0002 en producción (28-nov-2026)

**Veredicto: aplicada correctamente.** Autorizada expresamente por el responsable del proyecto, directamente en la rama principal de Neon (sin rama intermedia). Escrituras realizadas, y solo estas: el DDL de `0002` y una fila en `_prisma_migrations`. No se tocó ningún dato de usuarios, `.env` ni variables desplegadas, ni se ejecutaron otras migraciones. El borrado de cuentas **no** se probó.

### Comprobaciones previas (solo lectura, todas coincidieron)
- `DIRECT_URL` no es del pooler; `DATABASE_URL` es el pooler del **mismo endpoint** (el que usa la app); mismo host que en las lecturas anteriores de la sesión; `sslmode=require`; instancia primaria (no réplica).
- Solo `0001_init` registrada, terminada, sin migraciones fallidas ni revertidas, y checksum igual al del archivo local.
- Esquema exactamente el de `0001`: 21 tablas, 56 índices, 19 FK, 6 enums, 0 CHECK, ningún objeto `Media*`; la huella de columnas coincide con la de una base creada solo con `0001`.
- Sin otras sesiones activas, sin bloqueos en espera, sin transacciones preparadas.
- SQL de `0002`: sha256 `29bb5808…fe6f4` (idéntico al validado en PostgreSQL 18.7), 10.130 bytes, versionado en git y sin cambios, sin `DROP`/`UPDATE`/`DELETE`.
- **Recuperación (comprobación parcial):** el servidor expone el almacenamiento con historial de Neon (`neon.timeline_id`, `neon.branch_id`). Punto de restauración registrado antes de escribir: **2026-11-28 11:18:09 UTC, LSN `0/1FFD3A8`**. Para usarlo: consola de Neon → rama principal → *Restore* a esa marca de tiempo (o crear una rama desde ese instante para revisarla antes). **No se pudo verificar la ventana de retención de tu plan** (no es visible por SQL ni hay clave de API en la sesión); la operación era atómica y solo aditiva, y existe el script de reversión probado de la sección anterior. «Rama principal» se identifica por ser el endpoint al que apunta la app; sin la API de Neon no se puede certificar de otro modo.

### Comandos ejecutados (sin secretos; la URL llegó por variable de entorno)
1. Lecturas previas y posteriores con `pg`, sesión `READ ONLY` (scripts en el scratchpad de la sesión, fuera del repositorio).
2. `psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f prisma/migrations/0002_media_reconcile_persistence/migration.sql` con el cliente de la imagen `postgres:18.7-alpine`. Código de salida **0**: 5 `CREATE TYPE`, 3 `CREATE TABLE`, 9 `CREATE INDEX`, 21 `ALTER TABLE` (3 FK y 18 CHECK) e `INSERT 0 1` (semilla).
3. `npx prisma migrate resolve --applied 0002_media_reconcile_persistence` → «marked as applied».

### Verificación posterior
- `prisma migrate status`: **«Database schema is up to date!»** (2 migraciones).
- `prisma migrate diff --exit-code`: BD → `schema.prisma` y `schema.prisma` → BD, ambos **«No difference detected»** (código 0). El diff «BD → migraciones» requiere una shadow database y no se ejecutó en producción (se había comprobado en local).
- `_prisma_migrations`: 2 filas, ambas terminadas y no revertidas, con checksums iguales a los de los archivos; el de `0002` es `29bb5808…fe6f4`, el validado. La fila de `0002` tiene `applied_steps_count = 0` y `logs` vacío, que es la forma en que `resolve --applied` registra una migración aplicada externamente (a diferencia de `0001`, que tiene 1 paso).
- Esquema: **24 tablas, 68 índices, 22 FK, 11 enums, 18 CHECK, 23 PK**, igual que en el entorno validado; 0 índices inválidos y 0 restricciones sin validar. Los 18 CHECK son los de `0002`.
- Fila semilla: `MediaReconcileLock` con 1 fila (`media-reconcile`, `fencingToken=0`, sin dueño ni expiración). `MediaAsset` y `MediaReconcileRun` vacías.
- Tablas existentes: huella de columnas y de índices **idéntica** a la previa y recuento de filas idéntico en las 21 tablas (22 filas en total). Integridad: 22 FK comprobadas (1 compuesta, no verificable por recuento simple), **0 filas huérfanas**. Sin sesiones activas ajenas después.
- **PrismaNeon por el pooler**, cliente real de la app, solo lectura: transacción `READ ONLY` correcta; `mediaReconcileLock.findMany` (1 fila), `mediaAsset` y `mediaReconcileRun` (`count` y `findMany` = 0), lecturas de las tablas existentes, 5 lecturas secuenciales de ≈33–35 ms y 12 lecturas concurrentes sin errores.

### Estado final y riesgos residuales
Producción tiene `0001_init` y `0002_media_reconcile_persistence` aplicadas y coincide con `schema.prisma`. Riesgos que siguen abiertos:
1. ~~No se probó el borrado de cuenta en producción~~: **probado después** con una cuenta de prueba (ver «Prueba de borrado de cuenta en producción»).
2. Ventana de recuperación de Neon sin verificar (plan no visible desde la sesión).
3. Pruebas de escritura y concurrencia solo en PostgreSQL local (17.12 y 18.7); PgBouncer y los límites reales del pooler bajo carga siguen sin medirse.
4. Los cron de reconciliación siguen sin programarse en `vercel.json` y la retención sigue en `DRY_RUN` (sin cambios).
5. El script de reversión solo es seguro mientras `MediaAsset`, `MediaReconcileRun` y `MediaReconcileLock` no contengan datos de la aplicación.

## Prueba de borrado de cuenta en producción (28-nov-2026)

**Veredicto: correcta.** Autorizada expresamente (variante A+, solo las operaciones enumeradas). Se ejecutó `accountService.delete` con el cliente de producción de la aplicación (PrismaNeon por el pooler) y Cloudinary real, sobre **un único usuario de prueba** creado por el propio script. No se arrancó el servidor, ni se invocó ningún cron, retención ni reconciliación real, ni se tocó `.env`, esquema o migraciones.

### Aislamiento
- Usuario `estab-<hex>@example.invalid` con id cuid generado por Prisma, contraseña aleatoria solo en memoria; el script se negaba a continuar si el id coincidía con uno de los 2 usuarios preexistentes o el email no terminaba en `@example.invalid`.
- Los 2 usuarios preexistentes: ids, nombres y correos **no se leyeron ni se imprimieron**; sus huellas se calcularon dentro de la base (`md5` por tabla) y no salieron de ella.
- Cloudinary: solo bajo `ai-wardrobe/<id-de-prueba>/`; los `public_id` devueltos se comprobaron contra ese prefijo antes de cualquier borrado. Ningún borrado ni listado fuera de él.
- Hora de ejecución 11:25 UTC, fuera de la ventana 04:00–04:45 de los cron programados (que además no han corrido nunca contra esta base: `CatalogSync` vacía y `RateLimit` con filas de más de 24 h).

### Operaciones y resultados
| Paso | Resultado |
|---|---|
| Alta del usuario con datos sintéticos (perfil, prenda, conjunto y elementos, feedback, historial, preferencia, favorito, imagen generada, compra y producto, log de IA, sesión, token, clave `RateLimit`) | Creados; todas las tablas relacionadas con ≥ 1 fila |
| 2 PNG de 1×1 a Cloudinary (1 público, 1 `authenticated`) con `uploadBuffer` y `uploadPrivate` de la app | Ambos bajo el prefijo de prueba |
| 1 ejecución `MediaReconcileRun` de prueba (`fencingToken = 2000000000`, `FAILED`) y 2 `MediaAsset` del usuario | Aceptados por los CHECK y las FK en Neon real |
| Línea base | Cloudinary: exactamente 1 recurso por tipo bajo el prefijo |
| **Prueba negativa** (contraseña incorrecta) | **403 `BAD_PASSWORD`**; ninguna fila ni recurso borrado |
| **`accountService.delete` con la contraseña correcta** | Sin error, **1,8 s** |
| Verificación | Usuario y las 17 tablas/relaciones comprobadas a 0 (incluidas `OutfitItem`, `ShoppingProduct`, sesiones, `VerificationToken`, `RateLimit '%:<id>'` y `MediaAsset`); los 2 `MediaAsset` por id exacto inexistentes; Cloudinary: **0 recursos bajo el prefijo en ambos tipos** |
| Limpieza de la ejecución de prueba por id exacto (`id`, `fencingToken` y `codeVersion`) | 1 fila eliminada; `MediaReconcileRun` vuelve a 0 filas |
| Datos preexistentes | Huella (recuento + md5) de las **25 tablas idéntica a la línea base**; los 2 usuarios siguen existiendo; migraciones `0001` y `0002` registradas y terminadas |

### Observaciones
- **Dos comprobaciones fallaron por un error de mi script, no del sistema:** «el recurso responde 404 por id exacto». El SDK de Cloudinary rechaza con `{ error: { http_code: 404 } }` y el script leyó `e.http_code`. Se verificó después, con lecturas sobre el prefijo de prueba, que ambos tipos devuelven 0 recursos y que un id inexistente produce `e.error.http_code = 404`. Resultado del script: 23/25; las 2 restantes quedan explicadas, no ignoradas.
- No se confirmó que la carpeta `ai-wardrobe/<id>/` de Cloudinary se eliminara (el servicio la borra «a mejor esfuerzo»; comprobarlo exigía listar subcarpetas, que incluye ids de otros usuarios, y se evitó).
- **`asset_id` real de Cloudinary:** cadena de 32 caracteres hexadecimales en minúsculas. Cumple la `CHECK` de `MediaAsset` y el análisis opaco del código. Queda confirmado para este formato, aunque el código sigue sin asumirlo.
- Los listados de Cloudinary son eventualmente consistentes: el script sondea hasta 20 s antes de dar un resultado por válido.

### Qué NO cubre esta prueba
- La ruta HTTP `DELETE /api/account`, la autenticación por cookie, el rate limit `account-delete:<id>` y el CSRF (solo se ejecutó el servicio; esas capas tienen pruebas locales).
- El envío de correo (no hay SMTP configurado y el borrado no envía correos).
- Carga o concurrencia real de borrados contra Neon; la concurrencia solo está probada en PostgreSQL local.
- Borrado de cuentas con muchas imágenes (el bucle de 50 páginas por tipo de `deleteAllUserAssets` no se ejercitó).
- Cuentas con inicio de sesión OAuth (`Account`): no se creó ninguna.

### Estado de lo creado
Nada de lo creado queda en la base ni en Cloudinary: usuario, datos relacionados, `MediaAsset`, ejecución de prueba y los 2 PNG están eliminados. El id del usuario de prueba era `cmx0bqe8c0000u53slmoklxmh` (sin información personal). Lo único que persiste son los efectos inevitables de la operación sobre `_prisma_migrations` (ninguno: sin cambios) y el consumo de unas pocas llamadas a la Admin API de Cloudinary.

## Cierre de la Fase I: auditoría final (28-nov-2026)

**Veredicto: APROBADO CON OBSERVACIONES.** Auditoría de solo lectura del árbol de trabajo y comprobaciones locales; sin commits, sin `git add`, sin conexión a Neon ni a Cloudinary, sin cron, retención ni reconciliaciones, y sin tocar `.env`. Las variables de bases de datos y de pruebas PostgreSQL se desactivaron explícitamente en cada comando.

### Estado del repositorio
Rama `main`, HEAD `c6a0f6b`, 0 commits por delante o por detrás de `origin/main`, nada en el índice, sin stash. **13 archivos modificados** (311 inserciones y 31 borrados) y **6 entradas sin versionar que expanden a 12 archivos** (`scripts/a11y-browser/`, con 7 archivos, y 5 archivos más); ninguno eliminado. Ningún secreto, URL de conexión real, correo personal, binario ni archivo temporal en los 25 archivos pendientes (las únicas URLs con forma de Neon son ficticias, en `tests/unit/prisma-urls.test.ts`); `.env`, `.env.local`, `.next`, `.vitest` y `tsconfig.tsbuildinfo` están ignorados por git; los archivos nuevos no tienen problemas de espacios ni de finales de línea.

### Comprobaciones locales (cifras exactas)
| Comprobación | Resultado |
|---|---|
| `git diff --check` y comprobación equivalente en los 12 archivos nuevos | Sin errores |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm test` (PGlite, sin PostgreSQL externo) | exit 0: **124 archivos correctos y 5 omitidos; 3.121 pruebas correctas y 95 omitidas** |
| `npm run build` aislado (copia sin `.env*`, variables ficticias, `localhost`) | exit 0, compilado y 40/40 páginas |
| Suites PostgreSQL (`pg-concurrency`, `pg-token-concurrency`, `pg-auth-concurrency`, `rate-limit-purge-pg`, `neon-adapter-pg`) | **No se ejecutaron en el cierre** (no hay un PostgreSQL local aislado en marcha: el contenedor existente no tiene red ni puertos, y crear otro no estaba autorizado). Última ejecución completa con PostgreSQL 18.7 y proxy: 129/129 archivos y 3.216/3.216 pruebas. El último cambio de código (12:02 local) es anterior a esa ejecución; desde entonces solo cambió `docs/ESTADO.md` |

Los 95 omitidos son siempre los de las 5 suites PostgreSQL de la fila anterior: **omitidas no equivale a aprobadas** en esa ejecución.

### Incidencias (ninguna crítica ni alta)
**Media**
- **M1 — Sin CI y 95 pruebas fuera de `npm test`.** *(Parcialmente superado: ver «Fase 1: integración continua»; el workflow existe pero no está validado en GitHub.)* No existe `.github`, otro CI ni hooks de git. Las 5 suites PostgreSQL solo se ejecutan a mano. Dos defectos de esta fase (el SQLSTATE `23001` de PostgreSQL 18 y la carrera del presupuesto de tiempo del detector) solo salieron al ejecutarlas. Impacto: una regresión de concurrencia o de compatibilidad con PostgreSQL 18 no se detectaría automáticamente.
- **M2 — `deleteAllUserAssets` (anterior a esta fase, fuera del diff).** Tras 50 iteraciones por tipo de entrega continúa sin error aunque Cloudinary siga indicando `partial`, y el servicio borra la cuenta igualmente. Impacto: en una cuenta con un volumen de imágenes muy grande podrían quedar fotos sin propietario en Cloudinary, sin aviso. No se ha ejercitado ese límite ni con Cloudinary real ni en pruebas.

**Baja**
- **B1 — Marcador de `migrationUrl()`.** Sin una URL directa válida, Prisma falla con `P1001 Can't reach database server at localhost:5432` (base «placeholder»), un mensaje que no menciona el pooler ni la variable. No conecta con nada real (demostrado con valores ficticios), pero el comentario del código lo describe como «falla de forma evidente».
- **B2 — Salvaguardas de los tests PostgreSQL nuevos.** `pg-auth-concurrency` y `neon-adapter-pg` solo exigen que el host sea local (`isLocal`), no que el servidor sea desechable: un túnel local hacia otra base pasaría la comprobación. El borrado se limita a bases con nombre temporal (`authc_*`, `neonad_*`).
- **B3 — Fallo intermitente de `neon-adapter-pg`** (1 vez): causa no confirmada; endurecimiento basado en una hipótesis.
- **B4 — `account-deletion-hygiene.test.ts`** comprueba el texto del código fuente con expresiones regulares (frágil ante refactorizaciones); el comportamiento real sí está cubierto en `pg-auth-concurrency`.
- **B5 — Aviso de Vite** por `vitest.config.ts` (ESM cargado como CJS), sin impacto.
- **B6 — Documentación:** `ESTADO.md` acumulaba afirmaciones superadas (drift sin comprobar, «Neon real: BLOQUEADO», `0002` sin aplicar, interfaz «sin renderizar», `asset_id` «pendiente»). Corregido en este cierre con marcas «superado» y un resumen consolidado al principio; no se borró historial.

### Revisión técnica de los cambios (sin defectos nuevos)
- `migrationUrl()`: ahora descarta `DIRECT_URL` y `DATABASE_URL` si son del pooler; cubierto con 6 pruebas.
- `markVerified`/`setPassword` devuelven `{ count }`: los únicos consumidores (`verifyEmail`, `resetPassword`) tratan `count === 0` como `INVALID_TOKEN` (400) y las dos regresiones están en `pg-auth-concurrency`.
- `accountService.delete` con `deleteMany`: idempotente y probado, también en producción con un usuario de prueba.
- `media-reconcile`: el `TIME_BUDGET` agotado es definitivo para el tipo siguiente; la prueba nueva falla sin el cambio (2 en vez de 1).
- `media-retention`: `23001` además de `23503`; es el único lugar del código que dependía de `23503`.
- `catalog-sync`: autorización unificada con `isAuthorizedCron` (probada con una cabecera no ASCII).
- `neon-adapter-pg`, `pg-auth-concurrency` y los tests modificados no reducen cobertura: solo añaden aserciones o amplían la versión aceptada de PostgreSQL (17 o 18).

### Estado de este documento
Sin contradicciones objetivas pendientes entre secciones. Distingue validado en local, validado contra servicios reales, pendiente y riesgos abiertos en el «Resumen consolidado». O-1 y O-6 constan como aprobados por la validación del responsable y no se presentan como pendientes.
