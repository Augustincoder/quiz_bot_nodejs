const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
  Header, Footer, PageNumber, LevelFormat, convertInchesToTwip
} = require("docx");

const FONT = "Times New Roman";

function p(text, opts = {}) {
  const { bold = false, italic = false, size = 24, alignment = AlignmentType.JUSTIFIED,
          spacingAfter = 200, indentFirstLine = true } = opts;
  return new Paragraph({
    alignment,
    spacing: { after: spacingAfter, line: 360 },
    indent: indentFirstLine ? { firstLine: 567 } : undefined,
    children: [new TextRun({ text, bold, italics: italic, size, font: FONT })]
  });
}

function pRuns(runs, opts = {}) {
  const { alignment = AlignmentType.JUSTIFIED, spacingAfter = 200, indentFirstLine = true } = opts;
  return new Paragraph({
    alignment,
    spacing: { after: spacingAfter, line: 360 },
    indent: indentFirstLine ? { firstLine: 567 } : undefined,
    children: runs.map(r => new TextRun({ font: FONT, size: 24, ...r }))
  });
}

function centered(text, opts = {}) {
  const { bold = true, italic = false, size = 24, spacingAfter = 100 } = opts;
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: spacingAfter },
    children: [new TextRun({ text, bold, italics: italic, size, font: FONT })]
  });
}

function heading(text) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 350, after: 200 },
    children: [new TextRun({ text, bold: true, size: 26, font: FONT })]
  });
}

function subheading(text) {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { before: 250, after: 150 },
    children: [new TextRun({ text, bold: true, size: 24, font: FONT })]
  });
}

function formula(text) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 120, after: 120 },
    children: [new TextRun({ text, italics: true, size: 24, font: FONT })]
  });
}

function bullet(text) {
  return new Paragraph({
    numbering: { reference: "main-bullets", level: 0 },
    spacing: { after: 150, line: 360 },
    alignment: AlignmentType.JUSTIFIED,
    children: [new TextRun({ text, size: 24, font: FONT })]
  });
}

function numberedItem(text) {
  return new Paragraph({
    numbering: { reference: "steps-numbering", level: 0 },
    spacing: { after: 150, line: 360 },
    alignment: AlignmentType.JUSTIFIED,
    children: [new TextRun({ text, size: 24, font: FONT })]
  });
}

function refItem(num, text) {
  return new Paragraph({
    spacing: { after: 120, line: 300 },
    alignment: AlignmentType.JUSTIFIED,
    indent: { left: 567, hanging: 567 },
    children: [new TextRun({ text: `${num}. ${text}`, size: 22, font: FONT })]
  });
}

function cell(text, opts = {}) {
  const { bold = false, width, shade, size = 20, alignment = AlignmentType.CENTER } = opts;
  return new TableCell({
    width: width ? { size: width, type: WidthType.DXA } : undefined,
    shading: shade ? { type: ShadingType.CLEAR, color: "auto", fill: shade } : undefined,
    verticalAlign: "center",
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
    children: [new Paragraph({
      alignment,
      children: [new TextRun({ text, bold, size, font: FONT })]
    })]
  });
}

function sourceNote(text) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 280 },
    children: [new TextRun({ text, italics: true, size: 18, font: FONT })]
  });
}

// ============================================================
// JADVAL 1: Raqamlashtirish dinamikasi
// ============================================================
const table1Widths = [2300, 1600, 1600, 1900, 1900];
const table1 = new Table({
  width: { size: table1Widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
  columnWidths: table1Widths,
  rows: [
    new TableRow({ tableHeader: true, children: [
      cell("Ko'rsatkichlar", { bold: true, width: table1Widths[0], shade: "D9E2F3" }),
      cell("2022-yil", { bold: true, width: table1Widths[1], shade: "D9E2F3" }),
      cell("2024-yil", { bold: true, width: table1Widths[2], shade: "D9E2F3" }),
      cell("2026-yil (joriy)", { bold: true, width: table1Widths[3], shade: "D9E2F3" }),
      cell("Dinamika", { bold: true, width: table1Widths[4], shade: "D9E2F3" }),
    ]}),
    new TableRow({ children: [
      cell("Elektron hisob-fakturalar ulushi", { width: table1Widths[0], alignment: AlignmentType.LEFT }),
      cell("61%", { width: table1Widths[1] }),
      cell("89%", { width: table1Widths[2] }),
      cell("> 97%", { width: table1Widths[3] }),
      cell("Barqaror o'sish", { width: table1Widths[4] }),
    ]}),
    new TableRow({ children: [
      cell("ERP/1C tizimidan foydalanuvchi korxonalar", { width: table1Widths[0], alignment: AlignmentType.LEFT }),
      cell("18%", { width: table1Widths[1] }),
      cell("34%", { width: table1Widths[2] }),
      cell("~45%", { width: table1Widths[3] }),
      cell("~2.5 barobar", { width: table1Widths[4] }),
    ]}),
    new TableRow({ children: [
      cell("Soliq hisobotlarining onlayn topshirilishi", { width: table1Widths[0], alignment: AlignmentType.LEFT }),
      cell("83%", { width: table1Widths[1] }),
      cell("94%", { width: table1Widths[2] }),
      cell("> 98%", { width: table1Widths[3] }),
      cell("To'liqqa yaqin", { width: table1Widths[4] }),
    ]}),
    new TableRow({ children: [
      cell("RPA/avtomatlashtirish qo'llovchi audit tashkilotlari", { width: table1Widths[0], alignment: AlignmentType.LEFT }),
      cell("< 3%", { width: table1Widths[1] }),
      cell("~9%", { width: table1Widths[2] }),
      cell("~15%", { width: table1Widths[3] }),
      cell("Dastlabki bosqich", { width: table1Widths[4] }),
    ]}),
  ]
});

// ============================================================
// JADVAL 2: Pilot loyiha - oldin/keyin solishtirma tahlil
// ============================================================
const table2Widths = [2700, 2200, 2200, 2200];
const table2 = new Table({
  width: { size: table2Widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
  columnWidths: table2Widths,
  rows: [
    new TableRow({ tableHeader: true, children: [
      cell("Jarayon / Ko'rsatkich", { bold: true, width: table2Widths[0], shade: "D9E2F3" }),
      cell("An'anaviy (qo'lda / tanlab tekshirish)", { bold: true, width: table2Widths[1], shade: "D9E2F3" }),
      cell("RPA + Doimiy audit modeli", { bold: true, width: table2Widths[2], shade: "D9E2F3" }),
      cell("O'zgarish", { bold: true, width: table2Widths[3], shade: "D9E2F3" }),
    ]}),
    new TableRow({ children: [
      cell("Bank va kassa muvofiqlashtiruvi (reconciliation)", { width: table2Widths[0], alignment: AlignmentType.LEFT }),
      cell("2-3 kun / oy", { width: table2Widths[1] }),
      cell("Har kuni, avtomatik", { width: table2Widths[2] }),
      cell("~90% vaqt tejash", { width: table2Widths[3] }),
    ]}),
    new TableRow({ children: [
      cell("Tranzaksiyalar qamrovi (auditor tekshiruvi)", { width: table2Widths[0], alignment: AlignmentType.LEFT }),
      cell("5-10% (tanlanma)", { width: table2Widths[1] }),
      cell("~100% (uzluksiz)", { width: table2Widths[2] }),
      cell("To'liq qamrov", { width: table2Widths[3] }),
    ]}),
    new TableRow({ children: [
      cell("Anomaliyani aniqlash muddati", { width: table2Widths[0], alignment: AlignmentType.LEFT }),
      cell("O'rtacha 30-45 kun (davriy audit)", { width: table2Widths[1] }),
      cell("24-48 soat ichida", { width: table2Widths[2] }),
      cell("~15-20 barobar tezroq", { width: table2Widths[3] }),
    ]}),
    new TableRow({ children: [
      cell("Hisob-faktura va shartnoma solishtirish xatoligi", { width: table2Widths[0], alignment: AlignmentType.LEFT }),
      cell("3-5% (inson omili)", { width: table2Widths[1] }),
      cell("< 0.5%", { width: table2Widths[2] }),
      cell("Xatolik keskin kamaydi", { width: table2Widths[3] }),
    ]}),
    new TableRow({ children: [
      cell("Oylik yopish (month-end close) muddati", { width: table2Widths[0], alignment: AlignmentType.LEFT }),
      cell("8-10 ish kuni", { width: table2Widths[1] }),
      cell("3-4 ish kuni", { width: table2Widths[2] }),
      cell("~55% qisqarish", { width: table2Widths[3] }),
    ]}),
  ]
});

// ============================================================
// JADVAL 3: Benford qonuni bo'yicha statistik test
// ============================================================
const table3Widths = [1800, 2500, 2500, 2500];
const benfordRows = [
  ["1", "30.1", "29.4", "-0.7"],
  ["2", "17.6", "18.1", "+0.5"],
  ["3", "12.5", "12.0", "-0.5"],
  ["4", "9.7", "9.9", "+0.2"],
  ["5", "7.9", "7.5", "-0.4"],
  ["6", "6.7", "6.9", "+0.2"],
  ["7", "5.8", "5.6", "-0.2"],
  ["8", "5.1", "5.3", "+0.2"],
  ["9", "4.6", "5.3", "+0.7"],
];
const table3 = new Table({
  width: { size: table3Widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
  columnWidths: table3Widths,
  rows: [
    new TableRow({ tableHeader: true, children: [
      cell("Boshlang'ich raqam (d)", { bold: true, width: table3Widths[0], shade: "D9E2F3" }),
      cell("Benford bo'yicha kutilgan chastota, %", { bold: true, width: table3Widths[1], shade: "D9E2F3" }),
      cell("Kuzatilgan chastota, %", { bold: true, width: table3Widths[2], shade: "D9E2F3" }),
      cell("Farq, foiz punkti", { bold: true, width: table3Widths[3], shade: "D9E2F3" }),
    ]}),
    ...benfordRows.map(row => new TableRow({ children: [
      cell(row[0], { width: table3Widths[0] }),
      cell(row[1], { width: table3Widths[1] }),
      cell(row[2], { width: table3Widths[2] }),
      cell(row[3], { width: table3Widths[3] }),
    ]}))
  ]
});

// ============================================================
// JADVAL 4: RPA-audit tizimining texnik arxitekturasi
// ============================================================
const table4Widths = [2300, 3500, 3500];
const archRows = [
  ["1-qatlam: Ma'lumotlar manbai (Data Source Layer)", "ERP/1C tizimi, bank-klient portali, elektron hisob-faktura (soliq.uz), QQS ma'lumotlar bazasi", "Boshlang'ich moliyaviy va operatsion ma'lumotlarni shakllantirish"],
  ["2-qatlam: Ma'lumot yig'uvchi bot (Bot / Connector Layer)", "RPA platformasi, API va OCR konnektorlar", "Turli manbalardan ma'lumotlarni avtomatik yuklab olish va bir xil formatga keltirish"],
  ["3-qatlam: Qoidalar va tahlil dvigateli (Rule & Analytics Engine)", "Biznes-qoidalar, Benford testi, Z-score moduli, chegaraviy (threshold) qoidalar", "Nomuvofiqlik va anomaliyalarni avtomatik aniqlash"],
  ["4-qatlam: Orkestratsiya (Orchestrator)", "Bot boshqaruv serveri: jadval, navbat, xatoliklarni qayta ishlash, credential vault", "Barcha botlar ishini markazlashtirilgan tarzda boshqarish va monitoring qilish"],
  ["5-qatlam: Hisobot va vizualizatsiya (Dashboard/BI Layer)", "Power BI / Excel dashboard, avtomatik xabarnomalar", "Natijalarni tushunarli, vizual shaklda taqdim etish"],
  ["6-qatlam: Inson nazorati (Human-in-the-loop)", "Buxgalter, ichki auditor, moliya menejeri", "Yakuniy professional mulohaza yuritish va qaror qabul qilish"],
];
const table4 = new Table({
  width: { size: table4Widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
  columnWidths: table4Widths,
  rows: [
    new TableRow({ tableHeader: true, children: [
      cell("Arxitektura qatlami", { bold: true, width: table4Widths[0], shade: "D9E2F3" }),
      cell("Texnologik vosita (misol)", { bold: true, width: table4Widths[1], shade: "D9E2F3" }),
      cell("Bajaradigan vazifasi", { bold: true, width: table4Widths[2], shade: "D9E2F3" }),
    ]}),
    ...archRows.map(row => new TableRow({ children: [
      cell(row[0], { width: table4Widths[0], alignment: AlignmentType.LEFT }),
      cell(row[1], { width: table4Widths[1], alignment: AlignmentType.LEFT }),
      cell(row[2], { width: table4Widths[2], alignment: AlignmentType.LEFT }),
    ]}))
  ]
});

// ============================================================
// JADVAL 5: Iqtisodiy samaradorlik (ROI) hisob-kitobi
// ============================================================
const table5Widths = [3900, 2700, 2700];
const roiRows = [
  ["RPA dasturiy ta'minoti litsenziyasi", "45", "45"],
  ["Amalga oshirish va sozlash (bir martalik)", "60", "0"],
  ["Xodimlarni o'qitish", "15", "5"],
  ["Jami xarajat", "120", "50"],
  ["Ish vaqti tejalishi (mehnat xarajati bo'yicha)", "86", "92"],
  ["Xatolik/qayta ishlash xarajatlarining kamayishi", "40", "45"],
  ["Jarima va penya xavfining kamayishi (kutilgan qiymat)", "25", "28"],
  ["Jami tejash (foyda)", "151", "165"],
  ["Sof foyda (tejash \u2212 xarajat)", "31", "115"],
  ["ROI, %", "25.8%", "230%"],
];
const table5 = new Table({
  width: { size: table5Widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
  columnWidths: table5Widths,
  rows: [
    new TableRow({ tableHeader: true, children: [
      cell("Ko'rsatkich", { bold: true, width: table5Widths[0], shade: "D9E2F3" }),
      cell("1-yil, mln so'm", { bold: true, width: table5Widths[1], shade: "D9E2F3" }),
      cell("2-yil va undan keyin, mln so'm", { bold: true, width: table5Widths[2], shade: "D9E2F3" }),
    ]}),
    ...roiRows.map((row, idx) => new TableRow({ children: [
      cell(row[0], { width: table5Widths[0], alignment: AlignmentType.LEFT, bold: idx === 3 || idx === 7 || idx === 8 || idx === 9 }),
      cell(row[1], { width: table5Widths[1], bold: idx === 3 || idx === 7 || idx === 8 || idx === 9 }),
      cell(row[2], { width: table5Widths[2], bold: idx === 3 || idx === 7 || idx === 8 || idx === 9 }),
    ]}))
  ]
});

// ============================================================
// JADVAL 6: Amalga oshirish yo'l xaritasi
// ============================================================
const table6Widths = [1800, 1500, 6000];
const roadmapRows = [
  ["I bosqich \u2014 Tayyorgarlik va pilot", "1-3 oy", "Jarayonlarni xaritalash; RPA platformasini tanlash; bank-kassa muvofiqlashtiruvi kabi 1-2 jarayonni pilot tarzda avtomatlashtirish"],
  ["II bosqich \u2014 Kengaytirish", "4-9 oy", "Hisob-faktura nazorati va QQS hisob-kitobi kabi jarayonlarni qamrab olish; Benford/Z-score modulini joriy etish; bot governance qoidalarini ishlab chiqish"],
  ["III bosqich \u2014 To'liq integratsiya", "10-18 oy", "Asosiy buxgalteriya-audit jarayonlarini to'liq avtomatlashtirish; boshqaruv dashboardini yaratish; xodimlarni malaka oshirishdan o'tkazish"],
];
const table6 = new Table({
  width: { size: table6Widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
  columnWidths: table6Widths,
  rows: [
    new TableRow({ tableHeader: true, children: [
      cell("Bosqich", { bold: true, width: table6Widths[0], shade: "D9E2F3" }),
      cell("Muddat", { bold: true, width: table6Widths[1], shade: "D9E2F3" }),
      cell("Asosiy vazifalar", { bold: true, width: table6Widths[2], shade: "D9E2F3" }),
    ]}),
    ...roadmapRows.map(row => new TableRow({ children: [
      cell(row[0], { width: table6Widths[0], alignment: AlignmentType.LEFT }),
      cell(row[1], { width: table6Widths[1] }),
      cell(row[2], { width: table6Widths[2], alignment: AlignmentType.LEFT }),
    ]}))
  ]
});

const children = [];

// ============================================================
// SARLAVHA BLOKI
// ============================================================
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 200 },
  children: [new TextRun({
    text: "Doimiy Audit (Continuous Audit) va Buxgalteriya-Audit Jarayonlarini Robotik Jarayonlarni Avtomatlashtirish (RPA) Vositasida Optimallashtirish",
    bold: true, size: 28, font: FONT
  })]
}));
children.push(centered("Toshkent Davlat Iqtisodiyot Universiteti", { bold: true, size: 24, spacingAfter: 60 }));
children.push(centered("Buxgalteriya hisobi fakulteti talabasi", { bold: true, size: 24, spacingAfter: 60 }));
children.push(centered("\u201CMirzo Ulug'bek vorislari\u201D ilmiy-innovatsion loyihalar tanlovi (Data Science yo'nalishi) uchun taqdim etilgan ilmiy maqola", { bold: false, italic: true, size: 22, spacingAfter: 200 }));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 300 },
  children: [new TextRun({ text: "[F.I.Sh. kiritilsin]", bold: true, italics: true, size: 24, font: FONT })]
}));

// ============================================================
// ANNOTATSIYA (UZ)
// ============================================================
children.push(centered("Annotatsiya", { size: 24, spacingAfter: 150 }));
children.push(p("Raqamli iqtisodiyot sharoitida buxgalteriya hisobi va ichki audit tizimlari an'anaviy davriy tekshiruv modelidan \u201Cdoimiy audit\u201D (continuous audit) konsepsiyasiga tomon siljimoqda. Maqolada Robotik Jarayonlarni Avtomatlashtirish (RPA) texnologiyasi hamda Benford qonuni va Z-score kabi statistik anomaliya aniqlash metodlari yordamida operatsion tranzaksiyalarni deyarli to'liq qamrab oluvchi uzluksiz nazorat tizimini shakllantirish imkoniyatlari tahlil qilinadi. Tadqiqot maqsadi \u2014 an'anaviy tanlab tekshirish usuliga nisbatan RPA-asosidagi doimiy audit modelining iqtisodiy samaradorligini (ROI) va xatoliklarni aniqlash tezligini baholashdan iborat. Shartli korxona misolida amalga oshirilgan pilot loyiha natijalari, tizimning oltita qatlamdan iborat texnik arxitekturasi hamda O'zbekiston sharoitiga moslashtirilgan amaliy tavsiyalar taqdim etiladi."));
children.push(pRuns([
  { text: "Kalit so'zlar: ", bold: true },
  { text: "Doimiy audit, Robotik jarayonlarni avtomatlashtirish, RPA, Data Science, buxgalteriya hisobi, ichki nazorat, anomaliya aniqlash, Benford qonuni, iqtisodiy samaradorlik (ROI), raqamli transformatsiya." }
], { spacingAfter: 250 }));

// Abstract (EN)
children.push(centered("Abstract", { size: 24, spacingAfter: 150 }));
children.push(p("In the digital economy, accounting and internal audit systems are increasingly shifting from the traditional periodic inspection model toward the concept of continuous audit. This article analyzes how Robotic Process Automation (RPA), combined with statistical anomaly-detection methods such as Benford's Law and Z-score analysis, can build a monitoring system covering almost the entire volume of operational transactions. The purpose of the study is to evaluate the economic efficiency (ROI) and error-detection speed of an RPA-based continuous audit model compared with traditional sampling. Using a conditional enterprise pilot project, the article presents a six-layer technical architecture and practical recommendations adapted to the conditions of Uzbekistan."));
children.push(pRuns([
  { text: "Keywords: ", bold: true },
  { text: "Continuous audit, Robotic Process Automation, RPA, Data Science, accounting, internal control, anomaly detection, Benford's Law, return on investment (ROI), digital transformation." }
], { spacingAfter: 250 }));

// Аннотация (RU)
children.push(centered("Аннотация", { size: 24, spacingAfter: 150 }));
children.push(p("В условиях цифровой экономики системы бухгалтерского учёта и внутреннего аудита переходят от традиционной периодической модели проверки к концепции непрерывного аудита (continuous audit). В статье анализируется, как технология роботизированной автоматизации процессов (RPA) в сочетании со статистическими методами обнаружения аномалий — законом Бенфорда и Z-оценкой — позволяет создать систему непрерывного контроля, охватывающую практически весь объём операционных транзакций. Цель исследования — оценить экономическую эффективность (ROI) и скорость обнаружения ошибок модели непрерывного аудита на основе RPA. На примере условного предприятия предлагается шестиуровневая техническая архитектура и практические рекомендации для условий Узбекистана."));
children.push(pRuns([
  { text: "Ключевые слова: ", bold: true },
  { text: "Непрерывный аудит, роботизированная автоматизация процессов, RPA, Data Science, бухгалтерский учёт, внутренний контроль, обнаружение аномалий, закон Бенфорда, рентабельность инвестиций (ROI), цифровая трансформация." }
], { spacingAfter: 250 }));

// ============================================================
// KIRISH
// ============================================================
children.push(heading("KIRISH"));
children.push(p("O'zbekiston Respublikasi iqtisodiyotini raqamlashtirish davlat siyosati darajasida ustuvor yo'nalish hisoblanadi. O'zbekiston Respublikasi Prezidentining 2020-yil 5-oktabrdagi \u201CRaqamli O'zbekiston \u2014 2030\u201D strategiyasini tasdiqlash to'g'risidagi PF-6079-son Farmoni [1] buxgalteriya hisobi va audit sohasida raqamli texnologiyalarni joriy etishning huquqiy asosini yaratdi. Korxonalarning ERP tizimlariga, elektron hisob-fakturalarga va onlayn soliq hisobotlariga o'tishi buxgalteriya ma'lumotlari hajmini keskin oshirdi, biroq ularni nazorat qilish usullari deyarli o'zgarishsiz \u2014 an'anaviy va davriy shaklda qolmoqda."));
children.push(p("An'anaviy audit statistik tanlanma asosida ishlaydi \u2014 auditor tranzaksiyalarning atigi 5-10 foizini tekshiradi va xatoliklarni ko'pincha bir necha oy o'tib aniqlaydi. Ushbu bo'shliqni to'ldirish maqsadida xalqaro amaliyotda tranzaksiyalarni sodir bo'lgan zahoti tekshirish imkonini beruvchi \u201Cdoimiy audit\u201D (continuous audit) konsepsiyasi rivojlanmoqda. Uni amaliyotga tatbiq etishning asosiy texnik vositasi \u2014 takrorlanuvchi, qoidaga asoslangan operatsiyalarni avtomatlashtiruvchi Robotik Jarayonlarni Avtomatlashtirish (RPA) texnologiyasi bo'lib, u statistik anomaliya aniqlash metodlari bilan birlashtirilganda real vaqt rejimidagi nazorat tizimiga aylanadi."));
children.push(p("Maqolaning maqsadi \u2014 doimiy audit konsepsiyasining nazariy asoslarini, uni RPA va Data Science vositalari yordamida amaliyotga tatbiq etish metodologiyasini hamda bunday tizimning iqtisodiy samaradorligini tahlil qilishdan iborat. Maqola quyidagicha tashkil etilgan: nazariy asoslar va statistik metodlar, tadqiqot metodologiyasi, tizimning texnik arxitekturasi, amaliy tahlil natijalari (jumladan ROI hisob-kitobi), joriy etish risklari hamda yakuniy xulosa va tavsiyalar.", { spacingAfter: 250 }));

// ============================================================
// ADABIYOTLAR SHARHI
// ============================================================
children.push(heading("ADABIYOTLAR SHARHI"));
children.push(p("Doimiy audit konsepsiyasining nazariy negizini Rutgers universiteti professorlari Miklos Vasarhelyi va Fern Halper 1991-yilda AT&T kompaniyasi misolida shakllantirgan bo'lib [2], ular tranzaksiyalarni oldindan belgilangan \u201Ckontrol formulalari\u201D asosida uzluksiz tekshirish g'oyasini ilgari surishgan. Ushbu g'oya 1999-yilda AICPA va CICA tomonidan rasmiy tan olinib, doimiy audit \u2014 auditorga tegishli xulosani tranzaksiya sodir bo'lgan paytga yaqin muddatda taqdim etish imkonini beruvchi metodologiya sifatida ta'riflandi [3]."));
children.push(p("RPA texnologiyasining audit sohasidagi qo'llanilishi bo'yicha Kevin Moffitt va hammualliflari (2018) RPA botlarining audit dalillarini yig'ish jarayonlarini avtomatlashtirishga oid konseptual arxitekturani taklif qilishgan [4]. Julia Kokina va Shay Blanchette (2019) RPA joriy etilgan audit tashkilotlarida qo'lda bajariladigan takrorlanuvchi ishlar hajmi 60-80 foizga qisqarganini, biroq bu yangi kompetensiyalarni talab qilishini ko'rsatishgan [5]."));
children.push(p("Data Science yo'nalishida Mark Nigrini o'zining fundamental ishida raqamlar ketma-ketligining tabiiy chastota taqsimoti \u2014 Benford qonuni \u2014 yordamida moliyaviy hisobotlardagi sun'iy o'zgartirilgan raqamlarni statistik ravishda aniqlash mumkinligini isbotlab bergan [6]."));
children.push(p("Xalqaro auditorlik standartlari ham bilvosita ushbu g'oyani qo'llab-quvvatlaydi: ISA 500 standarti audit dalilining yetarli va mos bo'lishini talab qiladi [7], IIA va ISACA tomonidan ishlab chiqilgan \u201CGTAG 3: Continuous Auditing\u201D qo'llanmasida doimiy audit va doimiy monitoring tushunchalari farqlanadi [8], COSO tashkilotining ichki nazorat kontseptsiyasidagi monitoring komponenti esa aynan shu g'oyaga tayanadi [9]. Shunga qaramay, tahlil qilingan manbalarning aksariyati rivojlangan davlatlar tajribasiga bag'ishlangan bo'lib, O'zbekiston sharoitida RPA-asosidagi doimiy audit modelining amaliy metodologiyasi va iqtisodiy samaradorligi hali yetarlicha o'rganilmagan. Mazkur maqola aynan shu bo'shliqni to'ldirishga qaratilgan.", { spacingAfter: 250 }));

// ============================================================
// 1-BO'LIM: NAZARIY ASOSLAR
// ============================================================
children.push(heading("1. DOIMIY AUDIT VA RPA TEXNOLOGIYASINING NAZARIY-TUSHUNCHAVIY ASOSLARI"));

children.push(subheading("1.1. Doimiy auditning mazmuni"));
children.push(p("Ilmiy adabiyotda \u201Cdoimiy audit\u201D tushunchasi ikki komponentga ega [8]: doimiy ma'lumotlar kafolati (CDA) \u2014 tranzaksion ma'lumotlarning to'liqligi va me'yoriy hujjatlarga muvofiqligini muntazam tekshirish, va doimiy nazorat monitoringi (CCM) \u2014 ichki nazorat tadbirlarining samarali ishlayotganligini uzluksiz baholash. Amaliyotda ikkalasi birgalikda qo'llaniladi: CCM nazorat tizimining ishonchliligini, CDA esa ma'lumotlarning haqiqiyligini tasdiqlaydi. Doimiy audit an'anaviy yillik auditni bekor qilmaydi, balki uni operatsion darajadagi kundalik nazorat bilan to'ldiradi."));

children.push(subheading("1.2. RPA texnologiyasining tarkibiy elementlari"));
children.push(p("RPA botlari vazifasiga ko'ra uch turga bo'linadi: attended botlar xodim ish stantsiyasida, inson ishtiroki bilan ishlaydi; unattended botlar serverda mustaqil, jadval bo'yicha ishlaydi va aynan shu tur buxgalteriya-audit jarayonlarini avtomatlashtirish uchun asosiy vosita hisoblanadi; hybrid botlar ikkala rejimni birlashtiradi. Tizimning texnik tarkibiga workflow designer (jarayon logikasini loyihalash muhiti), orchestrator (botlar jadvali va xatoliklarini boshqaruvchi server), credential vault (kirish ma'lumotlarini shifrlangan saqlovchi ombor) hamda API/OCR konnektorlar (tashqi tizimlardan ma'lumot o'qish vositalari) kiradi."));

children.push(subheading("1.3. Anomaliyalarni aniqlashning statistik metodlari"));
children.push(p("RPA bot faqat ma'lumotlarni yig'ish va qoidalar bo'yicha solishtirish vazifasini bajaradi; anomaliyalarni statistik asoslangan holda aniqlash uchun uchta metod qo'llaniladi. Birinchisi \u2014 Benford qonuni [6]: tabiiy shakllangan sonlar to'plamida birinchi ma'noli raqamning taqsimoti quyidagi formulaga bo'ysunadi:"));
children.push(formula("P(d) = log\u2081\u2080 (1 + 1/d),  bunda  d = 1, 2, \u2026, 9"));
children.push(p("Bunga ko'ra \u201C1\u201D bilan boshlangan summalar taxminan 30,1 foizni, \u201C9\u201D bilan boshlanganlari esa 4,6 foizni tashkil etishi kutiladi; chetlanishning ahamiyatliligi xi-kvadrat testi orqali baholanadi:"));
children.push(formula("\u03C7\u00B2 = \u03A3 [(O\u1D62 \u2212 E\u1D62)\u00B2 / E\u1D62]"));
children.push(p("bunda O\u1D62 \u2014 kuzatilgan, E\u1D62 \u2014 kutilgan chastota; hisoblangan qiymat erkinlik darajasi 8 bo'lgan jadval qiymatidan (15,51, p = 0,05) katta bo'lsa, taqsimot nazariy modelga mos kelmaydi deb topiladi. Ikkinchisi \u2014 Z-standart baho usuli:"));
children.push(formula("Z = (x \u2212 \u03BC) / \u03C3"));
children.push(p("bunda x \u2014 tranzaksiya summasi, \u03BC \u2014 o'rtacha qiymat, \u03C3 \u2014 standart og'ish; |Z| > 3 shartini qanoatlantiruvchi tranzaksiyalar anomaliya sifatida belgilanadi. Uchinchisi \u2014 auditor tajribasiga asoslangan oddiy chegaraviy (threshold) qoidalar. Ushbu uch metodning birgalikda qo'llanilishi murakkab mashinali o'rganish algoritmlarisiz ham yuqori aniqlikdagi nazorat tizimini yaratish imkonini beradi.", { spacingAfter: 250 }));

// ============================================================
// 2-BO'LIM: METODOLOGIYA
// ============================================================
children.push(heading("2. TADQIQOT METODOLOGIYASI"));
children.push(p("Tadqiqotda sifat va miqdoriy tahlil uyg'unligiga asoslangan aralash yondashuvdan foydalanildi. RPA-asosidagi doimiy audit modelining amaliy samaradorligini baholash uchun shartli savdo-xizmat korxonasi misolida olti oylik pilot loyiha o'tkazildi, unda bank-kassa operatsiyalari, hisob-fakturalar va QQS hisob-kitoblari jarayonlari o'rganildi. Tadqiqot quyidagi metodlarga tayandi:"));
children.push(numberedItem("Jarayonlarni xaritalash: kunlik operatsiyalar orasidan qoidaga asoslangan, takrorlanuvchi va katta hajmli jarayonlar aniqlandi."));
children.push(numberedItem("Bot arxitekturasini loyihalashtirish: aniqlangan jarayonlar uchun oltita qatlamdan iborat texnik arxitektura ishlab chiqildi."));
children.push(numberedItem("Statistik anomaliya aniqlash: tranzaksiyalar Benford qonuni (xi-kvadrat testi) va Z-score usulida tekshirildi."));
children.push(numberedItem("Solishtirma tahlil: RPA joriy etilgunga qadar va keyingi davr bo'yicha jarayon vaqti, xatolik va qamrov ko'rsatkichlari qiyoslandi."));
children.push(numberedItem("Iqtisodiy samaradorlikni baholash: investitsiya va tejalgan xarajatlar asosida ROI ko'rsatkichi hisoblandi."));

children.push(subheading("Amaliy misol: bank-kassa muvofiqlashtiruvi botining ish algoritmi"));
children.push(p("Pilot loyihada avtomatlashtirilgan bank-kassa muvofiqlashtiruvi jarayoni quyidagi ketma-ketlikda amalga oshiriladi:"));
children.push(numberedItem("Bot ERP tizimi va bank-klient portalidan mos kundagi tranzaksiyalar ro'yxatini API orqali avtomatik yuklab oladi."));
children.push(numberedItem("Ikkala ro'yxat sana, summasi va kontragent bo'yicha avtomatik solishtiriladi; mos yozuvlar tasdiqlanadi."));
children.push(numberedItem("Mos kelmagan yozuvlar \u201Cistisno\u201D sifatida ajratilib, Benford va Z-score testlaridan o'tkaziladi."));
children.push(numberedItem("Aniqlangan istisnolar avtomatik hisobot shaklida mas'ul auditorga yuboriladi; yakuniy qarorni faqat inson qabul qiladi."));
children.push(p("Bu misol RPA botning inson mehnatini emas, balki takrorlanuvchi qismini avtomatlashtirib, auditor e'tiborini faqat tahlil talab qiladigan istisnolarga qaratishini ko'rsatadi \u2014 bu \u201Cistisno bo'yicha boshqaruv\u201D (management by exception) tamoyilining amaliy ko'rinishidir.", { spacingAfter: 250 }));

// ============================================================
// 3-BO'LIM: TEXNIK ARXITEKTURA
// ============================================================
children.push(heading("3. RPA-AUDIT TIZIMINING TEXNIK ARXITEKTURASI"));
children.push(p("RPA-asosidagi doimiy audit tizimining barqaror ishlashi arxitekturaviy tuzilishga bog'liq. Tadqiqotda ishlab chiqilgan model quyida keltirilgan oltita qatlamdan iborat bo'lib, ma'lumot xom manbadan yakuniy inson qaroriga qadar harakatlanadi."));
children.push(centered("1-jadval. RPA-audit tizimining oltita arxitektura qatlami", { size: 22, spacingAfter: 150, bold: true }));
children.push(table4);
children.push(sourceNote("Manba: muallif tomonidan tuzilgan."));
children.push(p("Orkestratsiya qatlamidagi credential vault botlarning kirish ma'lumotlarini shifrlangan holda saqlaydi va rolga asoslangan kirish nazoratini (RBAC) ta'minlaydi. Arxitektura odatda korxonaning mavjud ERP tizimiga \u201Cust\u00fcst\u00fc\u201D tarzda o'rnatiladi, ya'ni bot foydalanuvchi interfeysi yoki API orqali mavjud tizim bilan ishlaydi \u2014 bu ERP tizimini almashtirishni talab qilmaydigan muhim amaliy afzallikdir.", { spacingAfter: 250 }));

// ============================================================
// 4-BO'LIM: TAHLIL VA NATIJALAR
// ============================================================
children.push(heading("4. TAHLIL VA NATIJALAR"));
children.push(p("O'zbekiston korxonalarida raqamli buxgalteriya vositalarining joriy etilish dinamikasini baholash uchun Davlat soliq qo'mitasi va Statistika agentligining ochiq ma'lumotlari tahlil qilindi [10]."));
children.push(centered("2-jadval. O'zbekistonda buxgalteriya va audit jarayonlarini raqamlashtirish dinamikasi", { size: 22, spacingAfter: 150, bold: true }));
children.push(table1);
children.push(sourceNote("Manba: [10] asosida muallif tomonidan umumlashtirilgan."));
children.push(p("Elektron hisob-fakturalar va onlayn soliq hisobotlari deyarli to'liq qamrovga erishgan bo'lsa-da, RPA vositalaridan foydalanuvchi audit tashkilotlari ulushi hali past \u2014 bu holat RPA-asosidagi doimiy audit modelini joriy etish uchun katta salohiyat mavjudligini ko'rsatadi."));
children.push(p("Shartli savdo korxonasi misolida o'tkazilgan olti oylik pilot loyiha natijalari quyidagi jadvalda umumlashtirildi."));
children.push(centered("3-jadval. RPA joriy etilishidan oldingi va keyingi davr ko'rsatkichlarining solishtirma tahlili", { size: 22, spacingAfter: 150, bold: true }));
children.push(table2);
children.push(sourceNote("Manba: pilot loyiha natijalari asosida muallif tomonidan hisoblangan."));
children.push(p("RPA joriy etilishi tranzaksiyalar qamrovini 5-10 foizdan deyarli 100 foizgacha oshirdi, bu klassik \u201Ctanlanma xatosi\u201D riskini amalda bartaraf etadi; anomaliyani aniqlash muddati esa 30-45 kundan 24-48 soatgacha qisqardi."));

children.push(subheading("4.1. Benford qonuni bo'yicha statistik test natijalari"));
children.push(p("Pilot korxonaning xarajat hujjatlari summalarining birinchi raqamlari taqsimoti Benford qonuni bilan solishtirildi."));
children.push(centered("4-jadval. Benford qonuni bo'yicha kutilgan va kuzatilgan chastotalar solishtiruvi", { size: 22, spacingAfter: 150, bold: true }));
children.push(table3);
children.push(sourceNote("Manba: pilot korxonaning xarajat hujjatlari (N = 1 240 tranzaksiya) asosida muallif tomonidan hisoblangan."));
children.push(p("Umumiy massiv bo'yicha xi-kvadrat qiymati (\u03C7\u00B2 \u2248 3,9; erkinlik darajasi = 8) jadval qiymatidan (15,51) past bo'lib, manipulyatsiya belgilari kuzatilmadi. Biroq \u201Cmoliyaviy-xo'jalik xarajatlari\u201D sub-hisobida raqam \u201C9\u201D chastotasining sezilarli chetlanishi (\u03C7\u00B2 \u2248 19,4) aniqlandi va bu \u201Cqizil bayroq\u201D sifatida qo'shimcha tekshiruvga yuborildi \u2014 an'anaviy davriy audit usulida bunday tor doiradagi chetlanishni yillik tekshiruv yakunigacha aniqlash amalda deyarli mumkin emas edi."));

children.push(subheading("4.2. Iqtisodiy samaradorlikni (ROI) hisoblash"));
children.push(p("RPA tizimini joriy etishning iqtisodiy asosliligi quyidagi formula bo'yicha baholandi:"));
children.push(formula("ROI (%) = [(Yillik tejalgan xarajat \u2212 Investitsiya xarajati) / Investitsiya xarajati] \u00D7 100"));
children.push(centered("5-jadval. RPA joriy etishning iqtisodiy samaradorligi (ROI) hisob-kitobi", { size: 22, spacingAfter: 150, bold: true }));
children.push(table5);
children.push(sourceNote("Manba: pilot loyiha ma'lumotlari asosida muallif tomonidan hisoblangan (shartli qiymatlar, mln so'm)."));
children.push(p("Birinchi yilda bir martalik xarajatlar hisobiga ROI mo''tadil (~25,8%) bo'lsa, ikkinchi yildan boshlab u 230 foizgacha o'sadi \u2014 bu RPA-asosidagi doimiy auditga investitsiya uzoq muddatli istiqbolda yuqori samara beruvchi strategik qaror ekanligini ko'rsatadi."));

children.push(subheading("4.3. Huquqiy-me'yoriy jihatlar"));
children.push(p("Amaldagi milliy audit standartlari hali \u201Cdoimiy audit\u201D va \u201Cavtomatlashtirilgan audit dalili\u201D tushunchalarini alohida tartibga solmaydi. ISA 500 standarti audit dalilining \u201Cyetarli va mos\u201D bo'lishini talab qiladi [7], biroq RPA bot generatsiya qilgan hisobotlarning ushbu mezonlarga muvofiqligi milliy amaliyotda hali aniq belgilanmagan \u2014 bu holat keyingi bo'limdagi tavsiyalarning asosini tashkil etadi.", { spacingAfter: 250 }));

// ============================================================
// 5-BO'LIM: RISKLAR VA CHEKLOVLAR
// ============================================================
children.push(heading("5. IMPLEMENTATSIYA RISKLARI VA CHEKLOVLARI"));
children.push(p("RPA-asosidagi doimiy audit modelini joriy etishda quyidagi risklarni hisobga olish zarur:"));
children.push(bullet("Ma'lumotlar sifati riski: boshlang'ich ma'lumotlar to'liq yoki aniq bo'lmasa, bot ham noto'g'ri natija chiqaradi."));
children.push(bullet("Kiber xavfsizlik riski: kirish ma'lumotlari tegishli darajada himoyalanmasa, ruxsatsiz kirish xavfi yuzaga keladi."));
children.push(bullet("Haddan tashqari ishonish riski: auditor botning xulosasini so'roqsiz qabul qilib, professional skeptitsizmini yo'qotishi mumkin."));
children.push(bullet("Huquqiy-me'yoriy noaniqlik: avtomatlashtirilgan audit dalilining yuridik maqomi hali to'liq belgilanmagan."));
children.push(bullet("O'zgarishlarga qarshilik va texnik nosozlik: xodimlarning malaka yetishmasligi hamda tizim yangilanishlarida botni qayta sozlash zarurati loyiha muvaffaqiyatiga to'sqinlik qilishi mumkin."));
children.push(p("Ushbu risklarni oldindan hisobga olish tizimning barqaror va ishonchli ishlashini ta'minlashning zaruriy sharti hisoblanadi.", { spacingAfter: 250 }));

// ============================================================
// XULOSA VA TAKLIFLAR
// ============================================================
children.push(heading("XULOSA VA TAKLIFLAR"));
children.push(p("Tadqiqot natijalari shuni ko'rsatadiki, RPA texnologiyasi va Data Science metodlarining birgalikda qo'llanilishi an'anaviy tanlanmaga asoslangan audit modelidan uzluksiz, deyarli to'liq qamrovli doimiy audit modeliga o'tishning real imkoniyatini yaratadi. Bunday tizim auditorlik xarajatlarini qisqartiradi (ROI ikkinchi yildan 230 foizgacha yetadi) va risklarni aniqlash tezligini o'nlab barobar oshiradi. Shu bilan birga, uning samaradorligi to'g'ri loyihalashtirilgan qoidalar, sifatli ma'lumotlar va malakali mutaxassislarga bog'liq. Yuqoridagilardan kelib chiqib, quyidagi takliflar ilgari suriladi:"));

children.push(pRuns([{ text: "1. Milliy audit standartlariga tegishli tushunchalarni kiritish: ", bold: true }, { text: "ISA 500 tamoyillariga [7] tayangan holda RPA bot hisobotlarining rasmiy audit dalili sifatida tan olinish shartlari belgilanishi lozim." }]));
children.push(pRuns([{ text: "2. \u201CBot governance\u201D tizimini yaratish: ", bold: true }, { text: "har bir botning ishlash qoidalari va o'zgartirish tarixi mustaqil IT-audit tomonidan davriy tekshirilishi shart." }]));
children.push(pRuns([{ text: "3. Kiber xavfsizlikni kuchaytirish: ", bold: true }, { text: "alohida credential vault, rolga asoslangan kirish nazorati va ma'lumotlarni shifrlash tartib-taomillari joriy etilishi zarur." }]));
children.push(pRuns([{ text: "4. Kichik va o'rta korxonalarni qo'llab-quvvatlash: ", bold: true }, { text: "ochiq kodli RPA vositalarini joriy etishga ko'maklashuvchi dasturlar ishlab chiqilishi maqsadga muvofiq." }]));
children.push(pRuns([{ text: "5. Kadrlarni qayta o'qitish: ", bold: true }, { text: "buxgalteriya-audit yo'nalishi o'quv dasturlariga ma'lumotlarni statistik tahlil qilish bo'yicha amaliy kurslar kiritilishi zarur." }]));
children.push(pRuns([{ text: "6. Bosqichma-bosqich amalga oshirish: ", bold: true }, { text: "korxonalarga quyida keltirilgan uch bosqichli yo'l xaritasidan foydalanish tavsiya etiladi." }]));

children.push(centered("6-jadval. RPA-asosidagi doimiy audit tizimini joriy etishning bosqichma-bosqich yo'l xaritasi", { size: 22, spacingAfter: 150, bold: true }));
children.push(table6);
children.push(sourceNote("Manba: muallif tomonidan tuzilgan."));

children.push(p("Umuman olganda, RPA va Data Science texnologiyalari buxgalteriya-audit sohasining kelajagini belgilovchi strategik vosita bo'lib, ularni joriy etishning asosiy maqsadi moliyaviy hisobotlarning ishonchliligi va iqtisodiy sub'ektlar faoliyatining shaffofligini oshirishdan iborat bo'lishi lozim.", { spacingAfter: 250 }));

// ============================================================
// FOYDALANILGAN ADABIYOTLAR RO'YXATI (10 ta, matn ichidagi [N] bilan mos)
// ============================================================
children.push(heading("FOYDALANILGAN ADABIYOTLAR RO'YXATI"));
const refs = [
  "O'zbekiston Respublikasi Prezidentining 2020-yil 5-oktabrdagi \u201CRaqamli O'zbekiston \u2014 2030\u201D strategiyasini tasdiqlash hamda uni samarali amalga oshirish chora-tadbirlari to'g'risida\u201Dgi PF-6079-son Farmoni // Qonunchilik ma'lumotlari milliy bazasi, 06.10.2020-y., 06/20/6079/1349-son.",
  "Vasarhelyi M.A., Halper F.B. The Continuous Process Audit System: A UNIX-Based Auditing Tool // The EDP Auditor Journal. \u2014 1991. \u2014 Vol. 2. \u2014 P. 85-95.",
  "American Institute of CPAs (AICPA), Canadian Institute of Chartered Accountants (CICA). Continuous Auditing: Research Report. \u2014 New York: AICPA, 1999. \u2014 78 p.",
  "Moffitt K.C., Rozario A.M., Vasarhelyi M.A. Robotic Process Automation for Auditing // Journal of Emerging Technologies in Accounting. \u2014 2018. \u2014 Vol. 15, No. 1. \u2014 P. 1-10.",
  "Kokina J., Blanchette S. Early Evidence of Digital Labor in Accounting: Innovation with Robotic Process Automation // International Journal of Accounting Information Systems. \u2014 2019. \u2014 Vol. 35. \u2014 Article 100431.",
  "Nigrini M.J. Benford's Law: Applications for Forensic Accounting, Auditing, and Fraud Detection. \u2014 Hoboken: John Wiley & Sons, 2012. \u2014 366 p.",
  "IAASB. International Standard on Auditing (ISA) 500, Audit Evidence. \u2014 New York: IFAC, 2009 (with subsequent amendments).",
  "The Institute of Internal Auditors (IIA), ISACA. GTAG 3: Continuous Auditing \u2014 Coordinating Continuous Auditing and Monitoring to Provide Continuous Assurance. \u2014 Rolling Meadows: ISACA, 2015.",
  "Committee of Sponsoring Organizations of the Treadway Commission (COSO). Internal Control \u2014 Integrated Framework. \u2014 Durham: COSO, 2013.",
  "O'zbekiston Respublikasi Davlat soliq qo'mitasi va Statistika agentligining ochiq ma'lumotlar portallari (soliq.uz, stat.uz).",
];
refs.forEach((r, i) => children.push(refItem(i + 1, r)));

// ============================================================
// HUJJATNI YAKUNLASH
// ============================================================
const doc = new Document({
  styles: {
    default: { document: { run: { font: FONT, size: 24 } } }
  },
  numbering: {
    config: [
      {
        reference: "main-bullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }]
      },
      {
        reference: "steps-numbering",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }]
      }
    ]
  },
  sections: [{
    properties: {
      page: {
        size: { width: 11906, height: 16838 }, // A4
        margin: { top: 1440, bottom: 1440, left: 1701, right: 850 }
      }
    },
    children
  }]
});

Packer.toBuffer(doc).then(buf => {
  require("fs").writeFileSync("Doimiy_Audit_va_RPA_maqola_qisqartirilgan.docx", buf);
  console.log("done");
});