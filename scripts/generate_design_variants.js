'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const edupageService = require('../src/services/edupageService');

// ─── Constants & Dimensions ──────────────────────────────────────────────────
const SVG_W   = 2970;
const DAY_W   = 220;
const TITLE_H = 190;
const HDR_H   = 170;
const CELL_H  = 330;
const MARGIN  = 12;

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

function formatTeacherName(name, maxChars = 16) {
  if (!name) return '';
  const trimmed = name.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    const formatted = `${parts[0]} ${parts[1][0]}.`;
    if (formatted.length <= maxChars) return formatted;
  }
  return trimmed.slice(0, maxChars - 1) + '…';
}

function wrapSubjectText(text, cardW) {
  const maxChars = Math.floor((cardW - 48) / 21);
  let lines = wrapText(text, maxChars);
  let fSize = 44;
  if (lines.length === 1) {
    fSize = 46;
  } else if (lines.length === 2) {
    fSize = 40;
  } else if (lines.length >= 3) {
    fSize = 34;
    if (lines.length > 3) {
      lines = lines.slice(0, 3);
      lines[2] = lines[2].replace(/[.,;: ]+$/, '') + '…';
    }
  }
  return { lines, fSize };
}

function getRoomBadge(rawRoom, maxAvailableW) {
  const room = (rawRoom || '?').trim();
  let fontSize = 24;
  let label = room;
  if (room.length > 16) {
    fontSize = 18;
  } else if (room.length > 11) {
    fontSize = 21;
  }
  const estimatedW = label.length * (fontSize * 0.65) + 36;
  const badgeW = Math.min(maxAvailableW, Math.max(110, Math.round(estimatedW)));
  return { label, fontSize, badgeW };
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

// ─── Harmonized Color Palettes (Coupled Lecture & Seminar Shades) ─────────────

// Dark themes color palette (Rich vs Softer Tint)
const DARK_PALETTES = [
  // 1. Cobalt
  {
    name: 'Cobalt',
    lecture: { bg: '#1E3A8A', border: '#3B82F6', accent: '#60A5FA', tagBg: '#2563EB', tagText: '#FFFFFF', roomBg: '#38BDF8', roomText: '#0B132B' },
    seminar: { bg: '#142145', border: '#2563EB', accent: '#93C5FD', tagBg: '#1E3A8A', tagText: '#BFDBFE', roomBg: '#0284C7', roomText: '#FFFFFF' },
  },
  // 2. Emerald
  {
    name: 'Emerald',
    lecture: { bg: '#064E3B', border: '#10B981', accent: '#34D399', tagBg: '#059669', tagText: '#FFFFFF', roomBg: '#34D399', roomText: '#022C22' },
    seminar: { bg: '#072E24', border: '#059669', accent: '#6EE7B7', tagBg: '#064E3B', tagText: '#A7F3D0', roomBg: '#059669', roomText: '#FFFFFF' },
  },
  // 3. Violet
  {
    name: 'Violet',
    lecture: { bg: '#4C1D95', border: '#8B5CF6', accent: '#C4B5FD', tagBg: '#6D28D9', tagText: '#FFFFFF', roomBg: '#C084FC', roomText: '#2E1065' },
    seminar: { bg: '#2B1257', border: '#6D28D9', accent: '#DDD6FE', tagBg: '#4C1D95', tagText: '#E9D5FF', roomBg: '#7C3AED', roomText: '#FFFFFF' },
  },
  // 4. Amber
  {
    name: 'Amber',
    lecture: { bg: '#78350F', border: '#F59E0B', accent: '#FDE68A', tagBg: '#D97706', tagText: '#FFFFFF', roomBg: '#FBBF24', roomText: '#451A03' },
    seminar: { bg: '#431F0A', border: '#D97706', accent: '#FEF3C7', tagBg: '#78350F', tagText: '#FDE68A', roomBg: '#D97706', roomText: '#FFFFFF' },
  },
  // 5. Crimson Rose
  {
    name: 'Rose',
    lecture: { bg: '#881337', border: '#F43F5E', accent: '#FDA4AF', tagBg: '#E11D48', tagText: '#FFFFFF', roomBg: '#FB7185', roomText: '#4C0519' },
    seminar: { bg: '#4C0E22', border: '#BE123C', accent: '#FECDD3', tagBg: '#881337', tagText: '#FFE4E6', roomBg: '#BE123C', roomText: '#FFFFFF' },
  },
  // 6. Teal
  {
    name: 'Teal',
    lecture: { bg: '#134E4A', border: '#14B8A6', accent: '#5EEAD4', tagBg: '#0D9488', tagText: '#FFFFFF', roomBg: '#2DD4BF', roomText: '#042F2E' },
    seminar: { bg: '#0B2E2C', border: '#0D9488', accent: '#99F6E4', tagBg: '#134E4A', tagText: '#CCFBF1', roomBg: '#0D9488', roomText: '#FFFFFF' },
  },
  // 7. Indigo
  {
    name: 'Indigo',
    lecture: { bg: '#312E81', border: '#6366F1', accent: '#A5B4FC', tagBg: '#4338CA', tagText: '#FFFFFF', roomBg: '#818CF8', roomText: '#1E1B4B' },
    seminar: { bg: '#1F1D54', border: '#4338CA', accent: '#C7D2FE', tagBg: '#312E81', tagText: '#E0E7FF', roomBg: '#4F46E5', roomText: '#FFFFFF' },
  },
  // 8. Tangerine
  {
    name: 'Tangerine',
    lecture: { bg: '#7C2D12', border: '#F97316', accent: '#FED7AA', tagBg: '#EA580C', tagText: '#FFFFFF', roomBg: '#FB923C', roomText: '#431407' },
    seminar: { bg: '#461A0C', border: '#C2410C', accent: '#FFEDD5', tagBg: '#7C2D12', tagText: '#FED7AA', roomBg: '#C2410C', roomText: '#FFFFFF' },
  },
];

// Light themes color palette
const LIGHT_PALETTES = [
  // 1. Blue
  {
    name: 'Blue',
    lecture: { bg: '#E0EDFF', border: '#2563EB', accent: '#1D4ED8', text: '#0F172A', tagBg: '#2563EB', tagText: '#FFFFFF', roomBg: '#0F172A', roomText: '#FFFFFF' },
    seminar: { bg: '#F1F5F9', border: '#60A5FA', accent: '#2563EB', text: '#334155', tagBg: '#DBEAFE', tagText: '#1E40AF', roomBg: '#1E293B', roomText: '#FFFFFF' },
  },
  // 2. Emerald
  {
    name: 'Emerald',
    lecture: { bg: '#D1FAE5', border: '#059669', accent: '#047857', text: '#0F172A', tagBg: '#059669', tagText: '#FFFFFF', roomBg: '#064E3B', roomText: '#FFFFFF' },
    seminar: { bg: '#F1F5F9', border: '#34D399', accent: '#059669', text: '#334155', tagBg: '#E6FDF2', tagText: '#065F46', roomBg: '#064E3B', roomText: '#FFFFFF' },
  },
  // 3. Purple
  {
    name: 'Purple',
    lecture: { bg: '#EDE9FE', border: '#7C3AED', accent: '#6D28D9', text: '#0F172A', tagBg: '#7C3AED', tagText: '#FFFFFF', roomBg: '#4C1D95', roomText: '#FFFFFF' },
    seminar: { bg: '#F1F5F9', border: '#A78BFA', accent: '#7C3AED', text: '#334155', tagBg: '#F3E8FF', tagText: '#6B21A8', roomBg: '#4C1D95', roomText: '#FFFFFF' },
  },
  // 4. Amber
  {
    name: 'Amber',
    lecture: { bg: '#FEF3C7', border: '#D97706', accent: '#B45309', text: '#0F172A', tagBg: '#D97706', tagText: '#FFFFFF', roomBg: '#451A03', roomText: '#FFFFFF' },
    seminar: { bg: '#F1F5F9', border: '#FBBF24', accent: '#B45309', text: '#334155', tagBg: '#FFFBEB', tagText: '#92400E', roomBg: '#451A03', roomText: '#FFFFFF' },
  },
  // 5. Rose
  {
    name: 'Rose',
    lecture: { bg: '#FFE4E6', border: '#E11D48', accent: '#BE123C', text: '#0F172A', tagBg: '#E11D48', tagText: '#FFFFFF', roomBg: '#881337', roomText: '#FFFFFF' },
    seminar: { bg: '#F1F5F9', border: '#FB7185', accent: '#BE123C', text: '#334155', tagBg: '#FFF1F2', tagText: '#9F1239', roomBg: '#881337', roomText: '#FFFFFF' },
  },
  // 6. Teal
  {
    name: 'Teal',
    lecture: { bg: '#CCFBF1', border: '#0D9488', accent: '#0F766E', text: '#0F172A', tagBg: '#0D9488', tagText: '#FFFFFF', roomBg: '#134E4A', roomText: '#FFFFFF' },
    seminar: { bg: '#F1F5F9', border: '#2DD4BF', accent: '#0D9488', text: '#334155', tagBg: '#F0FDFA', tagText: '#115E59', roomBg: '#134E4A', roomText: '#FFFFFF' },
  },
];

// ─── Base Renderer Framework ──────────────────────────────────────────────────
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
  const palettes = themeConfig.isLight ? LIGHT_PALETTES : DARK_PALETTES;

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

  // Header periods
  let headerHtml = '';
  for (let i = 0; i < maxPeriod; i++) {
    const bx = DAY_W + i * cellW;
    const midX = bx + cellW / 2;

    if (i > 0) {
      headerHtml += `<line x1="${bx}" y1="${TITLE_H}" x2="${bx}" y2="${gridY}" stroke="${themeConfig.borderDivider}" stroke-width="1.5"></line>`;
    }

    // Number Badge
    const cy = TITLE_H + 65;
    headerHtml += `<circle cx="${midX}" cy="${cy}" r="38" fill="${themeConfig.badgeBg}"></circle>`;
    headerHtml += `<text font-size="44" font-weight="800" text-anchor="middle" dominant-baseline="central" x="${midX}" y="${cy}" fill="${themeConfig.badgeText}">${i + 1}</text>`;

    // Time text
    headerHtml += `<text font-size="34" font-weight="600" text-anchor="middle" dominant-baseline="auto" x="${midX}" y="${TITLE_H + HDR_H - 24}" fill="${themeConfig.timeColor}">${TIMES[i]}</text>`;
  }

  // Day labels
  let dayLabelsHtml = '';
  activeDays.forEach((dayIdx, rowIdx) => {
    const by = gridY + rowIdx * CELL_H;
    const midY = by + CELL_H / 2;

    if (rowIdx > 0) {
      dayLabelsHtml += `<line x1="0" y1="${by}" x2="${SVG_W}" y2="${by}" stroke="${themeConfig.borderDivider}" stroke-width="1.5"></line>`;
    }

    const dotColors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#06B6D4'];
    dayLabelsHtml += `<circle cx="34" cy="${midY}" r="12" fill="${dotColors[dayIdx]}"></circle>`;
    dayLabelsHtml += `<text font-size="52" font-weight="800" text-anchor="middle" dominant-baseline="central" x="${DAY_W / 2 + 14}" y="${midY}" fill="${themeConfig.dayTextColor}">${DAY_NAMES[dayIdx]}</text>`;
  });

  // Zebra columns background
  let zebraHtml = '';
  for (let i = 0; i < maxPeriod; i++) {
    const bx = DAY_W + i * cellW;
    const bg = i % 2 === 0 ? themeConfig.colBg1 : themeConfig.colBg2;
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

      cardsHtml += themeConfig.renderCard({
        lesson,
        baseX,
        baseY,
        span,
        cellW,
        colorSet: c,
        theme: themeConfig,
      });

      pNum += span;
    }
  }

  return `
<svg width="${SVG_W}" height="${svgH}" viewBox="0 0 ${SVG_W} ${svgH}" xmlns="http://www.w3.org/2000/svg" style="background-color: ${themeConfig.canvasBg}; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <defs>
    <filter id="shadow-card" x="-4%" y="-4%" width="108%" height="114%">
      <feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="${themeConfig.shadowColor || '#000000'}" flood-opacity="${themeConfig.shadowOpacity || 0.4}"/>
    </filter>
    <filter id="glow-badge" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="4" result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over" />
    </filter>
    ${themeConfig.extraDefs || ''}
  </defs>

  <!-- Background -->
  <rect x="0" y="0" width="${SVG_W}" height="${svgH}" fill="${themeConfig.canvasBg}"></rect>

  <!-- Column zebra striping -->
  ${zebraHtml}

  <!-- Header & Side rail containers -->
  <rect x="0" y="${TITLE_H}" width="${DAY_W}" height="${HDR_H + numRows * CELL_H}" fill="${themeConfig.sideRailBg}"></rect>
  <rect x="0" y="0" width="${SVG_W}" height="${TITLE_H}" fill="${themeConfig.titleBarBg}"></rect>

  <!-- Decorative title accent -->
  <rect x="0" y="0" width="14" height="${TITLE_H}" fill="${themeConfig.titleAccentBar || '#3B82F6'}"></rect>

  <!-- Title & Meta -->
  <text font-size="76" font-weight="900" letter-spacing="2px" text-anchor="middle" dominant-baseline="central" x="${SVG_W / 2}" y="${TITLE_H / 2 - 14}" fill="${themeConfig.titleTextColor}">
    ${escapeXml(className)} — HAFTALIK DARS JADVALI
  </text>
  <text font-size="30" font-weight="600" letter-spacing="4px" text-anchor="middle" dominant-baseline="central" x="${SVG_W / 2}" y="${TITLE_H / 2 + 45}" fill="${themeConfig.titleSubtitleColor}">
    TOSHKENT DAVLAT IQTISODIYOT UNIVERSITETI • RASMIY DARS JADVALI
  </text>

  <!-- Headers & Day labels -->
  ${headerHtml}
  ${dayLabelsHtml}

  <!-- Lesson Cards -->
  ${cardsHtml}

  <!-- Outer Borders -->
  <line x1="${DAY_W}" y1="${TITLE_H}" x2="${DAY_W}" y2="${svgH}" stroke="${themeConfig.borderDivider}" stroke-width="2.5"></line>
  <line x1="0" y1="${gridY}" x2="${SVG_W}" y2="${gridY}" stroke="${themeConfig.borderDivider}" stroke-width="2.5"></line>
  <rect x="0" y="0" width="${SVG_W}" height="${svgH}" fill="none" stroke="${themeConfig.borderDivider}" stroke-width="3"></rect>
</svg>`;
}

// ═════════════════════════════════════════════════════════════════════════════
// 6 DISTINCT SENIOR-LEVEL DESIGN CONCEPTS
// ═════════════════════════════════════════════════════════════════════════════

// ─── Concept 1: Modern Dark OLED (Deep Slate & Glowing High-Contrast Badges) ───
const THEME_1_MODERN_DARK = {
  name: 'Modern Dark OLED',
  isLight: false,
  canvasBg: '#090D16',
  titleBarBg: '#0F172A',
  sideRailBg: '#0F172A',
  colBg1: '#0B1120',
  colBg2: '#0D1527',
  borderDivider: '#1E293B',
  titleTextColor: '#F8FAFC',
  titleSubtitleColor: '#64748B',
  titleAccentBar: '#38BDF8',
  badgeBg: '#3B82F6',
  badgeText: '#FFFFFF',
  timeColor: '#94A3B8',
  dayTextColor: '#F8FAFC',
  shadowColor: '#000000',
  shadowOpacity: 0.6,
  renderCard: ({ lesson, baseX, baseY, span, cellW, colorSet }) => {
    const cardW = cellW * span - MARGIN * 2;
    const cardH = CELL_H - MARGIN * 2;
    const cardX = baseX + MARGIN;
    const cardY = baseY + MARGIN;

    const subj = escapeXml(lesson.subject || '');
    const teacher = escapeXml(formatTeacherName(lesson.teacher, 16));
    const isLecture = colorSet.type === 'lecture';
    const tagLabel = isLecture ? "MA'RUZA" : "SEMINAR";

    const { lines: subjLines, fSize } = wrapSubjectText(subj, cardW);
    const maxBadgeW = cardW - 32;
    const { label: roomLabel, fontSize: roomFontSize, badgeW: roomW } = getRoomBadge(lesson.room, maxBadgeW);
    const roomH = 42;
    const roomX = cardX + cardW - roomW - 16;
    const roomY = cardY + cardH - roomH - 12;

    return `
      <g filter="url(#shadow-card)">
        <!-- Card Body -->
        <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="22" ry="22" fill="${colorSet.bg}" stroke="${colorSet.border}" stroke-width="2" stroke-opacity="0.85"></rect>
        
        <!-- Left indicator bar -->
        <rect x="${cardX + 8}" y="${cardY + 14}" width="${isLecture ? 8 : 4}" height="${cardH - 28}" rx="4" fill="${colorSet.accent}"></rect>

        <!-- Header row: Type Tag & Teacher -->
        <rect x="${cardX + 26}" y="${cardY + 16}" width="${isLecture ? 116 : 108}" height="32" rx="8" fill="${colorSet.tagBg}" opacity="0.95"></rect>
        <text x="${cardX + (isLecture ? 84 : 80)}" y="${cardY + 33}" font-size="18" font-weight="900" text-anchor="middle" dominant-baseline="central" fill="${colorSet.tagText}">${tagLabel}</text>

        ${teacher ? `<text x="${cardX + cardW - 20}" y="${cardY + 33}" font-size="22" font-weight="700" text-anchor="end" dominant-baseline="central" fill="${colorSet.accent}">${teacher}</text>` : ''}

        <!-- Subtle Divider -->
        <line x1="${cardX + 26}" y1="${cardY + 56}" x2="${cardX + cardW - 20}" y2="${cardY + 56}" stroke="${colorSet.border}" stroke-width="1.2" stroke-opacity="0.4"></line>

        <!-- Subject Name -->
        <g transform="translate(${cardX + 26}, ${cardY + 100})">
          ${subjLines.map((l, idx) => `<text x="0" y="${idx * (fSize * 1.2)}" font-size="${fSize}" font-weight="800" fill="#FFFFFF">${l}</text>`).join('')}
        </g>

        <!-- Bottom Room Capsule Badge -->
        <rect x="${roomX}" y="${roomY}" width="${roomW}" height="${roomH}" rx="12" ry="12" fill="${colorSet.roomBg}"></rect>
        <g transform="translate(${roomX + 12}, ${roomY + 12})">
          <rect x="0" y="0" width="12" height="18" rx="2" fill="none" stroke="${colorSet.roomText}" stroke-width="1.8"/>
          <circle cx="9" cy="9" r="1.2" fill="${colorSet.roomText}"/>
        </g>
        <text x="${roomX + 32}" y="${roomY + roomH / 2 + 1}" font-size="${roomFontSize}" font-weight="900" text-anchor="start" dominant-baseline="central" fill="${colorSet.roomText}">${roomLabel}</text>
      </g>
    `;
  },
};

// ─── Concept 2: Clean Swiss Minimalist Light (Apple & Editorial Clarity) ────────
const THEME_2_SWISS_LIGHT = {
  name: 'Clean Swiss Light',
  isLight: true,
  canvasBg: '#F8FAFC',
  titleBarBg: '#0F172A',
  sideRailBg: '#FFFFFF',
  colBg1: '#FFFFFF',
  colBg2: '#F8FAFC',
  borderDivider: '#CBD5E1',
  titleTextColor: '#FFFFFF',
  titleSubtitleColor: '#94A3B8',
  titleAccentBar: '#2563EB',
  badgeBg: '#2563EB',
  badgeText: '#FFFFFF',
  timeColor: '#475569',
  dayTextColor: '#0F172A',
  shadowColor: '#64748B',
  shadowOpacity: 0.18,
  renderCard: ({ lesson, baseX, baseY, span, cellW, colorSet }) => {
    const cardW = cellW * span - MARGIN * 2;
    const cardH = CELL_H - MARGIN * 2;
    const cardX = baseX + MARGIN;
    const cardY = baseY + MARGIN;

    const subj = escapeXml(lesson.subject || '');
    const teacher = escapeXml(formatTeacherName(lesson.teacher, 16));
    const isLecture = colorSet.type === 'lecture';
    const tagLabel = isLecture ? "MA'RUZA" : "SEMINAR";

    const { lines: subjLines, fSize } = wrapSubjectText(subj, cardW);
    const maxBadgeW = cardW - 32;
    const { label: roomLabel, fontSize: roomFontSize, badgeW: roomW } = getRoomBadge(lesson.room, maxBadgeW);
    const roomH = 40;
    const roomX = cardX + cardW - roomW - 16;
    const roomY = cardY + cardH - roomH - 12;

    return `
      <g filter="url(#shadow-card)">
        <!-- Card Body with Left Border Anchor -->
        <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="18" ry="18" fill="${colorSet.bg}" stroke="${colorSet.border}" stroke-width="1.8"></rect>
        <path d="M ${cardX} ${cardY + 18} A 18 18 0 0 1 ${cardX + 18} ${cardY} L ${cardX + 14} ${cardY} L ${cardX + 14} ${cardY + cardH} L ${cardX + 18} ${cardY + cardH} A 18 18 0 0 1 ${cardX} ${cardY + cardH - 18} Z" fill="${colorSet.border}"></path>

        <!-- Top row: Format Pill & Teacher -->
        <rect x="${cardX + 26}" y="${cardY + 16}" width="${isLecture ? 116 : 108}" height="32" rx="8" fill="${colorSet.tagBg}"></rect>
        <text x="${cardX + (isLecture ? 84 : 80)}" y="${cardY + 33}" font-size="18" font-weight="800" text-anchor="middle" dominant-baseline="central" fill="${colorSet.tagText}">${tagLabel}</text>

        ${teacher ? `<text x="${cardX + cardW - 20}" y="${cardY + 33}" font-size="22" font-weight="600" text-anchor="end" dominant-baseline="central" fill="#475569">${teacher}</text>` : ''}

        <!-- Subject Name -->
        <g transform="translate(${cardX + 26}, ${cardY + 98})">
          ${subjLines.map((l, idx) => `<text x="0" y="${idx * (fSize * 1.2)}" font-size="${fSize}" font-weight="800" fill="${colorSet.text}">${l}</text>`).join('')}
        </g>

        <!-- Deep Charcoal Room Badge -->
        <rect x="${roomX}" y="${roomY}" width="${roomW}" height="${roomH}" rx="10" ry="10" fill="${colorSet.roomBg}"></rect>
        <g transform="translate(${roomX + 12}, ${roomY + 11})">
          <rect x="0" y="0" width="12" height="18" rx="2" fill="none" stroke="${colorSet.roomText}" stroke-width="1.8"/>
          <circle cx="9" cy="9" r="1.2" fill="${colorSet.roomText}"/>
        </g>
        <text x="${roomX + 32}" y="${roomY + roomH / 2 + 1}" font-size="${roomFontSize}" font-weight="800" text-anchor="start" dominant-baseline="central" fill="${colorSet.roomText}">${roomLabel}</text>
      </g>
    `;
  },
};

// ─── Concept 3: Glassmorphism Cyber-Indigo (Frost Card & Neon Outlines) ─────────
const THEME_3_GLASS_CYBER = {
  name: 'Cyber Glassmorphism',
  isLight: false,
  canvasBg: '#05070E',
  titleBarBg: '#0B1021',
  sideRailBg: '#0B1021',
  colBg1: '#070C1A',
  colBg2: '#0A1124',
  borderDivider: '#1E293B',
  titleTextColor: '#FFFFFF',
  titleSubtitleColor: '#38BDF8',
  titleAccentBar: '#6366F1',
  badgeBg: '#6366F1',
  badgeText: '#FFFFFF',
  timeColor: '#818CF8',
  dayTextColor: '#E2E8F0',
  shadowColor: '#000000',
  shadowOpacity: 0.7,
  extraDefs: `
    <linearGradient id="grad-glass-header" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#3B82F6" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="#8B5CF6" stop-opacity="0.05"/>
    </linearGradient>
  `,
  renderCard: ({ lesson, baseX, baseY, span, cellW, colorSet }) => {
    const cardW = cellW * span - MARGIN * 2;
    const cardH = CELL_H - MARGIN * 2;
    const cardX = baseX + MARGIN;
    const cardY = baseY + MARGIN;

    const subj = escapeXml(lesson.subject || '');
    const teacher = escapeXml(formatTeacherName(lesson.teacher, 16));
    const isLecture = colorSet.type === 'lecture';

    const { lines: subjLines, fSize } = wrapSubjectText(subj, cardW);
    const maxBadgeW = cardW - 32;
    const { label: roomLabel, fontSize: roomFontSize, badgeW: roomW } = getRoomBadge(lesson.room, maxBadgeW);
    const roomH = 42;
    const roomX = cardX + cardW - roomW - 16;
    const roomY = cardY + cardH - roomH - 12;

    return `
      <g filter="url(#shadow-card)">
        <!-- Frosted Glass Card -->
        <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="24" ry="24" fill="${colorSet.bg}" fill-opacity="${isLecture ? '0.88' : '0.65'}" stroke="${colorSet.border}" stroke-width="2.5"></rect>

        <!-- Neon Top Pill Tag -->
        <rect x="${cardX + 24}" y="${cardY + 18}" width="${isLecture ? 116 : 108}" height="32" rx="10" fill="${colorSet.tagBg}"></rect>
        <text x="${cardX + (isLecture ? 82 : 78)}" y="${cardY + 34}" font-size="18" font-weight="900" text-anchor="middle" dominant-baseline="central" fill="${colorSet.tagText}">${isLecture ? "MA'RUZA" : "SEMINAR"}</text>

        <!-- Teacher Name -->
        ${teacher ? `<text x="${cardX + cardW - 20}" y="${cardY + 34}" font-size="22" font-weight="700" text-anchor="end" dominant-baseline="central" fill="${colorSet.accent}">${teacher}</text>` : ''}

        <!-- Center Subject Title -->
        <g transform="translate(${cardX + 24}, ${cardY + 100})">
          ${subjLines.map((l, idx) => `<text x="0" y="${idx * (fSize * 1.2)}" font-size="${fSize}" font-weight="800" fill="#FFFFFF">${l}</text>`).join('')}
        </g>

        <!-- Floating Neon Room Pill -->
        <rect x="${roomX}" y="${roomY}" width="${roomW}" height="${roomH}" rx="12" ry="12" fill="${colorSet.roomBg}"></rect>
        <g transform="translate(${roomX + 12}, ${roomY + 12})">
          <rect x="0" y="0" width="12" height="18" rx="2" fill="none" stroke="${colorSet.roomText}" stroke-width="1.8"/>
          <circle cx="9" cy="9" r="1.2" fill="${colorSet.roomText}"/>
        </g>
        <text x="${roomX + 32}" y="${roomY + roomH / 2 + 1}" font-size="${roomFontSize}" font-weight="900" text-anchor="start" dominant-baseline="central" fill="${colorSet.roomText}">${roomLabel}</text>
      </g>
    `;
  },
};

// ─── Concept 4: Academic Prestige (Navy, Gold & Slate Elegance) ───────────────
const THEME_4_ACADEMIC_NAVY = {
  name: 'Academic Prestige Navy',
  isLight: false,
  canvasBg: '#0A1128',
  titleBarBg: '#050A1A',
  sideRailBg: '#070E22',
  colBg1: '#0A122B',
  colBg2: '#0D1736',
  borderDivider: '#1E2F5B',
  titleTextColor: '#F1F5F9',
  titleSubtitleColor: '#F59E0B',
  titleAccentBar: '#F59E0B',
  badgeBg: '#1E3A8A',
  badgeText: '#F59E0B',
  timeColor: '#93C5FD',
  dayTextColor: '#F8FAFC',
  shadowColor: '#000000',
  shadowOpacity: 0.55,
  renderCard: ({ lesson, baseX, baseY, span, cellW, colorSet }) => {
    const cardW = cellW * span - MARGIN * 2;
    const cardH = CELL_H - MARGIN * 2;
    const cardX = baseX + MARGIN;
    const cardY = baseY + MARGIN;

    const subj = escapeXml(lesson.subject || '');
    const teacher = escapeXml(formatTeacherName(lesson.teacher, 16));
    const isLecture = colorSet.type === 'lecture';

    const { lines: subjLines, fSize } = wrapSubjectText(subj, cardW);
    const maxBadgeW = cardW - 32;
    const { label: roomLabel, fontSize: roomFontSize, badgeW: roomW } = getRoomBadge(lesson.room, maxBadgeW);
    const roomH = 40;
    const roomX = cardX + cardW - roomW - 16;
    const roomY = cardY + cardH - roomH - 12;

    return `
      <g filter="url(#shadow-card)">
        <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="16" ry="16" fill="${colorSet.bg}" stroke="${isLecture ? '#F59E0B' : colorSet.border}" stroke-width="${isLecture ? '2.5' : '1.5'}"></rect>

        <!-- Academic Gold/Subtle Ribbon -->
        <rect x="${cardX + 24}" y="${cardY + 16}" width="${isLecture ? 120 : 110}" height="32" rx="6" fill="${isLecture ? '#B45309' : '#1E3A8A'}"></rect>
        <text x="${cardX + (isLecture ? 84 : 79)}" y="${cardY + 33}" font-size="18" font-weight="900" text-anchor="middle" dominant-baseline="central" fill="#FFFFFF">${isLecture ? "MA'RUZA" : "SEMINAR"}</text>

        ${teacher ? `<text x="${cardX + cardW - 20}" y="${cardY + 33}" font-size="22" font-weight="600" text-anchor="end" dominant-baseline="central" fill="#CBD5E1">${teacher}</text>` : ''}

        <line x1="${cardX + 24}" y1="${cardY + 56}" x2="${cardX + cardW - 20}" y2="${cardY + 56}" stroke="#334155" stroke-width="1"></line>

        <!-- Subject Name -->
        <g transform="translate(${cardX + 24}, ${cardY + 98})">
          ${subjLines.map((l, idx) => `<text x="0" y="${idx * (fSize * 1.2)}" font-size="${fSize}" font-weight="800" fill="#FFFFFF">${l}</text>`).join('')}
        </g>

        <!-- Room Badge with Gold Outline -->
        <rect x="${roomX}" y="${roomY}" width="${roomW}" height="${roomH}" rx="10" ry="10" fill="#0A1128" stroke="#F59E0B" stroke-width="2"></rect>
        <g transform="translate(${roomX + 12}, ${roomY + 12})">
          <line x1="0" y1="0" x2="16" y2="0" stroke="#FBBF24" stroke-width="2"/>
          <line x1="2" y1="4" x2="2" y2="14" stroke="#FBBF24" stroke-width="1.8"/>
          <line x1="8" y1="4" x2="8" y2="14" stroke="#FBBF24" stroke-width="1.8"/>
          <line x1="14" y1="4" x2="14" y2="14" stroke="#FBBF24" stroke-width="1.8"/>
          <line x1="0" y1="16" x2="16" y2="16" stroke="#FBBF24" stroke-width="2"/>
        </g>
        <text x="${roomX + 36}" y="${roomY + roomH / 2 + 1}" font-size="${roomFontSize}" font-weight="900" text-anchor="start" dominant-baseline="central" fill="#FBBF24">${roomLabel}</text>
      </g>
    `;
  },
};

// ─── Concept 5: Nordic Muted Pastel (Soft Minimal & Calm Contrast) ────────────
const THEME_5_NORDIC_PASTEL = {
  name: 'Nordic Muted Pastel',
  isLight: false,
  canvasBg: '#18181B',
  titleBarBg: '#27272A',
  sideRailBg: '#27272A',
  colBg1: '#1F1F23',
  colBg2: '#232328',
  borderDivider: '#3F3F46',
  titleTextColor: '#FAFAFA',
  titleSubtitleColor: '#A1A1AA',
  titleAccentBar: '#A1A1AA',
  badgeBg: '#3F3F46',
  badgeText: '#FAFAFA',
  timeColor: '#D4D4D8',
  dayTextColor: '#FAFAFA',
  shadowColor: '#000000',
  shadowOpacity: 0.45,
  renderCard: ({ lesson, baseX, baseY, span, cellW, colorSet }) => {
    const cardW = cellW * span - MARGIN * 2;
    const cardH = CELL_H - MARGIN * 2;
    const cardX = baseX + MARGIN;
    const cardY = baseY + MARGIN;

    const subj = escapeXml(lesson.subject || '');
    const teacher = escapeXml(formatTeacherName(lesson.teacher, 16));
    const isLecture = colorSet.type === 'lecture';

    const { lines: subjLines, fSize } = wrapSubjectText(subj, cardW);
    const maxBadgeW = cardW - 32;
    const { label: roomLabel, fontSize: roomFontSize, badgeW: roomW } = getRoomBadge(lesson.room, maxBadgeW);
    const roomH = 40;
    const roomX = cardX + cardW - roomW - 16;
    const roomY = cardY + cardH - roomH - 12;

    return `
      <g filter="url(#shadow-card)">
        <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="20" ry="20" fill="${colorSet.bg}" stroke="${colorSet.border}" stroke-width="2"></rect>

        <rect x="${cardX + 24}" y="${cardY + 16}" width="${isLecture ? 116 : 108}" height="32" rx="8" fill="${colorSet.tagBg}"></rect>
        <text x="${cardX + (isLecture ? 82 : 78)}" y="${cardY + 33}" font-size="18" font-weight="800" text-anchor="middle" dominant-baseline="central" fill="${colorSet.tagText}">${isLecture ? "MA'RUZA" : "SEMINAR"}</text>

        ${teacher ? `<text x="${cardX + cardW - 20}" y="${cardY + 33}" font-size="22" font-weight="600" text-anchor="end" dominant-baseline="central" fill="${colorSet.accent}">${teacher}</text>` : ''}

        <!-- Subject Name -->
        <g transform="translate(${cardX + 24}, ${cardY + 98})">
          ${subjLines.map((l, idx) => `<text x="0" y="${idx * (fSize * 1.2)}" font-size="${fSize}" font-weight="800" fill="#FFFFFF">${l}</text>`).join('')}
        </g>

        <!-- Matte Pill Room Badge -->
        <rect x="${roomX}" y="${roomY}" width="${roomW}" height="${roomH}" rx="12" ry="12" fill="${colorSet.roomBg}"></rect>
        <g transform="translate(${roomX + 12}, ${roomY + 11})">
          <rect x="0" y="0" width="12" height="18" rx="2" fill="none" stroke="${colorSet.roomText}" stroke-width="1.8"/>
          <circle cx="9" cy="9" r="1.2" fill="${colorSet.roomText}"/>
        </g>
        <text x="${roomX + 32}" y="${roomY + roomH / 2 + 1}" font-size="${roomFontSize}" font-weight="900" text-anchor="start" dominant-baseline="central" fill="${colorSet.roomText}">${roomLabel}</text>
      </g>
    `;
  },
};

// ─── Concept 6: High-Contrast Dynamic Pro (Oversized Room Pills for Mobile Glance) ─
const THEME_6_HIGH_CONTRAST = {
  name: 'High-Contrast Glanceable Pro',
  isLight: false,
  canvasBg: '#050505',
  titleBarBg: '#121212',
  sideRailBg: '#121212',
  colBg1: '#0D0D0D',
  colBg2: '#161616',
  borderDivider: '#27272A',
  titleTextColor: '#FFFFFF',
  titleSubtitleColor: '#22C55E',
  titleAccentBar: '#22C55E',
  badgeBg: '#22C55E',
  badgeText: '#000000',
  timeColor: '#E4E4E7',
  dayTextColor: '#FFFFFF',
  shadowColor: '#000000',
  shadowOpacity: 0.75,
  renderCard: ({ lesson, baseX, baseY, span, cellW, colorSet }) => {
    const cardW = cellW * span - MARGIN * 2;
    const cardH = CELL_H - MARGIN * 2;
    const cardX = baseX + MARGIN;
    const cardY = baseY + MARGIN;

    const subj = escapeXml(lesson.subject || '');
    const teacher = escapeXml(formatTeacherName(lesson.teacher, 16));
    const isLecture = colorSet.type === 'lecture';

    const { lines: subjLines, fSize } = wrapSubjectText(subj, cardW);

    // Dynamic clean room banner text fitting cleanly inside card width
    const rawRoom = (lesson.room || '?').trim();
    let bannerText = `XONA: ${rawRoom}`;
    let roomFontSize = 24;
    if (rawRoom.length > 16) {
      bannerText = rawRoom;
      roomFontSize = 19;
    } else if (rawRoom.length > 11) {
      bannerText = `XONA ${rawRoom}`;
      roomFontSize = 21;
    }

    const bannerH = 50;
    const bannerY = cardY + cardH - bannerH;

    return `
      <g filter="url(#shadow-card)">
        <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="20" ry="20" fill="${colorSet.bg}" stroke="${colorSet.border}" stroke-width="2.5"></rect>

        <!-- Format Badge -->
        <rect x="${cardX + 20}" y="${cardY + 16}" width="${isLecture ? 116 : 108}" height="32" rx="6" fill="${colorSet.tagBg}"></rect>
        <text x="${cardX + (isLecture ? 78 : 74)}" y="${cardY + 33}" font-size="18" font-weight="900" text-anchor="middle" dominant-baseline="central" fill="${colorSet.tagText}">${isLecture ? "MA'RUZA" : "SEMINAR"}</text>

        ${teacher ? `<text x="${cardX + cardW - 20}" y="${cardY + 33}" font-size="22" font-weight="700" text-anchor="end" dominant-baseline="central" fill="${colorSet.accent}">${teacher}</text>` : ''}

        <!-- Subject Name -->
        <g transform="translate(${cardX + 24}, ${cardY + 98})">
          ${subjLines.map((l, idx) => `<text x="0" y="${idx * (fSize * 1.2)}" font-size="${fSize}" font-weight="900" fill="#FFFFFF">${l}</text>`).join('')}
        </g>

        <!-- Full Bottom Banner for Maximum Room Legibility (Exact Card Boundary) -->
        <path d="M ${cardX} ${bannerY} L ${cardX + cardW} ${bannerY} L ${cardX + cardW} ${cardY + cardH - 20} A 20 20 0 0 1 ${cardX + cardW - 20} ${cardY + cardH} L ${cardX + 20} ${cardY + cardH} A 20 20 0 0 1 ${cardX} ${cardY + cardH - 20} Z" fill="${colorSet.roomBg}"></path>
        <text x="${cardX + cardW / 2}" y="${bannerY + bannerH / 2}" font-size="${roomFontSize}" font-weight="900" text-anchor="middle" dominant-baseline="central" fill="${colorSet.roomText}">${escapeXml(bannerText)}</text>
      </g>
    `;
  },
};

const ALL_THEMES = [
  THEME_1_MODERN_DARK,
  THEME_2_SWISS_LIGHT,
  THEME_3_GLASS_CYBER,
  THEME_4_ACADEMIC_NAVY,
  THEME_5_NORDIC_PASTEL,
  THEME_6_HIGH_CONTRAST,
];

// ─── Main Execution ──────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Initializing Design Variants Generation...');
  await edupageService.warmUpCache();

  const testGroup = 'BHA_51K';
  const schedule = await edupageService.getRawSchedule(testGroup);
  if (!schedule) {
    throw new Error(`Schedule for ${testGroup} not found!`);
  }

  const previewsDir = path.join(__dirname, '../previews');
  if (!fs.existsSync(previewsDir)) fs.mkdirSync(previewsDir, { recursive: true });

  const generatedFiles = [];

  for (let idx = 0; idx < ALL_THEMES.length; idx++) {
    const theme = ALL_THEMES[idx];
    const filename = `variant_${idx + 1}_${theme.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}.png`;
    const outPath = path.join(previewsDir, filename);

    console.log(`🎨 Rendering [${idx + 1}/6] ${theme.name}...`);
    const svgStr = renderScheduleSvg(testGroup, schedule, theme);

    const buf = await sharp(Buffer.from(svgStr))
      .png({ palette: true, quality: 90, compressionLevel: 7, effort: 3 })
      .toBuffer();

    fs.writeFileSync(outPath, buf);
    console.log(`✅ Saved: ${filename} (${Math.round(buf.length / 1024)} KB)`);

    generatedFiles.push({
      index: idx + 1,
      name: theme.name,
      filename,
      isLight: theme.isLight,
      sizeKb: Math.round(buf.length / 1024),
    });
  }

  // Generate Interactive HTML Comparison Gallery
  const htmlGallery = `<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dars Jadvali — 6 Ta Premium Dizayn Varianti</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Plus Jakarta Sans', sans-serif; background: #090D16; color: #F8FAFC; }
    .glass-nav { background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(12px); border-bottom: 1px solid rgba(255,255,255,0.08); }
    .card-zoom { transition: transform 0.25s ease, box-shadow 0.25s ease; }
    .card-zoom:hover { transform: translateY(-4px); }
  </style>
</head>
<body class="min-h-screen pb-24">
  <!-- Sticky Header -->
  <header class="sticky top-0 z-50 glass-nav px-8 py-4 flex items-center justify-between">
    <div class="flex items-center gap-4">
      <span class="w-3.5 h-3.5 rounded-full bg-emerald-500 animate-pulse"></span>
      <h1 class="text-xl font-bold tracking-tight text-white">TsUE Dars Jadvali — 6 Ta Premium Dizayn Konsepti</h1>
      <span class="text-xs bg-slate-800 text-slate-400 px-2.5 py-1 rounded-full border border-slate-700">10 Yillik Tajriba Standarti</span>
    </div>
    <div class="text-sm text-slate-400 font-medium">Guruh: <strong class="text-white">${testGroup}</strong></div>
  </header>

  <!-- Hero introduction -->
  <main class="max-w-7xl mx-auto px-6 pt-10">
    <div class="mb-10 text-center max-w-3xl mx-auto">
      <h2 class="text-3xl sm:text-4xl font-extrabold text-white mb-3">Qaysi dizayn ko'zingizga yoqdi?</h2>
      <p class="text-slate-400 text-base leading-relaxed">
        Har bir dizaynda <span class="text-emerald-400 font-semibold">bitta fanning ma'ruzasi to'yingan rangda</span>, <span class="text-sky-400 font-semibold">seminari esa o'sha rangning ochroq tusida</span> ishlangan. Xonalar katta va bir qarashda ko'rinadi.
      </p>
    </div>

    <!-- Gallery Grid -->
    <div class="space-y-16">
      ${generatedFiles.map(f => `
        <section class="bg-slate-900/90 rounded-3xl border border-slate-800 overflow-hidden shadow-2xl p-6 sm:p-8 card-zoom">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
            <div>
              <div class="flex items-center gap-3">
                <span class="px-3 py-1 text-xs font-extrabold rounded-lg bg-indigo-600 text-white">VARIANT ${f.index}</span>
                <h3 class="text-2xl font-bold text-white">${f.name}</h3>
                <span class="text-xs px-2.5 py-0.5 rounded-full ${f.isLight ? 'bg-amber-400/10 text-amber-400 border border-amber-400/20' : 'bg-slate-800 text-slate-400 border border-slate-700'}">${f.isLight ? 'Light Rejim' : 'Dark Rejim'}</span>
              </div>
              <p class="text-sm text-slate-400 mt-1.5">Fayl nomi: <code class="text-slate-300 font-mono text-xs bg-slate-800 px-2 py-0.5 rounded">${f.filename}</code> • Hajmi: <strong>${f.sizeKb} KB</strong></p>
            </div>
            <a href="${f.filename}" target="_blank" class="inline-flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 text-white text-sm font-semibold px-5 py-2.5 rounded-xl border border-slate-700 transition">
              🔍 To'liq o'lchamda ko'rish (2970px)
            </a>
          </div>

          <!-- Image Container -->
          <div class="rounded-2xl overflow-hidden border border-slate-800 bg-black/40 shadow-inner">
            <a href="${f.filename}" target="_blank">
              <img src="${f.filename}" alt="${f.name}" class="w-full h-auto object-cover hover:opacity-95 transition" loading="lazy" />
            </a>
          </div>
        </section>
      `).join('')}
    </div>
  </main>
</body>
</html>`;

  fs.writeFileSync(path.join(previewsDir, 'index.html'), htmlGallery, 'utf8');
  console.log('🎉 HTML Comparison Gallery generated at: previews/index.html');
}

main().catch(err => {
  console.error('Fatal error generating variants:', err);
  process.exit(1);
});
