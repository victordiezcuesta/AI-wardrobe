# Estado real del proyecto

Este documento dice con franqueza qué está **comprobado**, qué **depende de credenciales o servicios que no se pudieron probar** y qué **limitaciones** tiene el producto. Léelo antes de desplegar.

## Cómo se ha verificado

| Comprobación | Resultado |
|---|---|
| `npm run typecheck` (TypeScript estricto, `noUncheckedIndexedAccess`) | Sin errores |
| `npm run lint` | Sin errores ni avisos |
| `npm test` — 15 archivos | 100 % en verde |
| `npm run build` | Correcto |
| Migración SQL aplicada a PostgreSQL 17 real | Correcto (21 tablas, 19 claves foráneas) |

Los **tests de integración** usan el Prisma Client real contra PostgreSQL real (PGlite) con la migración del proyecto. Solo se simulan los proveedores externos. Durante su escritura aparecieron y se corrigieron fallos reales: columnas de lista `NOT NULL` sin valor por defecto (habrían roto todo registro), un `INSERT … unnest` que fallaba con arrays de `enum`, errores de la IA mostrados al usuario como «datos no válidos» (422) en vez de 502, y una respuesta de IA con un solo id mal formado que descartaba los conjuntos buenos.

## Qué NO se ha podido comprobar (hazlo tú en la primera puesta en marcha)

Ninguna de estas integraciones se ha ejecutado contra el servicio real. El código sigue su documentación oficial y está probado con respuestas simuladas, pero el primer contacto puede revelar diferencias:

| Integración | Qué comprobar |
|---|---|
| **Neon** | La app usa `@prisma/adapter-neon`; los tests usan `@prisma/adapter-pg`. Verifica la conexión real (`DATABASE_URL` con pooler) y que registro/login funcionan. |
| **Migración** | Generada con un script propio (no con `prisma migrate`). En una BD de desarrollo vacía ejecuta `npm run db:migrate` y confirma que Prisma no propone cambios (ver README §10). |
| **Cloudinary** | Subida firmada, tipo `authenticated`, URLs de descarga firmadas con caducidad (`private_download_url`) y borrado por prefijo. Comprueba que las imágenes privadas se ven en `<img>` con tu cuenta. |
| **OpenRouter** | Los modelos por defecto son orientativos. Confirma que existen, que el de visión es multimodal y que admiten salida estructurada (si no, el cliente reintenta sin `response_format`). |
| **Pollinations** | Modelo por defecto, créditos y **calidad real del parecido**. No hay garantía de conservar identidad ni detalles de las prendas. Prueba con tus propias fotos y compara modelos. |
| **Open-Meteo** | Funciona sin clave; su plan gratuito es **solo no comercial**. |
| **Awin** | URL de `feedList` y nombres de columna según su documentación; no se ha visto un feed real de ninguna tienda. El mapeo es configurable. Requiere cuenta de publisher y aprobación de cada anunciante. |
| **SMTP** | Verificación de email y recuperación de contraseña envían por Nodemailer; no probado contra un servidor real. |
| **Vercel** | Despliegue, `maxDuration = 300`, cron y límites de tu plan. |
| **Interfaz** | **No se ha visto renderizada en un navegador** (no había ninguno disponible). Compila, pasa lint y tipos, pero el diseño, los espaciados responsive y las animaciones no se han inspeccionado. Revisa cada pantalla en móvil y escritorio. |

## Lo que está implementado (y dónde)

- **Autenticación** (Auth.js v5 beta): registro, login, verificación de email, recuperación, rutas protegidas, perfil. *Auth.js v5 sigue publicándose como beta; es la rama compatible con Next 16.*
- **Onboarding y perfil** completos, editables, con ciudad habitual.
- **Armario:** subida individual, múltiple, cámara móvil, foto con varias prendas (recortes por cuadro delimitador), alta manual, edición, favoritas, disponibilidad, filtros y búsqueda, revisión de datos inciertos. Si la IA falla, la prenda se guarda marcada «por revisar», sin atributos inventados.
- **Estilista:** clima (Open-Meteo, caché 1 h), 3–5 conjuntos, **validación en servidor de que cada prenda es real, del usuario y disponible**, alternativas, favoritos, historial, valoraciones y aprendizaje de preferencias.
- **Probador virtual:** consentimiento explícito exigido en servidor, fotos privadas, generación asíncrona con estados y reintentos, historial, descarga, favoritas, borrado.
- **Completa tu armario:** detección de huecos con IA, productos reales de un catálogo importado, ranking con IA y respaldo determinista, filtros por tienda/marca/precio, distinción visual entre *sugerencia de IA*, *producto encontrado* y *no disponible*.
- **Dashboard:** saludo, clima de hoy, recomendación del día (si ya existe, sin llamar a la IA), resumen del armario, conjuntos recientes y huecos.
- **Cuenta:** exportación de datos (JSON) y eliminación definitiva con reautenticación (borra también Cloudinary; si eso falla no borra nada).

## Limitaciones conocidas

- **Inditex:** no hay API pública de catálogo; sus marcas solo aparecerán con un feed autorizado.
- **Tallas y género** no se usan para filtrar productos.
- **Probador virtual:** recreación con IA, sin garantía de fidelidad; la generación consume créditos de Pollinations.
- **Detección de varias prendas** por cuadros delimitadores del modelo, no segmentación píxel a píxel; si el recuadro es dudoso, la prenda se guarda con la foto completa y marcada para revisión.
- **Progreso de generación:** el proveedor no informa de porcentaje; se muestra tiempo transcurrido.
- **Catálogo:** los precios y la disponibilidad son los de la última sincronización (diaria); la interfaz lo advierte.
- **CSP** con `'unsafe-inline'` en scripts (necesario para la hidratación de Next sin nonce).
- **Sin** tests end-to-end de navegador, auditoría de accesibilidad completa, internacionalización (solo español), panel de administración ni cambio de email.
- **Datos sensibles:** el perfil guarda edad, altura y fotos. Revisa tu política de privacidad y las bases legales (RGPD) antes de lanzar; el proyecto ofrece las herramientas (consentimiento, exportación, borrado) pero no sustituye asesoría legal.
