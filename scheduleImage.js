'use strict';
const sharp = require('sharp');

// ─── Tungi rejim (Dark Theme) uchun maxsus ranglar oilasi ────────────────────
// lecture = ochroq to'q fon, seminar = to'qroq fon
// accent = matn uchun o'ta yorqin (neon) rang (Tungi rejimda ajoyib ko'rinadi)
const COLOR_FAMILIES = [
  { lecture: '#3F1D1D', seminar: '#701A1A', accent: '#FCA5A5' }, // Qizil
  { lecture: '#064E3B', seminar: '#14532D', accent: '#6EE7B7' }, // Yashil
  { lecture: '#1E3A8A', seminar: '#172554', accent: '#93C5FD' }, // Ko'k
  { lecture: '#4C1D95', seminar: '#2E1065', accent: '#C4B5FD' }, // Binafsha
  { lecture: '#78350F', seminar: '#451A03', accent: '#FDBA74' }, // To'q sariq/Jigarrang
  { lecture: '#115E59', seminar: '#042F2E', accent: '#5EEAD4' }, // Feruza
  { lecture: '#701A75', seminar: '#4A044E', accent: '#F9A8D4' }, // Pushti
  { lecture: '#312E81', seminar: '#1E1B4B', accent: '#A5B4FC' }, // Indigo
  { lecture: '#3F6212', seminar: '#1A2E05', accent: '#BEF264' }, // Limon
  { lecture: '#164E63', seminar: '#083344', accent: '#67E8F9' }, // Havorang
];

// ─── Yordamchi funksiyalar ────────────────────────────────────────────────────
function escapeXml(unsafe) {
  if (!unsafe) return '';
  return unsafe.toString().replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<':  return '&lt;';
      case '>':  return '&gt;';
      case '&':  return '&amp;';
      case '\'': return '&apos;';
      case '"':  return '&quot;';
    }
  });
}

function wrapText(text, maxChars) {
  if (!text) return [];
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const safe      = word.length > maxChars ? word.slice(0, maxChars - 1) + '…' : word;
    const candidate = current ? `${current} ${safe}` : safe;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = safe;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function getLessonType(subject) {
  if (!subject) return 'other';
  if (/\(Ma\)/i.test(subject))  return 'lecture';
  if (/\(Sem\)/i.test(subject)) return 'seminar';
  return 'other';
}

function getBaseSubject(subject) {
  return (subject || '')
    .replace(/\s*\(Ma\)\s*/i, '')
    .replace(/\s*\(Sem\)\s*/i, '')
    .trim()
    .toLowerCase();
}

function getMaxActivePeriod(schedule) {
  let maxP = 0;
  for (let d = 0; d < 6; d++) {
    if (!schedule[d]) continue;
    for (let p = 1; p <= 8; p++) {
      if (schedule[d][p] && schedule[d][p].length > 0) maxP = Math.max(maxP, p);
    }
  }
  return maxP > 0 ? maxP : 6;
}

function getActiveDays(schedule) {
  const active = [];
  for (let d = 0; d < 6; d++) {
    if (!schedule[d]) continue;
    for (let p = 1; p <= 8; p++) {
      if (schedule[d][p] && schedule[d][p].length > 0) {
        active.push(d);
        break;
      }
    }
  }
  return active;
}

// ─── Layout konstantalari ─────────────────────────────────────────────────────
const SVG_W   = 2970;
const DAY_W   = 210;   
const TITLE_H = 210;   
const HDR_H   = 195;   // Para sarlavhalari balandligi biroz oshirildi (kattaroq shrift uchun)
const CELL_H  = 320;   
const MARGIN  = 15;    
const PAD     = 26;    

// ─── Para sarlavhalari (Vaqtlar va Raqamlar) ──────────────────────────────────
function buildHeaderSvg(maxPeriod, cellW, gridY) {
  const times = [
    '08:30–09:50', '10:00–11:20', '11:30–12:50', '13:30–14:50',
    '15:00–16:20', '16:30–17:50', '18:00–19:20', '19:30–20:50',
  ];

  let html = '';

  for (let i = 0; i < maxPeriod; i++) {
    const bx   = DAY_W + i * cellW;
    const midX = bx + cellW / 2;

    // Ustun ajratgich
    if (i > 0) {
      html += `<line x1="${bx}" y1="${TITLE_H}" x2="${bx}" y2="${gridY}"
        stroke="#334155" stroke-width="2"></line>`;
    }

    // Para raqami — doira badge
    const cy = TITLE_H + 75;
    const cr = 50;
    html += `<circle cx="${midX}" cy="${cy}" r="${cr}" fill="#3B82F6"></circle>`;
    html += `<text
      font-size="64"
      text-anchor="middle" dominant-baseline="central"
      x="${midX}" y="${cy}"
      style="font-weight: 900;
             font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
             fill: #FFFFFF;">${i + 1}</text>`;

    // Vaqt — Kattalashtirilgan va yorqinlashtirilgan
    html += `<text
      font-size="38"
      text-anchor="middle" dominant-baseline="auto"
      x="${midX}" y="${TITLE_H + HDR_H - 22}"
      style="font-weight: 600;
             font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
             fill: #E2E8F0;">${times[i]}</text>`;
  }

  return html;
}

// ─── Kun nomlari ──────────────────────────────────────────────────────────────
function buildDayLabelsSvg(activeDays, gridY) {
  const shortDays = ['Dush', 'Sesh', 'Chor', 'Pay', 'Juma', 'Shan'];
  const dotColors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899'];

  let html = '';

  activeDays.forEach((dayIdx, rowIdx) => {
    const by   = gridY + rowIdx * CELL_H;
    const midY = by + CELL_H / 2;

    // Satr ajratgichi
    if (rowIdx > 0) {
      html += `<line x1="0" y1="${by}" x2="${SVG_W}" y2="${by}"
        stroke="#1E293B" stroke-width="2"></line>`;
    }

    // Rang nuqtasi
    html += `<circle cx="30" cy="${midY}" r="12"
      fill="${dotColors[dayIdx]}" opacity="0.9"></circle>`;

    // Kun nomi (Tungi rejimga mos oq rang)
    html += `<text
      font-size="54"
      text-anchor="middle" dominant-baseline="central"
      x="${DAY_W / 2 + 12}" y="${midY}"
      style="font-weight: 800;
             font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
             fill: #F8FAFC;">${shortDays[dayIdx]}</text>`;
  });

  return html;
}

// ─── Bitta dars kartasi ───────────────────────────────────────────────────────
function buildCardSvg(lesson, baseX, baseY, span, cellW, bg, accent) {
  const subj    = escapeXml(lesson.subject || '');
  const teacher = escapeXml(lesson.teacher || '');
  const room    = escapeXml(lesson.room    || '');
  const type    = getLessonType(lesson.subject);

  const cardW = cellW * span - MARGIN * 2;
  const cardH = CELL_H        - MARGIN * 2; 
  const cardX = baseX + MARGIN;
  const cardY = baseY + MARGIN;
  const midX  = cardX + cardW / 2;

  const ZONE_T  = 64; // Tepaga joy kengaytirildi (O'qituvchi yozuvi kattalashgani uchun)
  const ZONE_B  = 64; 
  const ZONE_MY = cardY + ZONE_T;
  const ZONE_MH = cardH - ZONE_T - ZONE_B;

  let html = '';

  // ── Karta asosi (Kuchli soya va to'q fon) ──────────────────────────────────
  html += `<rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}"
    rx="20" ry="20" fill="${bg}" filter="url(#card-shadow)"></rect>`;

  // Chap vertikal aksent
  const stripW = type === 'seminar' ? 10 : 6;
  html += `<rect x="${cardX + 12}" y="${cardY + 16}" width="${stripW}" height="${cardH - 32}"
    rx="4" ry="4" fill="${accent}" fill-opacity="0.8"></rect>`;

  // ── O'qituvchi ismi (Kattalashtirilgan va Aksent rangida) ─────────────────
  const tAvailW   = cardW - PAD * 2 - stripW - 14;
  const tMaxChars = Math.floor(tAvailW / 20);
  const tDisplay  = teacher.length > tMaxChars ? teacher.slice(0, tMaxChars - 1) + '…' : teacher;
  // Shrift razmerlari ancha yiriklashtirildi
  const tFSize    = teacher.length > 24 ? 30 : teacher.length > 18 ? 34 : 38;

  html += `<text
    font-size="${tFSize}"
    text-anchor="start" dominant-baseline="central"
    x="${cardX + PAD + 8}" y="${cardY + ZONE_T / 2}"
    style="font-weight: 700;
           font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
           fill: ${accent};">${tDisplay}</text>`;

  // O'qituvchi va fan nomi orasidagi ajratgich
  html += `<line x1="${cardX + PAD + 8}" y1="${ZONE_MY}"
    x2="${cardX + cardW - PAD}" y2="${ZONE_MY}"
    stroke="${accent}" stroke-width="1.5" stroke-opacity="0.3"></line>`;

  // ── Fan nomi (Oppoq va Markazlashgan) ───────────────────────────────────────
  const textAreaW  = cardW - PAD * 2;
  const getMaxC    = (fs) => Math.floor(textAreaW / (fs * 0.54));

  let sFontSize = 52;
  let lineH     = Math.round(sFontSize * 1.18);
  let subjLines = wrapText(subj, getMaxC(sFontSize));

  while (subjLines.length * lineH > ZONE_MH - 14 && sFontSize > 30) {
    sFontSize -= 2;
    lineH      = Math.round(sFontSize * 1.18);
    subjLines  = wrapText(subj, getMaxC(sFontSize));
  }

  if (subjLines.length > 4) {
    subjLines    = subjLines.slice(0, 4);
    subjLines[3] = subjLines[3].slice(0, -2) + '…';
  }

  const totalH     = (subjLines.length - 1) * lineH;
  const textStartY = ZONE_MY + ZONE_MH / 2 - totalH / 2;

  const tspans = subjLines.map((line, idx) =>
    `<tspan x="${midX}" ${idx > 0 ? `dy="${lineH}"` : ''}>${line}</tspan>`
  ).join('');

  html += `<text
    font-size="${sFontSize}"
    text-anchor="middle" dominant-baseline="central"
    y="${textStartY}"
    style="font-weight: 800;
           font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
           fill: #FFFFFF;">${tspans}</text>`;

  // ── Xona raqami (Kattalashtirilgan Badge) ────────────────────────────────────
  if (room) {
    const rFSize  = room.length > 12 ? 30 : 36; // Xona yozuvi yiriklashtirildi
    const badgeH  = 50; 
    const badgePX = 24;
    const badgeW  = Math.max(room.length * (rFSize * 0.65) + badgePX * 2, 110);
    const badgeX  = cardX + cardW - badgeW - 16;
    const badgeY  = cardY + cardH - badgeH - 12;

    html += `<rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="${badgeH}"
      rx="14" ry="14" fill="${accent}" fill-opacity="0.15"></rect>`;
    html += `<text
      font-size="${rFSize}"
      text-anchor="middle" dominant-baseline="central"
      x="${badgeX + badgeW / 2}" y="${badgeY + badgeH / 2 + 2}"
      style="font-weight: 800;
             font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
             fill: ${accent};">${room}</text>`;
  }

  return html;
}

// ─── Asosiy eksport ───────────────────────────────────────────────────────────
async function generateScheduleImage(className, schedule) {
  const maxPeriod  = getMaxActivePeriod(schedule);
  const activeDays = getActiveDays(schedule);
  const numRows    = activeDays.length;

  if (numRows === 0) throw new Error("Jadval bo'sh");

  const CONTENT_W = SVG_W - DAY_W;
  const cellW     = CONTENT_W / maxPeriod;
  const gridY     = TITLE_H + HDR_H;
  const svgH      = gridY + numRows * CELL_H + 50;

  const baseColorMap = {};
  let   colorIdx     = 0;

  function resolveColors(lesson) {
    const base = getBaseSubject(lesson.subject || '');
    if (!(base in baseColorMap)) {
      baseColorMap[base] = colorIdx % COLOR_FAMILIES.length;
      colorIdx++;
    }
    const fam  = COLOR_FAMILIES[baseColorMap[base]];
    const type = getLessonType(lesson.subject);
    const bg   = type === 'seminar' ? fam.seminar : fam.lecture;
    return { bg, accent: fam.accent };
  }

  // ── ZEBRA USTUNLARI (Para oraliqlari foni) ──────────────────────────────────
  let zebraHtml = '';
  for (let i = 0; i < maxPeriod; i++) {
    const bx = DAY_W + i * cellW;
    // Biri ochroq qora, biri to'qroq qora
    const colBg = i % 2 === 0 ? '#0F172A' : '#1E293B'; 
    zebraHtml += `<rect x="${bx}" y="${TITLE_H}" width="${cellW}" height="${HDR_H + numRows * CELL_H}" fill="${colBg}"></rect>`;
  }

  // ── Ustun ajratgichlari ─────────────────────────────────────────────────────
  let dividerHtml = '';
  for (let i = 1; i < maxPeriod; i++) {
    const x = DAY_W + i * cellW;
    dividerHtml += `<line x1="${x}" y1="${gridY}" x2="${x}" y2="${gridY + numRows * CELL_H}"
      stroke="#334155" stroke-width="2" stroke-dasharray="10,8"></line>`;
  }

  // ── Karta bloklari ──────────────────────────────────────────────────────────
  let blocksHtml  = '';
  for (const [rowIdx, dayIdx] of activeDays.entries()) {
    if (!schedule[dayIdx]) continue;
    const baseY = gridY + rowIdx * CELL_H;

    let pNum = 1;
    while (pNum <= maxPeriod) {
      const lessons = schedule[dayIdx][pNum];
      if (!lessons || lessons.length === 0) { pNum++; continue; }

      const lesson = lessons[0];
      const subjLower = (lesson.subject || '').toLowerCase(); // <--- Kichik harflarga o'tkazib olamiz
      
      let span = (lesson.weight > 1) ? lesson.weight : 1;

      // MAXSUS QOIDA: "Jismoniy madaniyat" avtomatik 2 para bo'ladi
      if (subjLower.includes('jismoniy madaniyat') || subjLower.includes('jismoniy tarbiya')) {
        span = 2;
      }

      if (span === 1) {
        while (pNum + span <= maxPeriod) {
          const nxt = schedule[dayIdx][pNum + span];
          if (nxt && nxt.length > 0 &&
              nxt[0].subject === lesson.subject &&
              nxt[0].teacher === lesson.teacher) {
            span++;
          } else break;
        }
      }
      if (pNum + span - 1 > maxPeriod) span = maxPeriod - pNum + 1;

      const baseX          = DAY_W + (pNum - 1) * cellW;
      const { bg, accent } = resolveColors(lesson);
      blocksHtml += buildCardSvg(lesson, baseX, baseY, span, cellW, bg, accent);
      pNum += span;
    }
  }

  // ── SVG yig'ish (Umumiy Tungi Rejim) ─────────────────────────────────────────
  const svgString = `
<svg width="${SVG_W}" height="${svgH}" viewBox="0 0 ${SVG_W} ${svgH}"
     xmlns="http://www.w3.org/2000/svg"
     style="background-color: #020617;">
  <defs>
    <filter id="card-shadow" x="-4%" y="-4%" width="112%" height="118%">
      <feDropShadow dx="0" dy="6" stdDeviation="8"
        flood-color="#000000" flood-opacity="0.5"/>
    </filter>
    <filter id="title-shadow" x="-1%" y="-5%" width="104%" height="130%">
      <feDropShadow dx="0" dy="5" stdDeviation="10"
        flood-color="#000000" flood-opacity="0.7"/>
    </filter>
  </defs>

  <rect x="0" y="0" width="${SVG_W}" height="${svgH}" fill="#020617"></rect>

  ${zebraHtml}

  <rect x="0" y="${TITLE_H}" width="${DAY_W}" height="${HDR_H + numRows * CELL_H}" fill="#0B1120"></rect>

  <rect x="0" y="0" width="${SVG_W}" height="${TITLE_H}" fill="#0B1120"
    filter="url(#title-shadow)"></rect>
  <rect x="0" y="0" width="12" height="${TITLE_H}" fill="#3B82F6"></rect>
  <text
    font-size="86"
    text-anchor="middle" dominant-baseline="central"
    x="${SVG_W / 2}" y="${TITLE_H / 2}"
    style="font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
           font-weight: 900;
           fill: #FFFFFF;
           letter-spacing: 3px;">${escapeXml(className)} — HAFTALIK DARS JADVALI</text>

  ${buildHeaderSvg(maxPeriod, cellW, gridY)}

  ${buildDayLabelsSvg(activeDays, gridY)}

  ${dividerHtml}

  ${blocksHtml}

  <line x1="${DAY_W}" y1="${TITLE_H}" x2="${DAY_W}" y2="${svgH}"
    stroke="#1E293B" stroke-width="4"></line>
  <line x1="0" y1="${gridY}" x2="${SVG_W}" y2="${gridY}"
    stroke="#1E293B" stroke-width="4"></line>

  <rect x="0" y="0" width="${SVG_W}" height="${svgH}"
    fill="none" stroke="#1E293B" stroke-width="4"></rect>
</svg>`;

  return sharp(Buffer.from(svgString)).png().toBuffer();
}

module.exports = { generateScheduleImage };