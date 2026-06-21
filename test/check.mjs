import { parse_minidump } from "./pkg/crash_pastebin_wasm.js";
import fs from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node check.mjs <file.dmp>");
  process.exit(1);
}
const bytes = fs.readFileSync(path);
console.log(`input: ${path} (${bytes.length.toLocaleString()} bytes)`);

const raw = parse_minidump(new Uint8Array(bytes));
const parsed = JSON.parse(raw);

console.log("\n=== header ===");
console.log(parsed.header);

console.log("\n=== streams present ===");
for (const s of parsed.streams_present) {
  console.log(`  ${s.type_name} (${s.type})  ${s.size.toLocaleString()} bytes`);
}

console.log("\n=== system info ===");
console.log(parsed.system_info);

console.log("\n=== exception ===");
console.log(parsed.exception);

console.log("\n=== misc ===");
console.log(parsed.misc);

console.log("\n=== modules:", parsed.modules.length, "===");
for (const m of parsed.modules.slice(0, 5)) {
  console.log(`  ${m.name.padEnd(28)} @ ${m.base_of_image} (${m.size_of_image.toLocaleString()} B)`);
}
if (parsed.modules.length > 5) console.log(`  ... ${parsed.modules.length - 5} more`);

console.log("\n=== threads:", parsed.threads.length, "===");
for (const t of parsed.threads.slice(0, 5)) {
  console.log(`  tid=${t.thread_id}  teb=${t.teb}  stack=${t.stack_start}+${t.stack_size}`);
}
if (parsed.threads.length > 5) console.log(`  ... ${parsed.threads.length - 5} more`);

const crashTid = parsed.exception?.thread_id;
const crashThread = parsed.threads.find((t) => t.thread_id === crashTid);
console.log("\n=== crashed thread ===");
console.log(`  thread ${crashTid}:`, crashThread || "(not found in thread list)");

console.log("\nOK");
