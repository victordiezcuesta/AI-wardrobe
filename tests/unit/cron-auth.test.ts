import { afterEach, describe, expect, it, vi } from "vitest";

/** isAuthorizedCron: comparación en tiempo constante sobre BYTES; cualquier entrada no válida → false (nunca excepción). */
const envState = vi.hoisted(() => ({ secret: undefined as string | undefined }));
vi.mock("@/lib/env", () => ({ env: () => ({ CRON_SECRET: envState.secret }) }));
const crypto = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:crypto", async (orig) => {
  const real = await orig<typeof import("node:crypto")>();
  const timingSafeEqual = (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => { crypto.calls++; return real.timingSafeEqual(a, b); };
  return { ...real, timingSafeEqual, default: { ...real, timingSafeEqual } };
});

import { isAuthorizedCron } from "@/lib/auth/cron";

const SECRET = ["cron", "prueba", "0123456789abcdef"].join("-"); // ficticio (sin literal: regla de higiene)
const req = (auth?: string) => new Request("http://localhost:3000/api/cron/media-reconcile", { headers: auth === undefined ? {} : { authorization: auth } });
afterEach(() => { envState.secret = undefined; crypto.calls = 0; });

describe("isAuthorizedCron", () => {
  it("secreto correcto → true (comparado en tiempo constante)", () => {
    envState.secret = SECRET;
    expect(isAuthorizedCron(req(`Bearer ${SECRET}`))).toBe(true);
    expect(crypto.calls).toBe(1);
  });

  it("secreto incorrecto de la misma longitud → false, también comparado en tiempo constante", () => {
    envState.secret = SECRET;
    const wrong = `Bearer ${SECRET.slice(0, -1)}X`;
    expect(Buffer.byteLength(wrong)).toBe(Buffer.byteLength(`Bearer ${SECRET}`));
    expect(isAuthorizedCron(req(wrong))).toBe(false);
    expect(crypto.calls).toBe(1);
  });

  it.each([
    ["más corto", (s: string) => `Bearer ${s.slice(1)}`],
    ["más largo", (s: string) => `Bearer ${s}x`],
    ["sin «Bearer»", (s: string) => s],
    ["vacío", () => ""],
  ])("longitud distinta (%s) → false", (_n, make) => {
    envState.secret = SECRET;
    expect(isAuthorizedCron(req(make(SECRET)))).toBe(false);
  });

  it("sin cabecera → false", () => {
    envState.secret = SECRET;
    expect(isAuthorizedCron(req())).toBe(false);
  });

  it.each([
    ["é (latin-1, 2 bytes en UTF-8)", "é"],
    ["ÿ", "ÿ"],
    ["varios", "éàü"],
  ])("caracteres no ASCII con la MISMA longitud en caracteres (%s) → false, sin excepción", (_n, chars) => {
    envState.secret = SECRET;
    const given = `Bearer ${chars}${SECRET.slice(chars.length)}`;
    expect(given.length).toBe(`Bearer ${SECRET}`.length); // antes: misma longitud en caracteres → timingSafeEqual lanzaba
    const r = req(given);
    expect(r.headers.get("authorization")).toBe(given); // la cabecera llega tal cual (ByteString válido)
    expect(() => isAuthorizedCron(r)).not.toThrow();
    expect(isAuthorizedCron(r)).toBe(false);
  });

  it("no ASCII cuya longitud en BYTES coincide → se compara en tiempo constante y es false", () => {
    envState.secret = SECRET;
    const given = `Bearer é${SECRET.slice(2)}`; // «é» ocupa 2 bytes: sustituye a 2 caracteres ASCII
    expect(Buffer.byteLength(given)).toBe(Buffer.byteLength(`Bearer ${SECRET}`));
    expect(isAuthorizedCron(req(given))).toBe(false);
    expect(crypto.calls).toBe(1);
  });

  it.each([["ausente", undefined], ["vacío", ""]])("CRON_SECRET %s → false para cualquier cabecera", (_n, secret) => {
    envState.secret = secret;
    expect(isAuthorizedCron(req("Bearer "))).toBe(false);
    expect(isAuthorizedCron(req(`Bearer ${SECRET}`))).toBe(false);
    expect(isAuthorizedCron(req("Bearer undefined"))).toBe(false);
  });
});
