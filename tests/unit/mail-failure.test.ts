import { describe, expect, it } from "vitest";
import { MailDeadlineError, mailFailure } from "@/lib/mail/failure";

/** Fase F.2 — el error de envío que llega al log solo conserva códigos técnicos con el formato esperado. */
const SECRETS = ["ana@example.com", "token=abc123def456", "https://app.example.com/reset-password?token=abc123def456", "smtp-secreto", "Recipient address rejected"];
const text = (e: Error) => `${e.message}\n${e.stack ?? ""}`;
const noSecrets = (e: Error) => { for (const s of SECRETS) expect(text(e)).not.toContain(s); };

describe("mailFailure", () => {
  it("conserva code, responseCode y command válidos", () => {
    const e = mailFailure({ code: "EAUTH", responseCode: 535, command: "AUTH PLAIN", message: "Invalid login for ana@example.com" });
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("Fallo de envío de correo (code=EAUTH, responseCode=535, command=AUTH PLAIN)");
  });

  it("nunca incluye message, destinatario, token, enlace, credenciales ni texto del servidor", () => {
    const err = Object.assign(new Error(`Recipient address rejected: ana@example.com ${SECRETS[2]} pass=smtp-secreto`), {
      code: "EENVELOPE", responseCode: 550, command: "RCPT TO", response: `550 ${SECRETS[4]} ana@example.com`,
      rejected: ["ana@example.com"], envelope: { to: ["ana@example.com"] }, options: { auth: { pass: "smtp-secreto" } },
    });
    const e = mailFailure(err);
    expect(e.message).toBe("Fallo de envío de correo (code=EENVELOPE, responseCode=550, command=RCPT TO)");
    noSecrets(e);
  });

  it.each([
    ["code en minúsculas", { code: "eauth" }],
    ["code con texto libre", { code: "EAUTH ana@example.com" }],
    ["code demasiado largo", { code: "E".repeat(33) }],
    ["code con salto de línea al final", { code: "EAUTH\n" }],
    ["code que no es texto", { code: 535 }],
    ["responseCode como texto", { responseCode: "535" }],
    ["responseCode decimal", { responseCode: 535.5 }],
    ["responseCode fuera de rango", { responseCode: 99 }],
    ["responseCode fuera de rango (alto)", { responseCode: 600 }],
    ["responseCode NaN", { responseCode: NaN }],
    ["command con parámetros", { command: "RCPT TO:<ana@example.com>" }],
    ["command en minúsculas", { command: "rcpt to" }],
    ["command demasiado largo", { command: "A".repeat(17) }],
    ["command que no es texto", { command: { toString: (): string => "DATA" } }],
  ])("descarta un campo inválido: %s", (_n, err) => {
    const e = mailFailure(err);
    expect(e.message).toBe("Fallo de envío de correo");
    noSecrets(e);
  });

  it("acepta cada campo por separado y descarta solo el inválido", () => {
    expect(mailFailure({ code: "ETIMEDOUT" }).message).toBe("Fallo de envío de correo (code=ETIMEDOUT)");
    expect(mailFailure({ code: "ESOCKET", responseCode: 0, command: "CONN" }).message).toBe("Fallo de envío de correo (code=ESOCKET, command=CONN)");
    expect(mailFailure({ responseCode: 421 }).message).toBe("Fallo de envío de correo (responseCode=421)");
  });

  it.each([[null], [undefined], ["ana@example.com"], [42], [true], [Symbol("x")]])("entrada que no es un objeto (%s) → mensaje genérico", (err) => {
    const e = mailFailure(err);
    expect(e.message).toBe("Fallo de envío de correo");
    noSecrets(e);
  });

  it("objetos manipulados: getters que lanzan, Proxy hostil y prototipo con datos no producen nada y no lanzan", () => {
    const hostile = new Proxy({}, { get() { throw new Error("ana@example.com"); } });
    expect(() => mailFailure(hostile)).not.toThrow();
    expect(mailFailure(hostile).message).toBe("Fallo de envío de correo");
    const getter = { get code(): string { throw new Error(SECRETS[2]); }, responseCode: 550 };
    expect(mailFailure(getter).message).toBe("Fallo de envío de correo (responseCode=550)");
    const withProto = Object.create({ code: "EAUTH" }) as object;
    expect(mailFailure(withProto).message).toBe("Fallo de envío de correo (code=EAUTH)"); // el prototipo normal de un Error: mismo formato validado
  });

  it("el plazo total de envío se registra como entrega incierta, sin ningún dato del error original", () => {
    const original = Object.assign(new MailDeadlineError(), { to: "ana@example.com", url: SECRETS[2], code: "EAUTH", responseCode: 535 });
    const e = mailFailure(original);
    expect(e.message).toBe("Entrega de correo incierta (plazo de envío agotado)");
    expect(e).not.toBe(original);
    noSecrets(e);
  });

  it("solo el plazo propio es «incierto»: un error que imita su name o su code, o un ETIMEDOUT de nodemailer, es un fallo normal", () => {
    expect(mailFailure(Object.assign(new Error("x"), { name: "MailDeadlineError" })).message).toBe("Fallo de envío de correo");
    expect(mailFailure(Object.assign(new Error("x"), { code: "ETIMEDOUT", command: "SEND" })).message).toBe("Fallo de envío de correo (code=ETIMEDOUT, command=SEND)");
    expect(mailFailure(Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT", command: "CONN" })).message).toBe("Fallo de envío de correo (code=ETIMEDOUT, command=CONN)");
  });

  it("devuelve un Error nuevo (no el recibido) y no conserva su stack ni su causa", () => {
    const original = Object.assign(new Error("ana@example.com"), { code: "EAUTH", cause: new Error("smtp-secreto") });
    const e = mailFailure(original);
    expect(e).not.toBe(original);
    expect((e as Error & { cause?: unknown }).cause).toBeUndefined();
    noSecrets(e);
  });
});
