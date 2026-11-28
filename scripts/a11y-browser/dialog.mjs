import { connect, FOCUS_JS } from "./cdp.mjs";
const c = await connect();
const D = `(() => { const d = document.querySelector('[role=dialog],[role=alertdialog]'); if (!d) return null; return { role: d.getAttribute('role'), modal: d.getAttribute('aria-modal'), label: d.getAttribute('aria-label') || document.getElementById(d.getAttribute('aria-labelledby')||'')?.textContent, inertOutside: [...document.body.children].filter(e => !e.contains(d) && (e.inert || e.getAttribute('aria-hidden')==='true')).length }; })()`;
async function trial(path, openerText) {
  await c.goto("http://localhost:3100" + path); await c.sleep(800);
  // tabular hasta el opener
  await c.ev(`document.activeElement?.blur()`);
  let opener = null;
  for (let i = 0; i < 90; i++) { await c.key("Tab"); const f = await c.ev(FOCUS_JS); if (f && f.name.includes(openerText)) { opener = f; break; } }
  if (!opener) return console.log(path, "opener no alcanzable por teclado:", openerText);
  const openerSel = await c.ev(`(() => { const a = document.activeElement; a.setAttribute('data-probe','op'); return true })()`);
  await c.key("Enter"); await c.sleep(700);
  console.log(`\n[${path}] abrir "${openerText}" ->`, JSON.stringify(await c.ev(D)));
  console.log(" foco inicial:", JSON.stringify(await c.ev(FOCUS_JS)));
  // Tab trap: 25 tabs, el foco nunca sale del diálogo
  let outside = 0; const seen = new Set();
  for (let i = 0; i < 25; i++) { await c.key("Tab"); const f = await c.ev(FOCUS_JS); if (!f || !f.dialog) outside++; else seen.add(f.name); }
  console.log(" Tab x25: fuera del diálogo =", outside, "| distintos =", seen.size);
  await c.key("Tab", { shift: true });
  console.log(" Shift+Tab sigue dentro:", (await c.ev(FOCUS_JS))?.dialog);
  await c.key("Escape"); await c.sleep(600);
  console.log(" tras Escape, diálogo:", JSON.stringify(await c.ev(D)), "| foco vuelve al opener:", await c.ev(`document.activeElement?.getAttribute('data-probe') === 'op'`));
}
await trial("/wardrobe", "Añadir");
await trial("/profile", "Eliminar");
c.close();
