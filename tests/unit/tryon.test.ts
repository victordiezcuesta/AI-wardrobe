import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTryOnPrompt, pickReferences, type PromptItem } from "@/services/tryon-prompt";

const item = (id: string, category: PromptItem["category"], hasImage = true, color: string | null = "azul"): PromptItem => ({ id, name: `Prenda ${id}`, category, color, hasImage });

describe("pickReferences", () => {
  it("reserva la imagen 1 para la persona y prioriza prendas principales", () => {
    const items = [item("bag", "BAG"), item("shoes", "SNEAKERS"), item("top", "TSHIRT"), item("bottom", "JEANS"), item("coat", "COAT")];
    const refs = pickReferences(items, 4); // 4 imágenes en total = persona + 3 prendas
    expect(refs.map((r) => r.id)).toEqual(["top", "bottom", "coat"]);
  });
  it("ignora prendas sin foto", () => {
    expect(pickReferences([item("a", "TSHIRT", false), item("b", "JEANS")], 5).map((r) => r.id)).toEqual(["b"]);
  });
});

describe("buildTryOnPrompt", () => {
  const items = [item("top", "TSHIRT"), item("bottom", "JEANS"), item("bag", "BAG", false)];
  const prompt = buildTryOnPrompt(items, pickReferences(items, 5), "street", "walking");
  it("numera las referencias desde la imagen 2 y fija la identidad en la imagen 1", () => {
    expect(prompt).toContain("Image 1 is the identity reference");
    expect(prompt).toContain("Image 2: Prenda top");
    expect(prompt).toContain("Image 3: Prenda bottom");
  });
  it("describe en texto las prendas sin foto y aplica escenario y pose", () => {
    expect(prompt).toContain("Prenda bag");
    expect(prompt).toContain("city street");
    expect(prompt).toContain("walking naturally");
  });
  it("no pide texto ni marcas de agua", () => {
    expect(prompt).toContain("No text, logos, watermarks");
  });
});

describe("editImage (Pollinations)", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const refs = [{ bytes: png, mime: "image/png", name: "person.jpg" }, { bytes: png, mime: "image/png", name: "g1.jpg" }];

  beforeEach(() => {
    vi.resetModules();
    Object.assign(process.env, {
      DATABASE_URL: "postgres://x", AUTH_SECRET: "x".repeat(32), CLOUDINARY_CLOUD_NAME: "c", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s",
      POLLINATIONS_API_KEY: "sk_test",
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.POLLINATIONS_API_KEY; });

  it("envía multipart a /v1/images/edits con b64_json y devuelve los bytes decodificados", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { editImage } = await import("@/lib/pollinations/client");
    const out = await editImage({ prompt: "p", images: refs });
    expect(out.equals(png)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gen.pollinations.ai/v1/images/edits");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk_test");
    const form = init.body as FormData;
    expect(form.get("response_format")).toBe("b64_json");
    expect(form.get("model")).toBe("google/gemini-2.5-flash-image");
    expect(form.getAll("image")).toHaveLength(2);
  });

  it("traduce 402 y 429 a mensajes comprensibles", async () => {
    const { editImage } = await import("@/lib/pollinations/client");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 402 })));
    await expect(editImage({ prompt: "p", images: refs })).rejects.toMatchObject({ code: "TRYON_NO_CREDITS" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 429, headers: { "retry-after": "12" } })));
    await expect(editImage({ prompt: "p", images: refs })).rejects.toMatchObject({ code: "TRYON_BUSY" });
  });

  it("falla con claridad si falta la clave", async () => {
    delete process.env.POLLINATIONS_API_KEY;
    const { editImage } = await import("@/lib/pollinations/client");
    await expect(editImage({ prompt: "p", images: refs })).rejects.toMatchObject({ code: "TRYON_NOT_CONFIGURED" });
  });
});
