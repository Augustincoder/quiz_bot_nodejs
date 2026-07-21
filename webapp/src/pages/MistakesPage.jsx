import React from 'react';
import { AlertCircle, Bot, CheckCircle2, XCircle, Lightbulb } from 'lucide-react';

export default function MistakesPage({ mistakes, loading, onExplain }) {
  if (loading) {
    return (
      <div className="py-20 flex flex-col items-center justify-center text-slate-400 gap-3.5">
        <div className="w-9 h-9 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        <span className="text-sm font-medium">Xatolar yuklanmoqda...</span>
      </div>
    );
  }

  const demoMistakes = [
    {
      question: "Korporativ boshqaruvning asosiy maqsadi nimadan iborat?",
      correct_ans: "Aksiyadorlar va jamiyat manfaatlarini uyushgan holda himoya qilish",
      wrong_ans: "Faqatgina soliq to'lovlarini kamaytirish",
      subject: "Korporativ Boshqaruv"
    },
    {
      question: "Buxgalteriya balansi tenglamasining to'g'ri ko'rinishi qaysi?",
      correct_ans: "Aktivlar = Majburiyatlar + O'z sarmoyasi",
      wrong_ans: "Aktivlar = Daromadlar - Xarajatlar",
      subject: "Moliyaviy Hisob"
    }
  ];

  const list = (!mistakes || mistakes.length === 0) ? demoMistakes : mistakes;

  return (
    <div className="space-y-5 pb-6 animate-smooth-in">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-amber-500/15 text-amber-400 border border-amber-500/25">
            <Lightbulb className="w-5 h-5" />
          </div>
          <h2 className="text-base sm:text-lg font-extrabold text-slate-100 tracking-tight">
            Xatolar Hub & Flashcard
          </h2>
        </div>
        <span className="px-3 py-1 rounded-full bg-slate-900/80 border border-white/10 text-xs text-slate-400 font-semibold">
          {list.length} ta xato
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
        {list.map((m, idx) => (
          <div
            key={idx}
            className="spell-card rounded-2xl backdrop-blur-xl bg-slate-900/60 border border-white/10 border-l-4 border-l-rose-500 p-4 sm:p-5 space-y-3.5 shadow-lg flex flex-col justify-between"
          >
            <h4 className="text-sm sm:text-base font-bold text-slate-100 leading-snug">{m.question}</h4>

            <div className="text-xs space-y-2 bg-slate-950/40 p-3 rounded-xl border border-white/5">
              <div className="flex items-center gap-2 text-emerald-400 font-semibold">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>To'g'ri javob: <strong className="text-emerald-300">{m.correct_ans}</strong></span>
              </div>
              {m.wrong_ans && (
                <div className="flex items-center gap-2 text-rose-400 font-semibold">
                  <XCircle className="w-4 h-4 shrink-0" />
                  <span>Sizning tanlov: <strong className="text-rose-300">{m.wrong_ans}</strong></span>
                </div>
              )}
            </div>

            <button
              onClick={() => onExplain({
                question: m.question,
                correctAns: m.correct_ans,
                userAns: m.wrong_ans || '',
                subject: m.subject || 'Umumiy'
              })}
              className="spell-button cursor-pointer w-full py-2.5 rounded-xl bg-blue-500/15 border border-blue-500/30 text-blue-400 hover:text-blue-300 text-xs font-bold flex items-center justify-center gap-2 hover:bg-blue-500/25 transition-all duration-200 active:scale-95 shadow-sm"
            >
              <Bot className="w-4 h-4" />
              <span>AI Tushuntirishi</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
