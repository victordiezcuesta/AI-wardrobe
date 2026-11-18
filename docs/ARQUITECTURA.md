# Arquitectura

## Capas

```
Route Handler (src/app/api)  →  Servicio (src/services)  →  Repositorio (src/repositories)  →  Prisma
        │ handler(): errores uniformes + CSRF            │ reglas de negocio                    │ SIEMPRE filtra por userId
        │ Zod valida entradas                            │ orquesta IA, clima, imágenes
```

Integraciones de proveedor (OpenRouter, Pollinations, Cloudinary, Open-Meteo, catálogo) viven en `src/lib/<proveedor>` detrás de funciones pequeñas, para poder sustituirlas y simularlas en tests.

## Reglas de diseño que importan

1. **La IA propone, el servidor decide.** Los modelos ven alias cortos (`i1`, `i2`…) y el servidor solo acepta alias de la petición en curso. Un id inventado, ajeno o de una prenda no disponible no llega nunca a la base de datos ni al usuario (`services/outfit-validation.ts`).
2. **Autorización en backend.** Cada repositorio filtra por `userId`; `requireUserId()` además comprueba que la cuenta existe. Ocultar botones no es seguridad.
3. **Nada de datos simulados.** Sin catálogo no hay productos; sin IA, la prenda se guarda «por revisar» sin atributos inventados.
4. **Coste bajo control.** Caché de clima (1 h) y de análisis de compras (24 h con el mismo armario), cuotas diarias por usuario, registro de tokens, modelos por variable de entorno, generación solo bajo demanda.
5. **Serverless realista.** Fotos redimensionadas en el navegador (límite de cuerpo ~4,5 MB), una foto por petición, rate limit en PostgreSQL, probador asíncrono con `after()` y sondeo, importación de catálogo por lotes en streaming.

## Flujos principales

**Armario:** navegador redimensiona → `POST /api/wardrobe/analyze` → valida firma binaria → Cloudinary → OpenRouter (visión, JSON Schema + Zod) → (varias prendas: recortes) → BD.

**Estilista:** petición → cuota → prendas disponibles (alias) + perfil + preferencias + recientes + clima → OpenRouter → `validateOutfits` → reintento con correcciones si hace falta → BD.

**Probador:** consentimiento → `POST /api/try-on` crea `GeneratedImage(PENDING)` y responde 202 → `after()` reclama el trabajo (PENDING→PROCESSING atómico), descarga referencias (solo CDN de Cloudinary), llama a Pollinations (`/v1/images/edits`, multipart, `b64_json`), valida el binario y sube a Cloudinary privado → el cliente sondea `GET /api/try-on/:id`. Los trabajos atascados se marcan fallidos al consultarlos.

**Compras:** huecos (IA) → búsqueda en `CatalogProduct` → filtros del perfil → ranking (IA, con respaldo determinista) → lote persistido. El catálogo se importa aparte (`catalog-sync`, cron o script) desde feeds autorizados.

## Modelo de datos (21 tablas)

Usuarios y sesión: `User`, `Account`, `Session`, `VerificationToken`, `UserProfile`. Armario: `ClothingCategory`, `WardrobeItem`. Estilista: `Outfit`, `OutfitItem`, `OutfitFeedback`, `OutfitHistory`, `FavoriteItem`, `UserPreference`. Imágenes: `GeneratedImage`. Compras: `ShoppingRecommendation`, `ShoppingProduct`, `CatalogProduct`, `CatalogSync`. Infraestructura: `WeatherCache`, `AiUsageLog`, `RateLimit`.

Todas las relaciones con `User` son `onDelete: Cascade`: eliminar la cuenta borra los datos (las imágenes se borran antes en Cloudinary).

## Seguridad

- Contraseñas: bcrypt (coste 12). Tokens de verificación/recuperación: 32 bytes aleatorios, solo se guarda su SHA-256, de un solo uso, con caducidad.
- Respuestas de registro y recuperación idénticas exista o no la cuenta (no se enumeran emails).
- Archivos: tamaño máximo y formato por firma binaria (no por extensión/Content-Type).
- CSRF: cookies SameSite + comprobación de `Origin` en toda mutación.
- Cabeceras: CSP, `X-Frame-Options: DENY`, `nosniff`, HSTS, `Permissions-Policy`; API con `Cache-Control: no-store`.
- Secretos solo en servidor; los errores internos no se devuelven al cliente.
- Cron protegido con `CRON_SECRET` (comparación en tiempo constante).
