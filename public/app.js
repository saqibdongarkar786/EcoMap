'use strict';

/* ============================== state ============================== */
const DEFAULT_POS = { lat: 40.7128, lng: -74.0060 }; // NYC fallback
const HAZARD_AQI = 200;
const ALERT_RADIUS_M = 1000;
const ALERT_COOLDOWN_MS = 90 * 1000;

const state = {
  map: null,
  userPos: null,
  timeOfDay: new Date().getHours(),
  view: 'aqi',            // 'aqi' | 'noise'
  data: null,             // last payload from /api/pollution-data
  circles: [],
  userMarker: null,
  alertRadius: null,
  alertsEnabled: false,
  lastAlertAt: 0,
};

/* ============================= helpers ============================= */
const $ = (id) => document.getElementById(id);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const pad2 = (n) => String(n).padStart(2, '0');

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function aqiBucket(aqi) {
  if (aqi <= 50) return { label: 'Good', color: '#22c55e' };
  if (aqi <= 100) return { label: 'Moderate', color: '#eab308' };
  if (aqi <= 150) return { label: 'Poor (USG)', color: '#f97316' };
  if (aqi <= 200) return { label: 'Unhealthy', color: '#ef4444' };
  if (aqi <= 300) return { label: 'Very Unhealthy', color: '#a855f7' };
  return { label: 'Hazardous', color: '#7f1d1d' };
}

function noiseColor(db) {
  if (db < 45) return '#22c55e';
  if (db < 60) return '#eab308';
  if (db < 75) return '#f97316';
  return '#ef4444';
}

/* toasts (also the fallback where the Notification API is unavailable) */
function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = message;
  $('toast-container').appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 5200);
}

/* ============================== map ================================ */
function initMap() {
  state.map = L.map('map', { zoomControl: true }).setView([DEFAULT_POS.lat, DEFAULT_POS.lng], 13);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20,
  }).addTo(state.map);

  // Leaflet caches container size at init — recompute after layout changes.
  window.addEventListener('resize', () => state.map.invalidateSize());
}

function setUserPos(pos) {
  state.userPos = pos;
  state.map.setView([pos.lat, pos.lng], 14);

  if (state.userMarker) {
    state.userMarker.remove();
    state.alertRadius.remove();
  }
  state.userMarker = L.circleMarker([pos.lat, pos.lng], {
    radius: 8, color: '#ffffff', weight: 2.5, fillColor: '#38bdf8', fillOpacity: 1,
  }).bindPopup('📍 You are here').addTo(state.map);

  state.alertRadius = L.circle([pos.lat, pos.lng], {
    radius: ALERT_RADIUS_M, color: '#ef4444', weight: 1.5, dashArray: '6 8',
    fill: false, interactive: false,
  }).addTo(state.map);
}

/* =========================== data + render ========================= */
async function fetchData() {
  if (!state.userPos) return;
  const { lat, lng } = state.userPos;
  try {
    const res = await fetch(`/api/pollution-data?lat=${lat}&lng=${lng}&timeOfDay=${state.timeOfDay}`);
    if (!res.ok) throw new Error(`API responded ${res.status}`);
    state.data = await res.json();
    renderData();
    updateStats();
    scanForHazards(); // re-evaluate hazards on every fresh dataset
  } catch (err) {
    console.error(err);
    toast('Could not load pollution data — is the server running?', true);
  }
}

function renderData() {
  state.circles.forEach((c) => c.remove());
  state.circles = state.data.sensors.map((s) => {
    const isAqi = state.view === 'aqi';
    const color = isAqi ? aqiBucket(s.aqi).color : noiseColor(s.noise);
    const radius = isAqi
      ? clamp(140 + s.aqi * 1.4, 140, 520)          // severity scales size (m)
      : clamp(140 + (s.noise - 32) * 5.5, 140, 520);
    return L.circle([s.lat, s.lng], {
      radius, color, weight: 2, fillColor: color, fillOpacity: 0.35,
    }).bindPopup(popupHtml(s)).addTo(state.map);
  });
}

function popupHtml(s) {
  const aqi = aqiBucket(s.aqi);
  const dist = s.distance >= 1000 ? `${(s.distance / 1000).toFixed(2)} km` : `${s.distance} m`;
  return `
    <div class="popup">
      <strong>${s.name}</strong><br/>
      <span class="dot" style="background:${aqi.color}"></span>
      AQI: <strong style="color:${aqi.color}">${s.aqi}</strong> (${aqi.label})<br/>
      🔊 Noise: <strong>${s.noise.toFixed(1)} dB</strong><br/>
      📏 ${dist} away
    </div>`;
}

function updateStats() {
  const { sensors, timeOfDay } = state.data;
  const avgAqi = Math.round(sensors.reduce((a, s) => a + s.aqi, 0) / sensors.length);
  const peakAqi = Math.max(...sensors.map((s) => s.aqi));
  const avgNoise = (sensors.reduce((a, s) => a + s.noise, 0) / sensors.length).toFixed(1);

  $('stat-avg-aqi').textContent = avgAqi;
  $('stat-avg-aqi').style.color = aqiBucket(avgAqi).color;
  $('stat-peak-aqi').textContent = peakAqi;
  $('stat-peak-aqi').style.color = aqiBucket(peakAqi).color;
  $('stat-avg-noise').textContent = avgNoise;
  $('stat-nodes').textContent = sensors.length;
  $('snapshot-note').textContent =
    `Simulating ${pad2(timeOfDay)}:00 · ${sensors.length} nodes near your location`;
}

/* ========================== hazard alerts ========================== */
function scanForHazards(force = false) {
  if (!state.alertsEnabled || !state.data || !state.userPos) return;

  const hazardous = state.data.sensors.filter(
    (s) =>
      s.aqi > HAZARD_AQI &&
      haversineMeters(state.userPos.lat, state.userPos.lng, s.lat, s.lng) <= ALERT_RADIUS_M
  );
  const statusEl = $('alert-status');

  if (!hazardous.length) {
    statusEl.textContent = 'Monitoring — no hazards within 1 km';
    statusEl.classList.remove('danger');
    return;
  }
  statusEl.textContent = `⚠ ${hazardous.length} hazardous node(s) within 1 km`;
  statusEl.classList.add('danger');

  const now = Date.now();
  if (!force && now - state.lastAlertAt < ALERT_COOLDOWN_MS) return;
  state.lastAlertAt = now;

  const worst = hazardous.reduce((a, b) => (b.aqi > a.aqi ? b : a));
  const distM = Math.round(
    haversineMeters(state.userPos.lat, state.userPos.lng, worst.lat, worst.lng)
  );
  const title = `⚠️ Hazardous Air Quality — AQI ${worst.aqi}`;
  const body = `${worst.name} is ${distM} m away and exceeds the ${HAZARD_AQI} threshold.`;

  // Desktop browsers accept the constructor directly. Android/iOS need a
  // service worker and throw here — the toast below is the fallback.
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body, tag: 'ecomap-hazard' });
    }
  } catch { /* no SW registered — fall through to toast */ }
  toast(`${title} · ${body}`);
}

async function onAlertToggle() {
  const checkbox = $('alerts-toggle');
  const statusEl = $('alert-status');

  if (!checkbox.checked) {
    state.alertsEnabled = false;
    statusEl.textContent = 'Alerts are off';
    statusEl.classList.remove('danger');
    return;
  }
  if (!('Notification' in window)) {
    checkbox.checked = false;
    toast('This browser does not support notifications.', true);
    return;
  }

  // Must run inside the click gesture so the permission prompt can show.
  let permission = Notification.permission;
  if (permission === 'default') permission = await Notification.requestPermission();

  if (permission !== 'granted') {
    checkbox.checked = false;
    statusEl.textContent = 'Permission denied';
    toast('Notification permission was denied — alerts stay off.', true);
    return;
  }

  state.alertsEnabled = true;
  statusEl.textContent = 'Monitoring your neighborhood…';
  toast('Hazard alerts enabled — watching AQI within 1 km.');
  scanForHazards(true);
}

/* ============================ PDF export =========================== */
function downloadReport() {
  if (!state.userPos) return toast('Location not ready yet — try again in a moment.', true);
  const url = `/api/export-report?lat=${state.userPos.lat}&lng=${state.userPos.lng}&timeOfDay=${state.timeOfDay}`;
  const a = document.createElement('a');
  a.href = url;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('Generating your PDF report…');
}

/* ============================ geolocation ========================== */
function initGeolocation() {
  const overlay = $('loading-overlay');
  const finish = (pos, message) => {
    setUserPos(pos);
    overlay.classList.add('hidden');
    state.map.invalidateSize();
    fetchData();
    if (message) toast(message, true);
  };

  if (!('geolocation' in navigator)) {
    finish(DEFAULT_POS, 'Geolocation unsupported — showing demo data for New York.');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (p) => finish({ lat: p.coords.latitude, lng: p.coords.longitude }),
    (err) => {
      console.warn('Geolocation failed:', err.message);
      finish(DEFAULT_POS, 'Location unavailable — showing demo data for New York.');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

/* ============================== wiring ============================= */
function setView(view) {
  state.view = view;
  $('view-aqi').classList.toggle('active', view === 'aqi');
  $('view-noise').classList.toggle('active', view === 'noise');
  if (state.data) renderData(); // re-render existing data, no refetch
}

function wireUi() {
  const slider = $('time-slider');
  slider.value = state.timeOfDay;
  $('time-label').textContent = `${pad2(state.timeOfDay)}:00`;

  // 'input' → live label; 'change' → refetch only when the drag ends.
  slider.addEventListener('input', () => {
    state.timeOfDay = Number(slider.value);
    $('time-label').textContent = `${pad2(state.timeOfDay)}:00`;
  });
  slider.addEventListener('change', () => fetchData());

  $('view-aqi').addEventListener('click', () => setView('aqi'));
  $('view-noise').addEventListener('click', () => setView('noise'));
  $('download-report-btn').addEventListener('click', downloadReport);
  $('alerts-toggle').addEventListener('change', onAlertToggle);
}

initMap();
wireUi();
initGeolocation();
