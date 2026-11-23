# Estado real del proyecto

Este documento dice con franqueza qué está **comprobado**, qué **depende de credenciales o servicios que no se pudieron probar** y qué **limitaciones** tiene el producto. Léelo antes de desplegar.

## Cómo se ha verificado

| Comprobación | Resultado |
|---|---|
| `npm run typecheck` (TypeScript estricto, `noUncheckedIndexedAccess`) | Sin errores |
| `npm run lint` | Sin errores ni avisos |
| `npm test` — 78 archivos (43 unitarios y 35 de integración) | 76 archivos en verde, 2 omitidos a propósito (ver abajo); 2.400 pruebas pasan y 60 se omiten, ninguna falla |
| `npm run build` | Correcto en la verificación inicial del proyecto; **no repetido** al actualizar este documento |
| Migraciones SQL (`0001_init` y `0002_media_reconcile_persistence`) | Las aplica la suite de integración sobre PGlite. Según el SQL, `0001` crea 21 tablas y 19 claves foráneas y `0002` añade 3 tablas y 3 claves foráneas. La comprobación contra PostgreSQL 17 real se hizo sobre `0001`; `0002` no se ha verificado en esta revisión contra un PostgreSQL real. Las pruebas `pg-concurrency` y `rate-limit-purge-pg` podrían aplicarla cuando se ejecutan con un PostgreSQL local configurado mediante `TEST_PG_URL`, pero no se han ejecutado en esta revisión |

Estado de la verificación en la última revisión de este documento (fase 20.2): `npm run lint`, `tsc --noEmit` y `npx vitest run` sin errores. Los **2 archivos omitidos** son `tests/integration/pg-concurrency.test.ts` y `tests/integration/rate-limit-purge-pg.test.ts`: sus bloques usan `describe.skipIf(!ADMIN_URL)` y solo se ejecutan con un PostgreSQL local aislado y su URL de administración configurada (concurrencia real de conexiones, lease del reconciliador y purga con bloqueos). Sin ese entorno **no se ejecutan** y no cuentan como verificados.

Los **tests de integración** usan el Prisma Client real contra PostgreSQL real (PGlite) con la migración del proyecto. Solo se simulan los proveedores externos. Durante su escritura aparecieron y se corrigieron fallos reales: columnas de lista `NOT NULL` sin valor por defecto (habrían roto todo registro), un `INSERT … unnest` que fallaba con arrays de `enum`, errores de la IA mostrados al usuario como «datos no válidos» (422) en vez de 502, y una respuesta de IA con un solo id mal formado que descartaba los conjuntos buenos.

## Comprobado solo en local (PGlite y simulaciones)

Todo lo de la sección «Lo que está implementado» y «Seguridad y robustez» está cubierto por las pruebas anteriores con PostgreSQL en memoria (PGlite) y proveedores simulados. **Nada de ello se ha probado en producción ni contra Neon.** Una prueba local no demuestra el comportamiento con la latencia, la concurrencia ni la configuración real de Vercel.

## Qué NO se ha podido comprobar (hazlo tú en la primera puesta en marcha)

Ninguna de estas integraciones se ha ejecutado contra el servicio real. El código sigue su documentación oficial y está probado con respuestas simuladas, pero el primer contacto puede revelar diferencias:

| Integración | Qué comprobar |
|---|---|
| **Neon** | La app usa `@prisma/adapter-neon`; los tests usan `@prisma/adapter-pg`. Verifica la conexión real (`DATABASE_URL` con pooler) y que registro/login funcionan. |
| **Migración** | Generada con un script propio (no con `prisma migrate`). En una BD de desarrollo vacía ejecuta `npm run db:migrate` y confirma que Prisma no propone cambios (ver README §10). |
| **Cloudinary** | Subida firmada, tipo `authenticated`, URLs de descarga firmadas con caducidad (`private_download_url`) y borrado por prefijo. Comprueba que las imágenes privadas se ven en `<img>` con tu cuenta. **Pendiente de verificación real:** el formato de `asset_id` en las respuestas de la Admin API. El código lo trata como identificador **opaco** (`src/services/media-reconcile.service.ts`, `parseOpaqueAssetId`) y no presupone ningún formato, pero ninguna respuesta autorizada real lo ha confirmado; además, el inventario de la reconciliación consume cuota de la Admin API. |
| **OpenRouter** | Los modelos por defecto son orientativos. Confirma que existen, que el de visión es multimodal y que admiten salida estructurada (si no, el cliente reintenta sin `response_format`). |
| **Pollinations** | Modelo por defecto, créditos y **calidad real del parecido**. No hay garantía de conservar identidad ni detalles de las prendas. Prueba con tus propias fotos y compara modelos. |
| **Open-Meteo** | Funciona sin clave; su plan gratuito es **solo no comercial**. |
| **Awin** | URL de `feedList` y nombres de columna según su documentación; no se ha visto un feed real de ninguna tienda. El mapeo es configurable. Requiere cuenta de publisher y aprobación de cada anunciante. |
| **SMTP** | Verificación de email y recuperación de contraseña envían por Nodemailer; no probado contra un servidor real. |
| **Vercel** | Despliegue, `maxDuration = 300`, cron y límites de tu plan. Además: `CRON_SECRET` (≥16 caracteres) definido, o los cron responden siempre 401; y la opción **Enable access to System Environment Variables** activada, porque los límites por IP solo confían en `x-forwarded-for` si `VERCEL === "1"` (ver README §13). Ninguna de las dos cosas se ha comprobado en un despliegue real. |
| **Interfaz** | **No se ha visto renderizada en un navegador** (no había ninguno disponible). Compila, pasa lint y tipos, pero el diseño, los espaciados responsive y las animaciones no se han inspeccionado. Revisa cada pantalla en móvil y escritorio. |

## Lo que está implementado (y dónde)

- **Autenticación** (Auth.js v5 beta): registro, login, verificación de email, recuperación, rutas protegidas, perfil. *Auth.js v5 sigue publicándose como beta; es la rama compatible con Next 16.*
- **Onboarding y perfil** completos, editables, con ciudad habitual.
- **Armario:** subida individual, múltiple, cámara móvil, foto con varias prendas (recortes por cuadro delimitador), alta manual, edición, favoritas, disponibilidad, filtros y búsqueda, revisión de datos inciertos. Si la IA falla, la prenda se guarda marcada «por revisar», sin atributos inventados.
- **Estilista:** clima (Open-Meteo, caché 1 h), 3–5 conjuntos, **validación en servidor de que cada prenda es real, del usuario y disponible**, alternativas, favoritos, historial, valoraciones y aprendizaje de preferencias.
- **Probador virtual:** consentimiento explícito exigido en servidor, fotos privadas, generación asíncrona con estados y reintentos, historial, descarga, favoritas, borrado.
- **Completa tu armario:** detección de huecos con IA, productos reales de un catálogo importado, ranking con IA y respaldo determinista, filtros por tienda/marca/precio, distinción visual entre *sugerencia de IA*, *producto encontrado* y *no disponible*.
- **Dashboard:** saludo, clima de hoy, recomendación del día (si ya existe, sin llamar a la IA), resumen del armario, conjuntos recientes y huecos.
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
- **Autenticación y rutas:** sesiones JWT con `Session` revocable en base de datos (la revocación se comprueba en cada `auth()`), login bloqueado hasta verificar el email, y `proxy.ts` que protege las rutas excepto `api/auth`, `api/health`, `api/cron` y estáticos (los cron se autentican con `CRON_SECRET`).
- **Ciclo de vida de imágenes (reconciliación de medios):** detector de huérfanos de **solo lectura** (`/api/cron/media-reconcile`) y reconciliación **persistente** (`/api/cron/media-reconcile/run`, con lease y registro de ejecuciones y de candidatas `MediaAsset`). Respuestas agregadas, sin identificadores ni URLs. **Ninguna de las dos rutas está programada en `vercel.json`** y la reconciliación **no borra nada en Cloudinary**. La retención está en modo `DRY_RUN` y el borrado (`APPLY`) está desactivado en el código (`RETENTION_APPLY_ENABLED = false`); de activarse, borraría exclusivamente filas de seguimiento (`MediaAsset` y `MediaReconcileRun`) en la base de datos, nunca archivos de Cloudinary; activarlo exigiría una fase aprobada expresamente. Estas rutas no se han ejecutado contra Cloudinary real.

## Limitaciones conocidas

- **Inditex:** no hay API pública de catálogo; sus marcas solo aparecerán con un feed autorizado.
- **Tallas y género** no se usan para filtrar productos.
- **Probador virtual:** recreación con IA, sin garantía de fidelidad; la generación consume créditos de Pollinations.
- **Detección de varias prendas** por cuadros delimitadores del modelo, no segmentación píxel a píxel; si el recuadro es dudoso, la prenda se guarda con la foto completa y marcada para revisión.
- **Progreso de generación:** el proveedor no informa de porcentaje; se muestra tiempo transcurrido.
- **Catálogo:** los precios y la disponibilidad son los de la última sincronización (diaria); la interfaz lo advierte.
- **Rendimiento de la búsqueda del catálogo (fase 20.1, cerrada sin cambios):** se hizo un benchmark **sintético** con PGlite y catálogos de hasta 100.000 productos sobre las consultas reales de `catalogRepository.search`. Con categoría y color el coste es bajo; las consultas solo por categoría o sin color son más costosas a volúmenes altos, porque se lee toda la categoría y se ordena antes del límite. Un índice trigram sobre el nombre empeoró los escenarios medidos. **No se justifican optimizaciones por ahora y no se han cambiado consultas, índices ni migraciones.** Los tiempos de PGlite (WASM) **no son extrapolables a Neon** ni son métricas de producción; el tamaño real del catálogo en producción no se ha consultado. Si el catálogo crece mucho, conviene volver a medir (el `shopping.service` puede lanzar hasta 3 consultas por hueco y hasta 6 huecos por petición).
- **CSP** con `'unsafe-inline'` en scripts (necesario para la hidratación de Next sin nonce).
- **Sin** tests end-to-end de navegador, auditoría de accesibilidad completa, internacionalización (solo español), panel de administración ni cambio de email.
- **Datos sensibles:** el perfil guarda edad, altura y fotos. Revisa tu política de privacidad y las bases legales (RGPD) antes de lanzar; el proyecto ofrece las herramientas (consentimiento, exportación, borrado) pero no sustituye asesoría legal.
