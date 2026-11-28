import { connect, FOCUS_JS } from "./cdp.mjs";
const c = await connect();
await c.goto("http://localhost:3100/login");
const info = await c.ev(`(() => ({ title: document.title, lang: document.documentElement.lang,
  landmarks: [...document.querySelectorAll('main,nav,header,footer,[role=main],[role=navigation],[role=banner]')].map(e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '')),
  h1: [...document.querySelectorAll('h1')].map(h => h.textContent), skip: document.querySelector('a[href^="#"]')?.textContent }))()`);
console.log("PAGE", JSON.stringify(info));
console.log("--- Tab order (login)");
for (let i = 0; i < 9; i++) { await c.key("Tab"); console.log(i + 1, JSON.stringify(await c.ev(FOCUS_JS))); }
console.log("--- envío vacío con Enter");
await c.ev(`document.querySelector('form')?.querySelector('input')?.focus()`);
await c.key("Enter"); await c.sleep(1200);
console.log("alert:", JSON.stringify(await c.ev(`[...document.querySelectorAll('[role=alert],[role=status],[aria-live]')].map(e => ({role: e.getAttribute('role'), live: e.getAttribute('aria-live'), text: e.textContent.trim().slice(0,150)}))`)));
console.log("invalid:", JSON.stringify(await c.ev(`[...document.querySelectorAll('[aria-invalid=true]')].map(e => ({id: e.id, describedby: e.getAttribute('aria-describedby'), desc: (e.getAttribute('aria-describedby')||'').split(' ').map(i=>document.getElementById(i)?.textContent).join('|')}))`)));
console.log("focus after submit:", JSON.stringify(await c.ev(FOCUS_JS)));
c.close();
