import { describe, expect, it } from "vitest";
import { parseImageUrl } from "@/lib/cloudinary/url";
import { setTestEnv } from "../helpers/mock-prisma";

/** parseImageUrl: qué URL guardada protege qué recurso. Cuenta de prueba: "demo" (la de setTestEnv). Sin red. */
const CLOUD = "demo";
const ID = "ai-wardrobe/cmusuario0000000000000000/wardrobe/abc123";
const PRIV = "ai-wardrobe/cmusuario0000000000000000/personal/p1";
const parse = (u: unknown) => parseImageUrl(u, CLOUD);
const own = (ids: string[], delivery: string) => ({ kind: "own", publicIds: ids, delivery, insidePrefix: true });

describe("URLs propias (se protegen)", () => {
  it.each([
    ["normal, sin versión ni extensión", `https://res.cloudinary.com/demo/image/upload/${ID}`],
    ["con versión", `https://res.cloudinary.com/demo/image/upload/v1732190000/${ID}`],
    ["con versión v1 (la que añade el SDK)", `https://res.cloudinary.com/demo/image/upload/v1/${ID}`],
    ["con una transformación", `https://res.cloudinary.com/demo/image/upload/f_auto,q_auto/${ID}`],
    ["miniatura del SDK (cadena de transformaciones + versión)", `https://res.cloudinary.com/demo/image/upload/c_fill,f_auto,g_auto,h_600,q_auto,w_480/v1/${ID}`],
    ["transformaciones encadenadas en varios segmentos", `https://res.cloudinary.com/demo/image/upload/c_limit,h_1600,w_1600/q_auto:good/v3/${ID}`],
    ["con firma", `https://res.cloudinary.com/demo/image/upload/s--AbCdEf12--/v2/${ID}`],
    ["variable de transformación", `https://res.cloudinary.com/demo/image/upload/$w_480/${ID}`],
    ["http heredado", `http://res.cloudinary.com/demo/image/upload/${ID}`],
    ["subdominio res-N", `https://res-3.cloudinary.com/demo/image/upload/${ID}`],
    ["parámetros de consulta (se ignoran)", `https://res.cloudinary.com/demo/image/upload/${ID}?_a=BAMAAAB0`],
    ["segmentos codificados", `https://res.cloudinary.com/demo/image/upload/v1/ai%2Dwardrobe/cmusuario0000000000000000/wardrobe/abc123`],
    ["espacios alrededor", `  https://res.cloudinary.com/demo/image/upload/${ID}  `],
  ])("%s", (_n, u) => {
    expect(parse(u)).toEqual(own([ID], "upload"));
  });

  it("con extensión: se protegen el id con y sin ella (un punto puede ser formato o parte del id)", () => {
    expect(parse(`https://res.cloudinary.com/demo/image/upload/v1/${ID}.jpg`)).toEqual(own([`${ID}.jpg`, ID], "upload"));
    expect(parse(`https://res.cloudinary.com/demo/image/upload/${ID}.tar.webp`)).toEqual(own([`${ID}.tar.webp`, `${ID}.tar`], "upload"));
  });

  it.each(["authenticated", "private"])("entrega %s", (type) => {
    expect(parse(`https://res.cloudinary.com/demo/image/${type}/s--Zx9_-abc--/v5/${PRIV}.jpg`)).toEqual(own([`${PRIV}.jpg`, PRIV], type));
  });

  it("descarga firmada de la API (privada)", () => {
    const u = `https://api.cloudinary.com/v1_1/demo/image/download?api_key=k&expires_at=1&format=jpg&public_id=${encodeURIComponent(PRIV)}&signature=x&timestamp=1&type=authenticated`;
    expect(parse(u)).toEqual(own([PRIV], "authenticated"));
  });

  it("las URL que genera el SDK REAL (sin red) se interpretan con su public_id exacto", async () => {
    setTestEnv();
    const { imageUrls, signedUrl } = await import("@/lib/cloudinary");
    const { url, thumbUrl } = imageUrls(ID);
    for (const u of [url, thumbUrl]) expect(parse(u)).toEqual(own([ID], "upload"));
    expect(parse(signedUrl(PRIV))).toEqual(own([PRIV], "authenticated"));
    expect(parse(signedUrl(PRIV, { attachment: true }))).toEqual(own([PRIV], "authenticated"));
  });

  it("de nuestra cuenta pero fuera de ai-wardrobe/ → propia, fuera del prefijo (no protege nada del inventario)", () => {
    expect(parse("https://res.cloudinary.com/demo/image/upload/v1/sample.jpg")).toEqual({ kind: "own", publicIds: [], delivery: "upload", insidePrefix: false });
    expect(parse("https://api.cloudinary.com/v1_1/demo/image/download?public_id=samples%2Fx&type=upload")).toMatchObject({ kind: "own", insidePrefix: false });
  });
});

describe("URLs externas (no se confunden con las nuestras)", () => {
  it.each([
    ["otra cuenta de Cloudinary con la MISMA ruta", `https://res.cloudinary.com/otra-cuenta/image/upload/v1/${ID}`],
    ["descarga de otra cuenta", `https://api.cloudinary.com/v1_1/otra/image/download?public_id=${ID}`],
    ["tienda", "https://cdn.tienda.example/img/123.jpg"],
    ["avatar de Google", "https://lh3.googleusercontent.com/a/ACg8ocJ=s96-c"],
    ["dominio con el nombre de la app (no es una ruta de recurso)", "https://ai-wardrobe.vercel.app/logo.png"],
    ["ruta relativa", "/images/placeholder.png"],
    ["texto que no es URL", "no es una url"],
    ["vacía", ""],
    ["no es texto", 42],
    ["null", null],
  ])("%s", (_n, u) => {
    expect(parse(u)).toEqual({ kind: "external" });
  });
});

describe("formatos ambiguos que mencionan ai-wardrobe/<id> (protegen al propietario o todo)", () => {
  const OWNER = "cmusuario0000000000000000";
  const amb = (ownerIds: string[] | null) => ({ kind: "ambiguous", ownerIds });
  it.each([
    ["segmento previo que no es transformación ni versión", `https://res.cloudinary.com/demo/image/upload/carpeta-rara/${ID}`],
    ["transformación con parámetro vacío", `https://res.cloudinary.com/demo/image/upload/c_fill,,w_1/${ID}`],
    ["tipo de entrega desconocido", `https://res.cloudinary.com/demo/image/fetch/${ID}`],
    ["recurso que no es imagen", `https://res.cloudinary.com/demo/video/upload/${ID}`],
    ["capa con nuestro recurso (l_…)", `https://res.cloudinary.com/demo/image/upload/l_ai-wardrobe:${OWNER}:wardrobe:abc/v1/sample`],
    ["codificación rota en un segmento", `https://res.cloudinary.com/demo/image/upload/%E0%A4%A/${ID}`],
    ["barra doble en el id", `https://res.cloudinary.com/demo/image/upload/ai-wardrobe/${OWNER}//x`],
    ["otro host de Cloudinary", `https://demo-res.cloudinary.com/image/upload/${ID}`],
    ["CDN o proxy propio", `https://img.example.com/${ID}`],
    ["misma cuenta con otras mayúsculas", `https://res.cloudinary.com/Demo/image/upload/${ID}`],
    ["descarga con ruta inesperada", `https://api.cloudinary.com/v1_1/demo/image/download/extra?public_id=${ID}`],
    ["descarga con public_id repetido", `https://api.cloudinary.com/v1_1/demo/image/download?public_id=${ID}&public_id=${ID}`],
    ["URL propia exacta pero con otra mención en el query", `https://res.cloudinary.com/demo/image/upload/v1/${ID}?ref=ai-wardrobe/${OWNER}/x`],
    ["no es URL pero cita la ruta", `ai-wardrobe/${OWNER}/wardrobe/abc`],
    ["protocolo no web", `data:text/plain,ai-wardrobe/${OWNER}/x`],
  ])("%s → ambiguous con propietario", (_n, u) => {
    expect(parse(u)).toEqual(amb([OWNER]));
  });

  it.each([
    ["carpeta reservada como propietario", "https://img.example.com/ai-wardrobe/_quarantine/wardrobe/x"],
    ["mención sin propietario", "https://img.example.com/ai-wardrobe/"],
    ["una mención con propietario y otra sin él", `https://img.example.com/ai-wardrobe/${OWNER}/x?b=ai-wardrobe`],
    ["solo la carpeta en nuestra cuenta", "https://res.cloudinary.com/demo/image/upload/v1/ai-wardrobe"],
  ])("%s → protección global", (_n, u) => {
    expect(parse(u)).toEqual(amb(null));
  });

  it("carpeta repetida → ambiguous con TODOS los posibles propietarios (también «v1»: proteger de más no borra nada)", () => {
    expect(parse(`https://res.cloudinary.com/demo/image/upload/ai-wardrobe/v1/${ID}`)).toEqual(amb([OWNER, "v1"]));
  });

  it("`ai-wardrobe/<id>` es un public_id posible: se protege tal cual (proteger de más nunca borra nada)", () => {
    expect(parse(`https://res.cloudinary.com/demo/image/upload/ai-wardrobe/${OWNER}`)).toEqual(own([`ai-wardrobe/${OWNER}`], "upload"));
  });

  it("un nombre de dominio o archivo que solo CONTIENE «ai-wardrobe» no es una mención", () => {
    expect(parse("https://ai-wardrobe.vercel.app/ai-wardrobe-logo.png")).toEqual({ kind: "external" });
  });
});

describe("D1: codificación rota y barras codificadas (nunca se pierde la referencia)", () => {
  const OWNER = "cmusuario0000000000000000";
  const B = "cmotrousuario00000000000";
  const amb = (ownerIds: string[] | null) => ({ kind: "ambiguous", ownerIds });
  const ENC = `ai-wardrobe%2F${OWNER}%2Fwardrobe%2Fx`;

  it.each([
    ["res: id con barras codificadas", `https://res.cloudinary.com/demo/image/upload/${ENC}`],
    ["res: barras codificadas + % roto en el query", `https://res.cloudinary.com/demo/image/upload/${ENC}?_a=%ZZ`],
    ["res: barras codificadas + % roto en otro segmento", `https://res.cloudinary.com/demo/image/upload/%E0%A4/${ENC}`],
    ["res: solo la última barra codificada", `https://res.cloudinary.com/demo/image/upload/v1/ai-wardrobe/${OWNER}/wardrobe%2Fx`],
    ["res: % roto en el query de una URL exacta", `https://res.cloudinary.com/demo/image/upload/v1/${ID}?_a=%ZZ`],
    ["res: carpeta codificada + % roto en el fragmento", `https://res.cloudinary.com/demo/image/upload/v1/ai%2Dwardrobe/${OWNER}/wardrobe/x#%ZZ`],
    ["api: public_id con % roto", `https://api.cloudinary.com/v1_1/demo/image/download?public_id=${ENC}%ZZ&type=authenticated`],
    ["api: public_id válido + % roto en otro parámetro", `https://api.cloudinary.com/v1_1/demo/image/download?public_id=${ENC}&timestamp=%ZZ`],
    ["CDN: barras codificadas + % roto", `https://cdn.example.com/${ENC}?_a=%ZZ`],
    ["CDN: carpeta codificada + % roto en el mismo segmento", `https://cdn.example.com/ai%2Dwardrobe%2F${OWNER}%2Fx%ZZ`],
    ["texto que no es URL con barras codificadas", `${ENC}%ZZ`],
  ])("%s → ambiguous con el propietario (no external ni «propia sin protección»)", (_n, u) => {
    expect(parse(u)).toEqual(amb([OWNER]));
  });

  it("varios propietarios en una URL ambigua → se protegen TODOS", () => {
    expect(parse(`https://img.example.com/ai-wardrobe/${OWNER}/x?also=ai-wardrobe/${B}/y`)).toEqual(amb([B, OWNER].sort()));
    expect(parse(`https://res.cloudinary.com/demo/image/upload/l_ai-wardrobe:${B}:wardrobe:a/${ENC}`)).toEqual(amb([B, OWNER].sort()));
  });

  it.each([
    ["% roto sin ninguna mención", "https://res.cloudinary.com/demo/image/upload/v1/sample?_a=%ZZ"],
    ["cuenta en la ruta con codificación rota", `https://res.cloudinary.com/%ZZ/image/upload/v1/sample`],
    ["recurso no imagen de nuestra cuenta, sin mención", "https://res.cloudinary.com/demo/video/upload/sample"],
    ["descarga propia sin public_id", "https://api.cloudinary.com/v1_1/demo/image/download?type=upload"],
  ])("nuestra cuenta, no interpretable y sin indicios (%s) → protección global", (_n, u) => {
    expect(parse(u)).toEqual(amb(null));
  });

  it("una URL ambigua nunca produce un public_id exacto inventado", () => {
    for (const u of [`https://res.cloudinary.com/demo/image/upload/${ENC}?_a=%ZZ`, `https://api.cloudinary.com/v1_1/demo/image/download?public_id=${ENC}%ZZ`]) {
      expect(parse(u)).not.toHaveProperty("publicIds");
    }
  });

  it("otra cuenta de Cloudinary sigue siendo externa aunque tenga codificación rota", () => {
    expect(parse(`https://res.cloudinary.com/otra/image/upload/${ENC}?_a=%ZZ`)).toEqual({ kind: "external" });
  });

  it("ids parecidos no se confunden: w1 no protege w10, ni x.jpg protege x.jpeg", () => {
    const r = parse(`https://res.cloudinary.com/demo/image/upload/v1/ai-wardrobe/${OWNER}/wardrobe/w1.jpg`) as { publicIds: string[] };
    expect(r.publicIds).toEqual([`ai-wardrobe/${OWNER}/wardrobe/w1.jpg`, `ai-wardrobe/${OWNER}/wardrobe/w1`]);
    expect(r.publicIds).not.toContain(`ai-wardrobe/${OWNER}/wardrobe/w10`);
    expect(r.publicIds).not.toContain(`ai-wardrobe/${OWNER}/wardrobe/w1.jpeg`);
  });
});

describe("N1: bytes UTF-8 inválidos junto a caracteres codificados (19.1.4)", () => {
  const OWNER = "cmusuario0000000000000000";
  const amb = (ownerIds: string[] | null) => ({ kind: "ambiguous", ownerIds });

  it.each([
    ["barra codificada + byte inválido antes del propietario", "https://cdn.example.com/ai-wardrobe%2F%FFcmowner/wardrobe/x"],
    ["letra codificada + byte inválido tras la carpeta", "https://cdn.example.com/ai-wardrob%65%FF/cmowner/wardrobe/x"],
    ["letra, byte inválido y barra en un mismo tramo", "https://cdn.example.com/ai-wardrob%65%FF%2Fcmowner%2Fx"],
    ["texto que no es URL", "ai-wardrobe%2F%FEx"],
  ])("%s → la mención NO se pierde (propietario no acotable → global)", (_n, u) => {
    expect(parse(u)).toEqual(amb(null));
  });

  it.each([
    ["byte inválido después del propietario", `https://cdn.example.com/ai-wardrob%65%2F${OWNER}%2F%FF/x`],
    ["byte inválido antes de la carpeta", `https://cdn.example.com/%FF%2Fai-wardrobe%2F${OWNER}%2Fx`],
    ["barra codificada pegada a un byte inválido al final", `https://cdn.example.com/ai-wardrobe%2F${OWNER}%2F%FE%2Fx`],
  ])("%s → protege al propietario detectable", (_n, u) => {
    expect(parse(u)).toEqual(amb([OWNER]));
  });

  it("en nuestra cuenta se mantiene la protección conservadora", () => {
    expect(parse("https://res.cloudinary.com/demo/image/upload/ai-wardrobe%2F%FFcmowner")).toEqual(amb(null));
    expect(parse(`https://res.cloudinary.com/demo/image/upload/ai-wardrob%65%2F${OWNER}%2F%FF`)).toEqual(amb([OWNER]));
  });

  it("nunca lanza con secuencias % incompletas o basura", () => {
    for (const u of ["https://cdn.example.com/%", "https://cdn.example.com/%%", "https://cdn.example.com/%F", "%E0%A4%A", "%ZZ%FF%00", "https://res.cloudinary.com/demo/image/upload/%FF%FE%FD"]) {
      expect(() => parse(u)).not.toThrow();
    }
  });

  it("un byte inválido que no sigue a la carpeta no crea menciones falsas", () => {
    expect(parse("https://cdn.example.com/ai-wardrobe-logo%FF.png")).toEqual({ kind: "external" });
    expect(parse("https://cdn.example.com/foto%FF%2Fx.jpg")).toEqual({ kind: "external" });
  });

  it("credenciales: `ai-wardrobe:<id>@host` y `ai-wardrobe%2F<id>@host` acotan al propietario", () => {
    expect(parse(`https://ai-wardrobe:${OWNER}@img.example.com/foto.jpg`)).toEqual(amb([OWNER]));
    expect(parse(`https://ai-wardrobe%2F${OWNER}@img.example.com/foto.jpg`)).toEqual(amb([OWNER]));
    expect(parse("https://usuario:clave@img.example.com/foto.jpg")).toEqual({ kind: "external" });
  });
});

describe("19.1.6 I1: una URL exacta no ignora menciones adicionales", () => {
  const A = "cmpropietarioa00000000000";
  const B = "cmpropietariob00000000000";
  const amb = (ownerIds: string[] | null) => ({ kind: "ambiguous", ownerIds });

  it("res exacta con A en la ruta y B en las credenciales → ambigua con A y B (no exacta)", () => {
    expect(parse(`https://ai-wardrobe:${B}@res.cloudinary.com/demo/image/upload/v1/ai-wardrobe/${A}/wardrobe/x`)).toEqual(amb([A, B]));
    expect(parse(`https://ai-wardrobe%2F${B}@res.cloudinary.com/demo/image/upload/v1/ai-wardrobe/${A}/wardrobe/x`)).toEqual(amb([A, B]));
  });

  it("descarga exacta con A en public_id y B en el fragmento → ambigua con A y B", () => {
    expect(parse(`https://api.cloudinary.com/v1_1/demo/image/download?public_id=ai-wardrobe%2F${A}%2Fpersonal%2Fp#ai-wardrobe/${B}/y`)).toEqual(amb([A, B]));
  });

  it("descarga exacta con B en las credenciales → ambigua con A y B", () => {
    expect(parse(`https://ai-wardrobe:${B}@api.cloudinary.com/v1_1/demo/image/download?public_id=ai-wardrobe%2F${A}%2Fpersonal%2Fp`)).toEqual(amb([A, B]));
  });

  it("res exacta con una mención SIN propietario en el fragmento → global (nunca external)", () => {
    expect(parse(`https://res.cloudinary.com/demo/image/upload/v1/ai-wardrobe/${A}/wardrobe/x#ai-wardrobe`)).toEqual(amb(null));
  });

  it("sin menciones adicionales sigue siendo exacta (credenciales o fragmento ajenos no la alteran)", () => {
    expect(parse(`https://u:p@res.cloudinary.com/demo/image/upload/v1/ai-wardrobe/${A}/wardrobe/x#vista`)).toEqual(own([`ai-wardrobe/${A}/wardrobe/x`], "upload"));
    expect(parse(`https://api.cloudinary.com/v1_1/demo/image/download?public_id=ai-wardrobe%2F${A}%2Fpersonal%2Fp&type=authenticated#x`)).toEqual(own([`ai-wardrobe/${A}/personal/p`], "authenticated"));
  });
});

describe("19.1.6 M1: propietario incompleto por codificación inválida", () => {
  const OWNER = "cmusuario0000000000000000";
  const amb = (ownerIds: string[] | null) => ({ kind: "ambiguous", ownerIds });

  it.each([
    ["byte UTF-8 inválido intermedio", "https://cdn.example.com/ai-wardrobe/cm%FFowner/wardrobe/x"],
    ["secuencia UTF-8 truncada intermedia", "https://cdn.example.com/ai-wardrobe/cm%E0%A4owner/wardrobe/x"],
    ["bytes inválidos pegados al final del propietario", `https://cdn.example.com/ai-wardrobe%2F${OWNER}%E0%A4%2Fx`],
    ["% literal pegado al propietario", `https://cdn.example.com/ai-wardrobe/${OWNER}%ZZ/x`],
    ["carácter no ASCII pegado al propietario", `https://cdn.example.com/ai-wardrobe/${OWNER}%C3%A9/x`],
    ["propietario de más de 64 caracteres", `https://cdn.example.com/ai-wardrobe/${"a".repeat(70)}/x`],
    ["en nuestra cuenta (además, no decodifica)", "https://res.cloudinary.com/demo/image/upload/ai-wardrobe/cm%FFowner/wardrobe/x"],
  ])("%s → protección global (no solo el prefijo)", (_n, u) => {
    expect(parse(u)).toEqual(amb(null));
  });

  it.each([
    ["seguido de barra", `https://cdn.example.com/ai-wardrobe/${OWNER}/%FF/x`],
    ["barra codificada y byte inválido después", `https://cdn.example.com/ai-wardrobe%2F${OWNER}%2F%FE%2Fx`],
    ["seguido de dos puntos (capa)", `https://cdn.example.com/l_ai-wardrobe:${OWNER}:wardrobe:x`],
    ["al final de la parte", `https://cdn.example.com/x?o=ai-wardrobe/${OWNER}`],
    ["seguido de punto", `https://cdn.example.com/ai-wardrobe/${OWNER}.jpg`],
  ])("propietario completamente identificable (%s) → protección específica", (_n, u) => {
    expect(parse(u)).toEqual(amb([OWNER]));
  });
});
