import { describe, expect, it } from "vitest";
import { CLIENT_IP_HEADER, resolveClientIp } from "@/lib/net/client-ip";

/** Fase 19.12c — resolvedor de IP del cliente (puro: entorno y cabeceras inyectados). */
const VERCEL = { VERCEL: "1" };
const h = (v: string, name = "x-forwarded-for") => new Headers({ [name]: v });
const ip = (v: string, env: { VERCEL?: string } = VERCEL) => resolveClientIp(h(v), env);
/** Cabeceras simuladas con el valor EXACTO: `Headers` recorta espacios y rechaza saltos de línea o caracteres no latinos. */
const raw = (v: string, env: { VERCEL?: string } = VERCEL) => resolveClientIp({ get: (n: string) => (n === "x-forwarded-for" ? v : null) } as unknown as Headers, env);

describe("Vercel: x-forwarded-for con una IP válida", () => {
  it("IPv4 → v4:<ip>", () => {
    expect(ip("203.0.113.7")).toBe("v4:203.0.113.7");
    expect(ip("  203.0.113.7  ")).toBe("v4:203.0.113.7"); // solo se recorta el espacio exterior
    expect(ip("0.0.0.0")).toBe("v4:0.0.0.0");
    expect(ip("255.255.255.255")).toBe("v4:255.255.255.255");
  });
  it("IPv6 → v6:<4 primeros grupos> (/64)", () => {
    expect(ip("2001:db8:85a3:8d3:1319:8a2e:370:7344")).toBe("v6:2001:db8:85a3:8d3");
    expect(ip("2001:db8::1")).toBe("v6:2001:db8:0:0");
    expect(ip("::1")).toBe("v6:0:0:0:0");
    expect(ip("::")).toBe("v6:0:0:0:0");
    expect(ip("fe80::1")).toBe("v6:fe80:0:0:0");
  });
  it("el nombre de la cabecera exportado es el documentado", () => { expect(CLIENT_IP_HEADER).toBe("x-forwarded-for"); });
});

describe("solo x-forwarded-for cuenta", () => {
  it("ausente → null", () => { expect(resolveClientIp(new Headers(), VERCEL)).toBeNull(); });
  it("x-vercel-forwarded-for aislada → null", () => { expect(resolveClientIp(h("203.0.113.7", "x-vercel-forwarded-for"), VERCEL)).toBeNull(); });
  it("x-real-ip aislada → null", () => { expect(resolveClientIp(h("203.0.113.7", "x-real-ip"), VERCEL)).toBeNull(); });
  it("conflicto: se usa x-forwarded-for y nunca las otras", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7", "x-vercel-forwarded-for": "198.51.100.9", "x-real-ip": "192.0.2.1" });
    expect(resolveClientIp(headers, VERCEL)).toBe("v4:203.0.113.7");
  });
  it("x-forwarded-for inválida NO se recupera con las otras cabeceras", () => {
    const headers = new Headers({ "x-forwarded-for": "basura", "x-vercel-forwarded-for": "198.51.100.9", "x-real-ip": "192.0.2.1" });
    expect(resolveClientIp(headers, VERCEL)).toBeNull();
  });
});

describe("entorno: solo VERCEL === \"1\"", () => {
  it.each([[{}], [{ VERCEL: "" }], [{ VERCEL: "0" }], [{ VERCEL: "true" }], [{ VERCEL: "yes" }], [{ VERCEL: " 1" }], [{ VERCEL: "1 " }], [{ VERCEL: "11" }], [{ VERCEL: "Vercel" }]])(
    "env %j → null aunque la cabecera sea válida", (env) => { expect(ip("203.0.113.7", env as { VERCEL?: string })).toBeNull(); });
  it("self-hosted con cabeceras falsificadas (todas) → null", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7", "x-vercel-forwarded-for": "203.0.113.8", "x-real-ip": "203.0.113.9", forwarded: "for=203.0.113.10" });
    expect(resolveClientIp(headers, {})).toBeNull();
    expect(resolveClientIp(headers, { VERCEL: undefined })).toBeNull();
  });
  it("no lanza con entornos o cabeceras anómalos", () => {
    expect(resolveClientIp(new Headers(), null as never)).toBeNull();
    expect(resolveClientIp({ get() { throw new Error("boom"); } } as unknown as Headers, VERCEL)).toBeNull();
    expect(resolveClientIp({ get: () => 5 } as unknown as Headers, VERCEL)).toBeNull();
    expect(resolveClientIp(null as never, VERCEL)).toBeNull();
  });
});

describe("cabeceras vacías, múltiples, largas o malformadas → null", () => {
  it.each([
    ["vacía", ""], ["solo espacios", "   "], ["tabuladores", "\t\t"],
    ["dos IPv4", "203.0.113.7, 198.51.100.9"], ["dos IPv4 sin espacio", "203.0.113.7,198.51.100.9"], ["IP y coma final", "203.0.113.7,"],
    ["coma inicial", ",203.0.113.7"], ["IPv4 + IPv6", "203.0.113.7, 2001:db8::1"], ["separadas por espacio", "203.0.113.7 198.51.100.9"],
    ["texto", "unknown"], ["hostname", "example.com"], ["con comillas", '"203.0.113.7"'], ["for=", "for=203.0.113.7"],
  ])("%s", (_n, v) => { expect(ip(v)).toBeNull(); });
  it("excesivamente larga (más de 64) → null sin procesarse", () => {
    expect(ip("1".repeat(65))).toBeNull();
    expect(raw(`203.0.113.7${" ".repeat(100)}`)).toBeNull(); // el valor bruto supera 64 aunque una IP «recortada» fuera válida
    expect(ip(`203.0.113.7,${"1.1.1.1,".repeat(200)}`)).toBeNull();
    expect(ip("a".repeat(5000))).toBeNull();
  });
  it("entre 46 y 64 caracteres (más que cualquier IP) → null", () => { expect(ip("2001:db8:0:0:0:0:0:1".padEnd(50, " ") + "0")).toBeNull(); });
});

describe("formatos no admitidos → null (no se intenta limpiar)", () => {
  it.each([
    ["IPv4 con puerto", "203.0.113.7:8080"], ["IPv6 con corchetes", "[2001:db8::1]"], ["IPv6 con corchetes y puerto", "[2001:db8::1]:443"],
    ["IPv6 con zona", "fe80::1%eth0"], ["IPv6 con zona numérica", "fe80::1%1"], ["IPv4 con ceros a la izquierda", "203.000.113.007"],
    ["IPv4 con un cero a la izquierda", "01.2.3.4"], ["IPv4 abreviada", "1.2.3"], ["IPv4 de 5 octetos", "1.2.3.4.5"], ["IPv4 hexadecimal", "0x7f.0.0.1"],
    ["IPv4 entera", "2130706433"], ["IPv4 con octeto 256", "256.1.1.1"], ["IPv4 negativa", "-1.2.3.4"], ["IPv6 con demasiados grupos", "1:2:3:4:5:6:7:8:9"],
    ["IPv6 con dos «::»", "2001::db8::1"], ["IPv6 con grupo de 5 dígitos", "2001:db8:12345::1"], ["IPv6 con carácter no hex", "2001:db8::g"],
    ["con CIDR", "203.0.113.0/24"], ["con barra", "2001:db8::/64"], ["IPv4-mapped con puerto", "::ffff:203.0.113.7:80"],
    ["URL", "http://203.0.113.7"], ["con punto final", "203.0.113.7."], 
  ])("%s", (_n, v) => { expect(ip(v)).toBeNull(); });
});

describe("valores brutos que Headers no deja construir", () => {
  it.each([
    ["dígitos de ancho completo", "２０３.0.113.7"], ["salto de línea interno", "203.0.113.7\n198.51.100.9"], ["retorno de carro", "203.0.113.7\r"],
    ["byte nulo", "203.0.113.7\u0000"], ["espacio sin ruptura", "203.0.113.7\u00a0"], ["tabulador interno", "203.0.113.\t7"], ["coma de ancho completo", "203.0.113.7，198.51.100.9"],
  ])("%s → null", (_n, v) => { expect(raw(v)).toBeNull(); });
  it("espacios y tabuladores exteriores sí se recortan", () => { expect(raw(" \t203.0.113.7\t ")).toBe("v4:203.0.113.7"); });
});

describe("IPv4-mapped IPv6", () => {
  it("::ffff:a.b.c.d y su forma hexadecimal dan la clave de la IPv4", () => {
    expect(ip("::ffff:203.0.113.7")).toBe("v4:203.0.113.7");
    expect(ip("::FFFF:203.0.113.7")).toBe("v4:203.0.113.7");
    expect(ip("::ffff:cb00:7107")).toBe("v4:203.0.113.7");
    expect(ip("0:0:0:0:0:ffff:cb00:7107")).toBe("v4:203.0.113.7");
    expect(ip("0000:0000:0000:0000:0000:ffff:203.0.113.7")).toBe("v4:203.0.113.7");
    expect(ip("::ffff:0.0.0.0")).toBe("v4:0.0.0.0");
    expect(ip("::ffff:255.255.255.255")).toBe("v4:255.255.255.255");
  });
  it("coincide exactamente con la clave de la IPv4 nativa", () => { expect(ip("::ffff:10.1.2.3")).toBe(ip("10.1.2.3")); });
  it("no confunde otras direcciones con IPv4-mapped", () => {
    expect(ip("::fffe:203.0.113.7")).toBe("v6:0:0:0:0");
    expect(ip("1::ffff:203.0.113.7")).toBe("v6:1:0:0:0");
    expect(ip("::1:ffff:cb00:7107")).toBe("v6:0:0:0:0"); // grupo 5 = 1: no es ::ffff:…
    expect(ip("0:0:0:1:0:ffff:cb00:7107")).toBe("v6:0:0:0:1"); // grupo 4 ≠ 0: tampoco
  });
});

describe("IPv6: representaciones equivalentes → la misma clave", () => {
  const EQUIVALENTS = [
    "2001:db8::1", "2001:DB8::1", "2001:0db8:0:0:0:0:0:1", "2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8:0:0::1", "2001:db8::0:1", "2001:0DB8::0001",
  ];
  it("todas las formas de 2001:db8::1 coinciden", () => {
    const keys = new Set(EQUIVALENTS.map((v) => ip(v)));
    expect([...keys]).toEqual(["v6:2001:db8:0:0"]);
  });
  it("comprimida y expandida de otras direcciones", () => {
    expect(ip("fe80::")).toBe(ip("fe80:0:0:0:0:0:0:0"));
    expect(ip("::2")).toBe(ip("0:0:0:0:0:0:0:2"));
    expect(ip("2001:db8:1::")).toBe(ip("2001:0db8:0001:0000:0000:0000:0000:0000"));
    expect(ip("1:2:3:4:5:6:7:8")).toBe("v6:1:2:3:4");
    expect(ip("1:2:3:4:5:6:7::")).toBe("v6:1:2:3:4");
    expect(ip("::2:3:4:5:6:7:8")).toBe("v6:0:2:3:4");
  });
  it("la compresión de un grupo «0» (ambigua) no cambia la clave", () => {
    expect(ip("2001:db8:0:1:1:1:1:1")).toBe("v6:2001:db8:0:1");
    expect(ip("2001:db8::1:1:1:1")).toBe("v6:2001:db8:0:0");
  });
});

describe("agrupación /64", () => {
  it("misma /64 → misma clave, con independencia de los 64 bits bajos", () => {
    const a = ip("2001:db8:85a3:8d3::1"); const b = ip("2001:db8:85a3:8d3:ffff:ffff:ffff:ffff"); const c = ip("2001:db8:85a3:8d3:1:2:3:4");
    expect(a).toBe("v6:2001:db8:85a3:8d3");
    expect(b).toBe(a); expect(c).toBe(a);
  });
  it("/64 distintas → claves distintas (se distingue cualquiera de los 4 primeros grupos)", () => {
    const base = ip("2001:db8:85a3:8d3::1");
    for (const other of ["2001:db8:85a3:8d4::1", "2001:db8:85a4:8d3::1", "2001:db9:85a3:8d3::1", "2002:db8:85a3:8d3::1"]) expect(ip(other)).not.toBe(base);
  });
  it("una IPv4 y una IPv6 nunca comparten clave", () => { expect(ip("1.2.3.4")).not.toBe(ip("::1:2:3:4")); expect(ip("1.2.3.4")?.startsWith("v4:")).toBe(true); });
});

describe("direcciones privadas, locales y reservadas: no se descartan", () => {
  it.each([
    ["10.0.0.1", "v4:10.0.0.1"], ["172.16.5.4", "v4:172.16.5.4"], ["192.168.1.10", "v4:192.168.1.10"], ["127.0.0.1", "v4:127.0.0.1"], ["169.254.1.1", "v4:169.254.1.1"],
    ["100.64.0.1", "v4:100.64.0.1"], ["fc00::1", "v6:fc00:0:0:0"], ["fd12:3456:789a:1::1", "v6:fd12:3456:789a:1"], ["::1", "v6:0:0:0:0"], ["fe80::1", "v6:fe80:0:0:0"],
    ["::ffff:192.168.1.10", "v4:192.168.1.10"],
  ])("%s", (v, key) => { expect(ip(v)).toBe(key); });
});

describe("determinismo y ausencia de efectos", () => {
  it("mismo resultado en llamadas repetidas y sin modificar las cabeceras", () => {
    const headers = new Headers({ "x-forwarded-for": "2001:DB8::1" });
    const first = resolveClientIp(headers, VERCEL);
    for (let i = 0; i < 5; i++) expect(resolveClientIp(headers, VERCEL)).toBe(first);
    expect(headers.get("x-forwarded-for")).toBe("2001:DB8::1");
  });
  it("no registra nada en consola", () => {
    const spies = (["log", "info", "warn", "error"] as const).map((k) => { const orig = console[k]; let n = 0; console[k] = () => { n++; }; return { k, orig, calls: () => n }; });
    try { for (const v of ["203.0.113.7", "basura", "", "1.2.3.4, 5.6.7.8", "[::1]:80"]) ip(v); resolveClientIp(null as never, VERCEL); } finally { for (const s of spies) console[s.k] = s.orig; }
    expect(spies.map((s) => s.calls())).toEqual([0, 0, 0, 0]);
  });
});
