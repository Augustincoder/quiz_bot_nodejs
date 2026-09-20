'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const edupageService = require('../src/services/edupageService');

// ─── Dimensions & Geometry ───────────────────────────────────────────────────
const SVG_W   = 2970;
const DAY_W   = 230;
const TITLE_H = 200;
const HDR_H   = 190;
const CELL_H  = 340;
const MARGIN  = 14;

const TIMES = [
  '08:30–09:50', '10:00–11:20', '11:30–12:50', '13:30–14:50',
  '15:00–16:20', '16:30–17:50', '18:00–19:20', '19:30–20:50',
];
const DAY_NAMES = ['Dush', 'Sesh', 'Chor', 'Pay', 'Juma', 'Shan'];

// ─── Text Helpers ────────────────────────────────────────────────────────────
function escapeXml(unsafe) {
  if (!unsafe) return '';
  return unsafe.toString().replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}

function cleanSubjectTitle(subject) {
  if (!subject) return '';
  return subject
    .replace(/\s*\((Ma['ʼ`]?ruza|Maruza|Seminar|Amaliy|Laboratoriya|Lab|Sem|Ma|Lk|Pr|Amal)\)\s*/gi, '')
    .replace(/\s*\((Ma'naviyat|Manaviyat)\)\s*/gi, '')
    .trim();
}

function wrapText(text, maxChars) {
  if (!text) return [];
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const safe = word.length > maxChars ? word.slice(0, maxChars - 1) + '…' : word;
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

function formatTeacherName(name) {
  if (!name) return '';
  const teachers = name.split(',').map(t => t.trim()).filter(Boolean);
  const formatted = teachers.map(t => {
    const parts = t.split(/\s+/);
    if (parts.length >= 2) {
      return `${parts[0]} ${parts[1][0]}.`;
    }
    return t.length > 14 ? t.slice(0, 13) + '…' : t;
  });
  const result = formatted.join(', ');
  return result.length > 24 ? result.slice(0, 23) + '…' : result;
}

function wrapSubjectText(text, cardW) {
  const maxChars = Math.floor((cardW - 48) / 23);
  let lines = wrapText(text, maxChars);
  let fSize = 46;
  if (lines.length === 1) {
    fSize = 48;
  } else if (lines.length === 2) {
    fSize = 42;
  } else if (lines.length >= 3) {
    fSize = 36;
    if (lines.length > 3) {
      lines = lines.slice(0, 3);
      lines[2] = lines[2].replace(/[.,;: ]+$/, '') + '…';
    }
  }
  return { lines, fSize };
}

// ─── UPGRADED ROOM BANNER (Increased font size with dynamic width scaling) ──
function formatRoomBanner(rawRoom, cardW = 400) {
  let room = (rawRoom || '').trim();
  room = room.replace(/\s*\(?(maruza|seminar|amaliy|lab)\)?\s*/gi, '').trim();

  let label = (!room || room === '?') ? 'XONA: ANIQMAS' : `XONA: ${room}`;

  if (/^(xona|bochka|\d+-bochka)/i.test(room)) {
    label = room.toUpperCase();
  }

  let fontSize = 42;
  const safeW = cardW - 48;

  const charRatio = 0.62;
  while (fontSize > 20 && (label.length * fontSize * charRatio) > safeW) {
    fontSize -= 1;
  }

  if ((label.length * fontSize * charRatio) > safeW) {
    const maxChars = Math.floor(safeW / (fontSize * charRatio));
    label = label.slice(0, Math.max(6, maxChars - 1)) + '…';
  }

  const letterSpacing = fontSize >= 36 ? '1.5px' : '0.5px';

  return { label, fontSize, letterSpacing };
}

function getLessonType(subject) {
  if (!subject) return 'other';
  if (/\(Ma\)/i.test(subject) || /\(Lk\)/i.test(subject) || /ma['ʼ`]?ruza/i.test(subject) || /lek[ts]iya/i.test(subject)) return 'lecture';
  if (/\(Sem\)/i.test(subject) || /\(Pr\)/i.test(subject) || /\(Amal\)/i.test(subject) || /seminar/i.test(subject) || /amaliy/i.test(subject) || /praktika/i.test(subject)) return 'seminar';
  if (/\(Lab\)/i.test(subject) || /laboratoriya/i.test(subject)) return 'lab';
  return 'other';
}

function getBaseSubject(subject) {
  return (subject || '')
    .replace(/\s*\((Ma['ʼ`]?ruza|Maruza|Seminar|Amaliy|Laboratoriya|Lab|Sem|Ma|Lk|Pr|Amal)\)\s*/gi, '')
    .replace(/\s*\(.*?\)\s*/g, '')
    .trim()
    .toLowerCase();
}

// ─── High Contrast Palettes ──────────────────────────────────────────────────
const PALETTES = [
  // 1. Blue
  {
    name: 'Blue',
    lecture: {
      bg: '#0F1E36', border: '#1E40AF', subjText: '#FFFFFF',
      accent: '#93C5FD', tagBg: '#1D4ED8', tagText: '#FFFFFF',
      roomBg: '#1D4ED8', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#172E54', border: '#60A5FA', subjText: '#F0F9FF',
      accent: '#BFDBFE', tagBg: '#60A5FA', tagText: '#082F49',
      roomBg: '#38BDF8', roomText: '#082F49',
    },
  },
  // 2. Emerald
  {
    name: 'Emerald',
    lecture: {
      bg: '#06261C', border: '#047857', subjText: '#FFFFFF',
      accent: '#6EE7B7', tagBg: '#047857', tagText: '#FFFFFF',
      roomBg: '#047857', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#0B3B2C', border: '#34D399', subjText: '#ECFDF5',
      accent: '#A7F3D0', tagBg: '#34D399', tagText: '#022C22',
      roomBg: '#34D399', roomText: '#022C22',
    },
  },
  // 3. Violet
  {
    name: 'Violet',
    lecture: {
      bg: '#1E1538', border: '#6D28D9', subjText: '#FFFFFF',
      accent: '#C4B5FD', tagBg: '#6D28D9', tagText: '#FFFFFF',
      roomBg: '#6D28D9', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#2E1E54', border: '#A78BFA', subjText: '#F5F3FF',
      accent: '#DDD6FE', tagBg: '#A78BFA', tagText: '#2E1065',
      roomBg: '#A78BFA', roomText: '#2E1065',
    },
  },
  // 4. Amber
  {
    name: 'Amber',
    lecture: {
      bg: '#261B07', border: '#B45309', subjText: '#FFFFFF',
      accent: '#FCD34D', tagBg: '#B45309', tagText: '#FFFFFF',
      roomBg: '#B45309', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#3D2A0A', border: '#FBBF24', subjText: '#FFFBEB',
      accent: '#FDE68A', tagBg: '#FBBF24', tagText: '#451A03',
      roomBg: '#FBBF24', roomText: '#451A03',
    },
  },
  // 5. Rose
  {
    name: 'Rose',
    lecture: {
      bg: '#2A0D18', border: '#BE123C', subjText: '#FFFFFF',
      accent: '#FDA4AF', tagBg: '#BE123C', tagText: '#FFFFFF',
      roomBg: '#BE123C', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#441426', border: '#FB7185', subjText: '#FFF1F2',
      accent: '#FECDD3', tagBg: '#FB7185', tagText: '#4C0519',
      roomBg: '#FB7185', roomText: '#4C0519',
    },
  },
  // 6. Teal
  {
    name: 'Teal',
    lecture: {
      bg: '#082424', border: '#0F766E', subjText: '#FFFFFF',
      accent: '#5EEAD4', tagBg: '#0F766E', tagText: '#FFFFFF',
      roomBg: '#0F766E', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#0E3B3B', border: '#2DD4BF', subjText: '#F0FDFA',
      accent: '#99F6E4', tagBg: '#2DD4BF', tagText: '#042F2E',
      roomBg: '#2DD4BF', roomText: '#042F2E',
    },
  },
];

// ─── CARD BUILDER (With increased teacher size 30 & room size 44) ────────────
function buildCardSvg(lesson, baseX, baseY, span, cellW, colorSet) {
  const cardW = cellW * span - MARGIN * 2;
  const cardH = CELL_H - MARGIN * 2;
  const cardX = baseX + MARGIN;
  const cardY = baseY + MARGIN;

  const rawSubj = lesson.subject || '';
  const cleanSubj = cleanSubjectTitle(rawSubj);
  const subj = escapeXml(cleanSubj);
  const teacher = escapeXml(formatTeacherName(lesson.teacher));
  const isLecture = colorSet.type === 'lecture';

  // 1. Subject text
  const { lines: subjLines, fSize } = wrapSubjectText(subj, cardW);

  // 2. Room banner (UPGRADED FONT SIZE with safe width containment)
  const rawRoom = (lesson.room || '?').trim();
  const { label: roomLabel, fontSize: roomFontSize, letterSpacing: roomLetterSpacing } = formatRoomBanner(rawRoom, cardW);
  const bannerH = 70;
  const bannerY = cardY + cardH - bannerH;

  // 3. Format badge & Teacher layout (No overlap guarantee)
  const tagW = isLecture ? 130 : 120;
  const tagH = 36;
  const tagLabel = isLecture ? "MA'RUZA" : "SEMINAR";

  let teacherStr = teacher;
  let teacherFontSize = 29;
  const maxTeacherW = cardW - 20 - tagW - 24 - 20;
  while (teacherFontSize > 20 && (teacherStr.length * teacherFontSize * 0.58) > maxTeacherW) {
    teacherFontSize -= 1;
  }
  if ((teacherStr.length * teacherFontSize * 0.58) > maxTeacherW) {
    const maxChars = Math.floor(maxTeacherW / (teacherFontSize * 0.58));
    teacherStr = teacherStr.slice(0, Math.max(4, maxChars - 1)) + '…';
  }

  const topZoneY = cardY + 16 + tagH;
  const availableH = bannerY - topZoneY - 14;
  const totalTextH = subjLines.length * (fSize * 1.18);
  const textStartY = Math.round(topZoneY + (availableH - totalTextH) / 2 + fSize * 0.85);

  return `
    <g filter="url(#shadow-card)">
      <!-- Card Base -->
      <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="22" ry="22"
            fill="${colorSet.bg}" stroke="${colorSet.border}" stroke-width="2.5"></rect>

      <!-- Lesson Format Badge (Priority #3) -->
      <rect x="${cardX + 20}" y="${cardY + 16}" width="${tagW}" height="${tagH}" rx="10" fill="${colorSet.tagBg}"></rect>
      <text x="${cardX + 20 + tagW / 2}" y="${cardY + 16 + tagH / 2 + 1}"
            font-size="20" font-weight="900" letter-spacing="1px"
            text-anchor="middle" dominant-baseline="central" fill="${colorSet.tagText}">${tagLabel}</text>

      <!-- Teacher Name (UPGRADED: font-size 29, dynamically scaled to avoid overlap) -->
      ${teacherStr ? `
      <text x="${cardX + cardW - 20}" y="${cardY + 16 + tagH / 2 + 1}"
            font-size="${teacherFontSize}" font-weight="800" text-anchor="end" dominant-baseline="central"
            fill="${colorSet.accent}">${teacherStr}</text>
      ` : ''}

      <!-- Subject Name (Priority #2) -->
      <g transform="translate(${cardX + 22}, 0)">
        ${subjLines.map((l, idx) => `
          <text x="0" y="${textStartY + idx * Math.round(fSize * 1.18)}"
                font-size="${fSize}" font-weight="900"
                fill="${colorSet.subjText}">${l}</text>
        `).join('')}
      </g>

      <!-- Signature Full-Width Bottom Banner: ROOM NUMBER (Priority #1) -->
      <path d="M ${cardX} ${bannerY}
               L ${cardX + cardW} ${bannerY}
               L ${cardX + cardW} ${cardY + cardH - 22}
               A 22 22 0 0 1 ${cardX + cardW - 22} ${cardY + cardH}
               L ${cardX + 22} ${cardY + cardH}
               A 22 22 0 0 1 ${cardX} ${cardY + cardH - 22}
               Z"
            fill="${colorSet.roomBg}"></path>

      <!-- Room Text (UPGRADED: font-size with dynamic width scaling) -->
      <text x="${cardX + cardW / 2}" y="${bannerY + bannerH / 2 + 1}"
            font-size="${roomFontSize}" font-weight="900" letter-spacing="${roomLetterSpacing}"
            text-anchor="middle" dominant-baseline="central"
            fill="${colorSet.roomText}">${escapeXml(roomLabel)}</text>
    </g>
  `;
}

// ─── SVG Generator with Custom Font Family ───────────────────────────────────
function buildSvgWithFont(className, schedule, fontFamily) {
  let maxPeriod = 0;
  for (let d = 0; d < 6; d++) {
    if (!schedule[d]) continue;
    for (let p = 1; p <= 8; p++) {
      if (schedule[d][p] && schedule[d][p].length > 0) maxPeriod = Math.max(maxPeriod, p);
    }
  }
  if (maxPeriod === 0) maxPeriod = 5;

  const activeDays = [];
  for (let d = 0; d < 6; d++) {
    if (!schedule[d]) continue;
    let hasLesson = false;
    for (let p = 1; p <= maxPeriod; p++) {
      if (schedule[d][p] && schedule[d][p].length > 0) { hasLesson = true; break; }
    }
    if (hasLesson) activeDays.push(d);
  }
  const numRows = activeDays.length;

  const CONTENT_W = SVG_W - DAY_W;
  const cellW     = CONTENT_W / maxPeriod;
  const gridY     = TITLE_H + HDR_H;
  const svgH      = gridY + numRows * CELL_H + 40;

  const baseColorMap = {};
  let colorCounter = 0;

  function resolveColors(lesson) {
    const base = getBaseSubject(lesson.subject || '');
    if (!(base in baseColorMap)) {
      baseColorMap[base] = colorCounter % PALETTES.length;
      colorCounter++;
    }
    const pal = PALETTES[baseColorMap[base]];
    const type = getLessonType(lesson.subject);
    const colorSet = type === 'seminar' ? pal.seminar : pal.lecture;
    return { ...colorSet, type };
  }

  // Header periods
  let headerHtml = '';
  for (let i = 0; i < maxPeriod; i++) {
    const bx = DAY_W + i * cellW;
    const midX = bx + cellW / 2;
    if (i > 0) {
      headerHtml += `<line x1="${bx}" y1="${TITLE_H}" x2="${bx}" y2="${gridY}" stroke="#1E293B" stroke-width="2"></line>`;
    }
    const cy = TITLE_H + 70;
    headerHtml += `<circle cx="${midX}" cy="${cy}" r="44" fill="#38BDF8"></circle>`;
    headerHtml += `<text font-size="52" font-weight="900" text-anchor="middle" dominant-baseline="central" x="${midX}" y="${cy + 1}" fill="#082F49">${i + 1}</text>`;
    headerHtml += `<text font-size="38" font-weight="700" text-anchor="middle" dominant-baseline="auto" x="${midX}" y="${TITLE_H + HDR_H - 26}" fill="#F1F5F9">${TIMES[i]}</text>`;
  }

  // Day labels
  let dayLabelsHtml = '';
  activeDays.forEach((dayIdx, rowIdx) => {
    const by = gridY + rowIdx * CELL_H;
    const midY = by + CELL_H / 2;
    if (rowIdx > 0) {
      dayLabelsHtml += `<line x1="0" y1="${by}" x2="${SVG_W}" y2="${by}" stroke="#1E293B" stroke-width="2"></line>`;
    }
    const dotColors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#06B6D4'];
    dayLabelsHtml += `<circle cx="36" cy="${midY}" r="14" fill="${dotColors[dayIdx]}"></circle>`;
    dayLabelsHtml += `<text font-size="58" font-weight="900" text-anchor="middle" dominant-baseline="central" x="${DAY_W / 2 + 16}" y="${midY}" fill="#FFFFFF">${DAY_NAMES[dayIdx]}</text>`;
  });

  // Zebra column stripes
  let zebraHtml = '';
  for (let i = 0; i < maxPeriod; i++) {
    const bx = DAY_W + i * cellW;
    const bg = i % 2 === 0 ? '#0F172A' : '#141E33';
    zebraHtml += `<rect x="${bx}" y="${TITLE_H}" width="${cellW}" height="${HDR_H + numRows * CELL_H}" fill="${bg}"></rect>`;
  }

  // Cards layout
  let cardsHtml = '';
  for (const [rowIdx, dayIdx] of activeDays.entries()) {
    if (!schedule[dayIdx]) continue;
    const baseY = gridY + rowIdx * CELL_H;

    let pNum = 1;
    while (pNum <= maxPeriod) {
      const lessons = schedule[dayIdx][pNum];
      if (!lessons || lessons.length === 0) { pNum++; continue; }

      const lesson = lessons[0];
      const subjLower = (lesson.subject || '').toLowerCase();
      let span = (lesson.weight > 1) ? lesson.weight : 1;

      if (subjLower.includes('jismoniy madaniyat') || subjLower.includes('jismoniy tarbiya')) {
        span = 2;
      }

      if (span === 1) {
        while (pNum + span <= maxPeriod) {
          const nxt = schedule[dayIdx][pNum + span];
          if (nxt && nxt.length > 0 && nxt[0].subject === lesson.subject && nxt[0].teacher === lesson.teacher) {
            span++;
          } else break;
        }
      }
      if (pNum + span - 1 > maxPeriod) span = maxPeriod - pNum + 1;

      const baseX = DAY_W + (pNum - 1) * cellW;
      const c = resolveColors(lesson);

      const combinedLesson = lessons.length > 1 ? {
        ...lesson,
        room: [...new Set(lessons.map(l => l.room).filter(Boolean))].join(', ') || lesson.room,
        teacher: [...new Set(lessons.map(l => l.teacher).filter(Boolean))].join(', ') || lesson.teacher,
      } : lesson;

      cardsHtml += buildCardSvg(combinedLesson, baseX, baseY, span, cellW, c);
      pNum += span;
    }
  }

  return `
<svg width="${SVG_W}" height="${svgH}" viewBox="0 0 ${SVG_W} ${svgH}"
     xmlns="http://www.w3.org/2000/svg"
     style="background-color: #0B0F19; font-family: ${fontFamily};">
  <defs>
    <filter id="shadow-card" x="-4%" y="-4%" width="112%" height="118%">
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#000000" flood-opacity="0.65"/>
    </filter>
    <filter id="shadow-title" x="-1%" y="-5%" width="104%" height="130%">
      <feDropShadow dx="0" dy="6" stdDeviation="12" flood-color="#000000" flood-opacity="0.7"/>
    </filter>
  </defs>

  <rect x="0" y="0" width="${SVG_W}" height="${svgH}" fill="#0B0F19"></rect>
  ${zebraHtml}
  <rect x="0" y="${TITLE_H}" width="${DAY_W}" height="${HDR_H + numRows * CELL_H}" fill="#0B0F19"></rect>

  <rect x="0" y="0" width="${SVG_W}" height="${TITLE_H}" fill="#111827" filter="url(#shadow-title)"></rect>
  <rect x="0" y="0" width="14" height="${TITLE_H}" fill="#38BDF8"></rect>

  <text font-size="88" font-weight="900" letter-spacing="3px"
        text-anchor="middle" dominant-baseline="central"
        x="${SVG_W / 2}" y="${TITLE_H / 2 - 18}" fill="#FFFFFF">${escapeXml(className)} — HAFTALIK DARS JADVALI</text>
  <text font-size="28" font-weight="800" letter-spacing="4px"
        text-anchor="middle" dominant-baseline="central"
        x="${SVG_W / 2}" y="${TITLE_H / 2 + 42}" fill="#38BDF8">TOSHKENT DAVLAT IQTISODIYOT UNIVERSITETI • RASMIY DARS JADVALI</text>

  ${headerHtml}
  ${dayLabelsHtml}

  <line x1="${DAY_W}" y1="${TITLE_H}" x2="${DAY_W}" y2="${svgH}" stroke="#1E293B" stroke-width="3"></line>
  <line x1="0" y1="${gridY}" x2="${SVG_W}" y2="${gridY}" stroke="#1E293B" stroke-width="3"></line>

  ${cardsHtml}

  <rect x="0" y="0" width="${SVG_W}" height="${svgH}" fill="none" stroke="#1E293B" stroke-width="4"></rect>
</svg>
  `;
}

// ─── Font Variations to Compare ──────────────────────────────────────────────
const FONT_OPTIONS = [
  {
    id: 'font_1_inter',
    name: '1. Inter (Tavsiya etiladi)',
    family: "'Inter', sans-serif",
    desc: "Dunyoning #1 raqamli UI shrifti (Apple, Figma, Linear). O'ta toza, zamonaviy, baland x-height, mukammal o'qiluvchanlik.",
  },
  {
    id: 'font_2_montserrat',
    name: '2. Montserrat',
    family: "'Montserrat', sans-serif",
    desc: "Geometrik, dadil, nufuzli Yevropa universitetlari uslubidagi premium shrift. Sarlavhalar va raqamlar juda kuchli ko'rinadi.",
  },
  {
    id: 'font_3_space_grotesk',
    name: '3. Space Grotesk',
    family: "'Space Grotesk', sans-serif",
    desc: "Ultra-zamonaviy, texnologik, o'ziga xos neo-grotesk xarakter. Juda yorqin va trenddagi dizayn.",
  },
  {
    id: 'font_4_ubuntu_sans',
    name: '4. Ubuntu Sans',
    family: "'Ubuntu Sans', 'Ubuntu', sans-serif",
    desc: "Yumshoq, insoniy va qulay chiziqlar. Ko'zni toliqtirmaydigan samimiy va toza ko'rinish.",
  },
  {
    id: 'font_5_lato',
    name: '5. Lato',
    family: "'Lato', sans-serif",
    desc: "Klassik korporativ silliqlik, nozik yarim-yumaloq burchaklar va muvozanatli professional uslub.",
  },
  {
    id: 'font_6_ibm_plex',
    name: '6. IBM Plex Sans',
    family: "'IBM Plex Sans', sans-serif",
    desc: "Muhandislik aniqligi, o'tkir va qat'iy chiziqlar, rasmiy akademik tartib.",
  },
];

async function main() {
  const previewsDir = path.join(__dirname, '../previews');
  if (!fs.existsSync(previewsDir)) fs.mkdirSync(previewsDir, { recursive: true });

  const rawSchedule = await edupageService.getRawSchedule('BHA_51K');
  if (!rawSchedule) {
    throw new Error("BHA_51K uchun jadval topilmadi");
  }

  const generatedList = [];

  for (const font of FONT_OPTIONS) {
    console.log(`⏳ Generating with font: ${font.name}...`);
    const svgStr = buildSvgWithFont('BHA_51K', rawSchedule, font.family);
    const filename = `${font.id}.png`;
    const outPath = path.join(previewsDir, filename);

    const buf = await sharp(Buffer.from(svgStr))
      .png({
        palette: true,
        quality: 90,
        compressionLevel: 7,
        effort: 3,
      })
      .toBuffer();

    fs.writeFileSync(outPath, buf);
    const sizeKb = Math.round(buf.length / 1024);
    console.log(`✅ Saved ${filename} (${sizeKb} KB)`);

    generatedList.push({
      ...font,
      filename,
      sizeKb,
    });
  }

  const htmlGallery = `<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="UTF-8">
  <title>Dars Jadvali — Shrift Variantlari Taqqoslashi</title>
  <style>
    :root {
      --bg: #090D16;
      --card-bg: #0F172A;
      --border: #1E293B;
      --text: #F8FAFC;
      --subtext: #94A3B8;
      --accent: #38BDF8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 40px 24px 80px; }
    .header { max-width: 1300px; margin: 0 auto 40px; text-align: center; }
    .header h1 {
      font-size: 38px; font-weight: 900;
      background: linear-gradient(135deg, #38BDF8 0%, #818CF8 50%, #C084FC 100%);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 12px;
    }
    .header p { color: var(--subtext); font-size: 17px; max-width: 780px; margin: 0 auto; }
    .grid { max-width: 1500px; margin: 0 auto; display: flex; flex-direction: column; gap: 50px; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 20px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    .card-header { padding: 24px 30px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); }
    .card-title { font-size: 24px; font-weight: 800; color: #FFFFFF; }
    .card-desc { font-size: 15px; color: var(--subtext); margin-top: 6px; }
    .card-badge { background: rgba(56, 189, 248, 0.15); color: var(--accent); border: 1px solid rgba(56, 189, 248, 0.3); padding: 8px 18px; border-radius: 20px; font-size: 14px; font-weight: 700; }
    .img-wrap { padding: 16px; background: #030712; }
    .img-wrap img { width: 100%; height: auto; border-radius: 12px; display: block; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Dars Jadvali: Shrift Variantlari Namoyishi</h1>
    <p>O‘qituvchi ismi 30px ga, Xona raqami 44px ga kattalashtirildi. Quyida 6 xil zamonaviy shrift bo‘yicha natijalar keltirilgan.</p>
  </div>
  <div class="grid">
    ${generatedList.map((g) => `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">${g.name}</div>
            <div class="card-desc">${g.desc}</div>
          </div>
          <div class="card-badge">${g.family} • ${g.sizeKb} KB</div>
        </div>
        <div class="img-wrap">
          <a href="${g.filename}" target="_blank">
            <img src="${g.filename}" alt="${g.name}" loading="lazy"/>
          </a>
        </div>
      </div>
    `).join('')}
  </div>
</body>
</html>`;

  fs.writeFileSync(path.join(previewsDir, 'font_options.html'), htmlGallery, 'utf8');
  console.log('🎉 Font comparison generated in previews/font_options.html!');
}

main().catch(err => {
  console.error('Error generating font options:', err);
  process.exit(1);
});
