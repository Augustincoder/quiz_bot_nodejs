'use strict';
const sharp = require('sharp');

// ═══════════════════════════════════════════════════════════════════════════
// LAYOUT CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const LAYOUT = {
  // Canvas
  CANVAS_WIDTH: 2970,
  CANVAS_HEIGHT: 1860,
  
  // Title bar (reduced from 220 → 110)
  TITLE_HEIGHT: 110,
  TITLE_FONT_SIZE: 56,
  TITLE_ACCENT_WIDTH: 6,
  
  // Grid structure
  DAY_COLUMN_WIDTH: 155,
  PERIOD_COLUMNS: 8,
  DAY_ROWS: 6,
  CELL_WIDTH: 342.25,
  CELL_HEIGHT: 257,
  
  // Period header zone (reduced spacing)
  HEADER_TOP_PADDING: 16,
  HEADER_PILL_HEIGHT: 40,
  HEADER_PILL_WIDTH: 48,
  HEADER_TIME_GAP: 12,
  HEADER_BOTTOM_PADDING: 20,
  
  // Period header typography
  PERIOD_NUMBER_FONT: 26,
  PERIOD_TIME_FONT: 19,
  
  // Day label
  DAY_FONT_SIZE: 35,
  
  // Card spacing and structure
  CARD_MARGIN: 16,
  CARD_PADDING: 18,
  CARD_RADIUS: 15,
  CARD_ACCENT_WIDTH: 4,
  CARD_ACCENT_INSET: 9,
  
  // Card internal zones
  CARD_TEACHER_ZONE: 38,
  CARD_ROOM_ZONE: 40,
  
  // Visual polish
  SHADOW_BLUR: 4,
  SHADOW_DY: 2,
  SHADOW_OPACITY: 0.055,
  GRID_LINE_WIDTH: 1.5,
  STRONG_LINE_WIDTH: 2.5
};

// Derived measurements
const GRID_X = LAYOUT.DAY_COLUMN_WIDTH;
const HEADER_HEIGHT = 
  LAYOUT.HEADER_TOP_PADDING + 
  LAYOUT.HEADER_PILL_HEIGHT + 
  LAYOUT.HEADER_TIME_GAP + 
  LAYOUT.PERIOD_TIME_FONT + 8 + 
  LAYOUT.HEADER_BOTTOM_PADDING;

const GRID_Y = LAYOUT.TITLE_HEIGHT + HEADER_HEIGHT;
const GRID_WIDTH = LAYOUT.CELL_WIDTH * LAYOUT.PERIOD_COLUMNS;
const GRID_HEIGHT = LAYOUT.CELL_HEIGHT * LAYOUT.DAY_ROWS;

// ═══════════════════════════════════════════════════════════════════════════
// COLOR SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

const PASTEL_BG = [
  '#FFE2E2', '#E2F0CB', '#EAE4E9', '#FFF1E6', '#FDE2E4',
  '#FAD2E1', '#C5DEDD', '#DBE7E4', '#F0EFEB', '#D6E2E9',
  '#BCD4E6', '#99C1B9', '#F3C6D1', '#E2D5DF', '#FFEBB5',
  '#CDEFE5', '#F6E8EA', '#D3E4CD', '#FEF5ED', '#E8DFF5'
];

const ACCENT_FG = [
  '#991B1B', '#365314', '#3B2F44', '#7C2D12', '#9F1239',
  '#831843', '#134E4A', '#1E3A35', '#44403C', '#1E3A5F',
  '#1E3A5F', '#134E4A', '#881337', '#4A1D3F', '#713F12',
  '#134E4A', '#9F1239', '#14532D', '#7C4B00', '#3B0764'
];

const COLORS = {
  BG: '#F8FAFC',
  TITLE_BAR: '#FFFFFF',
  TITLE_TEXT: '#0F172A',
  TITLE_ACCENT: '#334155',
  HEADER_BG: '#F1F5F9',
  DAY_BG: '#FAFBFC',
  PILL_BG: '#E2E8F0',
  PILL_TEXT: '#334155',
  TIME_TEXT: '#94A3B8',
  DAY_TEXT: '#1E293B',
  LINE_LIGHT: '#E2E8F0',
  LINE_STRONG: '#CBD5E1',
  ALT_FILL: '#F1F5F9',
  ROOM_BG: '#FFFFFF',
  SHADOW: '#0F172A'
};

// ═══════════════════════════════════════════════════════════════════════════
// TEXT UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

function escapeXml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe).replace(/[<>&'"]/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  }[c]));
}

/**
 * Estimate pixel width of text.
 * Calibrated for Segoe UI / Roboto: avg char ≈ 0.53 × fontSize.
 */
function textWidth(str, fontSize) {
  return str.length * fontSize * 0.53;
}

/**
 * Intelligently wrap text to fit maxWidth at given fontSize.
 * Handles long words by hard-breaking them.
 */
function wrapText(text, maxWidth, fontSize) {
  if (!text) return [];
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  
  for (let word of words) {
    // Hard-break overlong words
    while (textWidth(word, fontSize) > maxWidth) {
      const chars = Math.floor(maxWidth / (fontSize * 0.53)) - 1;
      if (chars < 3) break;
      lines.push(word.slice(0, chars) + '…');
      word = word.slice(chars);
    }
    
    const test = line ? `${line} ${word}` : word;
    if (textWidth(test, fontSize) <= maxWidth) {
      line = test;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Fit text into a bounded box by iteratively adjusting font size.
 * Returns { fontSize, lines, lineHeight } that fit within constraints.
 */
function fitText(text, maxWidth, maxHeight, startSize, minSize, maxLines = 4) {
  let size = startSize;
  
  while (size >= minSize) {
    const lineH = Math.round(size * 1.25);
    const lines = wrapText(text, maxWidth, size);
    const totalH = lines.length * lineH;
    
    if (totalH <= maxHeight && lines.length <= maxLines) {
      return { fontSize: size, lines, lineHeight: lineH };
    }
    size -= 2;
  }
  
  // Fallback: truncate to maxLines
  const lineH = Math.round(minSize * 1.25);
  let lines = wrapText(text, maxWidth, minSize);
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = lines[maxLines - 1].slice(0, -1) + '…';
  }
  return { fontSize: minSize, lines, lineHeight: lineH };
}

// ═══════════════════════════════════════════════════════════════════════════
// SVG BUILDING BLOCKS
// ═══════════════════════════════════════════════════════════════════════════

function buildTitleBar(className) {
  const cx = LAYOUT.CANVAS_WIDTH / 2;
  const cy = LAYOUT.TITLE_HEIGHT / 2;
  
  return `
  <!-- Title bar -->
  <rect x="0" y="0" width="${LAYOUT.CANVAS_WIDTH}" height="${LAYOUT.TITLE_HEIGHT}"
    fill="${COLORS.TITLE_BAR}" filter="url(#shadow)"/>
  <rect x="0" y="0" width="${LAYOUT.TITLE_ACCENT_WIDTH}" height="${LAYOUT.TITLE_HEIGHT}"
    fill="${COLORS.TITLE_ACCENT}"/>
  <text x="${cx}" y="${cy}"
    font-size="${LAYOUT.TITLE_FONT_SIZE}"
    text-anchor="middle" dominant-baseline="central"
    style="font-family: 'Segoe UI', Roboto, sans-serif;
           font-weight: 800; fill: ${COLORS.TITLE_TEXT};
           letter-spacing: 1.5px;">${escapeXml(className)} — Haftalik Dars Jadvali</text>
`;
}

function buildPeriodHeaders() {
  const times = [
    '08:30–09:50', '10:00–11:20', '11:30–12:50', '13:30–14:50',
    '15:00–16:20', '16:30–17:50', '18:00–19:20', '19:30–20:50'
  ];
  
  const headerY = LAYOUT.TITLE_HEIGHT;
  const pillY = headerY + LAYOUT.HEADER_TOP_PADDING;
  const timeY = pillY + LAYOUT.HEADER_PILL_HEIGHT + LAYOUT.HEADER_TIME_GAP + LAYOUT.PERIOD_TIME_FONT / 2;
  
  let svg = `
  <!-- Header background -->
  <rect x="${GRID_X}" y="${headerY}" width="${GRID_WIDTH}" height="${HEADER_HEIGHT}"
    fill="${COLORS.HEADER_BG}"/>
`;
  
  for (let i = 0; i < 8; i++) {
    const colX = GRID_X + i * LAYOUT.CELL_WIDTH;
    const midX = colX + LAYOUT.CELL_WIDTH / 2;
    
    // Subtle alternating column tint
    if (i % 2 === 1) {
      svg += `
  <rect x="${colX}" y="${GRID_Y}" width="${LAYOUT.CELL_WIDTH}" height="${GRID_HEIGHT}"
    fill="${COLORS.ALT_FILL}" opacity="0.35"/>`;
    }
    
    // Vertical divider
    if (i > 0) {
      svg += `
  <line x1="${colX}" y1="${headerY}" x2="${colX}" y2="${GRID_Y + GRID_HEIGHT}"
    stroke="${COLORS.LINE_LIGHT}" stroke-width="${LAYOUT.GRID_LINE_WIDTH}"
    stroke-dasharray="4,4" opacity="0.7"/>`;
    }
    
    // Period pill
    const pw = LAYOUT.HEADER_PILL_WIDTH;
    const ph = LAYOUT.HEADER_PILL_HEIGHT;
    svg += `
  <rect x="${midX - pw/2}" y="${pillY}" width="${pw}" height="${ph}" rx="11"
    fill="${COLORS.PILL_BG}"/>
  <text x="${midX}" y="${pillY + ph/2}"
    font-size="${LAYOUT.PERIOD_NUMBER_FONT}"
    text-anchor="middle" dominant-baseline="central"
    style="font-weight: 700; font-family: 'Segoe UI', Roboto, sans-serif;
           fill: ${COLORS.PILL_TEXT};">${i + 1}</text>`;
    
    // Time label
    svg += `
  <text x="${midX}" y="${timeY}"
    font-size="${LAYOUT.PERIOD_TIME_FONT}"
    text-anchor="middle" dominant-baseline="central"
    style="font-weight: 500; font-family: 'Segoe UI', Roboto, sans-serif;
           fill: ${COLORS.TIME_TEXT};">${times[i]}</text>`;
  }
  
  return svg;
}

function buildDayLabels() {
  const days = ['Dush', 'Sesh', 'Chor', 'Pay', 'Juma', 'Shan'];
  const midX = GRID_X / 2;
  
  let svg = `
  <!-- Day column background -->
  <rect x="0" y="${GRID_Y}" width="${GRID_X}" height="${GRID_HEIGHT}"
    fill="${COLORS.DAY_BG}"/>
`;
  
  for (let i = 0; i < 6; i++) {
    const rowY = GRID_Y + i * LAYOUT.CELL_HEIGHT;
    const midY = rowY + LAYOUT.CELL_HEIGHT / 2;
    
    if (i > 0) {
      svg += `
  <line x1="0" y1="${rowY}" x2="${GRID_X + GRID_WIDTH}" y2="${rowY}"
    stroke="${COLORS.LINE_LIGHT}" stroke-width="${LAYOUT.GRID_LINE_WIDTH}"/>`;
    }
    
    svg += `
  <text x="${midX}" y="${midY}"
    font-size="${LAYOUT.DAY_FONT_SIZE}"
    text-anchor="middle" dominant-baseline="central"
    style="font-weight: 700; font-family: 'Segoe UI', Roboto, sans-serif;
           fill: ${COLORS.DAY_TEXT};">${days[i]}</text>`;
  }
  
  return svg;
}

function buildGridStructure() {
  return `
  <!-- Main grid separators -->
  <line x1="${GRID_X}" y1="${LAYOUT.TITLE_HEIGHT}" x2="${GRID_X}" y2="${GRID_Y + GRID_HEIGHT}"
    stroke="${COLORS.LINE_STRONG}" stroke-width="${LAYOUT.STRONG_LINE_WIDTH}"/>
  <line x1="0" y1="${GRID_Y}" x2="${GRID_X + GRID_WIDTH}" y2="${GRID_Y}"
    stroke="${COLORS.LINE_STRONG}" stroke-width="${LAYOUT.STRONG_LINE_WIDTH}"/>
`;
}

/**
 * Render a lesson card with intelligent text fitting.
 */
function buildLessonCard(lesson, col, row, span, bgColor, fgColor) {
  const cardW = LAYOUT.CELL_WIDTH * span - LAYOUT.CARD_MARGIN * 2;
  const cardH = LAYOUT.CELL_HEIGHT - LAYOUT.CARD_MARGIN * 2;
  const cardX = GRID_X + col * LAYOUT.CELL_WIDTH + LAYOUT.CARD_MARGIN;
  const cardY = GRID_Y + row * LAYOUT.CELL_HEIGHT + LAYOUT.CARD_MARGIN;
  
  const pad = LAYOUT.CARD_PADDING;
  const innerW = cardW - pad * 2;
  
  const teacher = escapeXml(lesson.teacher || '');
  const subject = escapeXml(lesson.subject || '');
  const room = escapeXml(lesson.room || '');
  
  let svg = `
  <!-- Card -->
  <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}"
    rx="${LAYOUT.CARD_RADIUS}" fill="${bgColor}" filter="url(#shadow)"/>`;
  
  // Accent bar
  const barH = cardH - LAYOUT.CARD_ACCENT_INSET * 2;
  svg += `
  <rect x="${cardX + LAYOUT.CARD_ACCENT_INSET}" y="${cardY + LAYOUT.CARD_ACCENT_INSET}"
    width="${LAYOUT.CARD_ACCENT_WIDTH}" height="${barH}" rx="2"
    fill="${fgColor}" opacity="0.3"/>`;
  
  // ─── Teacher (top zone) ───
  const teacherY = cardY + LAYOUT.CARD_TEACHER_ZONE / 2;
  const teacherFit = fitText(teacher, innerW - 16, LAYOUT.CARD_TEACHER_ZONE - 4, 22, 16, 1);
  const teacherText = teacherFit.lines[0] || '';
  
  svg += `
  <text x="${cardX + pad}" y="${teacherY}"
    font-size="${teacherFit.fontSize}"
    text-anchor="start" dominant-baseline="central"
    style="font-weight: 600; font-family: 'Segoe UI', Roboto, sans-serif;
           fill: ${fgColor}; opacity: 0.85;">${teacherText}</text>`;
  
  // Divider
  const divY = cardY + LAYOUT.CARD_TEACHER_ZONE;
  svg += `
  <line x1="${cardX + pad}" y1="${divY}" x2="${cardX + cardW - pad}" y2="${divY}"
    stroke="${fgColor}" stroke-width="1" opacity="0.12"/>`;
  
  // ─── Subject (middle zone) ───
  const subjectZoneH = cardH - LAYOUT.CARD_TEACHER_ZONE - LAYOUT.CARD_ROOM_ZONE;
  const subjectFit = fitText(subject, innerW, subjectZoneH - 8, 28, 16, 4);
  
  const totalH = subjectFit.lines.length * subjectFit.lineHeight;
  const startY = divY + (subjectZoneH - totalH) / 2 + subjectFit.lineHeight / 2;
  
  const tspans = subjectFit.lines.map((ln, i) =>
    `<tspan x="${cardX + cardW / 2}" ${i > 0 ? `dy="${subjectFit.lineHeight}"` : ''}>${ln}</tspan>`
  ).join('');
  
  svg += `
  <text y="${startY}"
    font-size="${subjectFit.fontSize}"
    text-anchor="middle" dominant-baseline="central"
    style="font-weight: 800; font-family: 'Segoe UI', Roboto, sans-serif;
           fill: ${fgColor};">${tspans}</text>`;
  
  // ─── Room badge (bottom zone) ───
  if (room) {
    const badgeH = 30;
    const badgeW = Math.max(textWidth(room, 18) + 28, 60);
    const badgeX = cardX + cardW - badgeW - 11;
    const badgeY = cardY + cardH - badgeH - 8;
    
    svg += `
  <rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="${badgeH}" rx="9"
    fill="${COLORS.ROOM_BG}" opacity="0.65"/>
  <text x="${badgeX + badgeW / 2}" y="${badgeY + badgeH / 2}"
    font-size="18"
    text-anchor="middle" dominant-baseline="central"
    style="font-weight: 700; font-family: 'Segoe UI', Roboto, sans-serif;
           fill: ${fgColor};">${room}</text>`;
  }
  
  return svg;
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

async function generateScheduleImage(className, schedule) {
  const colorMap = {};
  const accentMap = {};
  let colorIdx = 0;
  
  const getColors = (subject) => {
    const key = subject || '';
    if (!colorMap[key]) {
      colorMap[key] = PASTEL_BG[colorIdx % PASTEL_BG.length];
      accentMap[key] = ACCENT_FG[colorIdx % ACCENT_FG.length];
      colorIdx++;
    }
    return { bg: colorMap[key], fg: accentMap[key] };
  };
  
  let cards = '';
  
  for (let day = 0; day < 6; day++) {
    if (!schedule[day]) continue;
    
    let period = 1;
    while (period <= 8) {
      const lessons = schedule[day][period];
      if (!lessons || lessons.length === 0) {
        period++;
        continue;
      }
      
      const lesson = lessons[0];
      let span = lesson.weight > 1 ? lesson.weight : 1;
      
      // Auto-detect consecutive identical lessons
      if (span === 1) {
        while (period + span <= 8) {
          const next = schedule[day][period + span];
          if (next && next[0] &&
              next[0].subject === lesson.subject &&
              next[0].teacher === lesson.teacher) {
            span++;
          } else {
            break;
          }
        }
      }
      
      // Clamp to grid bounds
      if (period + span - 1 > 8) span = 8 - period + 1;
      
      const col = period - 1;
      const colors = getColors(lesson.subject);
      cards += buildLessonCard(lesson, col, day, span, colors.bg, colors.fg);
      
      period += span;
    }
  }
  
  const svg = `
<svg width="${LAYOUT.CANVAS_WIDTH}" height="${LAYOUT.CANVAS_HEIGHT}"
     viewBox="0 0 ${LAYOUT.CANVAS_WIDTH} ${LAYOUT.CANVAS_HEIGHT}"
     xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="shadow" x="-10%" y="-10%" width="125%" height="130%">
      <feDropShadow dx="0" dy="${LAYOUT.SHADOW_DY}" stdDeviation="${LAYOUT.SHADOW_BLUR}"
        flood-color="${COLORS.SHADOW}" flood-opacity="${LAYOUT.SHADOW_OPACITY}"/>
    </filter>
  </defs>
  
  <rect width="${LAYOUT.CANVAS_WIDTH}" height="${LAYOUT.CANVAS_HEIGHT}" fill="${COLORS.BG}"/>
  
  ${buildTitleBar(className)}
  ${buildPeriodHeaders()}
  ${buildDayLabels()}
  ${buildGridStructure()}
  
  <g id="cards">${cards}</g>
</svg>`;
  
  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { generateScheduleImage };