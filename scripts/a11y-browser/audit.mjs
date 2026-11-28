import { connect, FOCUS_JS } from "./cdp.mjs";
const c = await connect();
// login por teclado
await c.goto("http://localhost:3100/login");
await c.ev(`document.querySelector('input[type=email]').focus()`); await c.type("sandbox@example.test");
await c.key("Tab"); await c.type("Sandbox-Clave-123"); await c.key("Enter"); await c.sleep(3500);
console.log("tras login:", await c.ev("location.pathname"));
const routes = process.argv.slice(2).length ? process.argv.slice(2) : ["/dashboard","/wardrobe","/stylist","/try-on","/shopping","/profile"];
for (const r of routes) {
  await c.goto("http://localhost:3100" + r); await c.sleep(1200);
  const { nodes } = await c.send("Accessibility.getFullAXTree");
  const inter = new Set(["button","link","textbox","checkbox","radio","combobox","tab","switch","searchbox","menuitem","slider","spinbutton","option"]);
  const unnamed = nodes.filter(n => !n.ignored && inter.has(n.role?.value) && !(n.name?.value||"").trim()).map(n => n.role.value);
  const landmarks = nodes.filter(n => !n.ignored && ["main","navigation","banner","contentinfo","complementary","search","region"].includes(n.role?.value)).map(n => `${n.role.value}:${n.name?.value||""}`);
  const heads = nodes.filter(n => !n.ignored && n.role?.value==="heading").map(n => `h${n.properties?.find(p=>p.name==="level")?.value.value}:${n.name?.value}`);
  const dup = await c.ev(`(() => { const m = {}; document.querySelectorAll('[id]').forEach(e => m[e.id] = (m[e.id]||0)+1); return Object.entries(m).filter(([,v]) => v>1).map(([k]) => k); })()`);
  // recorrido de Tab completo hasta volver al inicio
  await c.ev(`document.activeElement?.blur(); window.scrollTo(0,0)`);
  const stops = []; let first = null;
  for (let i = 0; i < 80; i++) { await c.key("Tab"); const f = await c.ev(FOCUS_JS); if (!f) { stops.push("(fuera del documento)"); continue; } const sig = f.tag + "|" + f.name; if (first === null) first = sig; else if (sig === first) break; stops.push(f); }
  const noFocusRing = stops.filter(s => typeof s === "object" && !s.outline && !s.shadow).map(s => s.tag + ":" + s.name);
  console.log(`\n=== ${r}  title="${await c.ev("document.title")}" url=${await c.ev("location.pathname")}`);
  console.log("landmarks:", landmarks.join(", ")); console.log("headings:", heads.join(" | "));
  console.log("interactivos SIN nombre accesible:", unnamed.length, unnamed.join(",")); console.log("ids duplicados:", dup.join(",")||"ninguno");
  console.log("paradas de Tab:", stops.length, "| sin indicador de foco:", noFocusRing.length, noFocusRing.join(" ; "));
}
c.close();
