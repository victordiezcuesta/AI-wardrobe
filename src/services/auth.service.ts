import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { sendMail } from "@/lib/mail";
import { userRepository } from "@/repositories/user.repository";
import { tokenRepository, type TokenKind } from "@/repositories/token.repository";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const TTL_MS: Record<TokenKind, number> = { VERIFY_EMAIL: 24 * 3600e3, RESET_PASSWORD: 3600e3 };

async function issueToken(email: string, kind: TokenKind): Promise<string> {
  const raw = randomBytes(32).toString("hex");
  await tokenRepository.replace(email, kind, sha256(raw), new Date(Date.now() + TTL_MS[kind]));
  return raw;
}

async function consumeToken(raw: string, kind: TokenKind): Promise<string> {
  const hash = sha256(raw);
  const record = await tokenRepository.find(hash, kind);
  if (!record || record.expires < new Date()) throw new AppError("Enlace no válido o caducado", 400, "INVALID_TOKEN");
  await tokenRepository.delete(hash);
  return record.identifier;
}

export const authService = {
  async register(input: { email: string; password: string; name?: string }) {
    const existing = await userRepository.findByEmail(input.email);

    // Si existe y no ha verificado su email, reenviamos un nuevo enlace.
    if (existing) {
      if (!existing.emailVerified) {
        await this.sendVerification(input.email);
      }
      return;
    }

    const passwordHash = await bcrypt.hash(input.password, 12);
    await userRepository.create({ email: input.email, name: input.name, passwordHash });
    await this.sendVerification(input.email);
  },

  async sendVerification(email: string) {
    const token = await issueToken(email, "VERIFY_EMAIL");
    const url = `${env().NEXT_PUBLIC_APP_URL}/verify-email?token=${token}`;
    await sendMail(email, "Confirma tu email en AI Wardrobe", `Confirma tu cuenta: ${url} \nEl enlace caduca en 24 horas.`);
  },

  async verifyEmail(rawToken: string) {
    const email = await consumeToken(rawToken, "VERIFY_EMAIL");
    await userRepository.markVerified(email);
  },

  async requestReset(email: string) {
    const user = await userRepository.findByEmail(email);
    if (!user?.passwordHash) return;
    const token = await issueToken(email, "RESET_PASSWORD");
    const url = `${env().NEXT_PUBLIC_APP_URL}/reset-password?token=${token}`;
    await sendMail(email, "Restablece tu contraseña", `Crea una nueva contraseña: ${url} \nEl enlace caduca en 1 hora.`);
  },

  async resetPassword(rawToken: string, password: string) {
    const email = await consumeToken(rawToken, "RESET_PASSWORD");
    await userRepository.setPassword(email, await bcrypt.hash(password, 12));
    await userRepository.markVerified(email); // recibir el enlace demuestra control del email
  },

  async verifyCredentials(email: string, password: string) {
    const user = await userRepository.findByEmail(email);
    // Comparación siempre ejecutada para igualar tiempos de respuesta.
    const hash = user?.passwordHash ?? "$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali";
    const ok = await bcrypt.compare(password, hash);
    if (!user || !ok) return null;
    if (!user.emailVerified) return null;
    return { id: user.id, email: user.email, name: user.name };
  },
};
