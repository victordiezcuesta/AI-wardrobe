import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Las páginas del panel no pueden confiar en la redirección del layout (se renderizan en paralelo): sin sesión válida
 * (JWT revocado o sin sid) deben redirigir ellas mismas a /login, sin llegar a consultar datos.
 */
const state = vi.hoisted(() => ({ session: null as { user: { id: string } } | null }));
const dashboardGet = vi.hoisted(() => vi.fn());
const findById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/session", () => ({ currentSession: async () => state.session }));
vi.mock("@/services/dashboard.service", () => ({ dashboardService: { get: dashboardGet } }));
vi.mock("@/repositories/user.repository", () => ({ userRepository: { findById } }));

/** redirect() de Next lanza un error especial con digest "NEXT_REDIRECT;<tipo>;<url>;<código>;". */
async function redirectTarget(render: () => Promise<unknown>): Promise<string | null> {
  try { await render(); return null; } catch (e) {
    const digest = (e as { digest?: string }).digest ?? "";
    if (!digest.startsWith("NEXT_REDIRECT")) throw e;
    return digest.split(";")[2] ?? null;
  }
}

type Page = () => Promise<unknown>;
let DashboardPage: Page;
let ProfilePage: Page;
// Importación en frío de las páginas (next/image, componentes, constantes…): ~1 s en aislado, pero con la suite en
// paralelo puede superar los 5 s de un test. Se hace una vez aquí, con margen propio, y los tests solo miden la lógica.
beforeAll(async () => {
  ({ default: DashboardPage } = await import("@/app/(dashboard)/dashboard/page"));
  ({ default: ProfilePage } = await import("@/app/(dashboard)/profile/page"));
}, 60_000);

beforeEach(() => { state.session = null; dashboardGet.mockReset(); findById.mockReset(); });

describe("páginas protegidas sin sesión", () => {
  it("dashboard redirige a /login sin consultar datos ni lanzar TypeError", async () => {
    expect(await redirectTarget(() => DashboardPage())).toBe("/login");
    expect(dashboardGet).not.toHaveBeenCalled();
  });

  it("profile redirige a /login sin consultar datos ni lanzar TypeError", async () => {
    expect(await redirectTarget(() => ProfilePage())).toBe("/login");
    expect(findById).not.toHaveBeenCalled();
  });

  it("con sesión válida, usan el id comprobado", async () => {
    state.session = { user: { id: "u1" } };
    findById.mockResolvedValue({ name: "Ana", profile: null });
    expect(await redirectTarget(() => ProfilePage())).toBeNull();
    expect(findById).toHaveBeenCalledWith("u1");
  });
});
