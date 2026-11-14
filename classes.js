/**
 * Класи повітряних цілей — серверна копія довідника.
 *
 * Фронтенд має свій розширений опис у public/js/config.js (кольори,
 * силуети, підказки). Тут лише те, що потрібно серверу для розрахунку
 * часу підльоту й підписів у Telegram.
 */
'use strict';

const CLASSES = {
  ballistic:     { label: 'Балістика',        speed: 2400, range: 500 },
  aeroballistic: { label: 'Аеробалістика',    speed: 3600, range: 2000 },
  cruise_air:    { label: 'Крилата (повітря)', speed: 750, range: 2800 },
  cruise_sea:    { label: 'Крилата (море)',   speed: 800,  range: 2500 },
  cruise_ground: { label: 'Крилата (земля)',  speed: 800,  range: 500 },
  kh22:          { label: 'Х-22 / Х-32',      speed: 1400, range: 600 },
  shahed:        { label: 'Shahed / Герань',  speed: 180,  range: 2500 },
  shahed_jet:    { label: 'Реактивний БпЛА',  speed: 550,  range: 2000 },
  kab:           { label: 'КАБ',              speed: 900,  range: 90 },
  sam:           { label: 'ЗРК по землі',     speed: 3000, range: 150 },
  recon_uav:     { label: 'Розвід. БпЛА',     speed: 120,  range: 300 },
  missile:       { label: 'Ракетна небезпека', speed: 900, range: 1500 },
  unknown:       { label: 'Невідомий тип',    speed: 400,  range: 1000 },
};

const get = (type) => CLASSES[type] || CLASSES.unknown;

const R = 6371;
const rad = (d) => (d * Math.PI) / 180;

function distKm(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const deg = (r) => (r * 180) / Math.PI;

function bearing(a, b) {
  const la1 = rad(a[0]);
  const la2 = rad(b[0]);
  const dLon = rad(b[1] - a[1]);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Точка на відстані d (км) від p за азимутом brg. */
function destination(p, brg, d) {
  const la1 = rad(p[0]);
  const lo1 = rad(p[1]);
  const t = rad(brg);
  const dr = d / R;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(dr) + Math.cos(la1) * Math.sin(dr) * Math.cos(t));
  const lo2 = lo1 + Math.atan2(Math.sin(t) * Math.sin(dr) * Math.cos(la1), Math.cos(dr) - Math.sin(la1) * Math.sin(la2));
  return [+deg(la2).toFixed(4), +(((deg(lo2) + 540) % 360) - 180).toFixed(4)];
}

/** Різниця азимутів у межах ±180°. */
function bearingDelta(a, b) {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

module.exports = { CLASSES, get, distKm, bearing, destination, bearingDelta };
