import nodemailer from "nodemailer";
import { env } from "@/lib/env";
import { MailDeadlineError } from "./failure";

/**
 * Tiempos del transporte SMTP (Fase F.2). Los valores por defecto de nodemailer (2 min de conexión, 10 min de socket) superan con mucho
 * el `maxDuration` de cualquier ruta que envíe correo: un SMTP colgado dejaba la petición esperando hasta que la plataforma la cortaba,
 * sin dejar rastro en el log. Cada fase tiene su límite (`socketTimeout` mide INACTIVIDAD, no tiempo total) y, además,
 * `SEND_DEADLINE_MS` acota cuánto ESPERA la aplicación por el envío entero: 20 s deja margen bajo el `maxDuration = 30` de la ruta de
 * recuperación (el resto del presupuesto es para la consulta de usuario y el token). Se aplican a todo el correo (verificación y
 * recuperación): un envío sano tarda del orden de 1 s, muy por debajo.
 *
 * IMPORTANTE (F.2.1): vencer el plazo NO cancela el envío. nodemailer 7 no ofrece cancelación y `transport.close()` en el transporte
 * SMTP sin pool solo libera recursos del transportador (emite `close`); no cierra la conexión del envío en curso. Esa conexión sigue
 * hasta que termine o venzan los timeouts de nodemailer, y el correo todavía puede entregarse. Por eso el plazo se señala con
 * `MailDeadlineError` (entrega incierta), distinta de un fallo SMTP confirmado.
 */
export const SMTP_TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000 } as const;
export const SEND_DEADLINE_MS = 20_000;

export async function sendMail(to: string, subject: string, text: string, html?: string) {
  const e = env();
  if (!e.SMTP_HOST) {
    if (process.env.NODE_ENV === "production") {
      // En producción nunca se imprime el destinatario, el texto ni el enlace (llevan el token): solo el diagnóstico de configuración.
      console.error(JSON.stringify({ level: "error", scope: "mail", message: "SMTP_HOST no configurado: el correo no se ha enviado" }));
      return;
    }
    // Desarrollo sin SMTP: el enlace se imprime en consola.
    console.info(JSON.stringify({ level: "info", scope: "mail", to, subject, text }));
    return;
  }
  const transport = nodemailer.createTransport({
    host: e.SMTP_HOST,
    port: e.SMTP_PORT,
    secure: e.SMTP_PORT === 465,
    auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASSWORD } : undefined,
    ...SMTP_TIMEOUTS,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MailDeadlineError()), SEND_DEADLINE_MS);
  });
  try {
    await Promise.race([transport.sendMail({ from: e.EMAIL_FROM, to, subject, text, html }), deadline]);
  } catch (err) {
    // Limpieza del transportador. NO aborta un envío en curso (ver arriba): tras un `MailDeadlineError` el envío puede seguir y completarse.
    try { transport.close(); } catch { /* ya cerrado */ }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
