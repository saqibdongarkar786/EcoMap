'use strict';

/**
 * EcoMap — Localized Air & Noise Pollution Dashboard (Backend)
 * Serves /public + two API routes:
 *   GET /api/pollution-data?lat&lng&timeOfDay  → JSON sensor nodes
 *   GET /api/export-report?lat&lng&timeOfDay   → PDF download
 *
 * Sensor data is DETERMINISTIC: the same coordinates + hour always
 * produce the same node set, so the map and the PDF always agree.
 */

const express = require('express');
const path = require('path');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;

/* ----------------------------- helpers ----------------------------- */

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** Deterministic PRNG (mulberry32). Same seed → same number sequence. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash mixing coordinates (~11 m precision) with hour of day. */
function hashSeed(lat, lng, hour) {
  const latI = Math.round(lat * 1e4);
  const lngI = Math.round(lng * 1e4);
  return ((latI * 374761393 + lngI * 668265263) ^ (hour * 1274126177)) >>> 0;
}

/** Smooth night-time lull: deep quiet before 06:00, calm late evening. */
function nightFactor(hour) {
  if (hour <= 5) return 0.62;
  if (hour <= 7) return 0.62 + (1 - 0.62) * ((hour - 5) / 2); // dawn ramp 5→7
  if (hour >= 22) return 0.72;
  if (hour >= 20) return 1 - (1 - 0.72) * ((hour - 20) / 2);  // evening ramp 20→22
  return 1;
}

/** Gaussian rush-hour spikes centred on 08:00 and 18:00. */
function rushFactor(hour) {
  const spike = (mu) => Math.exp(-((hour - mu) ** 2) / (2 * 1.25 ** 2));
  return 1 + 0.55 * spike(8) + 0.6 * spike(18);
}

const trafficFactor = (hour) => nightFactor(hour) * rushFactor(hour);

/** AQI severity bucket (PDF-friendly dark colors). */
function aqiStatus(aqi) {
  if (aqi <= 50) return { label: 'Good', color: '#1B7A3D' };
  if (aqi <= 100) return { label: 'Moderate', color: '#8A6D00' };
  if (aqi <= 150) return { label: 'Poor (USG)', color: '#B45309' };
  if (aqi <= 200) return { label: 'Unhealthy', color: '#B91C1C' };
  if (aqi <= 300) return { label: 'Very Unhealthy', color: '#6D28D9' };
  return { label: 'Hazardous', color: '#7F1D1D' };
}

const PLACE_A = ['Maple', 'Cedar', 'Riverside', 'Old Mill', 'Hillcrest', 'Lakeside', 'Harbor', 'Beacon', 'Juniper', 'Granite'];
const PLACE_B = ['Junction', 'Park', 'Avenue', 'School Zone', 'Bridge', 'Market', 'Depot', 'Gardens', 'Crossing', 'Lane'];

/**
 * Generate 6–8 sensor nodes clustered within ~250 m – 2.5 km of (lat, lng).
 * AQI and noise are modulated by the time of day (rush hours spike both).
 */
function generateSensors(lat, lng, hour) {
  const rand = mulberry32(hashSeed(lat, lng, hour));
  const count = 6 + Math.floor(rand() * 3); // 6–8 nodes
  const factor = trafficFactor(hour);
  const latRad = (lat * Math.PI) / 180;

  const sensors = [];
  for (let i = 0; i < count; i++) {
    const angle = rand() * Math.PI * 2;
    const dist = 250 + rand() * 2250;                 // meters from the user
    const isMainRoad = rand() < 0.35;                 // arterial roads run hotter
    const microBias = 0.85 + rand() * 0.3;            // 0.85–1.15 local variation
    const roadBias = isMainRoad ? 1.35 : microBias;

    const aqi = clamp(Math.round((28 + rand() * 115) * factor * roadBias), 8, 340);
    const noise = Math.round(
      clamp((40 + rand() * 22) * (0.8 + 0.3 * factor) * (isMainRoad ? 1.12 : 0.9), 32, 105) * 10
    ) / 10;

    const name = `Node ${String.fromCharCode(65 + i)} · ${PLACE_A[Math.floor(rand() * PLACE_A.length)]} ${PLACE_B[Math.floor(rand() * PLACE_B.length)]}`;

    sensors.push({
      id: `N${i + 1}`,
      name,
      lat: +(lat + (dist * Math.cos(angle)) / 111320).toFixed(6),
      lng: +(lng + (dist * Math.sin(angle)) / (111320 * Math.cos(latRad))).toFixed(6),
      aqi,
      noise,
      isMainRoad,
      distance: Math.round(dist),
    });
  }
  return sensors.sort((a, b) => a.distance - b.distance);
}

/* --------------------------- validation ---------------------------- */

function parseCoords(query) {
  const lat = parseFloat(query.lat);
  const lng = parseFloat(query.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function parseHour(query) {
  const h = parseInt(query.timeOfDay, 10);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : new Date().getHours();
}

/* ------------------------------ routes ----------------------------- */

app.use(express.static(path.join(__dirname, 'public')));

/* Endpoint 1 — JSON pollution data */
app.get('/api/pollution-data', (req, res) => {
  const coords = parseCoords(req.query);
  if (!coords) {
    return res.status(400).json({ error: 'Invalid or missing "lat"/"lng" query parameters.' });
  }
  const hour = parseHour(req.query);
  const sensors = generateSensors(coords.lat, coords.lng, hour);

  res.json({
    center: coords,
    timeOfDay: hour,
    generatedAt: new Date().toISOString(),
    sensors,
  });
});

/* Endpoint 2 — PDF export (streams straight to the response) */
const PAGE_LEFT = 50;
const RIGHT_EDGE = 545;           // A4 width 595 − 50 margin
const TABLE_WIDTH = RIGHT_EDGE - PAGE_LEFT; // 495
const ROW_H = 22;
const HEADER_H = 26;

const COLUMNS = [
  { x: PAGE_LEFT,       w: 48,  label: 'Node',       align: 'left' },
  { x: PAGE_LEFT + 48,  w: 158, label: 'Location',   align: 'left' },
  { x: PAGE_LEFT + 206, w: 68,  label: 'Dist (km)',  align: 'right' },
  { x: PAGE_LEFT + 274, w: 52,  label: 'AQI',        align: 'right' },
  { x: PAGE_LEFT + 326, w: 96,  label: 'Status',     align: 'left' },
  { x: PAGE_LEFT + 422, w: 73,  label: 'Noise (dB)', align: 'right' },
];

const fit = (s, maxChars) => (s.length > maxChars ? s.slice(0, maxChars - 1) + '…' : s);

function drawTableHeader(doc, y) {
  doc.rect(PAGE_LEFT, y, TABLE_WIDTH, HEADER_H).fill('#14532D');
  COLUMNS.forEach((c) => {
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8.5)
      .text(c.label, c.x + 6, y + 9, { width: c.w - 12, align: c.align, lineBreak: false });
  });
}

function drawRow(doc, y, cells, stripe) {
  doc.rect(PAGE_LEFT, y, TABLE_WIDTH, ROW_H).fill(stripe ? '#F0F5F1' : '#FFFFFF');
  COLUMNS.forEach((c, i) => {
    const cell = cells[i];
    doc.fillColor(cell.color || '#1F2937')
      .font(cell.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
      .text(cell.text, c.x + 6, y + 7, { width: c.w - 12, align: c.align, lineBreak: false });
  });
}

app.get('/api/export-report', (req, res) => {
  const coords = parseCoords(req.query);
  if (!coords) {
    return res.status(400).json({ error: 'Invalid or missing "lat"/"lng" query parameters.' });
  }
  const hour = parseHour(req.query);
  const { lat, lng } = coords;
  const sensors = generateSensors(lat, lng, hour);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="EcoMap-Report_${lat.toFixed(4)}_${lng.toFixed(4)}.pdf"`
  );

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 50, bottom: 50, left: PAGE_LEFT, right: 50 },
    info: { Title: 'Neighborhood Environmental Report', Author: 'EcoMap' },
  });

  // If the client cancels the download mid-stream, stop writing to the dead
  // socket instead of letting an unhandled EPIPE crash the process.
  let closed = false;
  const cleanup = () => {
    if (!closed) {
      closed = true;
      if (typeof doc.destroy === 'function') doc.destroy();
    }
  };
  res.on('close', () => { if (!res.writableEnded) cleanup(); });
  doc.on('error', (err) => {
    console.error('[PDF] generation failed:', err.message);
    cleanup();
    if (!res.headersSent) res.status(500).end();
    else res.destroy();
  });

  doc.pipe(res);

  /* ---------- title ---------- */
  let y = 50;
  doc.fillColor('#64748B').font('Helvetica').fontSize(8.5)
    .text('ECOMAP  ·  LOCAL ENVIRONMENTAL MONITORING  ·  SIMULATED SENSOR NETWORK', PAGE_LEFT, y, { lineBreak: false });
  y += 18;
  doc.fillColor('#14532D').font('Helvetica-Bold').fontSize(20)
    .text('Neighborhood Environmental Report', PAGE_LEFT, y, { lineBreak: false });
  y += 26;
  doc.moveTo(PAGE_LEFT, y).lineTo(RIGHT_EDGE, y).lineWidth(1.5).strokeColor('#14532D').stroke();
  y += 16;

  /* ---------- meta ---------- */
  const isRush = [7, 8, 9, 17, 18, 19].includes(hour);
  const meta = [
    ['Generated', new Date().toLocaleString()],
    ['Center coordinates', `${lat.toFixed(5)}°, ${lng.toFixed(5)}°`],
    ['Time of day', `${String(hour).padStart(2, '0')}:00${isRush ? '  (rush hour — elevated readings)' : ''}`],
    ['Sensor nodes', `${sensors.length} nodes within 2.5 km of the center`],
  ];
  meta.forEach(([label, value]) => {
    doc.fillColor('#64748B').font('Helvetica').fontSize(9)
      .text(label, PAGE_LEFT, y, { width: 150, lineBreak: false });
    doc.fillColor('#111827').font('Helvetica-Bold').fontSize(9)
      .text(value, PAGE_LEFT + 150, y, { width: 345, lineBreak: false });
    y += 15;
  });

  /* ---------- summary boxes ---------- */
  const avgAqi = Math.round(sensors.reduce((s, n) => s + n.aqi, 0) / sensors.length);
  const peakAqi = Math.max(...sensors.map((n) => n.aqi));
  const avgNoise = (sensors.reduce((s, n) => s + n.noise, 0) / sensors.length).toFixed(1);
  const peakNoise = Math.max(...sensors.map((n) => n.noise)).toFixed(1);

  y += 8;
  const boxes = [
    { label: 'AVERAGE AQI', value: String(avgAqi), color: aqiStatus(avgAqi).color },
    { label: 'PEAK AQI', value: String(peakAqi), color: aqiStatus(peakAqi).color },
    { label: 'AVERAGE NOISE', value: `${avgNoise} dB`, color: '#0F766E' },
    { label: 'PEAK NOISE', value: `${peakNoise} dB`, color: '#B91C1C' },
  ];
  const boxW = 114, boxGap = 13, boxH = 46;
  boxes.forEach((b, i) => {
    const bx = PAGE_LEFT + i * (boxW + boxGap);
    doc.rect(bx, y, boxW, boxH).fill('#F0F5F1');
    doc.fillColor('#64748B').font('Helvetica-Bold').fontSize(7.5)
      .text(b.label, bx + 8, y + 8, { width: boxW - 16, lineBreak: false });
    doc.fillColor(b.color).font('Helvetica-Bold').fontSize(15)
      .text(b.value, bx + 8, y + 22, { width: boxW - 16, lineBreak: false });
  });
  y += boxH + 22;

  /* ---------- node table ---------- */
  doc.fillColor('#14532D').font('Helvetica-Bold').fontSize(10)
    .text('SURROUNDING SENSOR NODES', PAGE_LEFT, y, { lineBreak: false });
  y += 12;
  drawTableHeader(doc, y);
  y += HEADER_H;

  sensors.forEach((s, i) => {
    if (y + ROW_H > doc.page.height - 60) {          // paginate gracefully
      doc.addPage();
      y = doc.page.margins.top;
      drawTableHeader(doc, y);
      y += HEADER_H;
    }
    const stripe = i % 2 === 1;
    const status = aqiStatus(s.aqi);
    drawRow(doc, y, [
      { text: s.id, bold: true },
      { text: fit(s.name, 30) },
      { text: (s.distance / 1000).toFixed(2) },
      { text: String(s.aqi), color: status.color, bold: true },
      { text: status.label, color: status.color },
      { text: `${s.noise.toFixed(1)} dB` },
    ], stripe);
    y += ROW_H;
  });

  /* ---------- footer ---------- */
  y += 18;
  doc.fillColor('#94A3B8').font('Helvetica-Oblique').fontSize(8)
    .text('All readings are simulated for demonstration purposes and do not reflect real-world measurements.', PAGE_LEFT, y, { width: TABLE_WIDTH, lineBreak: false });
  y += 14;
  doc.fillColor('#94A3B8').font('Helvetica').fontSize(8)
    .text(`Generated by EcoMap · ${new Date().toISOString()}`, PAGE_LEFT, y, { lineBreak: false });

  doc.end();
});

/* ------------------------------ boot ------------------------------- */

app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` }));

app.listen(PORT, () => {
  console.log(`\n  🌍 EcoMap running →  http://localhost:${PORT}\n`);
});
