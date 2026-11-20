import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** SDK de Cloudinary simulado: ninguna prueba llama al servicio real. */
const sdk = vi.hoisted(() => ({
  config: vi.fn(),
  url: vi.fn((publicId: string) => `https://res.cloudinary.com/c/image/upload/${publicId}`),
  uploader: { upload: vi.fn(), upload_stream: vi.fn(), destroy: vi.fn() },
  api: { delete_resources: vi.fn() },
  utils: { private_download_url: vi.fn() },
}));
vi.mock("cloudinary", () => ({ v2: sdk }));

const box = { x: 10, y: 20, width: 100, height: 200 };
const uploaded = (format: string) => ({ public_id: "ai-wardrobe/u1/wardrobe/crop1", format, width: 100, height: 200 });

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  Object.assign(process.env, { DATABASE_URL: "postgres://x", AUTH_SECRET: "x".repeat(32), CLOUDINARY_CLOUD_NAME: "c", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s" });
});
afterEach(() => vi.restoreAllMocks());

describe("uploadCrop (Cloudinary)", () => {
  it.each(["jpg", "png", "webp", "JPG"])("formato admitido (%s) → recurso nuevo con sus URLs; exige los formatos permitidos", async (format) => {
    sdk.uploader.upload.mockResolvedValue(uploaded(format));
    const { uploadCrop } = await import("@/lib/cloudinary");
    const out = await uploadCrop("ai-wardrobe/u1/wardrobe/src", box, "ai-wardrobe/u1/wardrobe");
    expect(out).toMatchObject({ publicId: "ai-wardrobe/u1/wardrobe/crop1", width: 100, height: 200 });
    expect(out.url).toContain("crop1");
    const [, opts] = sdk.uploader.upload.mock.calls[0]!;
    expect(opts).toMatchObject({ folder: "ai-wardrobe/u1/wardrobe", resource_type: "image", allowed_formats: ["jpg", "png", "webp"] });
    expect(sdk.uploader.destroy).not.toHaveBeenCalled();
  });

  it("el recorte se pide sobre la imagen origen con las coordenadas del cuadro", async () => {
    sdk.uploader.upload.mockResolvedValue(uploaded("jpg"));
    const { uploadCrop } = await import("@/lib/cloudinary");
    await uploadCrop("ai-wardrobe/u1/wardrobe/src", box, "f");
    expect(sdk.url).toHaveBeenCalledWith("ai-wardrobe/u1/wardrobe/src", expect.objectContaining({ secure: true, transformation: [{ crop: "crop", ...box }] }));
  });

  it("Cloudinary rechaza el formato (400) → INVALID_IMAGE 422 genérico; el detalle solo va al log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sdk.uploader.upload.mockRejectedValue({ http_code: 400, message: "Image file format gif not allowed" });
    const { uploadCrop } = await import("@/lib/cloudinary");
    const err = await uploadCrop("src", box, "f").then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ status: 422, code: "INVALID_IMAGE" });
    expect((err as Error).message).not.toMatch(/cloudinary|gif|400/i);
    expect(String(log.mock.calls[0]?.[0])).toContain("gif not allowed");
  });

  it("resultado con un formato no permitido (defensa adicional) → se borra el recurso y INVALID_IMAGE", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    sdk.uploader.upload.mockResolvedValue(uploaded("gif"));
    sdk.uploader.destroy.mockResolvedValue({ result: "ok" });
    const { uploadCrop } = await import("@/lib/cloudinary");
    await expect(uploadCrop("src", box, "f")).rejects.toMatchObject({ status: 422, code: "INVALID_IMAGE" });
    expect(sdk.uploader.destroy).toHaveBeenCalledWith("ai-wardrobe/u1/wardrobe/crop1", { invalidate: true });
  });

  it("si además falla ese borrado, el error sigue siendo INVALID_IMAGE (el borrado fallido solo se registra)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    sdk.uploader.upload.mockResolvedValue(uploaded("tiff"));
    sdk.uploader.destroy.mockRejectedValue({ http_code: 500, message: "boom" });
    const { uploadCrop } = await import("@/lib/cloudinary");
    await expect(uploadCrop("src", box, "f")).rejects.toMatchObject({ code: "INVALID_IMAGE" });
  });

  it.each([
    ["5xx del proveedor", { http_code: 500, message: "Internal" }],
    ["error de red", new Error("socket hang up")],
  ])("fallo de subida (%s) → STORAGE_UNAVAILABLE 502 genérico", async (_n, failure) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    sdk.uploader.upload.mockRejectedValue(failure);
    const { uploadCrop } = await import("@/lib/cloudinary");
    const err = await uploadCrop("src", box, "f").then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: "STORAGE_UNAVAILABLE" });
    expect((err as Error).message).not.toMatch(/cloudinary|socket|Internal/i);
  });
});
