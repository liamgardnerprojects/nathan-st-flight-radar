import { airlineFromCallsign, airlineFromMetadata } from "./airlines.js";
import { resolveTypeInfo } from "./aircraft-types.js";
import { formatAirport } from "./airports.js";

const STANDBY = { from: { h: 23, m: 0 }, until: { h: 7, m: 0 } };

const CONFIG = {
  lat: -33.9189055,
  lon: 151.2489740,
  label: "NATHAN ST · COOGEE",
  /** Asymmetric sector: 1 km west, 5 km east (toward ocean), ±crossM north/south */
  sector: { westM: 2000, eastM: 8000, crossM: 4000 },
  refreshMs: 162_000,
  standby: STANDBY,
  openskyAuthenticated: false,
};

function sectorLabel() {
  const { westM, eastM, crossM } = CONFIG.sector;
  return `${westM / 1000}W · ${eastM / 1000}E · ${crossM / 1000}N/S KM`;
}

function rangeSubline() {
  const sec = Math.floor(CONFIG.refreshMs / 1000);
  const auth = CONFIG.openskyAuthenticated ? " · AUTH" : "";
  return `SECTOR ${sectorLabel()} · ${sec}S SCAN${auth} · AIRBORNE ONLY`;
}

const HUD = {
  cyan: "#00e8ff",
  cyanDim: "rgba(0, 232, 255, 0.28)",
  amber: "#ff9f43",
  bg: "#000810",
};

const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 111_320;

let aircraft = [];
let lastFetchOk = false;
let sweepAngle = 0;
let lastSweepTs = 0;
let countdownSec = 162;
let map = null;
let mapResizeObserver = null;
let planeMarkers = [];
let metadataCache = new Map();
let flightRouteCache = new Map();
let inStandby = false;

const els = {
  hudLocation: document.getElementById("hud-location"),
  hudRange: document.getElementById("hud-range"),
  hudScan: document.getElementById("hud-scan"),
  hudCount: document.getElementById("hud-count"),
  hudLink: document.getElementById("hud-link"),
  errorBanner: document.getElementById("error-banner"),
  aircraftList: document.getElementById("aircraft-list"),
  emptyMsg: document.getElementById("empty-msg"),
  radarCanvas: document.getElementById("radar"),
  panelRadar: document.getElementById("panel-radar"),
  panelMap: document.getElementById("panel-map"),
};

const radarCtx = els.radarCanvas.getContext("2d");

function setReadout(el, text, flash = true) {
  const upper = String(text).toUpperCase();
  if (el.textContent !== upper) {
    el.textContent = upper;
    if (flash) {
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
    }
  }
}

function setLinkState(state) {
  els.hudLink.className = `readout-value link-${state}`;
  const labels = {
    ok: CONFIG.openskyAuthenticated ? "AUTH" : "ONLINE",
    err: "FAULT",
    busy: "SYNC",
    standby: "STBY",
  };
  setReadout(els.hudLink, labels[state] || "---", false);
}

function localMinutesOfDay(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

function standbyWindowMins() {
  const { from, until } = CONFIG.standby;
  return {
    start: from.h * 60 + from.m,
    end: until.h * 60 + until.m,
  };
}

function formatCountdown(sec) {
  if (sec >= 60) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `T-${m}M${String(s).padStart(2, "0")}S`;
  }
  return `T-${String(sec).padStart(2, "0")}S`;
}

function isStandbyNow(date = new Date()) {
  const { start, end } = standbyWindowMins();
  const now = localMinutesOfDay(date);
  // Overnight window (e.g. 23:00 → 07:00)
  if (start >= end) return now >= start || now < end;
  return now >= start && now < end;
}

function formatResumeTime() {
  const { until } = CONFIG.standby;
  const h = String(until.h).padStart(2, "0");
  const m = String(until.m).padStart(2, "0");
  return `${h}:${m}`;
}

function enterStandby() {
  inStandby = true;
  setLinkState("standby");
  setReadout(els.hudScan, "STANDBY", false);
  setReadout(els.hudRange, `STANDBY · RESUME ${formatResumeTime()}`, false);
}

function exitStandby() {
  inStandby = false;
  setReadout(els.hudRange, rangeSubline(), false);
  countdownSec = CONFIG.refreshMs / 1000;
}

async function applyServerConfig() {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) return;
    const data = await res.json();
    if (data.refreshSec) {
      CONFIG.refreshMs = data.refreshSec * 1000;
      countdownSec = data.refreshSec;
    }
    CONFIG.openskyAuthenticated = !!data.openskyAuthenticated;
    setReadout(els.hudRange, rangeSubline(), false);
  } catch {
    /* server may be offline during boot */
  }
}

function eastWestOffsetM(lat, lon, centerLat = CONFIG.lat, centerLon = CONFIG.lon) {
  return (
    (lon - centerLon) * DEG * M_PER_DEG_LAT * Math.cos(centerLat * DEG)
  );
}

function isInSector(lat, lon) {
  const { westM, eastM, crossM } = CONFIG.sector;
  const ew = eastWestOffsetM(lat, lon);
  const ns = (lat - CONFIG.lat) * DEG * M_PER_DEG_LAT;
  return ew >= -westM && ew <= eastM && Math.abs(ns) <= crossM;
}

function bboxForSector(pad = 1.15) {
  const { lat, lon, sector } = CONFIG;
  const cos = Math.cos(lat * DEG);
  const dLonW = (sector.westM * pad) / (M_PER_DEG_LAT * cos);
  const dLonE = (sector.eastM * pad) / (M_PER_DEG_LAT * cos);
  const dLat = (sector.crossM * pad) / M_PER_DEG_LAT;
  return {
    lamin: lat - dLat,
    lamax: lat + dLat,
    lomin: lon - dLonW,
    lomax: lon + dLonE,
  };
}

function sectorLatLngBounds() {
  const { lat, lon, sector } = CONFIG;
  const cos = Math.cos(lat * DEG);
  const dLat = sector.crossM / M_PER_DEG_LAT;
  const dLonW = sector.westM / (M_PER_DEG_LAT * cos);
  const dLonE = sector.eastM / (M_PER_DEG_LAT * cos);
  return [
    [lat - dLat, lon - dLonW],
    [lat + dLat, lon + dLonE],
  ];
}

function haversineM(lat1, lon1, lat2, lon2) {
  const r = 6371000;
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * DEG) * Math.cos(lat2 * DEG);
  const x =
    Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) -
    Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos((lon2 - lon1) * DEG);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

function mpsToKnots(mps) {
  return mps == null ? null : mps * 1.94384;
}

function mToFt(m) {
  return m == null ? null : m * 3.28084;
}

function showError(message) {
  lastFetchOk = false;
  els.errorBanner.textContent = `⚠ ${String(message).toUpperCase()}`;
  els.errorBanner.classList.remove("hidden");
  setLinkState("err");
  aircraft = [];
  renderList();
  updateMapMarkers();
  drawRadar();
}

function clearError() {
  els.errorBanner.classList.add("hidden");
  setLinkState("ok");
}

async function fetchStates() {
  const box = bboxForSector(1.15);
  const q = new URLSearchParams({
    lamin: box.lamin.toFixed(5),
    lamax: box.lamax.toFixed(5),
    lomin: box.lomin.toFixed(5),
    lomax: box.lomax.toFixed(5),
    extended: "1",
  });
  const res = await fetch(`/api/states?${q}`);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) detail = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(`OPENSKY ${res.status}: ${detail}`);
  }
  const data = await res.json();
  return data?.states ?? [];
}

async function fetchMetadata(icao24) {
  if (metadataCache.has(icao24)) return metadataCache.get(icao24);
  const empty = { typeCode: null, model: null, airline: null };
  try {
    const res = await fetch(`/api/aircraft/${icao24}`);
    if (!res.ok) {
      metadataCache.set(icao24, empty);
      return empty;
    }
    const meta = await res.json();
    const result = {
      typeCode: meta?.typecode?.trim().toUpperCase() || null,
      model:
        meta?.model ||
        [meta?.manufacturername, meta?.model].filter(Boolean).join(" ") ||
        null,
      airline: airlineFromMetadata(meta),
    };
    metadataCache.set(icao24, result);
    return result;
  } catch {
    metadataCache.set(icao24, empty);
    return empty;
  }
}

function resolveAirline(ac, metaAirline) {
  return metaAirline || airlineFromCallsign(ac.callsign) || "---";
}

function pickCurrentFlight(flights) {
  if (!Array.isArray(flights) || !flights.length) return null;
  const now = Date.now() / 1000;
  const recent = flights.filter(
    (f) => f.estDepartureAirport && f.lastSeen >= now - 8 * 3600,
  );
  if (!recent.length) return null;
  return recent.sort((a, b) => b.lastSeen - a.lastSeen)[0];
}

async function fetchFlightRoute(icao24) {
  if (flightRouteCache.has(icao24)) return flightRouteCache.get(icao24);
  const empty = { origin: null, destination: null };
  try {
    const now = Math.floor(Date.now() / 1000);
    const q = new URLSearchParams({
      begin: String(now - 8 * 3600),
      end: String(now + 120),
    });
    const res = await fetch(`/api/flights/${icao24}?${q}`);
    if (!res.ok) {
      flightRouteCache.set(icao24, empty);
      return empty;
    }
    const flights = await res.json();
    const active = pickCurrentFlight(flights);
    const result = {
      origin: active?.estDepartureAirport?.toUpperCase() || null,
      destination: active?.estArrivalAirport?.toUpperCase() || null,
    };
    flightRouteCache.set(icao24, result);
    return result;
  } catch {
    flightRouteCache.set(icao24, empty);
    return empty;
  }
}

function formatOrigin(ac) {
  return formatAirport(ac.origin);
}

function parseState(row) {
  const [
    icao24,
    callsign,
    ,
    ,
    ,
    lon,
    lat,
    baroAlt,
    onGround,
    velocity,
    trueTrack,
    ,
    ,
    ,
    ,
    ,
    ,
    category,
  ] = row;
  if (lat == null || lon == null) return null;
  if (onGround === true) return null;
  if (!isInSector(lat, lon)) return null;
  const dist = haversineM(CONFIG.lat, CONFIG.lon, lat, lon);
  return {
    icao24,
    callsign: (callsign || "").trim() || icao24.toUpperCase(),
    lat,
    lon,
    altitudeM: baroAlt,
    speedKts: mpsToKnots(velocity),
    heading: trueTrack,
    distanceM: dist,
    bearing: bearingDeg(CONFIG.lat, CONFIG.lon, lat, lon),
    typeCode: null,
    typeName: null,
    capacity: null,
    category: category ?? null,
    origin: null,
    airline: null,
  };
}

async function enrichAircraft(list) {
  if (!list.length) return;
  await Promise.all(
    list.map(async (ac) => {
      const [meta, route] = await Promise.all([
        fetchMetadata(ac.icao24),
        fetchFlightRoute(ac.icao24),
      ]);
      const info = resolveTypeInfo(meta.typeCode, meta.model, ac.category);
      ac.typeCode = info.typeCode || meta.typeCode;
      ac.typeName = info.typeName;
      ac.capacity = info.capacity;
      ac.origin = route.origin;
      ac.airline = resolveAirline(ac, meta.airline);
    }),
  );
}

function formatType(ac) {
  const name = ac.typeName || ac.typeCode;
  return name ? name.toUpperCase().slice(0, 16) : "---";
}

function formatCapacity(ac) {
  if (ac.capacity == null) return "---";
  return `~${ac.capacity}`;
}

async function scan() {
  if (isStandbyNow()) {
    enterStandby();
    return;
  }
  setLinkState("busy");
  setReadout(els.hudScan, "SCAN");
  try {
    let states;
    try {
      states = await fetchStates();
    } catch (firstErr) {
      if (/timed out|502|503|504|503|unavailable|fetch/i.test(firstErr.message)) {
        await new Promise((r) => setTimeout(r, 2000));
        states = await fetchStates();
      } else {
        throw firstErr;
      }
    }
    const parsed = states.map(parseState).filter(Boolean);
    parsed.sort((a, b) => a.distanceM - b.distanceM);
    await enrichAircraft(parsed);
    aircraft = parsed;
    lastFetchOk = true;
    clearError();
    renderAll();
  } catch (err) {
    console.error(err);
    showError(err.message || "SCAN FAILED — CHECK SERVER");
  } finally {
    countdownSec = CONFIG.refreshMs / 1000;
    updateStatusReadouts();
  }
}

function formatAlt(ac) {
  const ft = mToFt(ac.altitudeM);
  if (ft == null) return "---";
  return `FL${Math.round(ft / 100)}`;
}

function formatSpeed(ac) {
  if (ac.speedKts == null) return "---";
  return `${Math.round(ac.speedKts)}`;
}

function formatHdg(ac) {
  if (ac.heading == null) return "---";
  return String(Math.round(ac.heading)).padStart(3, "0");
}

function formatDist(ac) {
  if (ac.distanceM < 1000) return `${Math.round(ac.distanceM)}M`;
  return `${(ac.distanceM / 1000).toFixed(1)}KM`;
}

function popupLine(label, value) {
  return `<div class="popup-row"><span class="popup-tag">${label}</span>${value}</div>`;
}

const FIELD_DEFS = [
  { label: "flight", primary: true, format: (ac) => (ac.callsign || ac.icao24).toUpperCase().slice(0, 10) },
  { label: "airline", format: (ac) => (ac.airline || "---").toUpperCase().slice(0, 18) },
  { label: "origin", format: formatOrigin },
  { label: "alt", format: (ac) => formatAlt(ac) },
  { label: "spd kt", format: (ac) => formatSpeed(ac) },
  { label: "hdg °", format: (ac) => formatHdg(ac) },
  { label: "rng", format: (ac) => formatDist(ac) },
  { label: "type", format: formatType },
  { label: "seats", format: formatCapacity },
];

function visibleFields(ac) {
  return FIELD_DEFS.map((f) => ({
    label: f.label,
    value: f.format(ac),
    primary: !!f.primary,
  }));
}

function renderAircraftCard(ac) {
  const card = document.createElement("article");
  card.className = "hud-contact";
  const fields = visibleFields(ac);
  const wrap = document.createElement("div");
  wrap.className = "contact-fields";

  if (!fields.length) {
    const f = document.createElement("div");
    f.className = "hud-field primary";
    f.innerHTML = `<span class="field-label">flight</span><span class="field-value">${(ac.callsign || ac.icao24).toUpperCase()}</span>`;
    wrap.appendChild(f);
  } else {
    fields.forEach(({ label, value, primary }) => {
      const f = document.createElement("div");
      f.className = `hud-field${primary ? " primary" : ""}`;
      f.innerHTML = `<span class="field-label">${label}</span><span class="field-value">${value}</span>`;
      wrap.appendChild(f);
    });
  }

  card.appendChild(wrap);
  return card;
}

function renderList() {
  els.aircraftList.querySelectorAll(".hud-contact").forEach((n) => n.remove());

  if (!lastFetchOk) {
    els.emptyMsg.classList.add("hidden");
    return;
  }

  if (!aircraft.length) {
    els.emptyMsg.textContent = `NO CONTACTS · ${sectorLabel()}`;
    els.emptyMsg.classList.remove("hidden");
    return;
  }

  els.emptyMsg.classList.add("hidden");
  aircraft.forEach((ac) => {
    els.aircraftList.appendChild(renderAircraftCard(ac));
  });
}

function updateStatusReadouts() {
  if (inStandby) return;
  const n = aircraft.length;
  setReadout(els.hudCount, String(n).padStart(2, "0"));
  if (lastFetchOk) {
    setReadout(els.hudScan, formatCountdown(countdownSec));
  }
}

function tickSchedule() {
  const standby = isStandbyNow();

  if (standby) {
    if (!inStandby) enterStandby();
    return;
  }

  if (inStandby) {
    exitStandby();
    scan();
    return;
  }

  if (countdownSec > 0) {
    countdownSec -= 1;
    if (lastFetchOk) updateStatusReadouts();
    return;
  }
  scan();
}

function renderAll() {
  renderList();
  drawRadar();
  updateMapMarkers();
  updateStatusReadouts();
  scheduleMapResize();
}

function resizeRadar() {
  const frame = els.panelRadar.querySelector(".hud-frame");
  const pad = 20;
  const header = 34;
  const maxW = frame.clientWidth - pad;
  const maxH = frame.clientHeight - header;
  const size = Math.floor(Math.min(maxW, maxH));
  if (size < 80) return;
  const dpr = window.devicePixelRatio || 1;
  const px = `${size}px`;
  els.radarCanvas.width = size * dpr;
  els.radarCanvas.height = size * dpr;
  els.radarCanvas.style.width = px;
  els.radarCanvas.style.height = px;
  els.radarCanvas.style.maxWidth = px;
  els.radarCanvas.style.maxHeight = px;
  radarCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawRadar();
}

function drawRadarRing(ctx, cx, cy, r, label) {
  ctx.strokeStyle = HUD.cyanDim;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  if (label) {
    ctx.fillStyle = HUD.cyanDim;
    ctx.font = `9px "Share Tech Mono", monospace`;
    ctx.textAlign = "center";
    ctx.fillText(label, cx, cy - r - 4);
  }
}

function drawRadarBlip(ctx, x, y, heading) {
  const h = (heading ?? 0) * DEG;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(h);
  ctx.strokeStyle = HUD.cyan;
  ctx.fillStyle = HUD.cyan;
  ctx.shadowColor = HUD.cyan;
  ctx.shadowBlur = 10;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, -6);
  ctx.lineTo(4, 4);
  ctx.lineTo(0, 2);
  ctx.lineTo(-4, 4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.shadowBlur = 0;
}

function drawRadar() {
  const size = els.radarCanvas.width / (window.devicePixelRatio || 1);
  if (!size) return;
  const ctx = radarCtx;
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.44;

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = HUD.bg;
  ctx.fillRect(0, 0, size, size);

  const { westM, eastM } = CONFIG.sector;
  const westFrac = westM / eastM;

  for (let i = 1; i <= 4; i++) {
    const km = (eastM / 1000 / 4) * i;
    drawRadarRing(ctx, cx, cy, (r * i) / 4, i === 4 ? `${km}E` : "");
  }

  ctx.strokeStyle = HUD.cyanDim;
  ctx.lineWidth = 1;
  const wx = cx - r * westFrac;
  ctx.beginPath();
  ctx.moveTo(wx, cy - r);
  ctx.lineTo(wx, cy + r);
  ctx.stroke();
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = HUD.cyanDim;
  ctx.font = `9px "Share Tech Mono", monospace`;
  ctx.textAlign = "center";
  ctx.fillText("W", wx, cy - r - 6);
  ctx.fillText("E", cx + r, cy - r - 6);

  ctx.strokeStyle = HUD.amber;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy - r * 0.15);
  ctx.stroke();
  ctx.globalAlpha = 1;

  const now = performance.now();
  if (!lastSweepTs) lastSweepTs = now;
  const dt = Math.min(now - lastSweepTs, 50);
  lastSweepTs = now;
  sweepAngle = (sweepAngle + (dt / CONFIG.refreshMs) * 360) % 360;
  const sweepRad = (sweepAngle - 90) * DEG;
  const grad = ctx.createConicGradient(sweepRad, cx, cy);
  grad.addColorStop(0, "rgba(0, 232, 255, 0)");
  grad.addColorStop(0.06, "rgba(0, 232, 255, 0.22)");
  grad.addColorStop(0.12, "rgba(0, 232, 255, 0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  aircraft.forEach((ac) => {
    const distFrac = Math.min(ac.distanceM / eastM, 1);
    const angle = (ac.bearing - 90) * DEG;
    const pr = r * distFrac;
    const x = cx + Math.cos(angle) * pr;
    const y = cy + Math.sin(angle) * pr;
    drawRadarBlip(ctx, x, y, ac.heading);
  });

  ctx.fillStyle = HUD.amber;
  ctx.shadowColor = HUD.amber;
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
}

function fitMapToSector() {
  if (!map) return;
  map.fitBounds(sectorLatLngBounds(), {
    padding: [28, 28],
    maxZoom: 12,
    animate: false,
  });
}

function initMap() {
  if (map) return;
  map = L.map("map", { zoomControl: false, attributionControl: false });
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd",
    maxZoom: 19,
  }).addTo(map);
  L.circleMarker([CONFIG.lat, CONFIG.lon], {
    radius: 6,
    color: HUD.amber,
    fillColor: HUD.amber,
    fillOpacity: 1,
    weight: 2,
    opacity: 1,
  })
    .addTo(map)
    .bindPopup("HOME · NATHAN ST");
  L.rectangle(sectorLatLngBounds(), {
    color: HUD.cyan,
    fillColor: HUD.cyan,
    fillOpacity: 0.08,
    weight: 2,
    dashArray: "8 6",
  }).addTo(map);
  watchMapContainer();
  scheduleMapResize(() => fitMapToSector());
}

function scheduleMapResize(afterResize) {
  if (!map) return;
  requestAnimationFrame(() => {
    map.invalidateSize();
    setTimeout(() => {
      map.invalidateSize();
      afterResize?.();
    }, 200);
  });
}

function watchMapContainer() {
  const el = document.getElementById("map");
  if (!el || mapResizeObserver) return;
  mapResizeObserver = new ResizeObserver(() => {
    scheduleMapResize(() => fitMapToSector());
  });
  mapResizeObserver.observe(el);
}


function planeIcon(heading) {
  const h = heading == null ? 0 : Math.round(heading);
  return L.divIcon({
    className: "plane-blip",
    html: `<span style="display:block;transform:rotate(${h}deg)">▲</span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function updateMapMarkers() {
  if (!map) return;
  planeMarkers.forEach((m) => m.remove());
  planeMarkers = [];
  aircraft.forEach((ac) => {
    const m = L.marker([ac.lat, ac.lon], { icon: planeIcon(ac.heading) }).addTo(map);
    const lines = visibleFields(ac)
      .map(({ label, value }) => popupLine(label, value))
      .join("");
    m.bindPopup(lines || `<strong>${(ac.callsign || ac.icao24).toUpperCase()}</strong>`);
    planeMarkers.push(m);
  });
}

function tick() {
  drawRadar();
  requestAnimationFrame(tick);
}

function startTimers() {
  setInterval(tickSchedule, 1000);
}

async function boot() {
  setReadout(els.hudLocation, CONFIG.label, false);
  setReadout(els.hudRange, rangeSubline(), false);
  setReadout(els.hudScan, "BOOT", false);
  setReadout(els.hudCount, "00", false);
  window.addEventListener("resize", () => {
    resizeRadar();
    scheduleMapResize(() => fitMapToSector());
  });
  tick();
  initMap();
  await applyServerConfig();
  startTimers();
  if (isStandbyNow()) {
    enterStandby();
  } else {
    setLinkState("busy");
    scan();
  }
  requestAnimationFrame(() => {
    resizeRadar();
    scheduleMapResize();
  });
}

boot();
