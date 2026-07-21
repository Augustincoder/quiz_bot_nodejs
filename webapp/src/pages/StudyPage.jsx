import React, { useState } from 'react';
import { triggerHaptic } from '../lib/telegram';
import { api } from '../lib/api';
import { 
  ChevronLeft, 
  Bookmark, 
  Share2, 
  Settings, 
  Flag, 
  Clock, 
  Bot, 
  Play, 
  Check, 
  X,
  BookOpen,
  Sparkles
} from 'lucide-react';
import SettingsModal from '../components/SettingsModal';

const SUBJECT_QUESTION_BANKS = {
  korporativ: [
    {
      id: 1,
      question: "Korporativ boshqaruvning asosiy maqsadi nimadan iborat?",
      options: ["Aksiyadorlar va jamiyat manfaatlarini uyushgan holda himoya qilish va kompaniya qiymatini oshirish", "Faqatgina soliq to'lovlarini kamaytirish", "Kompaniyadagi xodimlarni qisqartirish", "Bosh direktorning shaxsiy foydasini ko'paytirish"],
      correct: 0,
      rule: "Korporativ boshqaruv kodeksiga ko'ra, asosiy maqsad — barcha manfaatdor tomonlar va aksiyadorlar huquqlarini ta'minlagan holda uzoq muddatli barqarorlikni yaratishdir."
    },
    {
      id: 2,
      question: "Kuzatuv kengashining (Board of Directors) asosiy vazifasi qaysi?",
      options: ["Kunlik operatsion ishlarni bajarish", "Kompaniyaning strategik yo'nalishini belgilash va ijroiya organini nazorat qilish", "Buxgalteriya hisobotlarini qo'lda yozish", "Kichik xodimlarni ishga qabul qilish"],
      correct: 1,
      rule: "Kuzatuv kengashi strategiya, xavflarni boshqarish va top-menejment faoliyatini nazorat qilish uchun mas'ul organ hisoblanadi."
    },
    {
      id: 3,
      question: "Mustaqil direktor (Independent Director) kim?",
      options: ["Kompaniya bilan hech qanday moddiy yoki qarindoshlik aloqasi bo'lmagan xolis a'zo", "Kompaniyaning bosh buxgalteri", "Asosiy aksiyadorning yaqin qarindoshi", "Kompaniya mahsulotlarining eng yirik sotuvchisi"],
      correct: 0,
      rule: "Mustaqil direktor qarorlar qabul qilishda xolislikni ta'minlash uchun kompaniya menejmenti yoki yirik aksiyadorlarga bog'liq bo'lmasligi shart."
    },
    {
      id: 4,
      question: "Aksiyadorlarning umumiy yig'ilishi (AGM) qachon o'tkaziladi?",
      options: ["Moliya yili tugagandan keyin yiliga kamida bir marta", "Har hafta dushanba kuni", "Faqat kompaniya bankrot bo'lganda", "Har 5 yilda bir marta"],
      correct: 0,
      rule: "Qonunchilikka ko'ra, yillik umumiy yig'ilish moliya yili yakunidan so'ng belgilangan muddatda o'tkazilishi majburiy."
    },
    {
      id: 5,
      question: "Dividend siyosati nimani belgilab beradi?",
      options: ["Sof foydaning qancha qismi aksiyadorlarga taqsimlanishi va qancha qismi rivojlanishga yo'naltirilishini", "Xodimlarning tushlik vaqtini", "Soliq deklaratsiyasini topshirish muddatini", "Ofis jihozlarini sotib olish me'yorini"],
      correct: 0,
      rule: "Dividend siyosati — kompaniyaning sof foydasini taqsimlash va qayta investitsiya qilish bo'yicha aniq qoidalarni o'z ichiga oladi."
    }
  ],
  moliyaviy: [
    {
      id: 1,
      question: "Buxgalteriya balansi tenglamasining to'g'ri ko'rinishini ko'rsating:",
      options: ["Aktivlar = Majburiyatlar + O'z sarmoyasi (Kapital)", "Aktivlar = Daromadlar - Xarajatlar", "Kapital = Aktivlar + Majburiyatlar", "Majburiyatlar = Aktivlar * Soliq stavkasi"],
      correct: 0,
      rule: "Asosiy buxgalteriya tenglamasi (Accounting Equation): Assets = Liabilities + Equity."
    },
    {
      id: 2,
      question: "Amortizatsiya (Eskirish) hisoblashdan maqsad nima?",
      options: ["Asosiy vosita qiymatini uning foydali xizmat muddati davomida xarajatlarga taqsimlash", "Bankdagi pul qoldig'ini ko'paytirish", "Soliq organlarini chalg'itish", "Kompaniya qarzlarini yashirish"],
      correct: 0,
      rule: "Amortizatsiya — uzoq muddatli aktiv qiymatini uning xizmat muddati davomida bosqichma-bosqich xarajat deb e'tirof etishdir."
    },
    {
      id: 3,
      question: "Moliyaviy natijalar to'g'risidagi hisobot (Profit & Loss) nimani ko'rsatadi?",
      options: ["Ma'lum bir davr ichida kompaniyaning daromadlari, xarajatlari va sof foyda/zararini", "Kompaniyaning kelgusi 10 yillik rejasini", "Faqat bankdagi pul mablag'larining qoldig'ini", "Aksiyadorlarning uy manzillarini"],
      correct: 0,
      rule: "P&L hisoboti muayyan davrdagi moliyaviy faoliyat samarasini (daromad minus xarajatlar) aks ettiradi."
    },
    {
      id: 4,
      question: "Pul oqimlari to'g'risidagi hisobot (Cash Flow Statement) necha bo'limdan iborat?",
      options: ["Operatsion, investitsion va moliyaviy faoliyat", "Faqat kirim va chiqim", "Ichki va tashqi oqimlar", "Soliq va dividendlar"],
      correct: 0,
      rule: "Cash Flow hisoboti 3 ta asosiy bo'limga bo'linadi: Operating, Investing, va Financing Cash Flows."
    },
    {
      id: 5,
      question: "Debitorlik qarzi (Accounts Receivable) balansning qaysi qismida aks etadi?",
      options: ["Joriy aktivlarda (Current Assets)", "Uzoq muddatli majburiyatlarda", "O'z sarmoyasida (Equity)", "Nomoddiy aktivlarda"],
      correct: 0,
      rule: "Debitorlik qarzi — xaridorlarning kompaniya oldidagi qisqa muddatli to'lanishi kerak bo'lgan mablag'i bo'lib, joriy aktiv hisoblanadi."
    }
  ],
  ekonometrika: [
    {
      id: 1,
      question: "Chiziqli regressiya modelida (Y = a + bX + e) 'e' nimani anglatadi?",
      options: ["Tasodifiy xatolik (Residual / Error term)", "Erkli o'zgaruvchining o'rtacha qiymatini", "Determinatsiya koeffitsientini", "Elastiklik darajasini"],
      correct: 0,
      rule: "Regressiyadagi 'e' — model tomonidan tushuntirib berilmagan barcha tasodifiy omillarni o'z ichiga oladi."
    },
    {
      id: 2,
      question: "R-kvadrat (R²) qiymati qaysi diapazonda bo'ladi va nimani bildiradi?",
      options: ["0 dan 1 gacha bo'lib, modelning natijaviy o'zgaruvchini tushuntirish darajasini bildiradi", "-100 dan +100 gacha bo'ladi", "Faqat manfiy son bo'ladi", "0 dan cheksizlikkacha o'zgaradi"],
      correct: 0,
      rule: "R² (Determinatsiya koeffitsienti) 0 va 1 (yoki 0% dan 100%) oralig'ida bo'lib, dispersiyaning necha foizi model bilan tushuntirilishini ko'rsatadi."
    },
    {
      id: 3,
      question: "Geteroskedastiklik (Heteroskedasticity) nima?",
      options: ["Regressiya xatoliklarining dispersiyasi doimiy bo'lmagan holat", "Barcha o'zgaruvchilarning o'zaro tengligi", "Ma'lumotlar sonining juda kamligi", "Korrelyatsiyaning nolga tengligi"],
      correct: 0,
      rule: "Geteroskedastiklik — kuzatuvlar bo'ylab tasodifiy xatolar dispersiyasining o'zgaruvchanligidir."
    },
    {
      id: 4,
      question: "Multikolleniarlik qachon yuz beradi?",
      options: ["Erkli o'zgaruvchilar o'rtasida juda kuchli o'zaro korrelyatsiya bo'lganda", "Faqat bitta o'zgaruvchi bo'lganda", "Xatoliklar normal taqsimlanmaganda", "Kuzatuvlar soni 1000 dan oshganda"],
      correct: 0,
      rule: "Multikolleniarlik erkli o'zgaruvchilar o'zaro yuqori bog'liq bo'lganda model koeffitsientlarining aniqligiga salbiy ta'sir qiladi."
    },
    {
      id: 5,
      question: "Durbin-Uotson (Durbin-Watson) testi nimani aniqlash uchun ishlatiladi?",
      options: ["Avtokorrelyatsiya (xatolar o'rtasidagi bog'liqlik) mavjudligini", "O'rtacha arifmetik qiymatni", "Tanlanma hajmning yetarliligini", "O'zgaruvchilar sonining ko'pligini"],
      correct: 0,
      rule: "Durbin-Watson statistikasi odatda 0 dan 4 gacha qiymat oladi va 2 ga yaqin bo'lsa birinchi tartibli avtokorrelyatsiya yo'qligini bildiradi."
    }
  ],
  general: [
    {
      id: 1,
      question: "Quyidagilardan qaysi biri o'zbek adabiyotining asoschisi hisoblanadi?",
      options: ["Alisher Navoiy", "Zahiriddin Muhammad Bobur", "Abdulla Qodiriy", "Cho'lpon"],
      correct: 0,
      rule: "Alisher Navoiy (1441-1501) turkiy adabiy til va mumtoz o'zbek adabiyotining asoschisi hisoblanadi."
    },
    {
      id: 2,
      question: "Nyutonning ikkinchi qonuni formulasini ko'rsating.",
      options: ["F = m * a", "E = m * c^2", "P = F / S", "s = v * t"],
      correct: 0,
      rule: "Kuch (F) jism massasi (m) va uning tezlanishining (a) ko'paytmasiga teng."
    },
    {
      id: 3,
      question: "O'zbekiston Respublikasi qachon mustaqillikka erishgan?",
      options: ["1989-yil 21-oktabr", "1991-yil 31-avgust", "1992-yil 8-dekabr", "1991-yil 1-sentyabr"],
      correct: 1,
      rule: "1991-yil 31-avgustda O'zbekiston Respublikasining Davlat Mustaqilligi e'lon qilingan."
    },
    {
      id: 4,
      question: "Quyidagi elementlardan qaysi biri davriy sistemada birinchi o'rinda turadi?",
      options: ["Vodorod (H)", "Geliy (He)", "Kislorod (O)", "Uglerod (C)"],
      correct: 0,
      rule: "Vodorod (H) atom raqami 1 ga teng bo'lib, davriy sistemaning eng birinchi elementidir."
    },
    {
      id: 5,
      question: "Inson tanasidagi eng katta organ qaysi?",
      options: ["Teri", "Jigar", "Yurak", "O'pka"],
      correct: 0,
      rule: "Teri inson tanasini tashqi tomondan qoplaydigan eng katta organ hisoblanadi."
    }
  ]
};

export default function StudyPage({ subject, onFinish, onExplain }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState(null);

  const subjectKey = subject?.key || 'korporativ';
  const [questions, setQuestions] = useState(SUBJECT_QUESTION_BANKS[subjectKey] || SUBJECT_QUESTION_BANKS.korporativ);
  const [loadingQuestions, setLoadingQuestions] = useState(false);

  React.useEffect(() => {
    let active = true;
    setLoadingQuestions(true);
    api.getQuestions(subjectKey).then(res => {
      if (active && res && res.success && Array.isArray(res.questions) && res.questions.length > 0) {
        setQuestions(res.questions);
      }
    }).catch(e => {
      console.warn('Questions API error, using default questions:', e.message);
    }).finally(() => {
      if (active) setLoadingQuestions(false);
    });
    return () => { active = false; };
  }, [subjectKey]);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedOpt, setSelectedOpt] = useState(null);
  const [isAnswered, setIsAnswered] = useState(false);
  const [answersStatus, setAnswersStatus] = useState({}); // { [idx]: 'correct' | 'wrong' }
  const [selectedHistory, setSelectedHistory] = useState({}); // { [idx]: number }
  const [bookmarkedQs, setBookmarkedQs] = useState({}); // { [id]: boolean }
  const [flaggedQs, setFlaggedQs] = useState({}); // { [id]: boolean }

  const currentQ = questions[currentIndex];

  const showToast = (msg) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2800);
  };

  const handleSelect = (idx) => {
    if (isAnswered) return;
    setSelectedOpt(idx);
    setIsAnswered(true);

    const correct = idx === currentQ.correct;
    setAnswersStatus(prev => ({
      ...prev,
      [currentIndex]: correct ? 'correct' : 'wrong'
    }));
    setSelectedHistory(prev => ({
      ...prev,
      [currentIndex]: idx
    }));

    if (correct) {
      triggerHaptic('light');
    } else {
      triggerHaptic('heavy');
    }
  };

  const handleNext = async () => {
    if (currentIndex + 1 < questions.length) {
      const nextIdx = currentIndex + 1;
      setCurrentIndex(nextIdx);
      if (answersStatus[nextIdx]) {
        setSelectedOpt(selectedHistory[nextIdx]);
        setIsAnswered(true);
      } else {
        setSelectedOpt(null);
        setIsAnswered(false);
      }
    } else {
      let correct = 0;
      let wrong = 0;
      Object.values(answersStatus).forEach(status => {
        if (status === 'correct') correct++;
        else if (status === 'wrong') wrong++;
      });
      try {
        await api.finishTest({
          correct,
          wrong,
          subject: subject?.name || 'Umumiy'
        });
      } catch (e) {}
      onFinish();
    }
  };

  const toggleBookmark = () => {
    const nextState = !bookmarkedQs[currentQ.id];
    setBookmarkedQs(prev => ({ ...prev, [currentQ.id]: nextState }));
    triggerHaptic('light');
    showToast(nextState ? "🔖 Savol saqlandi (Xatolar & Flashcard)" : "🔖 Savol saqlanganlardan olindi");
  };

  const handleShare = () => {
    triggerHaptic('light');
    const textToCopy = `${currentQ.question}\n\nA) ${currentQ.options[0]}\nB) ${currentQ.options[1]}\nC) ${currentQ.options[2]}\nD) ${currentQ.options[3]}\n\n✨ Quiz Bot Pro orqali yechildi!`;
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(textToCopy);
      showToast("🔗 Savol matni nusxalandi! Ulashishingiz mumkin.");
    } else {
      showToast("🔗 Savol ulashish uchun tayyor!");
    }
  };

  const handleFlag = () => {
    const nextState = !flaggedQs[currentQ.id];
    setFlaggedQs(prev => ({ ...prev, [currentQ.id]: nextState }));
    triggerHaptic('light');
    showToast(nextState ? "🚩 Savol adminga tekshirishga yuborildi. Rahmat!" : "🚩 Shikoyat bekor qilindi");
  };

  const handleShowRule = () => {
    triggerHaptic('light');
    if (onExplain) {
      onExplain({
        question: currentQ.question,
        correctAns: currentQ.options[currentQ.correct],
        userAns: currentQ.rule || "Qoida va nazariy asos",
        subject: subject?.name || 'Umumiy'
      });
    } else {
      showToast(currentQ.rule || "Bu savol uchun nazariy qoida mavjud");
    }
  };

  if (loadingQuestions && !currentQ) {
    return (
      <div className="py-24 flex flex-col items-center justify-center text-slate-400 gap-3.5 animate-fadeIn">
        <div className="w-9 h-9 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        <span className="text-sm font-semibold">Savollar bazadan yuklanmoqda...</span>
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-10 animate-smooth-in">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-2xl bg-[#0A0E17]/95 border border-blue-500/40 shadow-2xl backdrop-blur-2xl text-xs sm:text-sm font-bold text-slate-100 flex items-center gap-2 animate-smooth-in max-w-[90vw]">
          <Sparkles className="w-4 h-4 text-blue-400 shrink-0 animate-subtle-float" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Top Header Bar */}
      <div className="flex items-center justify-between py-1">
        <div className="flex items-center gap-2 sm:gap-2.5">
          <button 
            onClick={onFinish}
            className="spell-button w-10 h-10 rounded-xl bg-slate-900/80 hover:bg-slate-800 border border-white/10 flex items-center justify-center text-slate-300 transition-colors"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <button
            onClick={toggleBookmark}
            className={`spell-button w-10 h-10 rounded-xl border flex items-center justify-center transition-all ${
              bookmarkedQs[currentQ.id]
                ? 'bg-blue-500/20 border-blue-500/40 text-blue-400'
                : 'bg-slate-900/80 hover:bg-slate-800 border-white/10 text-slate-300'
            }`}
          >
            <Bookmark className={`w-4 h-4 ${bookmarkedQs[currentQ.id] ? 'fill-blue-400' : ''}`} />
          </button>
          <button
            onClick={handleShare}
            className="spell-button w-10 h-10 rounded-xl bg-slate-900/80 hover:bg-slate-800 border border-white/10 flex items-center justify-center text-slate-300 transition-colors"
          >
            <Share2 className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-1.5 text-amber-500 font-bold text-sm bg-amber-500/10 border border-amber-500/25 px-3 py-1.5 rounded-full">
          <Clock className="w-4 h-4" />
          <span>{subject?.name ? 'Imtihon' : 'Mashq'}</span>
        </div>

        <div className="flex items-center gap-2 sm:gap-2.5">
          <button 
            onClick={() => setSettingsOpen(true)}
            className="spell-button w-10 h-10 rounded-xl bg-slate-900/80 hover:bg-slate-800 border border-white/10 flex items-center justify-center text-slate-300 transition-colors"
          >
            <Settings className="w-4 h-4" />
          </button>
          <button
            onClick={handleFlag}
            className={`spell-button w-10 h-10 rounded-xl border flex items-center justify-center transition-all ${
              flaggedQs[currentQ.id]
                ? 'bg-rose-500/20 border-rose-500/40 text-rose-400'
                : 'bg-slate-900/80 hover:bg-slate-800 border-white/10 text-slate-300'
            }`}
          >
            <Flag className={`w-4 h-4 ${flaggedQs[currentQ.id] ? 'fill-rose-400' : ''}`} />
          </button>
        </div>
      </div>

      {/* Horizontal Scrollable Question Numbers Ribbon */}
      <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-1">
        {questions.map((q, i) => {
          const isActive = i === currentIndex;
          const status = answersStatus[i];

          let chipClass = "bg-slate-900/80 border border-white/10 text-slate-400 font-bold";
          if (status === 'correct') {
            chipClass = "bg-[#58cc02] border-[#58cc02] text-white font-extrabold";
          } else if (status === 'wrong') {
            chipClass = "bg-[#ff4b4b] border-[#ff4b4b] text-white font-extrabold";
          } else if (isActive) {
            chipClass = "bg-blue-600 border-2 border-[#00d2ff] text-white font-extrabold shadow-md";
          }

          return (
            <button
              key={q.id}
              onClick={() => {
                setCurrentIndex(i);
                if (answersStatus[i]) {
                  setSelectedOpt(selectedHistory[i]);
                  setIsAnswered(true);
                } else {
                  setSelectedOpt(null);
                  setIsAnswered(false);
                }
              }}
              className={`spell-button w-11 h-11 rounded-xl shrink-0 flex items-center justify-center text-sm transition-all ${chipClass}`}
            >
              {i + 1}
            </button>
          );
        })}
      </div>

      {/* Subject Badge & Question Title */}
      <div className="space-y-3">
        <div className="flex justify-center">
          <span className="px-3 py-1 rounded-full bg-blue-500/15 border border-blue-500/30 text-blue-400 text-xs font-semibold">
            {subject?.name || 'Umumiy Test Fanlari'}
          </span>
        </div>
        <h2 className="text-base sm:text-lg font-bold text-white text-center px-2 leading-snug">
          {currentQ.question}
        </h2>
      </div>

      {/* iOS Clean Card Container */}
      <div className="spell-card rounded-3xl backdrop-blur-xl bg-slate-900/70 border border-white/10 p-6 flex flex-col items-center justify-center text-center shadow-xl min-h-[130px] text-slate-100">
        <div className="w-12 h-12 rounded-2xl bg-blue-500/15 border border-blue-500/30 flex items-center justify-center mb-3 text-blue-400 shadow-sm animate-subtle-float">
          <BookOpen className="w-6 h-6" />
        </div>
        <div className="font-extrabold text-base sm:text-lg text-slate-100 tracking-tight">
          Quiz Bot Pro — AI Akademiya
        </div>
        <div className="text-xs text-slate-400 mt-1 font-medium">
          Savol №{currentIndex + 1} / {questions.length} • O'zlashtirish va AI pedagogik tahlil
        </div>
      </div>

      {/* Answer Options */}
      <div className="space-y-3">
        {currentQ.options.map((opt, idx) => {
          const isCorrect = idx === currentQ.correct;
          const isSelected = idx === selectedOpt;

          let btnClass = "bg-slate-900/60 border-white/10 text-slate-200 hover:border-blue-500/40 hover:bg-slate-900/85";
          if (isAnswered) {
            if (isCorrect) {
              btnClass = "bg-emerald-500/15 border-emerald-500/40 text-emerald-300";
            } else if (isSelected) {
              btnClass = "bg-rose-500/15 border-rose-500/40 text-rose-300";
            }
          }

          return (
            <button
              key={idx}
              onClick={() => handleSelect(idx)}
              className={`spell-button cursor-pointer w-full p-4 sm:p-5 rounded-2xl border text-left font-semibold transition-all duration-200 flex items-center justify-between gap-3 shadow-md ${btnClass}`}
            >
              <div className="flex items-center gap-3.5">
                <span className="w-9 h-9 rounded-xl bg-slate-800/80 border border-white/5 shrink-0 flex items-center justify-center text-xs text-slate-400 font-extrabold">
                  {String.fromCharCode(65 + idx)}
                </span>
                <span className="text-sm sm:text-base leading-snug">{opt}</span>
              </div>
              {isAnswered && isCorrect && <Check className="w-5 h-5 text-emerald-400 shrink-0" />}
              {isAnswered && isSelected && !isCorrect && <X className="w-5 h-5 text-rose-400 shrink-0" />}
            </button>
          );
        })}
      </div>

      {/* Bottom Action Bar */}
      <div className="flex items-center justify-between pt-4 gap-3">
        {isAnswered && selectedOpt !== currentQ.correct ? (
          <button
            onClick={() => onExplain && onExplain({
              question: currentQ.question,
              correctAns: currentQ.options[currentQ.correct],
              userAns: selectedOpt !== null ? currentQ.options[selectedOpt] : '',
              subject: subject?.name || 'Umumiy'
            })}
            className="spell-button cursor-pointer bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 px-5 py-3.5 rounded-2xl text-white text-sm font-extrabold flex items-center gap-2 shadow-lg shadow-blue-500/25 transition-all duration-200 flex-1 justify-center"
          >
            <Bot className="w-4 h-4" />
            <span>AI Ustoz Izohi</span>
          </button>
        ) : (
          <button
            onClick={handleShowRule}
            className="spell-button cursor-pointer bg-slate-900/80 hover:bg-slate-800 border border-white/10 px-5 py-3.5 rounded-2xl text-slate-300 text-sm font-bold flex items-center gap-2 transition-all duration-200"
          >
            <BookOpen className="w-4 h-4 text-blue-400" />
            <span>Qoidasi / Nazariya</span>
          </button>
        )}

        <button
          onClick={handleNext}
          className="spell-button cursor-pointer bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700 px-7 py-3.5 rounded-2xl text-white text-sm font-extrabold flex items-center gap-2 shadow-lg shadow-blue-500/25 transition-all duration-200"
        >
          <Play className="w-4 h-4 fill-white" />
          <span>{currentIndex + 1 === questions.length ? "Yakunlash" : "Keyingisi"}</span>
        </button>
      </div>

      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
