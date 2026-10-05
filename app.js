const DB_NAME = "gas-usage-db";
const DB_VERSION = 1;
const LEGACY_KEY = "gas-usage-app-v1";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let state = blankState();
let editingId = null;
let dbPromise = null;

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function blankState() {
  const vehicleId = uid();
  return {
    settings: { currency: "$", distance: "mi", volume: "gal", activeVehicleId: vehicleId },
    vehicles: [{
      id: vehicleId,
      name: "My car",
      year: "",
      make: "",
      model: "",
      fuelType: "Regular",
      tankCapacity: ""
    }],
    fillups: []
  };
}

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("vehicles")) {
          db.createObjectStore("vehicles", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("fillups")) {
          const store = db.createObjectStore("fillups", { keyPath: "id" });
          store.createIndex("byVehicle", "vehicleId", { unique: false });
          store.createIndex("byDate", "date", { unique: false });
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function requestDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

async function readAll(db, name) {
  return requestDone(db.transaction(name, "readonly").objectStore(name).getAll());
}

async function load() {
  const db = await openDb();
  let vehicles = await readAll(db, "vehicles");
  let fillups = await readAll(db, "fillups");
  const settingsRow = await requestDone(db.transaction("meta", "readonly").objectStore("meta").get("settings"));
  if (!vehicles.length && !fillups.length && !settingsRow) {
    try {
      const raw = localStorage.getItem(LEGACY_KEY);
      if (raw) {
        const old = JSON.parse(raw);
        if (old && Array.isArray(old.vehicles)) {
          state = {
            settings: Object.assign({ currency: "$", distance: "mi", volume: "gal" }, old.settings),
            vehicles: old.vehicles,
            fillups: Array.isArray(old.fillups) ? old.fillups : []
          };
          await save();
          localStorage.removeItem(LEGACY_KEY);
          return state;
        }
      }
    } catch (_) {}
  }
  if (!vehicles.length) return blankState();
  return {
    settings: Object.assign({ currency: "$", distance: "mi", volume: "gal", activeVehicleId: vehicles[0].id }, settingsRow && settingsRow.value),
    vehicles,
    fillups
  };
}

async function save() {
  const db = await openDb();
  const tx = db.transaction(["vehicles", "fillups", "meta"], "readwrite");
  const vehicles = tx.objectStore("vehicles");
  const fillups = tx.objectStore("fillups");
  const meta = tx.objectStore("meta");
  vehicles.clear();
  fillups.clear();
  state.vehicles.forEach((v) => vehicles.put(v));
  state.fillups.forEach((f) => fillups.put(f));
  meta.put({ key: "settings", value: state.settings });
  await txDone(tx);
}

async function eraseDb() {
  if (dbPromise) {
    try { (await dbPromise).close(); } catch (_) {}
    dbPromise = null;
  }
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
  try { localStorage.removeItem(LEGACY_KEY); } catch (_) {}
}

function money(n) {
  const v = Number(n) || 0;
  return `${state.settings.currency}${v.toFixed(2)}`;
}
function num(n, d = 1) {
  if (n == null || Number.isNaN(n) || !Number.isFinite(n)) return "—";
  return Number(n).toFixed(d);
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
function vehicleName(id) {
  return state.vehicles.find((v) => v.id === id)?.name || "Vehicle";
}
function activeId() {
  if (!state.vehicles.some((v) => v.id === state.settings.activeVehicleId)) {
    state.settings.activeVehicleId = state.vehicles[0]?.id || "";
  }
  return state.settings.activeVehicleId;
}
function fillsFor(id) {
  return state.fillups
    .filter((f) => f.vehicleId === id)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || a.odometer - b.odometer);
}

function economyRows(fills) {
  const rows = [];
  let lastFull = null;
  let gallonsSince = 0;
  fills.forEach((f) => {
    gallonsSince += Number(f.gallons) || 0;
    if (f.fullTank && lastFull) {
      const miles = Number(f.odometer) - Number(lastFull.odometer);
      const mpg = miles > 0 && gallonsSince > 0 ? miles / gallonsSince : null;
      rows.push({ ...f, miles, mpg, intervalGallons: gallonsSince });
      gallonsSince = 0;
      lastFull = f;
    } else if (f.fullTank && !lastFull) {
      rows.push({ ...f, miles: null, mpg: null, intervalGallons: gallonsSince });
      gallonsSince = 0;
      lastFull = f;
    } else {
      rows.push({ ...f, miles: null, mpg: null, intervalGallons: null });
    }
  });
  return rows;
}

function summarize(id) {
  const fills = fillsFor(id);
  const econ = economyRows(fills).filter((r) => r.mpg != null);
  const gallons = fills.reduce((s, f) => s + Number(f.gallons || 0), 0);
  const spent = fills.reduce((s, f) => s + Number(f.gallons || 0) * Number(f.pricePerGallon || 0), 0);
  const odos = fills.map((f) => Number(f.odometer)).filter((n) => Number.isFinite(n));
  const miles = odos.length > 1 ? Math.max(...odos) - Math.min(...odos) : 0;
  const avgMpg = econ.length ? econ.reduce((s, r) => s + r.mpg, 0) / econ.length : null;
  const lastMpg = econ.length ? econ[econ.length - 1].mpg : null;
  const avgPrice = gallons ? spent / gallons : null;
  const costPerMile = miles > 0 ? spent / miles : null;
  return { fills, econ, gallons, spent, miles, avgMpg, lastMpg, avgPrice, costPerMile };
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2200);
}

function setView(name) {
  $$(".view").forEach((v) => v.classList.remove("active"));
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $(`#view-${name}`).classList.add("active");
  const titles = {
    dashboard: ["Overview", "Dashboard"],
    log: ["New entry", "Log fill-up"],
    history: ["All entries", "History"],
    vehicles: ["Garage", "Vehicles"],
    reports: ["Backup and units", "Reports"]
  };
  $("#eyebrow").textContent = titles[name][0];
  $("#viewTitle").textContent = titles[name][1];
}

function fillVehicleSelects() {
  const opts = state.vehicles.map((v) => `<option value="${v.id}">${escapeHtml(v.name)}</option>`).join("");
  $("#activeVehicle").innerHTML = opts || `<option value="">No vehicles</option>`;
  $("#formVehicle").innerHTML = opts;
  $("#activeVehicle").value = activeId();
  if (!editingId) $("#formVehicle").value = activeId();
}

function renderStats() {
  const id = activeId();
  const s = summarize(id);
  const unit = state.settings.distance === "km" && state.settings.volume === "L" ? "km/L" : `${state.settings.distance}/${state.settings.volume}`;
  const cards = [
    ["Last tank", s.lastMpg == null ? "—" : num(s.lastMpg, 1), unit],
    ["Average", s.avgMpg == null ? "—" : num(s.avgMpg, 1), unit],
    ["Spent", money(s.spent), `${num(s.gallons, 1)} ${state.settings.volume}`],
    ["Cost / distance", s.costPerMile == null ? "—" : money(s.costPerMile), `over ${num(s.miles, 0)} ${state.settings.distance}`]
  ];
  $("#statGrid").innerHTML = cards.map(([k, v, sub]) =>
    `<article class="stat"><span>${k}</span><strong>${v}</strong><em>${sub}</em></article>`
  ).join("");
  $("#mpgCaption").textContent = s.econ.length ? `${s.econ.length} full-tank intervals` : "Log two full tanks to chart MPG";
}

function drawLine(canvas, points, color) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 640;
  const h = 220;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!points.length) {
    ctx.fillStyle = "#a3ad98";
    ctx.font = "14px sans-serif";
    ctx.fillText("No data yet", 16, 32);
    return;
  }
  const vals = points.map((p) => p.y);
  const min = Math.min(...vals) * 0.9;
  const max = Math.max(...vals) * 1.08;
  const pad = 28;
  const x = (i) => pad + (points.length === 1 ? (w - pad * 2) / 2 : (i * (w - pad * 2)) / (points.length - 1));
  const y = (v) => h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);
  ctx.strokeStyle = "#2c3826";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, h - pad);
  ctx.lineTo(w - 12, h - pad);
  ctx.stroke();
  ctx.beginPath();
  points.forEach((p, i) => {
    const px = x(i);
    const py = y(p.y);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.4;
  ctx.stroke();
  points.forEach((p, i) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x(i), y(p.y), 3.5, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = "#a3ad98";
  ctx.font = "12px sans-serif";
  ctx.fillText(num(points[0].y, 1), x(0) + 6, y(points[0].y) - 8);
  if (points.length > 1) {
    const last = points[points.length - 1];
    ctx.fillText(num(last.y, 1), Math.min(x(points.length - 1) - 28, w - 48), y(last.y) - 8);
  }
}

function drawBars(canvas, points) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 420;
  const h = 220;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!points.length) {
    ctx.fillStyle = "#a3ad98";
    ctx.font = "14px sans-serif";
    ctx.fillText("No spend yet", 16, 32);
    return;
  }
  const max = Math.max(...points.map((p) => p.y), 1);
  const gap = 10;
  const bw = (w - 24 - gap * points.length) / points.length;
  points.forEach((p, i) => {
    const bh = (p.y / max) * 150;
    const x = 16 + i * (bw + gap);
    const y = 168 - bh;
    ctx.fillStyle = "#e8a317";
    ctx.beginPath();
    ctx.roundRect(x, y, bw, bh, 6);
    ctx.fill();
    ctx.fillStyle = "#a3ad98";
    ctx.font = "11px sans-serif";
    ctx.fillText(p.x, x, 190);
  });
}

function monthKey(date) {
  return date.slice(0, 7);
}
function monthLabel(key) {
  const [y, m] = key.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleString(undefined, { month: "short" });
}

function renderCharts() {
  const s = summarize(activeId());
  const mpgPoints = s.econ.slice(-12).map((r) => ({ x: r.date.slice(5), y: r.mpg }));
  drawLine($("#mpgChart"), mpgPoints, "#e8a317");
  const now = new Date();
  const buckets = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    buckets.push({ key, x: monthLabel(key), y: 0 });
  }
  s.fills.forEach((f) => {
    const b = buckets.find((x) => x.key === monthKey(f.date));
    if (b) b.y += Number(f.gallons) * Number(f.pricePerGallon);
  });
  drawBars($("#spendChart"), buckets);
}

function rowHtml(f, withVehicle) {
  const cost = Number(f.gallons) * Number(f.pricePerGallon);
  return `<tr>
    <td>${f.date}</td>
    ${withVehicle ? `<td>${escapeHtml(vehicleName(f.vehicleId))}</td>` : ""}
    <td>${num(f.odometer, 1)}</td>
    <td>${num(f.gallons, 3)}</td>
    <td>${money(f.pricePerGallon)}</td>
    <td>${money(cost)}</td>
    <td>${f.mpg == null ? "—" : num(f.mpg, 1)}</td>
    <td>${escapeHtml(f.station || "")}</td>
    <td><span class="pill ${f.fullTank ? "" : "partial"}">${f.fullTank ? "Full" : "Partial"}</span></td>
    <td class="row-actions">
      <button class="mini" data-edit="${f.id}" type="button">Edit</button>
      <button class="mini" data-del="${f.id}" type="button">Delete</button>
    </td>
  </tr>`;
}

function renderRecent() {
  const rows = economyRows(fillsFor(activeId())).slice().reverse().slice(0, 6);
  if (!rows.length) {
    $("#recentList").innerHTML = `<p class="empty">No fill-ups yet. Log the first one to start MPG.</p>`;
    return;
  }
  $("#recentList").innerHTML = `<table>
    <thead><tr><th>Date</th><th>Odo</th><th>Vol</th><th>$ / unit</th><th>Cost</th><th>MPG</th><th>Station</th><th></th><th></th></tr></thead>
    <tbody>${rows.map((f) => rowHtml(f, false)).join("")}</tbody>
  </table>`;
}

function renderHistory() {
  const q = ($("#historySearch").value || "").toLowerCase();
  const from = $("#historyFrom").value;
  const to = $("#historyTo").value;
  const id = activeId();
  let rows = economyRows(fillsFor(id)).slice().reverse();
  rows = rows.filter((f) => {
    const blob = `${f.station || ""} ${f.notes || ""}`.toLowerCase();
    if (q && !blob.includes(q)) return false;
    if (from && f.date < from) return false;
    if (to && f.date > to) return false;
    return true;
  });
  if (!rows.length) {
    $("#historyTable").innerHTML = `<p class="empty">No matching fill-ups.</p>`;
    return;
  }
  $("#historyTable").innerHTML = `<table>
    <thead><tr><th>Date</th><th>Odo</th><th>Vol</th><th>$ / unit</th><th>Cost</th><th>MPG</th><th>Station</th><th></th><th></th></tr></thead>
    <tbody>${rows.map((f) => rowHtml(f, false)).join("")}</tbody>
  </table>`;
}

function renderVehicles() {
  $("#vehicleList").innerHTML = state.vehicles.map((v) => {
    const s = summarize(v.id);
    const label = [v.year, v.make, v.model].filter(Boolean).join(" ");
    return `<article class="card vehicle">
      <div>
        <strong>${escapeHtml(v.name)}</strong>
        <p class="muted">${escapeHtml(label || v.fuelType)} · ${s.fills.length} fill-ups · avg ${s.avgMpg == null ? "—" : num(s.avgMpg, 1)}</p>
      </div>
      <div class="row-actions">
        <button class="mini" data-use="${v.id}" type="button">Use</button>
        <button class="mini" data-del-vehicle="${v.id}" type="button">Delete</button>
      </div>
    </article>`;
  }).join("");
}

function renderReport() {
  const rows = state.vehicles.map((v) => {
    const s = summarize(v.id);
    return `<tr>
      <td>${escapeHtml(v.name)}</td>
      <td>${s.fills.length}</td>
      <td>${num(s.miles, 0)}</td>
      <td>${num(s.gallons, 1)}</td>
      <td>${money(s.spent)}</td>
      <td>${s.avgMpg == null ? "—" : num(s.avgMpg, 1)}</td>
      <td>${s.avgPrice == null ? "—" : money(s.avgPrice)}</td>
    </tr>`;
  }).join("");
  $("#reportTable").innerHTML = `<table>
    <thead><tr><th>Vehicle</th><th>Fill-ups</th><th>Distance</th><th>Volume</th><th>Spent</th><th>Avg economy</th><th>Avg price</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
  $("#currencySymbol").value = state.settings.currency;
  $("#distanceUnit").value = state.settings.distance;
  $("#volumeUnit").value = state.settings.volume;
}

function render() {
  fillVehicleSelects();
  renderStats();
  renderCharts();
  renderRecent();
  renderHistory();
  renderVehicles();
  renderReport();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function toCsv() {
  const header = ["date", "vehicle", "odometer", "gallons", "price_per_gallon", "cost", "full_tank", "mpg", "station", "notes"];
  const lines = [header.join(",")];
  state.vehicles.forEach((v) => {
    economyRows(fillsFor(v.id)).forEach((f) => {
      const cost = Number(f.gallons) * Number(f.pricePerGallon);
      const cells = [f.date, v.name, f.odometer, f.gallons, f.pricePerGallon, cost.toFixed(2), f.fullTank ? "yes" : "no", f.mpg == null ? "" : f.mpg.toFixed(2), f.station || "", f.notes || ""];
      lines.push(cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","));
    });
  });
  return lines.join("\n");
}

function resetForm() {
  editingId = null;
  $("#fillForm").reset();
  $("#fillForm").date.value = today();
  $("#fillForm").fullTank.checked = true;
  $("#formVehicle").value = activeId();
  $("#saveFillBtn").textContent = "Save fill-up";
  $("#cancelEditBtn").hidden = true;
  $("#formNote").textContent = "";
}

$$(".nav-btn, .link").forEach((b) => {
  if (!b.dataset.view) return;
  b.addEventListener("click", () => setView(b.dataset.view));
});

$("#quickLogBtn").addEventListener("click", () => setView("log"));
$("#activeVehicle").addEventListener("change", (e) => {
  state.settings.activeVehicleId = e.target.value;
  save();
  render();
});

$("#fillForm").date.value = today();
$("#fillForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const entry = {
    id: editingId || uid(),
    vehicleId: fd.get("vehicleId"),
    date: fd.get("date"),
    odometer: Number(fd.get("odometer")),
    gallons: Number(fd.get("gallons")),
    pricePerGallon: Number(fd.get("pricePerGallon")),
    station: String(fd.get("station") || "").trim(),
    notes: String(fd.get("notes") || "").trim(),
    fullTank: fd.get("fullTank") === "on"
  };
  if (editingId) {
    state.fillups = state.fillups.map((f) => f.id === editingId ? entry : f);
    toast("Fill-up updated");
  } else {
    state.fillups.push(entry);
    toast("Fill-up saved");
  }
  state.settings.activeVehicleId = entry.vehicleId;
  save();
  resetForm();
  render();
  setView("dashboard");
});

$("#cancelEditBtn").addEventListener("click", resetForm);

document.body.addEventListener("click", (e) => {
  const edit = e.target.closest("[data-edit]");
  const del = e.target.closest("[data-del]");
  const use = e.target.closest("[data-use]");
  const delV = e.target.closest("[data-del-vehicle]");
  if (edit) {
    const f = state.fillups.find((x) => x.id === edit.dataset.edit);
    if (!f) return;
    editingId = f.id;
    const form = $("#fillForm");
    form.vehicleId.value = f.vehicleId;
    form.date.value = f.date;
    form.odometer.value = f.odometer;
    form.gallons.value = f.gallons;
    form.pricePerGallon.value = f.pricePerGallon;
    form.station.value = f.station || "";
    form.notes.value = f.notes || "";
    form.fullTank.checked = !!f.fullTank;
    $("#saveFillBtn").textContent = "Update fill-up";
    $("#cancelEditBtn").hidden = false;
    setView("log");
  }
  if (del) {
    if (!confirm("Delete this fill-up?")) return;
    state.fillups = state.fillups.filter((f) => f.id !== del.dataset.del);
    save();
    render();
    toast("Deleted");
  }
  if (use) {
    state.settings.activeVehicleId = use.dataset.use;
    save();
    render();
    setView("dashboard");
  }
  if (delV) {
    if (state.vehicles.length === 1) {
      toast("Keep at least one vehicle");
      return;
    }
    if (!confirm("Delete this vehicle and its fill-ups?")) return;
    const id = delV.dataset.delVehicle;
    state.vehicles = state.vehicles.filter((v) => v.id !== id);
    state.fillups = state.fillups.filter((f) => f.vehicleId !== id);
    save();
    render();
  }
});

$("#vehicleForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const v = {
    id: uid(),
    name: String(fd.get("name")).trim(),
    year: fd.get("year") || "",
    make: String(fd.get("make") || "").trim(),
    model: String(fd.get("model") || "").trim(),
    fuelType: fd.get("fuelType"),
    tankCapacity: fd.get("tankCapacity") || ""
  };
  state.vehicles.push(v);
  state.settings.activeVehicleId = v.id;
  save();
  e.target.reset();
  render();
  toast("Vehicle added");
});

$("#historySearch").addEventListener("input", renderHistory);
$("#historyFrom").addEventListener("change", renderHistory);
$("#historyTo").addEventListener("change", renderHistory);

function exportCsv() {
  download(`gas-usage-${today()}.csv`, toCsv(), "text/csv");
}
$("#exportCsvBtn").addEventListener("click", exportCsv);
$("#exportCsvBtn2").addEventListener("click", exportCsv);
$("#exportJsonBtn").addEventListener("click", () => {
  download(`gas-usage-${today()}.json`, JSON.stringify(state, null, 2), "application/json");
});
$("#importJson").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.vehicles || !data.fillups) throw new Error("bad");
    state.settings = Object.assign({ currency: "$", distance: "mi", volume: "gal" }, data.settings);
    state.vehicles = data.vehicles;
    state.fillups = data.fillups;
    await save();
    render();
    toast("Backup imported to IndexedDB");
  } catch (_) {
    toast("That file is not a Gas Usage backup");
  }
  e.target.value = "";
});

$("#currencySymbol").addEventListener("change", (e) => {
  state.settings.currency = e.target.value || "$";
  save();
  render();
});
$("#distanceUnit").addEventListener("change", (e) => {
  state.settings.distance = e.target.value;
  save();
  render();
});
$("#volumeUnit").addEventListener("change", (e) => {
  state.settings.volume = e.target.value;
  save();
  render();
});
$("#resetBtn").addEventListener("click", async () => {
  if (!confirm("Erase all Gas Usage data in this browser?")) return;
  await eraseDb();
  location.reload();
});

window.addEventListener("resize", () => {
  renderCharts();
});

load().then((loaded) => {
  state = loaded;
  render();
  setView("dashboard");
}).catch((err) => {
  console.error(err);
  toast("IndexedDB could not be opened");
  render();
  setView("dashboard");
});
