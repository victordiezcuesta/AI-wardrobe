import { NextResponse } from "next/server";

/** Comprobación de vida para el despliegue; no toca la base de datos ni expone configuración. */
export const GET = () => NextResponse.json({ ok: true });
