'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');

// Disable internal libvips cache and concurrency to prevent memory leaks/buildup
sharp.cache(false);
sharp.concurrency(1);

// Sync bundled fonts to ~/.fonts for fontconfig/librsvg detection
try {
  const userFontsDir = path.join(os.homedir(), '.fonts');
  const projectFonts = path.join(__dirname, '../../assets/fonts');
  if (fs.existsSync(projectFonts)) {
    if (!fs.existsSync(userFontsDir)) fs.mkdirSync(userFontsDir, { recursive: true });
    for (const file of fs.readdirSync(projectFonts)) {
      if (file.endsWith('.otf') || file.endsWith('.ttf')) {
        const dest = path.join(userFontsDir, file);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(path.join(projectFonts, file), dest);
        }
      }
    }
  }
} catch {
  // Silent fallback if filesystem is read-only
}

// ─── Dimensions & Geometry ───────────────────────────────────────────────────
const DAY_W   = 230;
const TITLE_H = 200;
const HDR_H   = 190;
const CELL_H  = 340;
const MARGIN  = 14;

const TIMES = [
  '08:00–09:20', '09:30–10:50', '11:00–12:20', '13:00–14:20',
  '14:30–15:50', '16:00–17:20', '17:30–18:50', '19:00–20:20',
];
const DAY_NAMES = ['Dush', 'Sesh', 'Chor', 'Pay', 'Juma', 'Shan'];

// ─── Text Processing Helpers ─────────────────────────────────────────────────
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
  // Preserve full subject name including (Ma), (Sem), (Lab) as requested by user
  return subject.trim().replace(/\s+/g, ' ');
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

function formatSingleTeacher(name) {
  if (!name) return '';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0]} ${parts[1][0]}.`;
  }
  return parts[0] || '';
}

function parseTeachers(name) {
  if (!name) return [];
  return name
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
    .map(formatSingleTeacher);
}

function formatTeacherName(name) {
  const list = parseTeachers(name);
  if (list.length === 0) return '';
  const result = list.join(', ');
  return result.length > 28 ? result.slice(0, 27) + '…' : result;
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

// Load raw groups from groups.json for exact naming
let rawGroupsMap = new Map();
try {
  const groupsPath = path.join(__dirname, '../data/groups.json');
  if (fs.existsSync(groupsPath)) {
    const arr = JSON.parse(fs.readFileSync(groupsPath, 'utf8'));
    for (const g of arr) {
      if (typeof g === 'string' && g.trim()) {
        const norm = g.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (norm && !rawGroupsMap.has(norm)) {
          rawGroupsMap.set(norm, g.trim());
        }
      }
    }
  }
} catch {
  // Silent fallback
}

function resolveRawGroupName(name) {
  if (!name) return '';
  const norm = name.toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (rawGroupsMap.has(norm)) {
    return rawGroupsMap.get(norm);
  }
  return name.toString().trim();
}

function formatRoomBanner(rawRoom, cardW = 400) {
  let room = (rawRoom || '').trim();
  room = room.replace(/\s*\(?(maruza|seminar|amaliy|lab)\)?\s*/gi, '').trim();

  // Strip leading "xona" or "xona:" or "xona -" if present
  room = room.replace(/^xona\s*[:\-\s]*/i, '').trim();

  let label = (!room || room === '?') ? 'ANIQMAS' : room.toUpperCase();

  // Base font size: 46px for maximum legibility and presence
  let fontSize = 46;
  const safeW = cardW - 44; // safe width inside rounded banner

  // Dynamically calculate font size to guarantee 100% containment
  const charRatio = 0.62;
  while (fontSize > 22 && (label.length * fontSize * charRatio) > safeW) {
    fontSize -= 1;
  }

  if ((label.length * fontSize * charRatio) > safeW) {
    const maxChars = Math.floor(safeW / (fontSize * charRatio));
    label = label.slice(0, Math.max(6, maxChars - 1)) + '…';
  }

  const letterSpacing = fontSize >= 38 ? '1.5px' : '0.5px';

  return { label, fontSize, letterSpacing };
}

function getLessonType(subject) {
  if (!subject) return 'other';
  const s = subject.toString();
  if (/\((lab|laboratoriya|лаб)\)/i.test(s) || /\b(lab|laboratoriya|labaratoriya)\b/i.test(s)) return 'lab';
  if (/\((amal|amaliy|praktika)\)/i.test(s) || /\b(amaliy|praktika)\b/i.test(s)) return 'practice';
  if (/\((sem|pr|seminar|сем)\)/i.test(s) || /\b(seminar)\b/i.test(s)) return 'seminar';
  if (/\((ma|lk|lek|ma['ʼ`]?ruza|lektsiya|leksiya|лек|ма)\)/i.test(s) || /\b(ma['ʼ`]?ruza|leksiya|lektsiya)\b/i.test(s)) return 'lecture';
  if (/\((ma'naviyat|manaviyat|tyutorlik|tyutorlik soati)\)/i.test(s)) return 'spiritual';
  return 'other';
}

function getLessonBadge(type, rawSubject = '') {
  switch (type) {
    case 'lecture': return "MA'RUZA";
    case 'seminar': return "SEMINAR";
    case 'lab': return "LABORATORIYA";
    case 'practice': return "AMALIY";
    case 'spiritual': return "MA'NAVIYAT";
    default: {
      const m = (rawSubject || '').match(/\((.*?)\)/);
      if (m && m[1] && m[1].length <= 12) {
        return m[1].toUpperCase().trim();
      }
      return "DARS";
    }
  }
}

function cleanForClustering(str) {
  return (str || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-z0-9\u0400-\u04FF\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordsMatch(w1, w2) {
  if (w1 === w2) return true;
  if (w1.length >= 3 && w2.length >= 3) {
    if (w1.startsWith(w2) || w2.startsWith(w1)) return true;
  }
  return false;
}

function areSameSubject(s1, s2) {
  const c1 = cleanForClustering(s1);
  const c2 = cleanForClustering(s2);
  if (c1 === c2) return true;

  const words1 = c1.split(' ').filter(w => w.length >= 2);
  const words2 = c2.split(' ').filter(w => w.length >= 2);
  if (words1.length === 0 || words2.length === 0) return false;

  let matches = 0;
  for (const w1 of words1) {
    if (words2.some(w2 => wordsMatch(w1, w2))) {
      matches++;
    }
  }

  const minWords = Math.min(words1.length, words2.length);
  if (minWords <= 2) {
    return matches >= minWords && (matches / Math.max(words1.length, words2.length) >= 0.5);
  }

  const ratio1 = matches / words1.length;
  const ratio2 = matches / words2.length;
  return matches >= 2 && (ratio1 >= 0.6 || ratio2 >= 0.6);
}

function clusterSubjects(schedule) {
  const allSubjects = new Set();
  for (let d = 0; d < 6; d++) {
    if (!schedule[d]) continue;
    for (let p = 1; p <= 8; p++) {
      if (!schedule[d][p]) continue;
      for (const l of schedule[d][p]) {
        if (l.subject) allSubjects.add(l.subject.trim());
      }
    }
  }

  const clusters = [];
  for (const subj of allSubjects) {
    let added = false;
    for (const cluster of clusters) {
      if (cluster.some(existing => areSameSubject(existing, subj))) {
        cluster.push(subj);
        added = true;
        break;
      }
    }
    if (!added) {
      clusters.push([subj]);
    }
  }

  const subjectToPaletteIndex = new Map();
  clusters.forEach((cluster, idx) => {
    for (const s of cluster) {
      subjectToPaletteIndex.set(s.toLowerCase(), idx);
    }
  });
  return subjectToPaletteIndex;
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

// ─── PALETTES DEFINITIONS ────────────────────────────────────────────────────

// 1. FRESH SLATE DARK (Variant 6A) — Ma'ruza: To'qroq | Seminar: Sezilarli ochroq va yorqin | Lab: Texnik aksent
const FRESH_SLATE_PALETTES = [
  // 1. Sky Azure (Moviy Ko'k)
  {
    name: 'Sky Azure',
    lecture: {
      bg: '#081730', border: '#2563EB', subjText: '#FFFFFF',
      accent: '#93C5FD', tagBg: '#1D4ED8', tagText: '#FFFFFF',
      roomBg: '#1D4ED8', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#122B54', border: '#38BDF8', subjText: '#F8FAFC',
      accent: '#BAE6FD', tagBg: '#38BDF8', tagText: '#082F49',
      roomBg: '#38BDF8', roomText: '#082F49',
    },
    lab: {
      bg: '#0A2540', border: '#00F2FE', subjText: '#F0F9FF',
      accent: '#67E8F9', tagBg: '#00F2FE', tagText: '#082F49',
      roomBg: '#0284C7', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#181A3D', border: '#818CF8', subjText: '#EEF2FF',
      accent: '#C7D2FE', tagBg: '#818CF8', tagText: '#0F172A',
      roomBg: '#4F46E5', roomText: '#FFFFFF',
    },
  },
  // 2. Emerald Mint (Zumrad Yashil)
  {
    name: 'Emerald Mint',
    lecture: {
      bg: '#042217', border: '#059669', subjText: '#FFFFFF',
      accent: '#6EE7B7', tagBg: '#047857', tagText: '#FFFFFF',
      roomBg: '#047857', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#0D4230', border: '#34D399', subjText: '#F0FDF4',
      accent: '#A7F3D0', tagBg: '#34D399', tagText: '#022C22',
      roomBg: '#34D399', roomText: '#022C22',
    },
    lab: {
      bg: '#042D2B', border: '#14B8A6', subjText: '#F0FDFA',
      accent: '#5EEAD4', tagBg: '#14B8A6', tagText: '#042F2E',
      roomBg: '#0D9488', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#153610', border: '#84CC16', subjText: '#F7FEE7',
      accent: '#BEF264', tagBg: '#84CC16', tagText: '#14532D',
      roomBg: '#65A30D', roomText: '#FFFFFF',
    },
  },
  // 3. Warm Amber (Yorqin Malla / Oltin Asal)
  {
    name: 'Warm Amber',
    lecture: {
      bg: '#2B1705', border: '#D97706', subjText: '#FFFFFF',
      accent: '#FDE68A', tagBg: '#B45309', tagText: '#FFFFFF',
      roomBg: '#B45309', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#452608', border: '#FBBF24', subjText: '#FFFBEB',
      accent: '#FED7AA', tagBg: '#FBBF24', tagText: '#451A03',
      roomBg: '#FBBF24', roomText: '#451A03',
    },
    lab: {
      bg: '#3A1F06', border: '#F59E0B', subjText: '#FFFBEB',
      accent: '#FCD34D', tagBg: '#FCD34D', tagText: '#451A03',
      roomBg: '#D97706', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#331B05', border: '#EAB308', subjText: '#FEFCE8',
      accent: '#FDE047', tagBg: '#EAB308', tagText: '#451A03',
      roomBg: '#CA8A04', roomText: '#FFFFFF',
    },
  },
  // 4. Ruby Crimson (Yorqin Qizil / Yoqut)
  {
    name: 'Ruby Crimson',
    lecture: {
      bg: '#2B0A0E', border: '#DC2626', subjText: '#FFFFFF',
      accent: '#FECACA', tagBg: '#B91C1C', tagText: '#FFFFFF',
      roomBg: '#B91C1C', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#4A1118', border: '#F87171', subjText: '#FEF2F2',
      accent: '#FEE2E2', tagBg: '#F87171', tagText: '#450A0A',
      roomBg: '#F87171', roomText: '#450A0A',
    },
    lab: {
      bg: '#3B0D14', border: '#EF4444', subjText: '#FEF2F2',
      accent: '#FCA5A5', tagBg: '#EF4444', tagText: '#FFFFFF',
      roomBg: '#DC2626', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#360910', border: '#E11D48', subjText: '#FFF1F2',
      accent: '#FDA4AF', tagBg: '#E11D48', tagText: '#FFFFFF',
      roomBg: '#BE123C', roomText: '#FFFFFF',
    },
  },
  // 5. Roasted Bronze (Boy Jigarrang / Shokolad)
  {
    name: 'Roasted Bronze',
    lecture: {
      bg: '#211209', border: '#92400E', subjText: '#FFFFFF',
      accent: '#FDE68A', tagBg: '#78350F', tagText: '#FFFFFF',
      roomBg: '#78350F', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#3D2010', border: '#D97706', subjText: '#FFFBEB',
      accent: '#FED7AA', tagBg: '#D97706', tagText: '#FFFFFF',
      roomBg: '#D97706', roomText: '#FFFFFF',
    },
    lab: {
      bg: '#2F190D', border: '#B45309', subjText: '#FFFBEB',
      accent: '#FCD34D', tagBg: '#B45309', tagText: '#FFFFFF',
      roomBg: '#92400E', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#29150B', border: '#CA8A04', subjText: '#FEFCE8',
      accent: '#FEF08A', tagBg: '#CA8A04', tagText: '#422006',
      roomBg: '#A16207', roomText: '#FFFFFF',
    },
  },
  // 6. Electric Violet (Yorqin Siyohrang)
  {
    name: 'Electric Violet',
    lecture: {
      bg: '#1A0E30', border: '#7C3AED', subjText: '#FFFFFF',
      accent: '#D8B4FE', tagBg: '#6D28D9', tagText: '#FFFFFF',
      roomBg: '#6D28D9', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#35185C', border: '#C084FC', subjText: '#FAF5FF',
      accent: '#E9D5FF', tagBg: '#C084FC', tagText: '#2E1065',
      roomBg: '#C084FC', roomText: '#2E1065',
    },
    lab: {
      bg: '#26063F', border: '#E879F9', subjText: '#FDF4FF',
      accent: '#F0ABFC', tagBg: '#E879F9', tagText: '#3B0764',
      roomBg: '#C026D3', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#191642', border: '#6366F1', subjText: '#EEF2FF',
      accent: '#A5B4FC', tagBg: '#6366F1', tagText: '#1E1B4B',
      roomBg: '#4F46E5', roomText: '#FFFFFF',
    },
  },
  // 7. Vibrant Teal (Firuza Dengiz)
  {
    name: 'Vibrant Teal',
    lecture: {
      bg: '#042224', border: '#0D9488', subjText: '#FFFFFF',
      accent: '#5EEAD4', tagBg: '#0F766E', tagText: '#FFFFFF',
      roomBg: '#0F766E', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#0E3E42', border: '#2DD4BF', subjText: '#F0FDFA',
      accent: '#CCFBF1', tagBg: '#2DD4BF', tagText: '#042F2E',
      roomBg: '#2DD4BF', roomText: '#042F2E',
    },
    lab: {
      bg: '#04282D', border: '#06B6D4', subjText: '#ECFDF5',
      accent: '#67E8F9', tagBg: '#06B6D4', tagText: '#042F2E',
      roomBg: '#0891B2', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#072435', border: '#38BDF8', subjText: '#F0F9FF',
      accent: '#7DD3FC', tagBg: '#38BDF8', tagText: '#082F49',
      roomBg: '#0284C7', roomText: '#FFFFFF',
    },
  },
  // 8. Sunset Orange (Olovrang Apelsin)
  {
    name: 'Sunset Orange',
    lecture: {
      bg: '#2C1204', border: '#EA580C', subjText: '#FFFFFF',
      accent: '#FDBA74', tagBg: '#C2410C', tagText: '#FFFFFF',
      roomBg: '#C2410C', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#471C07', border: '#FB923C', subjText: '#FFF7ED',
      accent: '#FFEDD5', tagBg: '#FB923C', tagText: '#431407',
      roomBg: '#FB923C', roomText: '#431407',
    },
    lab: {
      bg: '#381505', border: '#F97316', subjText: '#FFF7ED',
      accent: '#FED7AA', tagBg: '#F97316', tagText: '#FFFFFF',
      roomBg: '#EA580C', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#341705', border: '#F59E0B', subjText: '#FFFBEB',
      accent: '#FDE68A', tagBg: '#F59E0B', tagText: '#451A03',
      roomBg: '#D97706', roomText: '#FFFFFF',
    },
  },
  // 9. Rose Magenta (Pushti Yoqut)
  {
    name: 'Rose Magenta',
    lecture: {
      bg: '#2C0815', border: '#E11D48', subjText: '#FFFFFF',
      accent: '#FDA4AF', tagBg: '#BE123C', tagText: '#FFFFFF',
      roomBg: '#BE123C', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#54132C', border: '#FB7185', subjText: '#FDF2F8',
      accent: '#FCE7F3', tagBg: '#FB7185', tagText: '#4C0519',
      roomBg: '#FB7185', roomText: '#4C0519',
    },
    lab: {
      bg: '#380617', border: '#F43F5E', subjText: '#FFF1F2',
      accent: '#FDA4AF', tagBg: '#F43F5E', tagText: '#4C0519',
      roomBg: '#E11D48', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#2C0A33', border: '#C084FC', subjText: '#FAF5FF',
      accent: '#E9D5FF', tagBg: '#C084FC', tagText: '#2E1065',
      roomBg: '#9333EA', roomText: '#FFFFFF',
    },
  },
  // 10. Lime Chartreuse (Limon & Ohak Yashil)
  {
    name: 'Lime Chartreuse',
    lecture: {
      bg: '#142207', border: '#65A30D', subjText: '#FFFFFF',
      accent: '#BEF264', tagBg: '#4D7C0F', tagText: '#FFFFFF',
      roomBg: '#4D7C0F', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#233B0B', border: '#A3E635', subjText: '#F7FEE7',
      accent: '#ECFCCB', tagBg: '#A3E635', tagText: '#14532D',
      roomBg: '#A3E635', roomText: '#14532D',
    },
    lab: {
      bg: '#1B2E09', border: '#84CC16', subjText: '#F7FEE7',
      accent: '#D9F99D', tagBg: '#84CC16', tagText: '#14532D',
      roomBg: '#65A30D', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#1E320A', border: '#4ADE80', subjText: '#F0FDF4',
      accent: '#BBF7D0', tagBg: '#4ADE80', tagText: '#052E16',
      roomBg: '#16A34A', roomText: '#FFFFFF',
    },
  },
];

// 2. CLEAN AIR LIGHT (Variant 6B) — Ma'ruza: To'yingan pastel | Seminar: Juda och oqish | Lab/Amaliy: Ajralib turuvchi
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
    lab: {
      bg: '#E0F2FE', border: '#0891B2', subjText: '#0F172A',
      accent: '#0E7490', tagBg: '#0891B2', tagText: '#FFFFFF',
      roomBg: '#0891B2', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#EEF2FF', border: '#4F46E5', subjText: '#0F172A',
      accent: '#4338CA', tagBg: '#4F46E5', tagText: '#FFFFFF',
      roomBg: '#4F46E5', roomText: '#FFFFFF',
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
    lab: {
      bg: '#CCFBF1', border: '#0D9488', subjText: '#0F172A',
      accent: '#115E59', tagBg: '#0D9488', tagText: '#FFFFFF',
      roomBg: '#0D9488', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#F7FEE7', border: '#65A30D', subjText: '#0F172A',
      accent: '#4D7C0F', tagBg: '#65A30D', tagText: '#FFFFFF',
      roomBg: '#65A30D', roomText: '#FFFFFF',
    },
  },
  // 3. Warm Amber (Malla)
  {
    name: 'Warm Amber',
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
    lab: {
      bg: '#FEF08A', border: '#EA580C', subjText: '#0F172A',
      accent: '#9A3412', tagBg: '#EA580C', tagText: '#FFFFFF',
      roomBg: '#EA580C', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#FEF9C3', border: '#CA8A04', subjText: '#0F172A',
      accent: '#854D0E', tagBg: '#CA8A04', tagText: '#FFFFFF',
      roomBg: '#CA8A04', roomText: '#FFFFFF',
    },
  },
  // 4. Ruby Crimson (Qizil)
  {
    name: 'Ruby Crimson',
    lecture: {
      bg: '#FECDD3', border: '#B91C1C', subjText: '#0F172A',
      accent: '#7F1D1D', tagBg: '#B91C1C', tagText: '#FFFFFF',
      roomBg: '#B91C1C', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#FFF1F2', border: '#DC2626', subjText: '#1E293B',
      accent: '#991B1B', tagBg: '#DC2626', tagText: '#FFFFFF',
      roomBg: '#DC2626', roomText: '#FFFFFF',
    },
    lab: {
      bg: '#FFE4E6', border: '#EF4444', subjText: '#0F172A',
      accent: '#B91C1C', tagBg: '#EF4444', tagText: '#FFFFFF',
      roomBg: '#EF4444', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#FEE2E2', border: '#E11D48', subjText: '#0F172A',
      accent: '#9F1239', tagBg: '#E11D48', tagText: '#FFFFFF',
      roomBg: '#E11D48', roomText: '#FFFFFF',
    },
  },
  // 5. Roasted Bronze (Jigarrang)
  {
    name: 'Roasted Bronze',
    lecture: {
      bg: '#E7D7CB', border: '#78350F', subjText: '#0F172A',
      accent: '#451A03', tagBg: '#78350F', tagText: '#FFFFFF',
      roomBg: '#78350F', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#FBF8F5', border: '#92400E', subjText: '#1E293B',
      accent: '#78350F', tagBg: '#92400E', tagText: '#FFFFFF',
      roomBg: '#92400E', roomText: '#FFFFFF',
    },
    lab: {
      bg: '#EFE5DC', border: '#B45309', subjText: '#0F172A',
      accent: '#78350F', tagBg: '#B45309', tagText: '#FFFFFF',
      roomBg: '#B45309', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#F5EBE1', border: '#A16207', subjText: '#0F172A',
      accent: '#713F12', tagBg: '#A16207', tagText: '#FFFFFF',
      roomBg: '#A16207', roomText: '#FFFFFF',
    },
  },
  // 6. Purple
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
    lab: {
      bg: '#F5D0FE', border: '#C026D3', subjText: '#0F172A',
      accent: '#86198F', tagBg: '#C026D3', tagText: '#FFFFFF',
      roomBg: '#C026D3', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#E0E7FF', border: '#4338CA', subjText: '#0F172A',
      accent: '#3730A3', tagBg: '#4338CA', tagText: '#FFFFFF',
      roomBg: '#4338CA', roomText: '#FFFFFF',
    },
  },
  // 7. Teal
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
    lab: {
      bg: '#CFFAFE', border: '#0284C7', subjText: '#0F172A',
      accent: '#0369A1', tagBg: '#0284C7', tagText: '#FFFFFF',
      roomBg: '#0284C7', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#D1FAE5', border: '#059669', subjText: '#0F172A',
      accent: '#047857', tagBg: '#059669', tagText: '#FFFFFF',
      roomBg: '#059669', roomText: '#FFFFFF',
    },
  },
  // 8. Sunset Orange
  {
    name: 'Sunset Orange',
    lecture: {
      bg: '#FED7AA', border: '#C2410C', subjText: '#0F172A',
      accent: '#7C2D12', tagBg: '#C2410C', tagText: '#FFFFFF',
      roomBg: '#C2410C', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#FFF7ED', border: '#EA580C', subjText: '#1E293B',
      accent: '#9A3412', tagBg: '#EA580C', tagText: '#FFFFFF',
      roomBg: '#EA580C', roomText: '#FFFFFF',
    },
    lab: {
      bg: '#FFEDD5', border: '#F97316', subjText: '#0F172A',
      accent: '#9A3412', tagBg: '#F97316', tagText: '#FFFFFF',
      roomBg: '#F97316', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#FEF3C7', border: '#D97706', subjText: '#0F172A',
      accent: '#92400E', tagBg: '#D97706', tagText: '#FFFFFF',
      roomBg: '#D97706', roomText: '#FFFFFF',
    },
  },
  // 9. Rose
  {
    name: 'Rose',
    lecture: {
      bg: '#FBCFE8', border: '#BE123C', subjText: '#0F172A',
      accent: '#881337', tagBg: '#BE123C', tagText: '#FFFFFF',
      roomBg: '#BE123C', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#FDF2F8', border: '#E11D48', subjText: '#1E293B',
      accent: '#BE123C', tagBg: '#E11D48', tagText: '#FFFFFF',
      roomBg: '#E11D48', roomText: '#FFFFFF',
    },
    lab: {
      bg: '#FFE4E6', border: '#F43F5E', subjText: '#0F172A',
      accent: '#9F1239', tagBg: '#F43F5E', tagText: '#FFFFFF',
      roomBg: '#F43F5E', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#FCE7F3', border: '#DB2777', subjText: '#0F172A',
      accent: '#9D174D', tagBg: '#DB2777', tagText: '#FFFFFF',
      roomBg: '#DB2777', roomText: '#FFFFFF',
    },
  },
  // 10. Lime Chartreuse
  {
    name: 'Lime Chartreuse',
    lecture: {
      bg: '#D9F99D', border: '#4D7C0F', subjText: '#0F172A',
      accent: '#365314', tagBg: '#4D7C0F', tagText: '#FFFFFF',
      roomBg: '#4D7C0F', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#F7FEE7', border: '#65A30D', subjText: '#1E293B',
      accent: '#4D7C0F', tagBg: '#65A30D', tagText: '#FFFFFF',
      roomBg: '#65A30D', roomText: '#FFFFFF',
    },
    lab: {
      bg: '#ECFCCB', border: '#84CC16', subjText: '#0F172A',
      accent: '#3F6212', tagBg: '#84CC16', tagText: '#FFFFFF',
      roomBg: '#84CC16', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#DCFCE7', border: '#16A34A', subjText: '#0F172A',
      accent: '#14532D', tagBg: '#16A34A', tagText: '#FFFFFF',
      roomBg: '#16A34A', roomText: '#FFFFFF',
    },
  },
];

// 3. VIBRANT TINT SLATE (Variant 6C) — Toza Slate bazasi, o'ta kontrastli neon xona va teglari
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
    lab: {
      bg: '#0B132B', border: '#06B6D4', subjText: '#FFFFFF',
      accent: '#67E8F9', tagBg: '#06B6D4', tagText: '#082F49',
      roomBg: '#0891B2', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#131A2E', border: '#818CF8', subjText: '#FFFFFF',
      accent: '#C7D2FE', tagBg: '#818CF8', tagText: '#0F172A',
      roomBg: '#4F46E5', roomText: '#FFFFFF',
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
    lab: {
      bg: '#0B1A1E', border: '#10B981', subjText: '#FFFFFF',
      accent: '#6EE7B7', tagBg: '#10B981', tagText: '#022C22',
      roomBg: '#059669', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#131D24', border: '#84CC16', subjText: '#FFFFFF',
      accent: '#BEF264', tagBg: '#84CC16', tagText: '#14532D',
      roomBg: '#65A30D', roomText: '#FFFFFF',
    },
  },
  // 3. Warm Amber (Malla)
  {
    name: 'Warm Amber',
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
    lab: {
      bg: '#1A1412', border: '#F59E0B', subjText: '#FFFFFF',
      accent: '#FCD34D', tagBg: '#F59E0B', tagText: '#451A03',
      roomBg: '#D97706', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#181512', border: '#EAB308', subjText: '#FFFFFF',
      accent: '#FDE047', tagBg: '#EAB308', tagText: '#451A03',
      roomBg: '#CA8A04', roomText: '#FFFFFF',
    },
  },
  // 4. Ruby Crimson (Qizil)
  {
    name: 'Ruby Crimson',
    lecture: {
      bg: '#0F172A', border: '#B91C1C', subjText: '#FFFFFF',
      accent: '#F87171', tagBg: '#B91C1C', tagText: '#FFFFFF',
      roomBg: '#B91C1C', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#1E293B', border: '#EF4444', subjText: '#F1F5F9',
      accent: '#FCA5A5', tagBg: '#EF4444', tagText: '#FFFFFF',
      roomBg: '#DC2626', roomText: '#FFFFFF',
    },
    lab: {
      bg: '#1A0E10', border: '#F87171', subjText: '#FFFFFF',
      accent: '#FECACA', tagBg: '#F87171', tagText: '#450A0A',
      roomBg: '#B91C1C', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#170D12', border: '#E11D48', subjText: '#FFFFFF',
      accent: '#FDA4AF', tagBg: '#E11D48', tagText: '#FFFFFF',
      roomBg: '#BE123C', roomText: '#FFFFFF',
    },
  },
  // 5. Roasted Bronze (Jigarrang)
  {
    name: 'Roasted Bronze',
    lecture: {
      bg: '#0F172A', border: '#78350F', subjText: '#FFFFFF',
      accent: '#FCD34D', tagBg: '#78350F', tagText: '#FFFFFF',
      roomBg: '#78350F', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#1E293B', border: '#D97706', subjText: '#F1F5F9',
      accent: '#FED7AA', tagBg: '#D97706', tagText: '#FFFFFF',
      roomBg: '#D97706', roomText: '#FFFFFF',
    },
    lab: {
      bg: '#18120F', border: '#B45309', subjText: '#FFFFFF',
      accent: '#FDE68A', tagBg: '#B45309', tagText: '#FFFFFF',
      roomBg: '#92400E', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#16110D', border: '#CA8A04', subjText: '#FFFFFF',
      accent: '#FEF08A', tagBg: '#CA8A04', tagText: '#422006',
      roomBg: '#A16207', roomText: '#FFFFFF',
    },
  },
  // 6. Purple
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
    lab: {
      bg: '#141126', border: '#D946EF', subjText: '#FFFFFF',
      accent: '#F0ABFC', tagBg: '#D946EF', tagText: '#3B0764',
      roomBg: '#C026D3', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#15132B', border: '#6366F1', subjText: '#FFFFFF',
      accent: '#A5B4FC', tagBg: '#6366F1', tagText: '#1E1B4B',
      roomBg: '#4F46E5', roomText: '#FFFFFF',
    },
  },
  // 7. Teal
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
    lab: {
      bg: '#0A1820', border: '#10B981', subjText: '#FFFFFF',
      accent: '#6EE7B7', tagBg: '#10B981', tagText: '#022C22',
      roomBg: '#059669', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#0B1626', border: '#38BDF8', subjText: '#F0F9FF',
      accent: '#7DD3FC', tagBg: '#38BDF8', tagText: '#082F49',
      roomBg: '#0284C7', roomText: '#FFFFFF',
    },
  },
  // 8. Sunset Orange
  {
    name: 'Sunset Orange',
    lecture: {
      bg: '#0F172A', border: '#EA580C', subjText: '#FFFFFF',
      accent: '#FB923C', tagBg: '#C2410C', tagText: '#FFFFFF',
      roomBg: '#C2410C', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#1E293B', border: '#FB923C', subjText: '#F1F5F9',
      accent: '#FED7AA', tagBg: '#FB923C', tagText: '#431407',
      roomBg: '#FB923C', roomText: '#431407',
    },
    lab: {
      bg: '#1A130E', border: '#F97316', subjText: '#FFFFFF',
      accent: '#FED7AA', tagBg: '#F97316', tagText: '#FFFFFF',
      roomBg: '#EA580C', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#18120B', border: '#F59E0B', subjText: '#FFFFFF',
      accent: '#FDE047', tagBg: '#F59E0B', tagText: '#451A03',
      roomBg: '#D97706', roomText: '#FFFFFF',
    },
  },
  // 9. Rose
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
    lab: {
      bg: '#1A0E18', border: '#F43F5E', subjText: '#FFFFFF',
      accent: '#FDA4AF', tagBg: '#F43F5E', tagText: '#4C0519',
      roomBg: '#E11D48', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#180F22', border: '#C084FC', subjText: '#FFFFFF',
      accent: '#E9D5FF', tagBg: '#C084FC', tagText: '#2E1065',
      roomBg: '#9333EA', roomText: '#FFFFFF',
    },
  },
  // 10. Lime Chartreuse
  {
    name: 'Lime Chartreuse',
    lecture: {
      bg: '#0F172A', border: '#4D7C0F', subjText: '#FFFFFF',
      accent: '#A3E635', tagBg: '#4D7C0F', tagText: '#FFFFFF',
      roomBg: '#4D7C0F', roomText: '#FFFFFF',
    },
    seminar: {
      bg: '#1E293B', border: '#A3E635', subjText: '#F1F5F9',
      accent: '#ECFCCB', tagBg: '#A3E635', tagText: '#14532D',
      roomBg: '#A3E635', roomText: '#14532D',
    },
    lab: {
      bg: '#121A0F', border: '#84CC16', subjText: '#FFFFFF',
      accent: '#D9F99D', tagBg: '#84CC16', tagText: '#14532D',
      roomBg: '#65A30D', roomText: '#FFFFFF',
    },
    practice: {
      bg: '#0F1A14', border: '#10B981', subjText: '#FFFFFF',
      accent: '#6EE7B7', tagBg: '#10B981', tagText: '#022C22',
      roomBg: '#059669', roomText: '#FFFFFF',
    },
  },
];

// ─── THEME CONFIGURATIONS ────────────────────────────────────────────────────
const THEMES = {
  dark: {
    name: 'Fresh Slate Dark',
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
  light: {
    name: 'Clean Air Light',
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
  vibrant: {
    name: 'Vibrant Tint Slate',
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
};

// ─── Card Renderer ───────────────────────────────────────────────────────────
function buildCardSvg(lesson, baseX, baseY, span, cellW, colorSet) {
  const cardW = cellW * span - MARGIN * 2;
  const cardH = CELL_H - MARGIN * 2;
  const cardX = baseX + MARGIN;
  const cardY = baseY + MARGIN;

  const rawSubj = lesson.subject || '';
  const cleanSubj = cleanSubjectTitle(rawSubj);
  const subj = escapeXml(cleanSubj);

  // 1. Subject text
  const { lines: subjLines, fSize } = wrapSubjectText(subj, cardW);

  // 2. Room banner (Priority #1)
  const rawRoom = (lesson.room || '?').trim();
  const { label: roomLabel, fontSize: roomFontSize, letterSpacing: roomLetterSpacing } = formatRoomBanner(rawRoom, cardW);
  const bannerH = 70;
  const bannerY = cardY + cardH - bannerH;

  // 3. Format badge & Teacher layout (Senior Ultra-Visible Badge & Pro Layout)
  const tagLabel = getLessonBadge(colorSet.type, colorSet.rawSubject || rawSubj);
  const isLongTag = tagLabel.length > 8;
  const tagFontSize = isLongTag ? 22 : 26;
  const tagLetterSpacing = isLongTag ? '0.8px' : '1.2px';
  // Generous horizontal padding on both sides so text never touches the pill edges
  const tagPadX = 26;
  const estTextW = isLongTag ? (tagLabel.length * 14.5) : (tagLabel.length * 17.5);
  const tagW = Math.max(isLongTag ? 225 : 180, Math.round(estTextW + tagPadX * 2));
  const tagH = 48;

  const teachers = parseTeachers(lesson.teacher);
  const maxTeacherW = cardW - 20 - tagW - 24 - 20;

  let teacherSvg = '';
  let topZoneY = cardY + 16 + tagH;

  if (teachers.length === 1) {
    let tStr = teachers[0];
    let fSize = 32;
    while (fSize > 22 && (tStr.length * fSize * 0.58) > maxTeacherW) {
      fSize -= 1;
    }
    if ((tStr.length * fSize * 0.58) > maxTeacherW) {
      const maxChars = Math.floor(maxTeacherW / (fSize * 0.58));
      tStr = tStr.slice(0, Math.max(4, maxChars - 1)) + '…';
    }
    const tY = cardY + 16 + tagH / 2 + 1;
    teacherSvg = `
      <text x="${cardX + cardW - 20}" y="${tY}"
            font-size="${fSize}" font-weight="800" text-anchor="end" dominant-baseline="central"
            fill="${colorSet.accent}">${escapeXml(tStr)}</text>
    `;
  } else if (teachers.length >= 2) {
    const singleLine = teachers.join(', ');
    if (singleLine.length * 26 * 0.58 <= maxTeacherW) {
      const tY = cardY + 16 + tagH / 2 + 1;
      teacherSvg = `
        <text x="${cardX + cardW - 20}" y="${tY}"
              font-size="26" font-weight="800" text-anchor="end" dominant-baseline="central"
              fill="${colorSet.accent}">${escapeXml(singleLine)}</text>
      `;
    } else {
      let t1 = teachers[0];
      let t2 = teachers.slice(1).join(', ');
      let fSize1 = 25;
      let fSize2 = 25;
      while (fSize1 > 17 && (t1.length * fSize1 * 0.58) > maxTeacherW) fSize1--;
      while (fSize2 > 17 && (t2.length * fSize2 * 0.58) > maxTeacherW) fSize2--;
      if ((t1.length * fSize1 * 0.58) > maxTeacherW) {
        t1 = t1.slice(0, Math.floor(maxTeacherW / (fSize1 * 0.58)) - 1) + '…';
      }
      if ((t2.length * fSize2 * 0.58) > maxTeacherW) {
        t2 = t2.slice(0, Math.floor(maxTeacherW / (fSize2 * 0.58)) - 1) + '…';
      }

      topZoneY = cardY + 68;
      teacherSvg = `
        <text x="${cardX + cardW - 20}" y="${cardY + 24}"
              font-size="${fSize1}" font-weight="800" text-anchor="end" dominant-baseline="central"
              fill="${colorSet.accent}">${escapeXml(t1)}</text>
        <text x="${cardX + cardW - 20}" y="${cardY + 54}"
              font-size="${fSize2}" font-weight="800" text-anchor="end" dominant-baseline="central"
              fill="${colorSet.accent}">${escapeXml(t2)}</text>
      `;
    }
  }

  const availableH = bannerY - topZoneY - 14;
  const totalTextH = subjLines.length * (fSize * 1.18);
  const textStartY = Math.round(topZoneY + (availableH - totalTextH) / 2 + fSize * 0.85);

  return `
    <g>
      <!-- Card Base -->
      <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="22" ry="22"
            fill="${colorSet.bg}" stroke="${colorSet.border}" stroke-width="2.5"></rect>

      <!-- Lesson Format Badge (Priority #3 - Senior Ultra-Visible Pill) -->
      <rect x="${cardX + 20}" y="${cardY + 16}" width="${tagW}" height="${tagH}" rx="14" fill="${colorSet.tagBg}"></rect>
      <text x="${cardX + 20 + tagW / 2}" y="${cardY + 16 + tagH / 2 + 1}"
            font-size="${tagFontSize}" font-weight="900" letter-spacing="${tagLetterSpacing}"
            text-anchor="middle" dominant-baseline="central" fill="${colorSet.tagText}">${tagLabel}</text>

      <!-- Teacher Name (UPGRADED: 1-line or 2-line stacked for lab teachers) -->
      ${teacherSvg}

      <!-- Subject Title (Priority #2) -->
      <g transform="translate(${cardX + 24}, 0)">
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

// ─── Main Generator ──────────────────────────────────────────────────────────
async function generateScheduleImage(className, schedule, themeName = 'dark', options = {}) {
  const themeConfig = THEMES[themeName] || THEMES.dark;

  const maxPeriod  = getMaxActivePeriod(schedule);
  const activeDays = getActiveDays(schedule);
  const numRows    = activeDays.length;

  if (numRows === 0) throw new Error("Jadval bo'sh");

  // Guaranteed minimum width per period so evening groups (periods 6-8) are never squished
  const TARGET_MIN_CELL_W = 540;
  const CONTENT_W = Math.max(2740, maxPeriod * TARGET_MIN_CELL_W);
  const cellW     = CONTENT_W / maxPeriod;
  const SVG_W     = DAY_W + CONTENT_W;
  const gridY     = TITLE_H + HDR_H;
  const svgH      = gridY + numRows * CELL_H + 40;

  const subjectClusterMap = clusterSubjects(schedule);
  const palettes = themeConfig.palettes;

  function resolveColors(lesson) {
    const raw = (lesson.subject || '').trim();
    const type = getLessonType(raw);
    const clusterIdx = subjectClusterMap.get(raw.toLowerCase()) ?? 0;
    const pal = palettes[clusterIdx % palettes.length];

    let colorSet;
    if (type === 'lab') {
      colorSet = pal.lab || pal.seminar;
    } else if (type === 'practice') {
      colorSet = pal.practice || pal.seminar;
    } else if (type === 'seminar') {
      colorSet = pal.seminar;
    } else {
      colorSet = pal.lecture;
    }

    return { ...colorSet, type, rawSubject: raw };
  }

  // Header periods
  let headerHtml = '';
  for (let i = 0; i < maxPeriod; i++) {
    const bx = DAY_W + i * cellW;
    const midX = bx + cellW / 2;

    if (i > 0) {
      headerHtml += `<line x1="${bx}" y1="${TITLE_H}" x2="${bx}" y2="${gridY}" stroke="${themeConfig.borderDivider}" stroke-width="2"></line>`;
    }

    const cy = TITLE_H + 70;
    headerHtml += `<circle cx="${midX}" cy="${cy}" r="44" fill="${themeConfig.badgeBg}"></circle>`;
    headerHtml += `<text font-size="52" font-weight="900" text-anchor="middle" dominant-baseline="central" x="${midX}" y="${cy + 1}" fill="${themeConfig.badgeText}">${i + 1}</text>`;
    headerHtml += `<text font-size="38" font-weight="700" text-anchor="middle" dominant-baseline="auto" x="${midX}" y="${TITLE_H + HDR_H - 26}" fill="${themeConfig.timeColor}">${TIMES[i]}</text>`;
  }

  // Day labels
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

  // Zebra column stripes
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

      const combinedLesson = lessons.length > 1 ? {
        ...lesson,
        room: [...new Set(lessons.map(l => l.room).filter(Boolean))].join(', ') || lesson.room,
        teacher: [...new Set(lessons.map(l => l.teacher).filter(Boolean))].join(', ') || lesson.teacher,
      } : lesson;

      cardsHtml += buildCardSvg(combinedLesson, baseX, baseY, span, cellW, c);
      pNum += span;
    }
  }

  const displayGroupName = resolveRawGroupName(className);

  const svgString = `
<svg width="${SVG_W}" height="${svgH}" viewBox="0 0 ${SVG_W} ${svgH}"
     xmlns="http://www.w3.org/2000/svg"
     style="background-color: ${themeConfig.canvasBg}; font-family: 'Inter', sans-serif;">
  <rect x="0" y="0" width="${SVG_W}" height="${svgH}" fill="${themeConfig.canvasBg}"></rect>
  ${zebraHtml}
  <rect x="0" y="${TITLE_H}" width="${DAY_W}" height="${HDR_H + numRows * CELL_H}" fill="${themeConfig.isLight ? '#FFFFFF' : '#0B0F19'}"></rect>

  <rect x="0" y="0" width="${SVG_W}" height="${TITLE_H}" fill="${themeConfig.titleBarBg}"></rect>
  <rect x="0" y="0" width="14" height="${TITLE_H}" fill="${themeConfig.titleAccentBar}"></rect>

  <text font-size="104" font-weight="900" letter-spacing="3px"
        text-anchor="middle" dominant-baseline="central"
        x="${SVG_W / 2}" y="${TITLE_H / 2}" fill="${themeConfig.titleTextColor}">${escapeXml(displayGroupName)}</text>

  ${headerHtml}
  ${dayLabelsHtml}

  <line x1="${DAY_W}" y1="${TITLE_H}" x2="${DAY_W}" y2="${svgH}" stroke="${themeConfig.borderDivider}" stroke-width="3"></line>
  <line x1="0" y1="${gridY}" x2="${SVG_W}" y2="${gridY}" stroke="${themeConfig.borderDivider}" stroke-width="3"></line>

  ${cardsHtml}

  <rect x="0" y="0" width="${SVG_W}" height="${svgH}" fill="none" stroke="${themeConfig.borderDivider}" stroke-width="4"></rect>
</svg>
  `;

  if (options && options.returnSvg) {
    return svgString;
  }

  return sharp(Buffer.from(svgString))
    .png({
      compressionLevel: 4,
      effort: 1,
    })
    .toBuffer();
}

module.exports = {
  generateScheduleImage,
  THEMES,
  parseTeachers,
  formatTeacherName,
};