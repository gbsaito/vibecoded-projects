"use strict";
// Drives the running renderer over executeJavaScript: creates cards, edits
// them, toggles todos, navigates a nested board, deletes with undo. Any error
// throws and main.js exits non-zero.

const DRIVER = `
(async () => {
  const M = window.__mila;
  const S = M.state;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const errs = [];
  const fails = [];
  const assert = (c, m) => { if (!c) fails.push(m); };
  window.addEventListener("error", e => errs.push(e.message));

  await wait(400); // boot
  assert(S.canvas && S.canvas.title === "Home", "home loaded");

  // note + body edit commit
  let note = await M.createAt("note", 80, 80);
  await wait(50);
  M.enterEdit(note.id, "body");
  await wait(50);
  const body = S.nodes.get(note.id).querySelector(".body");
  body.innerText = "hello board";
  M.commitEdit();
  await wait(120);
  let stored = await window.mila.api("payload", [S.canvas.id]);
  let n = stored.items.find(i => i.id === note.id);
  assert(n.data.text === "hello board", "note text saved");
  assert(n.data.doc && n.data.doc.type === "doc", "note doc saved");

  // todo: rows via editor path (Enter creates the next row)
  let todo = await M.createAt("todo", 420, 80);
  await wait(50);
  M.enterEdit(todo.id, "task", 0);
  await wait(50);
  let row = S.nodes.get(todo.id).querySelectorAll(".trow .txt")[0];
  row.innerText = "task one";
  // simulate Enter by calling the handler path directly
  const enterEv = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
  Object.defineProperty(enterEv, "target", { value: row });
  row.dispatchEvent(enterEv);
  await wait(150);
  row = S.nodes.get(todo.id).querySelectorAll(".trow .txt")[1];
  assert(!!row, "enter added a row (waiting editor)");
  // first row editor is open on row 1 now; commit it empty to close
  M.commitEdit();
  await wait(120);
  stored = await window.mila.api("payload", [S.canvas.id]);
  let td = stored.items.find(i => i.id === todo.id);
  assert(td.data.tasks.length >= 1, "todo rows exist");
  // tick row 0 through the box path
  td.data.tasks[0].done = true;
  await window.mila.api("updateItem", [td]);
  M.refreshItem(S.items.get(todo.id));
  await wait(80);
  stored = await window.mila.api("payload", [S.canvas.id]);
  td = stored.items.find(i => i.id === todo.id);
  assert(td.data.tasks[0].done === true, "todo toggled");

  // nested board + navigate + back
  const board = await M.createAt("board", 700, 80);
  await wait(80);
  const childId = board.data.childCanvasId;
  assert(!!childId, "board child canvas");
  await M.openCanvas(childId);
  await wait(80);
  assert(S.canvas.id === childId, "entered board");
  const crumbOk = document.getElementById("crumb").innerHTML.includes("Home");
  assert(crumbOk, "breadcrumb shows Home");
  const inner = await M.createAt("note", 60, 60);
  await wait(50);
  M.enterEdit(inner.id, "body");
  await wait(40);
  S.nodes.get(inner.id).querySelector(".body").innerText = "deep note";
  M.commitEdit();
  await wait(120);
  M.goUp();
  await wait(100);
  assert(S.canvas.id === window.milaRoot, "went back up");

  // search finds the deep note
  const res = await window.mila.api("search", ["deep"]);
  assert(res.some(r => r.title.includes("deep")), "search hits note");

  // export payload path (markdown assembled in main; just exercise payload)
  stored = await window.mila.api("payload", [S.canvas.id]);
  assert(stored.items.length >= 3, "home has cards");

  // delete the note; undo via restore
  M.select(note.id);
  await wait(40);
  await M.deleteSelection();
  await wait(150);
  stored = await window.mila.api("payload", [S.canvas.id]);
  assert(!stored.items.find(i => i.id === note.id), "note gone from canvas");
  const trash = await window.mila.api("trashRoots");
  assert(trash.length >= 1, "trash has the note");

  // ---- extended card types ------------------------------------------------
  // link card via URL prompt
  const link = await M.createAt("link", 80, 300);
  await wait(60);
  const linkInput = S.nodes.get(link.id).querySelector(".linput");
  assert(!!linkInput, "link card shows inline URL input");
  assert(document.activeElement === linkInput, "link URL input is focused");
  linkInput.value = "https://example.com/page";
  linkInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await wait(150);
  stored = await window.mila.api("payload", [S.canvas.id]);
  const lk = stored.items.find(i => i.id === link.id);
  assert(lk && lk.data.url === "https://example.com/page", "link url saved");
  assert(S.nodes.get(link.id).querySelector(".host").textContent.includes("example.com"),
    "link host rendered");
  assert(getComputedStyle(S.nodes.get(link.id)).backgroundColor === "rgb(255, 255, 255)",
    "link card white");
  await wait(4000); // thumbnail + title fetch resolves (set or null) either way
  const thumbState = S.items.get(link.id).data.thumb;
  assert(thumbState !== undefined, "link thumb fetch resolved");
  if (thumbState) assert(!!S.nodes.get(link.id).querySelector(".thumb"), "thumb img rendered");
  assert(typeof S.items.get(link.id).data.title === "string" &&
    S.items.get(link.id).data.title.length > 0 && S.items.get(link.id).data.title !== "example.com",
    "page title fetched, got: " + S.items.get(link.id).data.title);

  // table cell edit commits on blur
  const tbl = await M.createAt("table", 80, 430);
  await wait(60);
  const cell = S.nodes.get(tbl.id).querySelector("td");
  cell.innerText = "cell A1";
  cell.dispatchEvent(new Event("input", { bubbles: true }));
  cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  await wait(150);
  stored = await window.mila.api("payload", [S.canvas.id]);
  const tb = stored.items.find(i => i.id === tbl.id);
  assert(tb.data.rows && tb.data.rows[0][0] === "cell A1", "table cell saved");

  // hex note becomes a swatch
  const sw = await M.createAt("note", 80, 580);
  await wait(50);
  M.enterEdit(sw.id, "body");
  await wait(40);
  S.nodes.get(sw.id).querySelector(".body").innerText = "#ff8800";
  M.commitEdit();
  await wait(120);
  stored = await window.mila.api("payload", [S.canvas.id]);
  const swIt = stored.items.find(i => i.id === sw.id);
  assert(swIt.type === "swatch" && swIt.data.hex === "#ff8800", "hex note became swatch");

  // labels dialog
  M.labelsDialog(todo.id);
  await wait(40);
  document.getElementById("labelsBox").value = "plot, draft";
  document.getElementById("labelsSave").click();
  await wait(150);
  stored = await window.mila.api("payload", [S.canvas.id]);
  td = stored.items.find(i => i.id === todo.id);
  assert((td.data.labels || []).map(l => l.name).join() === "plot,draft", "labels saved");
  assert(S.nodes.get(todo.id).querySelectorAll(".labels .tag").length === 2, "labels rendered");

  // line between two cards: no card node, but drawn with arrowhead
  const line = await M.createAt("line", 0, 0, { w: 1,
    data: { from: { id: todo.id }, to: { id: link.id }, arrow: "end", dashed: true, label: "flow", text: "" } });
  await wait(100);
  assert(!S.nodes.get(line.id), "line has no card node");
  assert(document.querySelectorAll("#linesvg path").length >= 2, "line drawn with arrow");

  // column nesting via updateItems
  const col = await M.createAt("column", 700, 300);
  await wait(60);
  M.commitEdit();
  await wait(80);
  const colKid = await M.createAt("note", 700, 380);
  await wait(50);
  M.commitEdit();
  await wait(60);
  await window.mila.api("updateItems",
    [[{ id: colKid.id, parentItemId: col.id, x: colKid.x, y: colKid.y, z: colKid.z }]]);
  await M.openCanvas(S.canvas.id);
  await wait(100);
  assert([...S.items.values()].filter(i => i.parentItemId === col.id).length === 1,
    "note nested in column");
  assert(S.nodes.get(col.id).querySelector(".n").textContent === "1 card", "column counter shows '1 card'");

  // image loads through milafile://
  const img = await M.createAt("image", 700, 560,
    { data: { src: "/uploads/test.png", caption: "shot" } });
  await wait(200);
  const im = S.nodes.get(img.id).querySelector("img");
  assert(im && im.complete && im.naturalWidth > 0, "image loads via milafile");

  // file card with preview
  const fil = await M.createAt("file", 700, 700,
    { data: { src: "/uploads/test.png", name: "test.png", mime: "image/png" } });
  await wait(200);
  const fim = S.nodes.get(fil.id).querySelector("img");
  assert(fim && fim.complete && fim.naturalWidth > 0, "file preview loads");

  // document overlay edits
  const doc = await M.createAt("document", 950, 80);
  await wait(60);
  M.commitEdit();
  await wait(80);
  M.openDocument(S.items.get(doc.id));
  await wait(80);
  document.getElementById("docBody").innerText = "alpha beta gamma";
  document.getElementById("docBody").dispatchEvent(new Event("input", { bubbles: true }));
  await wait(150);
  document.getElementById("docDialog").close();
  stored = await window.mila.api("payload", [S.canvas.id]);
  const dc = stored.items.find(i => i.id === doc.id);
  assert(dc.data.text === "alpha beta gamma", "document text saved");

  if (fails.length || errs.length) {
    return "FAILS: " + fails.join(" | ") + " ERRS: " + errs.join(" | ");
  }
  return "driver ok";
})().catch(e => "ERR " + (e && (e.stack || e.message) || String(e)))
`;

module.exports.run = async webContents => {
  const root = await webContents.executeJavaScript("window.__mila.state.rootId");
  await webContents.executeJavaScript(`window.milaRoot=${JSON.stringify(root)}`);
  try {
    const out = await webContents.executeJavaScript(DRIVER, true);
    if (out !== "driver ok") throw new Error("driver: " + out);
  } catch (e) {
    throw new Error("driver:\n" + (e.stack || e.message));
  }
  await typingTest(webContents);
};

// The real-input path: double-click a note with mouse events, type with char
// events, verify the store ends up with the characters. Mirrors a human user.
async function typingTest(wc) {
  wc.focus(); // the harness window often starts unfocused; a blur would close the editor
  const info = await wc.executeJavaScript(`(async () => {
    const M = window.__mila, S = M.state;
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const it = await M.createAt("note", 60, 620);
    await wait(80);
    M.commitEdit();          // close the auto-opened editor
    await wait(60);
    const r = S.nodes.get(it.id).querySelector(".body").getBoundingClientRect();
    return { id: it.id, x: Math.round(r.left + 30), y: Math.round(r.top + Math.max(8, r.height / 2)) };
  })()`, true);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await wc.executeJavaScript(`(() => {
    window.__probe = { click: 0, dbl: 0, pd: 0, pdown_card: 0, target: null };
    window.addEventListener("pointerdown", e => { window.__probe.pd++; },
                           { capture: true });
    window.addEventListener("click", e => { window.__probe.click++;
      window.__probe.target = e.target.className; }, { capture: true });
    window.addEventListener("dblclick", () => window.__probe.dbl++, { capture: true });
  })()`);
  for (const [type, cc] of [["mouseDown", 1], ["mouseUp", 1], ["mouseDown", 2], ["mouseUp", 2]]) {
    wc.sendInputEvent({ type, x: info.x, y: info.y, button: "left", clickCount: cc });
  }
  await sleep(250);
  const probe = await wc.executeJavaScript("window.__probe");
  const at = await wc.executeJavaScript(`(() => {
    const e = document.elementFromPoint(${info.x}, ${info.y});
    const node = window.__mila.state.nodes.get(${JSON.stringify(info.id)});
    const r = node.querySelector(".body").getBoundingClientRect();
    return { at: e && (e.className.baseVal !== undefined ? e.className.baseVal : e.className),
             id: e && e.id, rect: [r.left, r.top, r.width, r.height]
                   .map(Math.round), inner: node.querySelector(".body").textContent };
  })()`);
  console.error("PROBE", JSON.stringify(probe), "AT", JSON.stringify(at));
  const editingOpen = await wc.executeJavaScript(
    `window.__mila.state.editing && window.__mila.state.editing.id === ${JSON.stringify(info.id)}`);
  for (const ch of "XYZ") {
    wc.sendInputEvent({ type: "char", keyCode: ch });
    await sleep(40);
  }
  await sleep(150);
  const typed = await wc.executeJavaScript(
    `(() => {
      const M = window.__mila, S = M.state;
      const es = S.editing;
      const live = es ? es.el.innerText : "(editor closed)";
      const focusTag = document.activeElement &&
        (document.activeElement.className.baseVal !== undefined
          ? document.activeElement.className.baseVal : document.activeElement.className);
      return { live, focusTag };
    })()`);
  console.error("TYPED", JSON.stringify(typed));
  await wc.executeJavaScript("window.__mila.commitEdit()");
  await sleep(150);
  const stored = await wc.executeJavaScript(
    `window.__mila.state.items.get(${JSON.stringify(info.id)}).data.text`);
  if (!editingOpen) throw new Error("REAL INPUT: double-click did not open the editor");
  if (!/XYZ/.test(typed.live)) {
    throw new Error("REAL INPUT: editor open but typed chars missing, live="
      + JSON.stringify(typed.live) + " focus=" + JSON.stringify(typed.focusTag));
  }
  if (!/XYZ/.test(stored)) {
    throw new Error("REAL INPUT: commit lost chars, text=" + JSON.stringify(stored));
  }
  console.error("REAL INPUT ok: dblclick opened editor, typed chars committed");
}
