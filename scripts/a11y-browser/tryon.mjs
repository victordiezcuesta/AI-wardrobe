import { connect, FOCUS_JS } from "./cdp.mjs";
const c = await connect();
const IMG = "data:image/svg+xml;utf8," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='200' height='300'><rect width='200' height='300' fill='#cbb'/></svg>");
const now = () => new Date().toISOString();
const jobs = new Map(); let seq = 0; let releaseDone = false; const log = [];
const dto = (id) => { const j = jobs.get(id); const done = releaseDone; return { id, status: done ? "COMPLETED" : "PROCESSING", scenario: "studio", pose: "standing", outfitId: "o1", errorMessage: null, attempts: 1, isFavorite: false, createdAt: j.createdAt, updatedAt: done ? j.doneAt ??= now() : j.createdAt, imageUrl: done ? IMG : null, downloadUrl: done ? IMG : null }; };
await c.send("Fetch.enable", { patterns: [{ urlPattern: "*localhost:3100/api/*", requestStage: "Request" }] });
c.on(async (m) => {
  if (m.method !== "Fetch.requestPaused") return;
  const { requestId, request } = m.params; const u = new URL(request.url); const p = u.pathname;
  const ok = (obj) => c.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify(obj)).toString("base64") });
  if (p === "/api/consent") return ok({ granted: true, at: now(), version: "1" });
  if (p === "/api/photos") return ok({ photos: [{ publicId: "ph1", url: IMG }] });
  if (p === "/api/try-on" && request.method === "POST") { const id = "job" + ++seq; jobs.set(id, { createdAt: now() }); log.push("POST " + id); return ok({ image: dto(id) }); }
  if (p === "/api/try-on" && request.method === "GET") return ok({ images: [], nextCursor: null });
  const mm = p.match(/^\/api\/try-on\/(job\d+)$/); if (mm) return ok({ image: dto(mm[1]) });
  return c.send("Fetch.continueRequest", { requestId });
});
await c.send("Page.bringToFront"); await c.goto("http://localhost:3100/try-on?outfit=o1"); await c.sleep(2500);
await c.ev(`window.__ann = []; const t0 = performance.now(); new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) { const t = (n.textContent||'').trim(); if (t) window.__ann.push({ t: Math.round(performance.now()-t0), text: t, region: m.target.closest?.('[role=status],[role=alert],[aria-live]')?.getAttribute('role') ?? m.target.getAttribute?.('role') }); } }).observe(document.querySelector('main') ?? document.body, { childList: true, subtree: true, characterData: true }); true`);
// botón por teclado
await c.ev(`document.activeElement?.blur()`);
let btn = null; for (let i = 0; i < 60; i++) { await c.key("Tab"); const f = await c.ev(FOCUS_JS); if (f?.name?.includes("Ver cómo me queda")) { btn = f; break; } }
console.log("botón alcanzado por teclado:", !!btn, btn && "disabled?=" + await c.ev("document.activeElement.disabled"));
if (!btn) { console.log("estado:", await c.ev("document.querySelector('main').innerText.slice(0,400)")); process.exit(1); }
await c.key("Enter"); await c.sleep(900);
await c.ev(`document.querySelector('button:not([disabled])')&&0`);
// segundo trabajo: se vuelve a enfocar el botón (el foco puede haber cambiado) y se activa
await c.ev(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Ver cómo me queda'))?.focus(); true`); await c.key("Enter"); await c.sleep(900);
console.log("trabajos creados:", log.join(", "));
console.log("anuncios hasta ahora:", JSON.stringify(await c.ev("window.__ann")));
releaseDone = true;               // los dos terminan en el MISMO sondeo (consecutivos, resultado idéntico)
await c.sleep(4500);
const ann = await c.ev("window.__ann"); console.log("anuncios finales:", JSON.stringify(ann, null, 1));
console.log("región status ahora:", await c.ev(`[...document.querySelectorAll('[role=status]')].map(e => e.outerHTML.slice(0,200))`));
c.close();
