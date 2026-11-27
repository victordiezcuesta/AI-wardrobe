/**
 * Error de envío de correo apto para el log (Fase F.2). Un error de nodemailer puede llevar en `message`, `response` o `stack` la
 * dirección del destinatario, el enlace con el token o texto del servidor SMTP: nada de eso debe llegar a los logs. Solo se conservan tres
 * campos técnicos, y únicamente si tienen el formato esperado:
 *   - `code`: identificador en mayúsculas (EAUTH, ECONNECTION, ETIMEDOUT, EENVELOPE…);
 *   - `responseCode`: entero entre 100 y 599 (código de respuesta SMTP);
 *   - `command`: nombre del comando SMTP en mayúsculas (CONN, AUTH PLAIN, RCPT TO, DATA…), sin parámetros.
 * Un objeto manipulado (getters que lanzan, `Proxy`, valores con otro tipo o con texto libre) nunca introduce nada más: el resultado
 * es un `Error` nuevo cuyo mensaje se construye aquí. Mismo patrón que `safeDbError` para los errores de Prisma.
 */
/**
 * Vencimiento del PLAZO TOTAL de envío (`SEND_DEADLINE_MS` en `lib/mail`). Es una clase propia y se reconoce con `instanceof`: ningún
 * error de nodemailer puede serlo (ni siquiera sus `ETIMEDOUT`, que son fallos de conexión o de socket que cierran la conexión), y
 * tampoco un objeto que imite su `name` o su `code`. Significa ENTREGA INCIERTA: la aplicación dejó de esperar, pero el envío no se
 * cancela (nodemailer no lo permite) y el correo todavía puede llegar.
 */
export class MailDeadlineError extends Error {
  constructor() {
    super("Tiempo de envío agotado");
    this.name = "MailDeadlineError";
  }
}

const CODE = /^[A-Z][A-Z0-9_]{0,31}$/;
const COMMAND = /^[A-Z][A-Z0-9 ]{0,15}$/;

function read(obj: unknown, key: string): unknown {
  try { return (obj as Record<string, unknown>)[key]; } catch { return undefined; }
}

export function mailFailure(err: unknown): Error {
  if (err instanceof MailDeadlineError) return new Error("Entrega de correo incierta (plazo de envío agotado)");
  const parts: string[] = [];
  if (err !== null && (typeof err === "object" || typeof err === "function")) {
    const code = read(err, "code");
    if (typeof code === "string" && CODE.test(code)) parts.push(`code=${code}`);
    const responseCode = read(err, "responseCode");
    if (typeof responseCode === "number" && Number.isInteger(responseCode) && responseCode >= 100 && responseCode <= 599) parts.push(`responseCode=${responseCode}`);
    const command = read(err, "command");
    if (typeof command === "string" && COMMAND.test(command)) parts.push(`command=${command}`);
  }
  return new Error(`Fallo de envío de correo${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`);
}
