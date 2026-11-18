import nodemailer from "nodemailer";
import { env } from "@/lib/env";

export async function sendMail(to: string, subject: string, text: string, html?: string) {
  const e = env();
  if (!e.SMTP_HOST) {
    // Desarrollo sin SMTP: el enlace se imprime en consola. En producción configura SMTP_*.
    console.info(JSON.stringify({ level: "info", scope: "mail", to, subject, text }));
    return;
  }
  const transport = nodemailer.createTransport({
    host: e.SMTP_HOST,
    port: e.SMTP_PORT,
    secure: e.SMTP_PORT === 465,
    auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASSWORD } : undefined,
  });
  await transport.sendMail({ from: e.EMAIL_FROM, to, subject, text, html });
}
