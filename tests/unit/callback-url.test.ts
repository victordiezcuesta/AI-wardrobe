import { describe, expect, it } from "vitest";
import { DEFAULT_AFTER_LOGIN, safeCallbackPath } from "@/features/authentication/callback-url";

const ORIGIN = "http://localhost:3000";
const check = (raw: string | null | undefined) => safeCallbackPath(raw, ORIGIN);

describe("safeCallbackPath: destinos permitidos", () => {
  it.each([
    ["/dashboard", "/dashboard"],
    ["/wardrobe", "/wardrobe"],
    ["/profile", "/profile"],
    ["/wardrobe?category=shirts", "/wardrobe?category=shirts"],
    ["/stylist?date=2026-11-19", "/stylist?date=2026-11-19"],
    ["/wardrobe?q=camisa%20azul&favorite=true#top", "/wardrobe?q=camisa%20azul&favorite=true#top"],
    // URL absoluta del mismo origen: es lo que genera el proxy de Auth.js (request.nextUrl.href)
    [`${ORIGIN}/wardrobe?category=shirts`, "/wardrobe?category=shirts"],
    [`${ORIGIN}/try-on`, "/try-on"],
    // Codificado: se queda en el propio dominio (es una ruta, no un host)
    ["/%2F%2Fevil.example", "/%2F%2Fevil.example"],
  ])("%s → %s", (raw, expected) => {
    expect(check(raw)).toBe(expected);
  });
});

describe("safeCallbackPath: destinos rechazados (→ /dashboard)", () => {
  it.each([
    "https://evil.example",
    "http://evil.example",
    "https://evil.example/dashboard",
    "//evil.example",
    "///evil.example",
    "////evil.example",
    "/\\evil.example",
    "/\\/evil.example",
    "\\\\evil.example",
    "\\/evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    " /dashboard",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "blob:http://localhost:3000/uuid",
    "file:///etc/passwd",
    "mailto:a@b.c",
    "http://localhost:3001/dashboard", // otro puerto = otro origen
    "https://localhost:3000/dashboard", // otro protocolo = otro origen
    "http://localhost:3000.evil.example/dashboard",
    "http://user:pass@localhost:3000/dashboard",
    "http://evil.example@localhost:3000/", // credenciales en la URL
    "",
    "http://",
    "http://[::1",
  ])("%j", (raw) => {
    expect(check(raw)).toBe(DEFAULT_AFTER_LOGIN);
  });

  it("null / undefined → /dashboard", () => {
    expect(check(null)).toBe(DEFAULT_AFTER_LOGIN);
    expect(check(undefined)).toBe(DEFAULT_AFTER_LOGIN);
  });

  it("páginas de autenticación y APIs no son destino (evita bucles) → /dashboard", () => {
    for (const raw of ["/login", "/login?callbackUrl=/wardrobe", "/register", "/forgot-password", "/reset-password?token=x", "/verify-email", "/api/profile", `${ORIGIN}/login`]) {
      expect(check(raw), raw).toBe(DEFAULT_AFTER_LOGIN);
    }
    expect(check("/loginx")).toBe("/loginx"); // solo coincidencias exactas de segmento
  });

  it("el resultado siempre es una ruta interna de una sola barra inicial", () => {
    const samples = ["//a", "/\\a", "https://a", "/ok?x=1", `${ORIGIN}//evil.example`, "javascript:x", "/a/../../b"];
    for (const raw of samples) {
      const out = check(raw);
      expect(out.startsWith("/") && !out.startsWith("//") && !out.includes("\\"), raw).toBe(true);
      expect(new URL(out, ORIGIN).origin).toBe(ORIGIN);
    }
  });

  it("si el origen de la app no es válido, falla de forma segura", () => {
    expect(safeCallbackPath("/wardrobe", "no-es-un-origen")).toBe(DEFAULT_AFTER_LOGIN);
  });
});
