// Self-check: assert-based checks for toggleNoDisplay + trashDesktop. Run: node test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toggleNoDisplay, trashDesktop, restoreTrashed } from "./index.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deskman-test-"));

const write = (file, text) => fs.writeFileSync(path.join(dir, file), text);
const read = (file) => fs.readFileSync(path.join(dir, file), "utf8");

// 1. normal entry -> hide -> unhide
write("a.desktop", "[Desktop Entry]\nName=Foo\nExec=foo\n");
assert.equal(toggleNoDisplay("a.desktop", dir), true);
assert.ok(read("a.desktop").match(/^NoDisplay=true$/m));
assert.equal(toggleNoDisplay("a.desktop", dir), false);
assert.ok(!/^NoDisplay/m.test(read("a.desktop")));
assert.ok(read("a.desktop").startsWith("[Desktop Entry]\nName=Foo"));

// 2. existing NoDisplay=false -> hide
write("b.desktop", "[Desktop Entry]\nNoDisplay=false\nName=Bar\n");
assert.equal(toggleNoDisplay("b.desktop", dir), true);
assert.ok(/^NoDisplay=true$/m.test(read("b.desktop")));

// 3. second toggle unhides again
assert.equal(toggleNoDisplay("b.desktop", dir), false);
assert.ok(!/^NoDisplay/m.test(read("b.desktop")));

// 4. no [Desktop Entry] -> no-op
write("c.desktop", "garbage\n");
assert.equal(toggleNoDisplay("c.desktop", dir), null);

console.log("PASS: toggleNoDisplay self-check");

// 5. trash: file moves to Trash/files, .trashinfo records original path
write("t.desktop", "[Desktop Entry]\nName=T\n");
const trash = fs.mkdtempSync(path.join(os.tmpdir(), "deskman-trash-"));
await trashDesktop("t.desktop", dir, trash);
assert.ok(fs.existsSync(path.join(trash, "files", "t.desktop")));
assert.ok(!fs.existsSync(path.join(dir, "t.desktop")));
const ti = fs.readFileSync(path.join(trash, "info", "t.desktop.trashinfo"), "utf8");
assert.ok(ti.includes("[Trash Info]"));
assert.ok(ti.includes(`Path=${encodeURI(path.join(dir, "t.desktop"))}`));
assert.ok(/^DeletionDate=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/m.test(ti));

// 6. trash: name collision gets suffixed, both recorded
write("dup.desktop", "[Desktop Entry]\nName=dup1\n");
await trashDesktop("dup.desktop", dir, trash);
write("dup.desktop", "[Desktop Entry]\nName=dup2\n");
await trashDesktop("dup.desktop", dir, trash);
const trashed = fs.readdirSync(path.join(trash, "files")).sort();
assert.deepEqual(trashed, ["dup.desktop", "dup.trash-2.desktop", "t.desktop"]);
assert.ok(fs.existsSync(path.join(trash, "info", "dup.trash-2.desktop.trashinfo")));
assert.ok(fs.existsSync(path.join(trash, "info", "dup.desktop.trashinfo")));

console.log("PASS: trashDesktop self-check");

// 7. restoreTrashed puts file back where it came from, removes .trashinfo
const undoDir = fs.mkdtempSync(path.join(os.tmpdir(), "deskman-undo-"));
const trash2 = fs.mkdtempSync(path.join(os.tmpdir(), "deskman-utrash-"));
fs.writeFileSync(path.join(undoDir, "u.desktop"), "[Desktop Entry]\nName=U\n");
const trashedName = await trashDesktop("u.desktop", undoDir, trash2);
assert.equal(trashedName, "u.desktop");
const rest = await restoreTrashed(trashedName, trash2);
assert.equal(rest, path.join(undoDir, "u.desktop"));
assert.ok(fs.existsSync(path.join(undoDir, "u.desktop")));
assert.ok(!fs.existsSync(path.join(trash2, "files", "u.desktop")));
assert.ok(!fs.existsSync(path.join(trash2, "info", "u.desktop.trashinfo")));
// restore of unknown name -> null
assert.equal(await restoreTrashed("nope.desktop", trash2), null);

console.log("PASS: restoreTrashed self-check");
fs.rmSync(dir, { recursive: true });
fs.rmSync(trash, { recursive: true });
fs.rmSync(undoDir, { recursive: true });
fs.rmSync(trash2, { recursive: true });
