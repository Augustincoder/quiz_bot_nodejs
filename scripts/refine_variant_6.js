'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const edupageService = require('../src/services/edupageService');

// ─── Canvas Constants ────────────────────────────────────────────────────────
const SVG_W   = 2970;
const DAY_W   = 230;   // Slightly wider for prominent day names
const TITLE_H = 200;
const HDR_H   = 190;   // Taller for larger period badges & times
const CELL_H  = 340;   // Taller cell for massive room banner & subject
const MARGIN  = 14;

const TIMES = [
  '08:30–09:50', '10:00–11:20', '11:30–12:50', '13:30–14:50',
  '15:00–16:20', '16:30–17:50', '18:00–19:20', '19:30–20:50',
];
const DAY_NAMES = ['Dush', 'Sesh', 'Chor', 'Pay', 'Juma', 'Shan'];

// ─── Helpers ─────────────────────────────────────────────────────────────────
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
    .replace(/\s*\((Ma|Sem|Lab|Amal|Pr|Lk)\)\s*/gi, '')
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
  const trimmed = name.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0]} ${parts[1][0]}.`;
  }
  return trimmed.length > 16 ? trimmed.slice(0, 15) + '…' : trimmed;
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

function formatRoomBanner(rawRoom) {
  let room = (rawRoom || '?').trim();
  // Clean redundant lesson type mentions inside room text
  room = room.replace(/\s*\(?(maruza|seminar|amaliy)\)?\s*/gi, '').trim();

  let label = `XONA: ${room}`;
  let fontSize = 34;

  if (/^(xona|bochka|\d+-bochka)/i.test(room)) {
    label = room.toUpperCase();
  }

  if (label.length > 22) {
    fontSize = 24;
  } else if (label.length > 17) {
    fontSize = 28;
  } else if (label.length > 13) {
    fontSize = 31;
  }

  return { label, fontSize };
}

function getLessonType(subject) {
  if (!subject) return 'other';
  if (/\(Ma\)/i.test(subject) || /ma['ʼ`]?ruza/i.test(subject)) return 'lecture';
  if (/\(Sem\)/i.test(subject) || /seminar/i.test(subject) || /amaliy/i.test(subject)) return 'seminar';
  if (/\(Lab\)/i.test(subject) || /laboratoriya/i.test(subject)) return 'lab';
  return 'other';
}

function getBaseSubject(subject) {
  return (subject || '')
    .replace(/\s*\((Ma|Sem|Lab|Amal|Pr|Lk)\)\s*/gi, '')
    .replace(/\s*\(.*?\)\s*/g, '')
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

// ─── PALETTES DEFINITION ─────────────────────────────────────────────────────

// 1. FRESH SLATE DARK PALETTE (Tetik, jonli, yengil qorong'u rejim)
// Qoida: Ma'ruza = TO'QROQ, Seminar = SEZILARLI DARAJADA OCHROQ!
const FRESH_SLATE_PALETTES = [
  // 1. Sky / Azure
  {
    name: 'Sky Azure',
    lecture: {
      bg: '#0F1D38', border: '#1E40AF', subjText: '#FFFFFF',
      accent: '#60A5FA', tagBg: '#1D4ED8', tagText: '#FFFFFF',
      roomBg: '#1E40AF', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#1E3A8A', border: '#60A5FA', subjText: '#F0F9FF',
      accent: '#BAE6FD', tagBg: '#38BDF8', tagText: '#082F49',
      roomBg: '#38BDF8', roomText: '#082F49',
    },
  },
  // 2. Fresh Emerald
  {
    name: 'Emerald Mint',
    lecture: {
      bg: '#063123', border: '#047857', subjText: '#FFFFFF',
      accent: '#34D399', tagBg: '#047857', tagText: '#FFFFFF',
      roomBg: '#047857', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#065F46', border: '#34D399', subjText: '#F0FDF4',
      accent: '#A7F3D0', tagBg: '#34D399', tagText: '#022C22',
      roomBg: '#34D399', roomText: '#022C22',
    },
  },
  // 3. Electric Violet
  {
    name: 'Electric Violet',
    lecture: {
      bg: '#280F50', border: '#6D28D9', subjText: '#FFFFFF',
      accent: '#C084FC', tagBg: '#6D28D9', tagText: '#FFFFFF',
      roomBg: '#6D28D9', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#581C87', border: '#C084FC', subjText: '#FAF5FF',
      accent: '#E9D5FF', tagBg: '#C084FC', tagText: '#2E1065',
      roomBg: '#C084FC', roomText: '#2E1065',
    },
  },
  // 4. Warm Coral
  {
    name: 'Warm Coral',
    lecture: {
      bg: '#3B1303', border: '#B45309', subjText: '#FFFFFF',
      accent: '#FBBF24', tagBg: '#B45309', tagText: '#FFFFFF',
      roomBg: '#B45309', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#9A3412', border: '#FBBF24', subjText: '#FFF7ED',
      accent: '#FED7AA', tagBg: '#FBBF24', tagText: '#451A03',
      roomBg: '#FBBF24', roomText: '#451A03',
    },
  },
  // 5. Vibrant Teal
  {
    name: 'Vibrant Teal',
    lecture: {
      bg: '#042826', border: '#0F766E', subjText: '#FFFFFF',
      accent: '#2DD4BF', tagBg: '#0F766E', tagText: '#FFFFFF',
      roomBg: '#0F766E', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#0F766E', border: '#2DD4BF', subjText: '#F0FDFA',
      accent: '#CCFBF1', tagBg: '#2DD4BF', tagText: '#042F2E',
      roomBg: '#2DD4BF', roomText: '#042F2E',
    },
  },
  // 6. Rose Magenta
  {
    name: 'Rose Magenta',
    lecture: {
      bg: '#3B0515', border: '#BE123C', subjText: '#FFFFFF',
      accent: '#FB7185', tagBg: '#BE123C', tagText: '#FFFFFF',
      roomBg: '#BE123C', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#9F1239', border: '#FB7185', subjText: '#FDF2F8',
      accent: '#FCE7F3', tagBg: '#FB7185', tagText: '#4C0519',
      roomBg: '#FB7185', roomText: '#4C0519',
    },
  },
];

// 2. CLEAN AIR LIGHT PALETTE (Yorug', havodor, ko'zni charchatmaydigan yengil rejim)
// Qoida: Ma'ruza = to'yingan pastel, to'qroq fon. Seminar = deyarli oq, juda och havodor fon!
const CLEAN_AIR_LIGHT_PALETTES = [
  // 1. Sky Blue
  {
    name: 'Sky Blue',
    lecture: {
      bg: '#BFDBFE', border: '#1D4ED8', subjText: '#0F172A',
      accent: '#1E40AF', tagBg: '#1D4ED8', tagText: '#FFFFFF',
      roomBg: '#1E40AF', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#F0F9FF', border: '#0284C7', subjText: '#1E293B',
      accent: '#0369A1', tagBg: '#0284C7', tagText: '#FFFFFF',
      roomBg: '#0284C7', roomText: '#FFFFFF',
    },
  },
  // 2. Fresh Emerald
  {
    name: 'Fresh Emerald',
    lecture: {
      bg: '#A7F3D0', border: '#047857', subjText: '#0F172A',
      accent: '#064E3B', tagBg: '#047857', tagText: '#FFFFFF',
      roomBg: '#047857', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#ECFDF5', border: '#059669', subjText: '#1E293B',
      accent: '#047857', tagBg: '#059669', tagText: '#FFFFFF',
      roomBg: '#059669', roomText: '#FFFFFF',
    },
  },
  // 3. Purple
  {
    name: 'Purple',
    lecture: {
      bg: '#DDD6FE', border: '#6D28D9', subjText: '#0F172A',
      accent: '#4C1D95', tagBg: '#6D28D9', tagText: '#FFFFFF',
      roomBg: '#6D28D9', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#FAF5FF', border: '#7C3AED', subjText: '#1E293B',
      accent: '#6D28D9', tagBg: '#7C3AED', tagText: '#FFFFFF',
      roomBg: '#7C3AED', roomText: '#FFFFFF',
    },
  },
  // 4. Amber
  {
    name: 'Amber',
    lecture: {
      bg: '#FDE68A', border: '#B45309', subjText: '#0F172A',
      accent: '#78350F', tagBg: '#B45309', tagText: '#FFFFFF',
      roomBg: '#B45309', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#FFFBEB', border: '#D97706', subjText: '#1E293B',
      accent: '#B45309', tagBg: '#D97706', tagText: '#FFFFFF',
      roomBg: '#D97706', roomText: '#FFFFFF',
    },
  },
  // 5. Teal
  {
    name: 'Teal',
    lecture: {
      bg: '#99F6E4', border: '#0F766E', subjText: '#0F172A',
      accent: '#115E59', tagBg: '#0F766E', tagText: '#FFFFFF',
      roomBg: '#0F766E', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#F0FDFA', border: '#0D9488', subjText: '#1E293B',
      accent: '#0F766E', tagBg: '#0D9488', tagText: '#FFFFFF',
      roomBg: '#0D9488', roomText: '#FFFFFF',
    },
  },
  // 6. Rose
  {
    name: 'Rose',
    lecture: {
      bg: '#FECDD3', border: '#BE123C', subjText: '#0F172A',
      accent: '#881337', tagBg: '#BE123C', tagText: '#FFFFFF',
      roomBg: '#BE123C', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#FFF1F2', border: '#E11D48', subjText: '#1E293B',
      accent: '#BE123C', tagBg: '#E11D48', tagText: '#FFFFFF',
      roomBg: '#E11D48', roomText: '#FFFFFF',
    },
  },
];

// 3. VIBRANT TINT DARK (Toza Slate foni, xona va teglarda kontrast ajratish)
const VIBRANT_TINT_PALETTES = [
  // 1. Sky
  {
    name: 'Sky Blue',
    lecture: {
      bg: '#0F172A', border: '#1D4ED8', subjText: '#FFFFFF',
      accent: '#60A5FA', tagBg: '#1D4ED8', tagText: '#FFFFFF',
      roomBg: '#1E40AF', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#1E293B', border: '#38BDF8', subjText: '#F1F5F9',
      accent: '#BAE6FD', tagBg: '#38BDF8', tagText: '#082F49',
      roomBg: '#38BDF8', roomText: '#082F49',
    },
  },
  // 2. Emerald
  {
    name: 'Emerald',
    lecture: {
      bg: '#0F172A', border: '#047857', subjText: '#FFFFFF',
      accent: '#34D399', tagBg: '#047857', tagText: '#FFFFFF',
      roomBg: '#047857', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#1E293B', border: '#34D399', subjText: '#F1F5F9',
      accent: '#A7F3D0', tagBg: '#34D399', tagText: '#022C22',
      roomBg: '#34D399', roomText: '#022C22',
    },
  },
  // 3. Purple
  {
    name: 'Purple',
    lecture: {
      bg: '#0F172A', border: '#6D28D9', subjText: '#FFFFFF',
      accent: '#C084FC', tagBg: '#6D28D9', tagText: '#FFFFFF',
      roomBg: '#6D28D9', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#1E293B', border: '#C084FC', subjText: '#F1F5F9',
      accent: '#E9D5FF', tagBg: '#C084FC', tagText: '#2E1065',
      roomBg: '#C084FC', roomText: '#2E1065',
    },
  },
  // 4. Amber
  {
    name: 'Amber',
    lecture: {
      bg: '#0F172A', border: '#B45309', subjText: '#FFFFFF',
      accent: '#FBBF24', tagBg: '#B45309', tagText: '#FFFFFF',
      roomBg: '#B45309', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#1E293B', border: '#FBBF24', subjText: '#F1F5F9',
      accent: '#FED7AA', tagBg: '#FBBF24', tagText: '#451A03',
      roomBg: '#FBBF24', roomText: '#451A03',
    },
  },
  // 5. Rose
  {
    name: 'Rose',
    lecture: {
      bg: '#0F172A', border: '#BE123C', subjText: '#FFFFFF',
      accent: '#FB7185', tagBg: '#BE123C', tagText: '#FFFFFF',
      roomBg: '#BE123C', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#1E293B', border: '#FB7185', subjText: '#F1F5F9',
      accent: '#FECDD3', tagBg: '#FB7185', tagText: '#4C0519',
      roomBg: '#FB7185', roomText: '#4C0519',
    },
  },
  // 6. Teal
  {
    name: 'Teal',
    lecture: {
      bg: '#0F172A', border: '#0F766E', subjText: '#FFFFFF',
      accent: '#2DD4BF', tagBg: '#0F766E', tagText: '#FFFFFF',
      roomBg: '#0F766E', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#1E293B', border: '#2DD4BF', subjText: '#F1F5F9',
      accent: '#CCFBF1', tagBg: '#2DD4BF', tagText: '#042F2E',
      roomBg: '#2DD4BF', roomText: '#042F2E',
    },
  },
];

// ─── THEMES DEFINITIONS ──────────────────────────────────────────────────────

const REFINED_VARIANTS = [
  // ── VARIANT 6-A: Fresh Slate Dark ──────────────────────────────────────────
  {
    id: '6a_fresh_slate_dark',
    title: 'Variant 6A: Fresh Slate Dark (Yengil Dark-Mode)',
    desc: 'Tetik va jonli ranglar palitrasi. Qoramtir va loyqa ranglar yo‘q. Katta xona banneri va 3 bosqichli ierarxiya.',
    isLight: false,
    canvasBg: '#0B0F19',
    titleBarBg: '#111827',
    titleTextColor: '#FFFFFF',
    titleSubtitleColor: '#38BDF8',
    titleAccentBar: '#38BDF8',
    badgeBg: '#38BDF8',
    badgeText: '#082F49',
    timeColor: '#F1F5F9',
    dayTextColor: '#FFFFFF',
    colBg1: '#0F172A',
    colBg2: '#141E33',
    borderDivider: '#1E293B',
    palettes: FRESH_SLATE_PALETTES,
  },

  // ── VARIANT 6-B: Clean Air Light ───────────────────────────────────────────
  {
    id: '6b_clean_air_light',
    title: 'Variant 6B: Clean Air Light (Yorug‘ va Havodor)',
    desc: 'Oq va engil havodor fon. To‘liq enli kontrastli xona banneri. Ko‘zga chaqmoqdek tashlanuvchi xona raqami.',
    isLight: true,
    canvasBg: '#F8FAFC',
    titleBarBg: '#0F172A',
    titleTextColor: '#FFFFFF',
    titleSubtitleColor: '#94A3B8',
    titleAccentBar: '#2563EB',
    badgeBg: '#2563EB',
    badgeText: '#FFFFFF',
    timeColor: '#334155',
    dayTextColor: '#0F172A',
    colBg1: '#FFFFFF',
    colBg2: '#F1F5F9',
    borderDivider: '#CBD5E1',
    palettes: CLEAN_AIR_LIGHT_PALETTES,
  },

  // ── VARIANT 6-C: Vibrant Tint Pro ──────────────────────────────────────────
  {
    id: '6c_vibrant_tint_pro',
    title: 'Variant 6C: Vibrant Tint Slate (Zamonaviy Tungi Slate)',
    desc: 'Barcha kartalar toza Slate fonga ega, faqat hoshiyalar, xona bannerlari va MA‘RUZA/SEMINAR teglari yorqin rangda!',
    isLight: false,
    canvasBg: '#0A0E1A',
    titleBarBg: '#0F172A',
    titleTextColor: '#FFFFFF',
    titleSubtitleColor: '#22C55E',
    titleAccentBar: '#22C55E',
    badgeBg: '#22C55E',
    badgeText: '#052E16',
    timeColor: '#F1F5F9',
    dayTextColor: '#FFFFFF',
    colBg1: '#0F172A',
    colBg2: '#131D31',
    borderDivider: '#1E293B',
    palettes: VIBRANT_TINT_PALETTES,
  },
];

// ─── Card Renderer for Variant 6 ─────────────────────────────────────────────
function renderVariant6Card({ lesson, baseX, baseY, span, cellW, colorSet }) {
  const cardW = cellW * span - MARGIN * 2;
  const cardH = CELL_H - MARGIN * 2;
  const cardX = baseX + MARGIN;
  const cardY = baseY + MARGIN;

  const rawSubj = lesson.subject || '';
  const cleanSubj = cleanSubjectTitle(rawSubj);
  const subj = escapeXml(cleanSubj);
  const teacher = escapeXml(formatTeacherName(lesson.teacher));
  const isLecture = colorSet.type === 'lecture';

  // 1. SUBJECT NAME (Priority #2)
  const { lines: subjLines, fSize } = wrapSubjectText(subj, cardW);

  // 2. ROOM BANNER (Priority #1: Student scans Room first!)
  const rawRoom = (lesson.room || '?').trim();
  const { label: roomLabel, fontSize: roomFontSize } = formatRoomBanner(rawRoom);
  const bannerH = 70; // High, bold, glanceable
  const bannerY = cardY + cardH - bannerH;

  // 3. FORMAT PILL BADGE (Priority #3: Lecture vs Seminar)
  const tagW = isLecture ? 134 : 124;
  const tagH = 38;
  const tagLabel = isLecture ? "MA'RUZA" : "SEMINAR";

  // Center vertical placement for subject lines
  const topZoneY = cardY + 16 + tagH; // ~54px
  const availableH = bannerY - topZoneY - 14;
  const totalTextH = subjLines.length * (fSize * 1.18);
  const textStartY = Math.round(topZoneY + (availableH - totalTextH) / 2 + fSize * 0.85);

  return `
    <g filter="url(#shadow-card)">
      <!-- Main Card Body -->
      <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="22" ry="22"
            fill="${colorSet.bg}" stroke="${colorSet.border}" stroke-width="2.5"></rect>

      <!-- Top Row: Lesson Format Badge (Priority #3) -->
      <rect x="${cardX + 20}" y="${cardY + 16}" width="${tagW}" height="${tagH}" rx="10" fill="${colorSet.tagBg}"></rect>
      <text x="${cardX + 20 + tagW / 2}" y="${cardY + 16 + tagH / 2 + 1}"
            font-size="21" font-weight="900" letter-spacing="1px"
            text-anchor="middle" dominant-baseline="central" fill="${colorSet.tagText}">${tagLabel}</text>

      <!-- Teacher Name (Top Right) -->
      ${teacher ? `
      <text x="${cardX + cardW - 20}" y="${cardY + 16 + tagH / 2 + 1}"
            font-size="24" font-weight="700" text-anchor="end" dominant-baseline="central"
            fill="${colorSet.accent}">${teacher}</text>
      ` : ''}

      <!-- Center: Subject Name (Priority #2) -->
      <g transform="translate(${cardX + 24}, 0)">
        ${subjLines.map((l, idx) => `
          <text x="0" y="${textStartY + idx * Math.round(fSize * 1.18)}"
                font-size="${fSize}" font-weight="900"
                fill="${colorSet.subjText}">${l}</text>
        `).join('')}
      </g>

      <!-- Signature Full-Width Bottom Banner: ROOM NUMBER (Priority #1) -->
      <!-- STRICT CONSTRAINT: Exact path shape preserved, expanded to 70px height -->
      <path d="M ${cardX} ${bannerY}
               L ${cardX + cardW} ${bannerY}
               L ${cardX + cardW} ${cardY + cardH - 22}
               A 22 22 0 0 1 ${cardX + cardW - 22} ${cardY + cardH}
               L ${cardX + 22} ${cardY + cardH}
               A 22 22 0 0 1 ${cardX} ${cardY + cardH - 22}
               Z"
            fill="${colorSet.roomBg}"></path>

      <!-- Room Number Label (Massive, high-contrast, glanceable) -->
      <text x="${cardX + cardW / 2}" y="${bannerY + bannerH / 2 + 1}"
            font-size="${roomFontSize}" font-weight="900" letter-spacing="1.5px"
            text-anchor="middle" dominant-baseline="central"
            fill="${colorSet.roomText}">${escapeXml(roomLabel)}</text>
    </g>
  `;
}

// ─── Full SVG Builder ────────────────────────────────────────────────────────
function renderScheduleSvg(className, schedule, themeConfig) {
  const maxPeriod  = getMaxActivePeriod(schedule);
  const activeDays = getActiveDays(schedule);
  const numRows    = activeDays.length;

  if (numRows === 0) throw new Error("Jadval bo'sh");

  const CONTENT_W = SVG_W - DAY_W;
  const cellW     = CONTENT_W / maxPeriod;
  const gridY     = TITLE_H + HDR_H;
  const svgH      = gridY + numRows * CELL_H + 40;

  const baseColorMap = {};
  let colorCounter = 0;
  const palettes = themeConfig.palettes;

  function resolveColors(lesson) {
    const base = getBaseSubject(lesson.subject || '');
    if (!(base in baseColorMap)) {
      baseColorMap[base] = colorCounter % palettes.length;
      colorCounter++;
    }
    const pal = palettes[baseColorMap[base]];
    const type = getLessonType(lesson.subject);
    const colorSet = type === 'seminar' ? pal.seminar : pal.lecture;
    return { ...colorSet, type };
  }

  // 1. Header periods (Enlarged fonts!)
  let headerHtml = '';
  for (let i = 0; i < maxPeriod; i++) {
    const bx = DAY_W + i * cellW;
    const midX = bx + cellW / 2;

    if (i > 0) {
      headerHtml += `<line x1="${bx}" y1="${TITLE_H}" x2="${bx}" y2="${gridY}" stroke="${themeConfig.borderDivider}" stroke-width="2"></line>`;
    }

    // Number Badge (Larger circle & font)
    const cy = TITLE_H + 70;
    headerHtml += `<circle cx="${midX}" cy="${cy}" r="44" fill="${themeConfig.badgeBg}"></circle>`;
    headerHtml += `<text font-size="52" font-weight="900" text-anchor="middle" dominant-baseline="central" x="${midX}" y="${cy + 1}" fill="${themeConfig.badgeText}">${i + 1}</text>`;

    // Time text (Larger & clearer)
    headerHtml += `<text font-size="38" font-weight="700" text-anchor="middle" dominant-baseline="auto" x="${midX}" y="${TITLE_H + HDR_H - 26}" fill="${themeConfig.timeColor}">${TIMES[i]}</text>`;
  }

  // 2. Day labels (Larger fonts!)
  let dayLabelsHtml = '';
  activeDays.forEach((dayIdx, rowIdx) => {
    const by = gridY + rowIdx * CELL_H;
    const midY = by + CELL_H / 2;

    if (rowIdx > 0) {
      dayLabelsHtml += `<line x1="0" y1="${by}" x2="${SVG_W}" y2="${by}" stroke="${themeConfig.borderDivider}" stroke-width="2"></line>`;
    }

    const dotColors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#06B6D4'];
    dayLabelsHtml += `<circle cx="36" cy="${midY}" r="14" fill="${dotColors[dayIdx]}"></circle>`;
    dayLabelsHtml += `<text font-size="58" font-weight="900" text-anchor="middle" dominant-baseline="central" x="${DAY_W / 2 + 16}" y="${midY}" fill="${themeConfig.dayTextColor}">${DAY_NAMES[dayIdx]}</text>`;
  });

  // 3. Zebra column backgrounds
  let zebraHtml = '';
  for (let i = 0; i < maxPeriod; i++) {
    const bx = DAY_W + i * cellW;
    const bg = i % 2 === 0 ? themeConfig.colBg1 : themeConfig.colBg2;
    zebraHtml += `<rect x="${bx}" y="${TITLE_H}" width="${cellW}" height="${HDR_H + numRows * CELL_H}" fill="${bg}"></rect>`;
  }

  // 4. Cards
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

      cardsHtml += renderVariant6Card({
        lesson,
        baseX,
        baseY,
        span,
        cellW,
        colorSet: c,
      });

      pNum += span;
    }
  }

  return `
<svg width="${SVG_W}" height="${svgH}" viewBox="0 0 ${SVG_W} ${svgH}"
     xmlns="http://www.w3.org/2000/svg"
     style="background-color: ${themeConfig.canvasBg}; font-family: 'Segoe UI', -apple-system, Roboto, Helvetica, Arial, sans-serif;">
  <defs>
    <filter id="shadow-card" x="-4%" y="-4%" width="112%" height="118%">
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#000000" flood-opacity="${themeConfig.isLight ? '0.15' : '0.65'}"/>
    </filter>
    <filter id="shadow-title" x="-1%" y="-5%" width="104%" height="130%">
      <feDropShadow dx="0" dy="6" stdDeviation="12" flood-color="#000000" flood-opacity="${themeConfig.isLight ? '0.2' : '0.7'}"/>
    </filter>
  </defs>

  <!-- Canvas Background -->
  <rect x="0" y="0" width="${SVG_W}" height="${svgH}" fill="${themeConfig.canvasBg}"></rect>

  <!-- Zebra Column Stripes -->
  ${zebraHtml}

  <!-- Side Day Column Base -->
  <rect x="0" y="${TITLE_H}" width="${DAY_W}" height="${HDR_H + numRows * CELL_H}" fill="${themeConfig.isLight ? '#FFFFFF' : '#0B0F19'}"></rect>

  <!-- Top Title Header -->
  <rect x="0" y="0" width="${SVG_W}" height="${TITLE_H}" fill="${themeConfig.titleBarBg}" filter="url(#shadow-title)"></rect>
  <rect x="0" y="0" width="14" height="${TITLE_H}" fill="${themeConfig.titleAccentBar}"></rect>

  <!-- Header Main Title -->
  <text font-size="88" font-weight="900" letter-spacing="3px"
        text-anchor="middle" dominant-baseline="central"
        x="${SVG_W / 2}" y="${TITLE_H / 2 - 18}" fill="${themeConfig.titleTextColor}">${escapeXml(className)} — HAFTALIK DARS JADVALI</text>
  <text font-size="28" font-weight="800" letter-spacing="4px"
        text-anchor="middle" dominant-baseline="central"
        x="${SVG_W / 2}" y="${TITLE_H / 2 + 42}" fill="${themeConfig.titleSubtitleColor}">TOSHKENT DAVLAT IQTISODIYOT UNIVERSITETI • RASMIY DARS JADVALI</text>

  <!-- Periods Header -->
  ${headerHtml}

  <!-- Day Labels -->
  ${dayLabelsHtml}

  <!-- Outer & Inner Grid Separators -->
  <line x1="${DAY_W}" y1="${TITLE_H}" x2="${DAY_W}" y2="${svgH}" stroke="${themeConfig.borderDivider}" stroke-width="3"></line>
  <line x1="0" y1="${gridY}" x2="${SVG_W}" y2="${gridY}" stroke="${themeConfig.borderDivider}" stroke-width="3"></line>

  <!-- Cards -->
  ${cardsHtml}

  <!-- Outer Border Frame -->
  <rect x="0" y="0" width="${SVG_W}" height="${svgH}" fill="none" stroke="${themeConfig.borderDivider}" stroke-width="4"></rect>
</svg>
  `;
}

// ─── Main Execution ──────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Generating Refined Variant 6 Prototypes...');
  await edupageService.warmUpCache();

  const testGroup = 'BHA_51K';
  const schedule = await edupageService.getRawSchedule(testGroup);
  if (!schedule) {
    throw new Error(`Schedule for ${testGroup} not found!`);
  }

  const previewsDir = path.join(__dirname, '../previews');
  if (!fs.existsSync(previewsDir)) fs.mkdirSync(previewsDir, { recursive: true });

  const generatedList = [];

  for (const variant of REFINED_VARIANTS) {
    const filename = `refined_${variant.id}.png`;
    const outPath = path.join(previewsDir, filename);

    console.log(`🎨 Rendering ${variant.title}...`);
    const svgStr = renderScheduleSvg(testGroup, schedule, variant);

    const buf = await sharp(Buffer.from(svgStr))
      .png({ palette: true, quality: 90, compressionLevel: 7, effort: 3 })
      .toBuffer();

    fs.writeFileSync(outPath, buf);
    console.log(`✅ Saved: ${filename} (${Math.round(buf.length / 1024)} KB)`);

    generatedList.push({
      id: variant.id,
      title: variant.title,
      desc: variant.desc,
      filename,
      isLight: variant.isLight,
      sizeKb: Math.round(buf.length / 1024),
    });
  }

  // HTML Gallery
  const htmlGallery = `<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dars Jadvali — Variant 6 Takomillashgan Versiyalari</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090D16;
      --card-bg: #111827;
      --border: #1F2937;
      --text: #F9FAFB;
      --subtext: #9CA3AF;
      --accent: #38BDF8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 40px 24px 80px;
      line-height: 1.5;
    }
    .header {
      max-width: 1300px;
      margin: 0 auto 40px;
      text-align: center;
    }
    .header h1 {
      font-size: 38px;
      font-weight: 900;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, #38BDF8 0%, #818CF8 50%, #C084FC 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 12px;
    }
    .header p {
      color: var(--subtext);
      font-size: 17px;
      max-width: 780px;
      margin: 0 auto;
    }
    .grid {
      max-width: 1500px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 50px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 20px;
      overflow: hidden;
      box-shadow: 0 20px 40px rgba(0,0,0,0.5);
    }
    .card-header {
      padding: 24px 30px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(255,255,255,0.02);
      border-bottom: 1px solid var(--border);
    }
    .card-title {
      font-size: 22px;
      font-weight: 800;
    }
    .card-desc {
      font-size: 14px;
      color: var(--subtext);
      margin-top: 4px;
    }
    .card-badge {
      background: rgba(56, 189, 248, 0.15);
      color: var(--accent);
      border: 1px solid rgba(56, 189, 248, 0.3);
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 700;
    }
    .img-wrap {
      padding: 16px;
      background: #030712;
      overflow-x: auto;
    }
    .img-wrap img {
      width: 100%;
      height: auto;
      border-radius: 12px;
      display: block;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Variant 6: Takomillashtirilgan Versiyalar</h1>
    <p>1-o‘rinda: XONA (katta va yorqin) • 2-o‘rinda: FAN NOMI • 3-o‘rinda: MA‘RUZA/SEMINAR • Yengil va toza ranglar</p>
  </div>
  <div class="grid">
    ${generatedList.map((g) => `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">${g.title}</div>
            <div class="card-desc">${g.desc}</div>
          </div>
          <div class="card-badge">${g.sizeKb} KB • PNG</div>
        </div>
        <div class="img-wrap">
          <a href="${g.filename}" target="_blank">
            <img src="${g.filename}" alt="${g.title}" loading="lazy"/>
          </a>
        </div>
      </div>
    `).join('')}
  </div>
</body>
</html>`;

  fs.writeFileSync(path.join(previewsDir, 'refined_index.html'), htmlGallery, 'utf8');
  console.log('🎉 All refined prototypes & refined_index.html generated successfully!');
}

main().catch(err => {
  console.error('❌ Error generating refined variants:', err);
  process.exit(1);
});
