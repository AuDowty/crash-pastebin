import init, { parse_minidump } from "./pkg/crash_pastebin_wasm.js?v=1";

const drop = document.getElementById("drop");
const file = document.getElementById("file");
const errorBox = document.getElementById("error");
const statusBox = document.getElementById("status");
const result = document.getElementById("result");
const filenameEl = document.getElementById("filename");
const shareBtn = document.getElementById("share-btn");
const tabsNav = document.getElementById("tabs");

let currentBytes = null;
let alreadyShared = false;
let ready = false;

console.log("[crash-pastebin] loading wasm...");
await init();
ready = true;
console.log("[crash-pastebin] wasm ready");

const urlId = new URLSearchParams(location.search).get("h");
if (urlId) {
  loadShared(urlId);
}

drop.addEventListener("click", () => file.click());
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  if (e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]);
});
file.addEventListener("change", () => {
  if (file.files[0]) handle(file.files[0]);
});

shareBtn.addEventListener("click", async () => {
  if (alreadyShared || !currentBytes) return;
  shareBtn.disabled = true;
  shareBtn.textContent = "Uploading...";
  try {
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: currentBytes,
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`upload failed: ${res.status} ${t}`);
    }
    const data = await res.json();
    const url = `${location.origin}/?h=${data.id}`;
    history.replaceState(null, "", `?h=${data.id}`);
    try {
      await navigator.clipboard.writeText(url);
      showStatus(`Shared! URL copied to clipboard: ${url}`);
    } catch {
      showStatus(`Shared! URL: ${url}`);
    }
    alreadyShared = true;
    shareBtn.textContent = "Shared ✓";
  } catch (e) {
    console.error("[crash-pastebin] share error:", e);
    showError(String(e?.message ?? e));
    shareBtn.disabled = false;
    shareBtn.textContent = "Share via URL";
  }
});

async function loadShared(id) {
  if (!/^[a-f0-9]{16,64}$/i.test(id)) {
    showError(`invalid share id: ${id}`);
    return;
  }
  showStatus(`Loading shared dump ${id}...`);
  try {
    const res = await fetch(`/api/dump/${id}`);
    if (!res.ok) {
      throw new Error(`fetch dump failed: ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    const fakeFile = new File([buf], `shared-${id.slice(0, 8)}.dmp`);
    handle(fakeFile, { fromShare: true });
  } catch (e) {
    console.error(e);
    showError(String(e?.message ?? e));
  }
}

async function handle(f, opts = {}) {
  if (!ready) return;
  errorBox.hidden = true;
  if (!opts.fromShare) statusBox.hidden = true;
  result.hidden = true;
  alreadyShared = !!opts.fromShare;
  shareBtn.disabled = false;
  shareBtn.textContent = opts.fromShare ? "Already shared ✓" : "Share via URL";

  try {
    const buf = await f.arrayBuffer();
    const bytes = new Uint8Array(buf);
    console.log(`[crash-pastebin] parsing ${f.name} (${bytes.length} bytes)`);
    const raw = parse_minidump(bytes);
    if (typeof raw !== "string") {
      throw new Error(`expected string from parse_minidump, got ${typeof raw} — clear browser cache (Ctrl+Shift+R)`);
    }
    const parsed = JSON.parse(raw);
    console.log("[crash-pastebin] parsed:", parsed);
    currentBytes = bytes;
    render(f, parsed, opts.fromShare);
    if (!opts.fromShare) statusBox.hidden = true;
  } catch (e) {
    console.error("[crash-pastebin] parse error:", e);
    showError(String(e?.message ?? e));
  }
}

function showStatus(msg) {
  statusBox.textContent = msg;
  statusBox.hidden = false;
}
function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}

function render(f, p, fromShare) {
  filenameEl.textContent = f.name;
  shareBtn.hidden = false;
  shareBtn.disabled = !!fromShare;
  if (fromShare) shareBtn.textContent = "Already shared ✓";

  document.getElementById("exception-card").innerHTML = renderException(p.exception);
  document.getElementById("meta-grid").innerHTML = renderMeta(p);

  document.getElementById("tab-modules").innerHTML = renderModules(p.modules);
  document.getElementById("tab-threads").innerHTML = renderThreads(p.threads, p.exception?.thread_id);
  document.getElementById("tab-streams").innerHTML = renderStreams(p.streams_present);
  document.getElementById("tab-raw").innerHTML = `<pre>${escapeHtml(JSON.stringify(p, null, 2))}</pre>`;

  document.getElementById("modules-count").textContent = `· ${p.modules?.length ?? 0}`;
  document.getElementById("threads-count").textContent = `· ${p.threads?.length ?? 0}`;
  document.getElementById("streams-count").textContent = `· ${p.streams_present?.length ?? 0}`;

  result.hidden = false;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
  document.querySelector('.tabs button[data-tab="modules"]').classList.add("active");
  document.querySelectorAll(".tab-pane").forEach((el) => el.classList.remove("active"));
  document.getElementById("tab-modules").classList.add("active");
}

tabsNav.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (!btn) return;
  tabsNav.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".tab-pane").forEach((el) => {
    el.classList.toggle("active", el.id === `tab-${btn.dataset.tab}`);
  });
});

function renderException(e) {
  if (!e) {
    return `<div style="color:var(--text-dim)">No exception stream — this dump may have been written manually rather than from a crash.</div>`;
  }
  const regs = e.context
    ? Object.entries(e.context).map(([k, v]) => `<div><span class="r-name">${k}</span> ${v}</div>`).join("")
    : "";
  return `
    <div><span class="code">${e.exception_code}</span><span class="name">${e.exception_name}</span></div>
    <div class="addr"><span class="addr-label">at</span> ${e.exception_address}  <span class="addr-label">on thread</span> ${e.thread_id}</div>
    ${regs ? `<div class="regs">${regs}</div>` : ""}
  `;
}

function renderMeta(p) {
  const cells = [];
  if (p.system_info) {
    cells.push(kv("OS", p.system_info.os_version));
    cells.push(kv("Arch", p.system_info.architecture));
    cells.push(kv("CPUs", p.system_info.number_of_processors));
  }
  if (p.misc) {
    cells.push(kv("Process ID", p.misc.process_id));
  }
  cells.push(kv("Dump size", formatBytes(p.header?.size ?? 0)));
  return cells.join("");
}

function kv(k, v) {
  return `<div class="kv"><div class="k">${k}</div><div class="v">${v ?? "—"}</div></div>`;
}

function renderModules(modules) {
  if (!modules || modules.length === 0) return `<p style="color:var(--text-dim)">no modules</p>`;
  return `<table>
    <thead><tr><th>module</th><th>base</th><th>size</th></tr></thead>
    <tbody>
      ${modules.map((m) => `
        <tr>
          <td title="${escapeHtml(m.path)}">${escapeHtml(m.name)}</td>
          <td>${m.base_of_image}</td>
          <td>${(m.size_of_image ?? 0).toLocaleString()}</td>
        </tr>
      `).join("")}
    </tbody>
  </table>`;
}

function renderThreads(threads, crashedTid) {
  if (!threads || threads.length === 0) return `<p style="color:var(--text-dim)">no threads</p>`;
  return `<table>
    <thead><tr><th>tid</th><th>teb</th><th>stack</th><th>stack size</th><th>priority</th></tr></thead>
    <tbody>
      ${threads.map((t) => `
        <tr class="${t.thread_id === crashedTid ? "crashed" : ""}">
          <td>${t.thread_id}</td>
          <td>${t.teb}</td>
          <td>${t.stack_start}</td>
          <td>${(t.stack_size ?? 0).toLocaleString()}</td>
          <td>${t.priority}</td>
        </tr>
      `).join("")}
    </tbody>
  </table>`;
}

function renderStreams(streams) {
  if (!streams || streams.length === 0) return `<p style="color:var(--text-dim)">no streams</p>`;
  return `<table>
    <thead><tr><th>type</th><th>name</th><th>size</th></tr></thead>
    <tbody>
      ${streams.map((s) => `
        <tr><td>${s.type}</td><td>${s.type_name}</td><td>${(s.size ?? 0).toLocaleString()}</td></tr>
      `).join("")}
    </tbody>
  </table>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function formatBytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "?";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
