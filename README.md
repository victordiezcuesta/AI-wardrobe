# AI Wardrobe

Estilista personal con inteligencia artificial. Digitaliza tu armario con fotos, recibe conjuntos según clima y ocasión (solo con prendas que tienes), pruébatelos con un probador virtual y descubre qué prendas te faltan con productos reales de tiendas.

**Stack:** Next.js 16 · React 19 · TypeScript estricto · Tailwind 4 · Framer Motion · Prisma 7 + PostgreSQL (Neon) · Auth.js v5 · Cloudinary · OpenRouter · Pollinations.ai · Open-Meteo · Vercel.

> Antes de nada, lee [`docs/ESTADO.md`](docs/ESTADO.md): explica con honestidad qué está verificado con tests, qué depende de credenciales externas que no se han podido probar y qué limitaciones tiene cada integración.

## Contenido

1. [Requisitos previos](#1-requisitos-previos) · 2. [Instalación](#2-instalación) · 3. [Neon](#3-configuración-de-neon) · 4. [Prisma](#4-configuración-de-prisma) · 5. [Auth.js](#5-configuración-de-authjs) · 6. [Cloudinary](#6-configuración-de-cloudinary) · 7. [OpenRouter](#7-configuración-de-openrouter) · 8. [Pollinations](#8-configuración-de-pollinations) · 9. [Ejecución local](#9-ejecución-local) · 10. [Migraciones](#10-migraciones) · 11. [Tests](#11-tests) · 12. [Build](#12-build-de-producción) · 13. [Vercel](#13-despliegue-en-vercel) · [Catálogo de tiendas](#catálogo-de-tiendas-opcional) · [Estructura](#estructura-del-proyecto)

## 1. Requisitos previos

- **Node.js ≥ 20.9** y npm.
- Cuentas (cada servicio tiene sus propias condiciones y límites; consulta sus páginas de precios, no los doy por supuestos aquí):

| Servicio | Para qué | Obligatorio |
|---|---|---|
| [Neon](https://neon.tech) | PostgreSQL | Sí |
| [Cloudinary](https://cloudinary.com) | Imágenes (armario, fotos personales, resultados) | Sí |
| [OpenRouter](https://openrouter.ai) | Análisis de prendas, estilista, ranking de compras | Sí, para la IA |
| [Pollinations](https://pollinations.ai) | Probador virtual | Solo para el probador |
| Open-Meteo | Clima | No requiere cuenta ni clave (ver licencia abajo) |
| Servidor SMTP (Resend, Brevo, Mailgun…) | Verificación de email y recuperación de contraseña | Sí en producción |
| [Awin](https://www.awin.com) (publisher) | Catálogo de tiendas para «Completa tu armario» | Opcional |
| [Vercel](https://vercel.com) | Despliegue | Para producción |

**Open-Meteo:** su API gratuita es para uso **no comercial**. Si AI Wardrobe se comercializa, necesitas su plan de pago.

## 2. Instalación

```bash
unzip ai-wardrobe.zip && cd ai-wardrobe
npm install          # también ejecuta `prisma generate`
cp .env.example .env # y rellena los valores (ver secciones siguientes)
```

`.env.example` documenta cada variable. **Nunca subas `.env` al repositorio** (ya está en `.gitignore`; un test lo vigila).

## 3. Configuración de Neon

1. Crea un proyecto en Neon (elige región cercana a tu región de Vercel).
2. En *Connect* copia **dos** cadenas de conexión:
   - **Con pooler** (`…-pooler…`) → `DATABASE_URL` (la usa la aplicación, pensada para serverless).
   - **Directa** (sin pooler) → `DIRECT_URL` (la usan las migraciones).
3. Ambas deben incluir `sslmode=require`.

## 4. Configuración de Prisma

```bash
npm run db:generate   # genera el cliente (src/generated/prisma); también corre en postinstall y build
npm run db:deploy     # aplica prisma/migrations a la base de datos de DIRECT_URL
npm run db:seed       # (opcional) sincroniza las categorías de prenda
```

La app usa Prisma 7 con el **adaptador de Neon** (`@prisma/adapter-neon`). El esquema está en `prisma/schema.prisma` (21 modelos). Más en [Migraciones](#10-migraciones).

## 5. Configuración de Auth.js

- `AUTH_SECRET`: `openssl rand -base64 32`.
- `AUTH_URL`: URL pública (`http://localhost:3000` en local).
- Fuera de Vercel, define también `AUTH_TRUST_HOST=true`.
- **Correo:** registro y recuperación envían enlaces por email. Configura `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` y `EMAIL_FROM`. **Sin `SMTP_HOST` los enlaces se imprimen en la consola del servidor**: cómodo en local, inútil en producción (nadie podrá verificar su cuenta).
- Sesiones JWT en cookie `httpOnly`. Contraseñas con bcrypt (coste 12); bcrypt solo usa los primeros 72 bytes UTF-8, así que el registro y el restablecimiento rechazan contraseñas más largas (sin truncarlas) y el inicio de sesión no aplica ese límite, para no bloquear cuentas existentes. Inicio de sesión bloqueado hasta verificar el email.

## 6. Configuración de Cloudinary

1. Crea una cuenta y copia *Cloud name*, *API Key* y *API Secret* del dashboard → `CLOUDINARY_*`.
2. No hay que crear *upload presets*: la subida se hace desde el servidor, firmada.
3. Cómo se guardan las imágenes (`ai-wardrobe/{userId}/…`):
   - **Armario** (`wardrobe/`): públicas con identificador impredecible, optimizadas (`f_auto,q_auto`) con miniaturas.
   - **Fotos personales** (`personal/`) y **resultados del probador** (`try-on/`): tipo `authenticated`, **sin URL pública**; se sirven con enlaces firmados que caducan (1 h; 15 min para descargar).
4. Al eliminar la cuenta se borra toda la carpeta del usuario.

## 7. Configuración de OpenRouter

1. Crea una clave en <https://openrouter.ai/keys> → `OPENROUTER_API_KEY`.
2. Modelos: `OPENROUTER_MODEL` (defecto común) y, opcionalmente, `OPENROUTER_MODEL_VISION` (analizar fotos de prendas), `OPENROUTER_MODEL_STYLIST` (conjuntos y huecos del armario) y `OPENROUTER_MODEL_CHEAP` (ordenar productos). El análisis de prendas **necesita un modelo multimodal**.
3. Los valores por defecto del código son orientativos: **comprueba que existen en el catálogo de OpenRouter** y elige según calidad/coste.
4. Las respuestas se piden con JSON Schema estricto y se **validan con Zod**; si el modelo devuelve algo inválido se reintenta una vez.
5. Límites: `AI_DAILY_LIMIT_PER_USER` (por defecto 60 llamadas/día). Cada llamada queda registrada en `AiUsageLog` (modelo, tokens, latencia).
6. **Las fotos personales nunca se envían a OpenRouter.** Solo se envían las fotos de prendas del armario.

## 8. Configuración de Pollinations

1. Crea una clave **secreta** (`sk_…`) en <https://enter.pollinations.ai> → `POLLINATIONS_API_KEY`. Es solo de servidor.
2. `POLLINATIONS_MODEL` (defecto `black-forest-labs/flux.2-klein-4b`, gratuito: se paga con el saldo Quest y admite hasta 10 referencias). Los modelos marcados `paid_only` en <https://gen.pollinations.ai/image/models> (p. ej. `google/gemini-2.5-flash-image`) exigen saldo de pago y responden 402 sin él; comprueba la lista vigente.
3. `POLLINATIONS_MAX_REFERENCES` (defecto 5, máximo 8): imagen de la persona + prendas con foto; el resto de prendas se describe en el texto. No debe superar el `max_reference_images` del modelo elegido (flux.2-klein-4b: 10; microsoft/mai-image-*-flash: 5).
4. La generación usa `POST /v1/images/edits` con `response_format=b64_json` (el resultado no queda alojado en su servidor) y es de pago por créditos; `TRYON_DAILY_LIMIT_PER_USER` limita el gasto.
5. **Limitación importante:** no hay garantía de conservar la identidad ni los detalles exactos de las prendas. Es una recreación con IA y así se indica en la interfaz.
6. Se exige **consentimiento explícito** (verificado en servidor) antes de guardar o enviar ninguna foto personal.

## 9. Ejecución local

```bash
npm run dev          # http://localhost:3000
```

Flujo: regístrate → copia el enlace de verificación de la consola (sin SMTP) → onboarding → sube prendas.

## 10. Migraciones

La migración inicial está en `prisma/migrations/0001_init/`. **Se generó con `scripts/generate-migration.ts`** (lee el esquema con el parser oficial de Prisma y emite SQL con sus convenciones de nombres) porque el entorno de desarrollo no podía descargar el motor nativo de migraciones. Se validó aplicándola a PostgreSQL real y ejecutando todos los tests de integración sobre ella, y un test comprueba que sigue coincidiendo con el esquema.

- Producción / CI: `npm run db:deploy` (`prisma migrate deploy`).
- Desarrollo con cambios de esquema: `npm run db:migrate` (`prisma migrate dev`), que crea migraciones nuevas.
- **Recomendado la primera vez:** en una base de datos de desarrollo vacía ejecuta `npm run db:migrate` y comprueba que Prisma no propone cambios. Si los propusiera, serían diferencias menores de formato entre mi generador y el de Prisma; en ese caso regenera con `npx prisma migrate dev --name init` y sustituye la carpeta.
- Regenerar el SQL tras tocar el esquema: `npm run db:migration-sql > prisma/migrations/0001_init/migration.sql` (solo antes del primer despliegue; después, usa `migrate dev`).

## 11. Tests

```bash
npm test             # ~1 min, sin servicios externos
npm run lint
npm run typecheck
npm run check        # lint + typecheck + tests
```

- **Unitarios:** validaciones, parser CSV, normalización de catálogo, prompts, clientes de proveedores con `fetch` simulado, seguridad (CSRF).
- **Integración:** ejecutan los servicios y repositorios **reales con el Prisma Client real contra PostgreSQL real** (PGlite, PostgreSQL en WASM, con la migración del proyecto aplicada). Solo se simulan los proveedores externos (OpenRouter, Pollinations, Cloudinary, Open-Meteo). Cubren registro y recuperación de contraseña, aislamiento entre usuarios, rate limit, cuotas, el estilista (ningún id inventado, ajeno o no disponible llega al usuario), aprendizaje de preferencias, compras, probador virtual y eliminación de cuenta.
- **Higiene:** `.env.example` completo y vacío, ausencia de secretos en el código y migración al día.
- **Descargas y TLS:** `tests/unit/pinned-request.test.ts` levanta servidores HTTPS locales con una CA de prueba generada al vuelo: necesita `openssl` instalado (y la dirección `127.0.0.2`, presente en Linux, para su prueba de control).

### Concurrencia con PostgreSQL real (opcional)

PGlite tiene **una sola conexión**, así que no puede demostrar bloqueos entre transacciones. `tests/integration/pg-concurrency.test.ts` lo hace contra un PostgreSQL **local y desechable** con varias conexiones (borrados simultáneos de prendas que comparten foto con `FOR UPDATE`, y borrado del probador frente a la finalización de una generación). Sin la variable `TEST_PG_URL` se omite, también en `npm run check`. Se niega a conectarse directamente a hosts que no sean locales (`127.0.0.1`, `localhost`, `::1`), pero **no puede detectar un túnel o una redirección de puertos local** hacia una base de datos externa: **nunca la apuntes a Neon, tampoco a través de un túnel** (SSH, `kubectl port-forward`, proxies locales…). Cada ejecución crea su propia base de datos `race_<aleatorio>`, aplica la migración del proyecto y la elimina al terminar, también si alguna prueba falla (si el proceso se interrumpe a la fuerza, puede quedar una `race_*` en ese PostgreSQL desechable).

**1. Levantar** (requiere Docker). Si el puerto 55432 está ocupado, usa otro en `-p 127.0.0.1:<puerto>:5432` y **cambia también ese puerto en `TEST_PG_URL`** (paso 2):

```bash
# Primera vez: datos en memoria (--tmpfs), sin volumen que conserve una contraseña antigua.
docker run -d --name ai-wardrobe-pgrace -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" \
  -p 127.0.0.1:55432:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine

# Si el contenedor ya existe (aunque esté parado), reutilízalo:
docker start ai-wardrobe-pgrace

# Espera a que el servidor DEFINITIVO acepte conexiones TCP (-h 127.0.0.1). Sin -h, pg_isready usa el socket local y
# puede dar «listo» durante la inicialización (con --tmpfs ocurre en cada arranque), cuando aún no escucha por TCP:
until docker exec ai-wardrobe-pgrace pg_isready -h 127.0.0.1 -U postgres -q; do sleep 1; done
```

**2. Ejecutar** (la contraseña se lee de la configuración del propio contenedor y se pasa con `PGPASSWORD` solo a este comando: ni va en la URL ni queda exportada en la terminal):

```bash
PGPASSWORD="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ai-wardrobe-pgrace | sed -n 's/^POSTGRES_PASSWORD=//p')" \
  TEST_PG_URL="postgresql://postgres@127.0.0.1:55432/postgres" npx vitest run tests/integration/pg-concurrency.test.ts
```

**3. Limpiar:**

```bash
docker stop ai-wardrobe-pgrace                  # pararlo (se puede volver a arrancar con docker start)
docker rm ai-wardrobe-pgrace                    # eliminarlo cuando ya no lo necesites
```

**Si ya existen el contenedor o el volumen:**

- `docker run` falla con «name is already in use»: el contenedor existe; usa `docker start ai-wardrobe-pgrace` (paso 1) en lugar de crearlo de nuevo.
- Si un contenedor anterior se creó con un volumen con nombre (p. ej. `-v ai-wardrobe-pgrace-data:/var/lib/postgresql/data`), ese volumen conserva la contraseña con la que se inicializó: `POSTGRES_PASSWORD` solo se aplica la primera vez. Reutiliza el contenedor original (su contraseña sale de `docker inspect`, paso 2) o, si el volumen es solo de estas pruebas y ya no lo necesitas, elimínalo tras borrar el contenedor: `docker volume rm ai-wardrobe-pgrace-data`. No borres volúmenes que no sean de estas pruebas.

## 12. Build de producción

```bash
npm run build        # prisma generate + next build
npm start
```

## 13. Despliegue en Vercel

1. Importa el repositorio en Vercel (framework Next.js; el *build command* `npm run build` ya está en `package.json`).
2. Añade **todas** las variables de `.env.example` que uses en *Settings → Environment Variables*. `NEXT_PUBLIC_APP_URL` y `AUTH_URL` = tu dominio.
3. **Aplica las migraciones antes del primer despliegue** desde tu máquina: `DIRECT_URL=… npm run db:deploy`.
4. **Duración de funciones:** el probador virtual y el cron del catálogo declaran `maxDuration = 300`. Tu plan de Vercel debe permitirlo; si no, la generación de imágenes se cortará y hará falta una cola externa. Compruébalo en los límites vigentes de tu plan.
5. **Tamaño de petición:** las funciones de Vercel admiten cuerpos de ~4,5 MB; por eso el navegador redimensiona las fotos antes de subirlas y el servidor rechaza más de 4 MB.
6. **Cron:** `vercel.json` programa a diario `/api/cron/catalog-sync` (04:00 UTC) y `/api/cron/rate-limit-purge` (04:30 UTC, ver «Purga automática de RateLimit»). Define `CRON_SECRET` (≥16 caracteres): Vercel lo envía como `Authorization: Bearer …` y la ruta rechaza todo lo demás.
7. **Términos de uso:** el plan gratuito (Hobby) de Vercel está orientado a uso personal no comercial. Revisa sus términos antes de lanzar un SaaS.
8. **Variables de sistema (límite por IP):** en *Settings → Environment Variables* debe estar activada la opción **Enable access to System Environment Variables**. La aplicación solo se considera en Vercel (y solo confía en `x-forwarded-for`) si `VERCEL === "1"`. Con la opción desactivada, `VERCEL` no existe, el despliegue es indistinguible de uno autoalojado y los límites por IP que usan esa resolución (el login y las rutas de registro, recuperación, restablecimiento y verificación de email) **dejan de aplicarse sin ningún aviso**; en el login seguiría el límite por email. En entornos **locales y autoalojados** (donde `VERCEL` no es `1`) tampoco se aplica límite por IP con la configuración actual; eso no desactiva los demás controles (límite por email del login, comprobación de origen, validación de entradas, tokens de un solo uso y autenticación).

## Catálogo de tiendas (opcional)

«Completa tu armario» **solo muestra productos reales de un catálogo importado**; sin catálogo muestra los huecos detectados y avisa de que no hay productos. No hay scraping.

- **Zara, Pull&Bear, Bershka, Stradivarius, Massimo Dutti, Oysho y Lefties (Inditex):** no hay API pública de catálogo ni feed abierto. Solo aparecerán si consigues un feed autorizado (programa de afiliación o acuerdo).
- **Mango, H&M, Uniqlo, Springfield, Cortefiel, El Corte Inglés…:** vía **Awin**. Pasos:
  1. Hazte *publisher* en Awin y **solicita unirte a cada anunciante** (cada tienda aprueba o no).
  2. Copia tu ID de publisher y tu clave de feeds → `AWIN_PUBLISHER_ID`, `AWIN_DATAFEED_KEY`.
  3. `CATALOG_STORES` filtra las tiendas permitidas (por defecto las de tu lista).
  4. Primera carga: `npm run catalog:sync` (sin límite de tiempo). Después, el cron diario.
- **Otras redes o acuerdos directos:** feeds CSV en `CATALOG_FEEDS_JSON` (ver `src/lib/catalog/providers/generic.ts`). Para otra fuente, implementa `CatalogProvider` y regístrala en `providers/index.ts`.
- Los enlaces son de **afiliación**: la interfaz lo declara. Revisa el texto legal con tu asesor.
- No se filtra todavía por talla ni por género/presentación de la ropa (los feeds varían demasiado); se tienen en cuenta presupuesto, colores evitados, marcas y color/categoría.

## Estructura del proyecto

```
src/
  app/            Rutas (App Router): (auth), (dashboard), onboarding, api/
  components/     ui/ (sistema de componentes propio) y layout/
  features/       Lógica de interfaz por dominio (wardrobe, stylist, virtual-try-on, shopping, profile, authentication)
  services/       Casos de uso (auth, wardrobe, stylist, tryon, shopping, catalog-sync, account…)
  repositories/   Acceso a datos (toda consulta filtra por userId)
  lib/            Integraciones: prisma, auth, cloudinary, openrouter, pollinations, weather, catalog, validations, env
  utils/ types/
prisma/           schema.prisma, migrations/, seed.ts
scripts/          catalog-sync.ts, generate-migration.ts
tests/            unit/, integration/, helpers/
docs/             ESTADO.md, ARQUITECTURA.md
```

Capas: **Route Handler → servicio → repositorio → Prisma**. Cada Route Handler va envuelto en `handler()` (errores uniformes, defensa CSRF por origen) y valida con Zod.

## Seguridad y privacidad (resumen)

Validación de archivos por firma binaria y tamaño · autorización por `userId` en cada consulta · rate limiting en PostgreSQL (funciona entre instancias serverless) · cabeceras de seguridad y CSP · secretos solo en servidor · imágenes privadas con URL firmada y caducidad · consentimiento explícito para fotos personales · descarga de datos (`/api/account/export`) y **eliminación definitiva** de cuenta con reautenticación, que borra también todo en Cloudinary.

**Límites por email en registro, recuperación de contraseña e inicio de sesión:** además del límite por IP, `POST /api/auth/register` (scope `register-email`) y `POST /api/auth/forgot-password` (scope `forgot-email`) aplican cada una **3 solicitudes por email normalizado (recortado y en minúsculas) cada 3600 segundos**. Ambos límites se comprueban después de validar el cuerpo con Zod y se cuentan para cualquier email válido, exista o no la cuenta. El inicio de sesión mantiene su límite de **10 intentos por email cada 900 segundos** (scope `login-email`). Estos tres contadores usan una clave HMAC derivada de `AUTH_SECRET`: la clave de rate limiting no guarda el email en claro. Desde esta versión el login ya no crea claves `login:<email>`; las filas antiguas no se migran (su contador deja de aplicarse) y las elimina la purga diaria. `reset-password` y `verify-email` mantienen únicamente sus límites por IP.

**Límites por usuario en mutaciones autenticadas:** además de los límites de creación, estas operaciones aplican un contador por usuario (clave `<scope>:<userId>`, sin datos personales) que se comprueba justo después de autenticar y **antes de validar el cuerpo, de acceder a los datos o de llamar a Cloudinary**; al superarlo responden 429 `RATE_LIMITED` y no ejecutan nada más. `DELETE /api/wardrobe/[id]` (`wardrobe:delete`): 120 por hora · `DELETE /api/try-on/[id]` (`tryon:delete`): 60 por hora · `PATCH /api/wardrobe/[id]` (`wardrobe:update`), `PATCH /api/try-on/[id]` (`tryon:favorite`) y `PATCH /api/outfits/[id]` (`outfit:favorite`): 300 por hora cada una · `POST /api/consent` (`consent:set`): 20 por hora. Si el almacenamiento del limitador falla, la operación se rechaza (fail-closed). `POST /api/auth/logout` no tiene límite.

**Purga automática de RateLimit:** la tabla `RateLimit` acumula una fila por clave y ventana; las caducadas ya no tienen efecto (el limitador las reinicia al reutilizar la clave), así que se eliminan para que la tabla no crezca. `vercel.json` programa `GET /api/cron/rate-limit-purge` a diario a las **04:30 UTC** (30 minutos después del catálogo). La ruta solo acepta `Authorization: Bearer <CRON_SECRET>` (la misma comprobación que los otros cron): `CRON_SECRET` debe estar definido en el entorno de despliegue; sin él, la ruta responde siempre 401 y la purga no se ejecuta. No admite parámetros.
- **Qué elimina:** solo filas de `RateLimit` cuyo `windowStart` tiene más de **24 horas** (todas las ventanas del código duran como máximo 1 hora; una prueba impide ventanas de más de 12 h). Las ventanas recientes no se tocan. No borra cuentas ni ningún otro dato de usuario.
- **Cómo:** lotes de hasta **5.000** filas, un máximo de **20 lotes** por ejecución y un presupuesto de unos **25 segundos** (la ruta declara `maxDuration = 60`). Es idempotente y puede solaparse con otra ejecución sin borrar dos veces la misma fila.
- **Respuesta:** `{ "ok": true, "deleted": <filas borradas>, "batches": <lotes ejecutados>, "complete": <boolean> }`; no incluye claves, emails ni IP. `complete: true` significa que, al terminar, no quedaban filas caducadas; `complete: false` **no es un error**: queda trabajo pendiente (más de 100.000 filas, presupuesto agotado o filas bloqueadas en ese momento) que recogerá la siguiente ejecución. Un fallo inesperado responde 500 genérico.
