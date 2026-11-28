import { createRequire } from "node:module";
const require = createRequire(new URL("../../package.json", import.meta.url));
const WebSocket = require("ws");

const port = process.env.CDP_PORT ?? "9333";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function connect() {
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const tab = tabs.find((t) => t.type === "page");
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r) => ws.on("open", r));
  let id = 0; const pending = new Map(); const listeners = [];
  ws.on("message", (m) => {
    const msg = JSON.parse(m);
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
    else listeners.forEach((l) => l(msg));
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval error");
    return r.result.value;
  };
  const goto = async (url) => { await send("Page.navigate", { url }); await sleep(1500); };
  const key = async (k, { shift = false } = {}) => {
    const codes = { Tab: 9, Enter: 13, Escape: 27, " ": 32, ArrowRight: 39, ArrowLeft: 37, ArrowDown: 40, ArrowUp: 38 };
    const base = { key: k, code: k === " " ? "Space" : k, windowsVirtualKeyCode: codes[k] ?? k.charCodeAt(0), nativeVirtualKeyCode: codes[k] ?? k.charCodeAt(0), modifiers: shift ? 8 : 0 };
    await send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: k === "Enter" ? "\r" : k.length === 1 ? k : undefined, unmodifiedText: k === "Enter" ? "\r" : k.length === 1 ? k : undefined });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(120);
  };
  const type = async (text) => { for (const ch of text) { await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch }); } await sleep(80); };
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }); await send("Page.enable"); await send("Runtime.enable"); await send("Accessibility.enable");
  return { send, ev, goto, key, type, sleep, close: () => ws.close(), on: (l) => listeners.push(l) };
}

/** Descripción del elemento con foco: rol, nombre accesible aproximado, y si tiene indicador visible. */
export const FOCUS_JS = `(() => {
  const a = document.activeElement; if (!a || a === document.body) return null;
  const cs = getComputedStyle(a); const r = a.getBoundingClientRect();
  const name = a.getAttribute('aria-label') || (a.getAttribute('aria-labelledby') ? a.getAttribute('aria-labelledby').split(' ').map(i => document.getElementById(i)?.textContent).join(' ') : '') || a.textContent?.trim().slice(0, 60) || a.getAttribute('placeholder') || a.getAttribute('title') || a.getAttribute('alt') || '';
  const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
  const shadow = cs.boxShadow && cs.boxShadow !== 'none';
  return { tag: a.tagName.toLowerCase(), role: a.getAttribute('role'), type: a.getAttribute('type'), name, outline, shadow, visible: r.width > 0 && r.height > 0, dialog: !!a.closest('[role=dialog]') };
})()`;
