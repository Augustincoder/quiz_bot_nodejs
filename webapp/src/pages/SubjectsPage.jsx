import React from 'react';
import { BookOpen, ChevronRight, Library } from 'lucide-react';

export default function SubjectsPage({ subjects, loading, onSelectSubject }) {
  if (loading) {
    return (
      <div className="py-20 flex flex-col items-center justify-center text-slate-400 gap-3.5">
        <div className="w-9 h-9 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        <span className="text-sm font-medium">Fanlar yuklanmoqda...</span>
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-6 animate-fadeIn">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-blue-500/15 text-blue-400 border border-blue-500/25">
            <Library className="w-5 h-5" />
          </div>
          <h2 className="text-base sm:text-lg font-extrabold text-slate-100 tracking-tight">
            Fanlar ro'yxati
          </h2>
        </div>
        <span className="px-3 py-1 rounded-full bg-slate-900/80 border border-white/10 text-xs text-slate-400 font-semibold">
          {subjects.length} ta fan
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
        {subjects.map((sub) => (
          <div
            key={sub.key}
            onClick={() => onSelectSubject(sub)}
            className={`spell-card cursor-pointer rounded-2xl backdrop-blur-xl transition-all p-4 sm:p-5 flex items-center justify-between group shadow-lg border ${
              sub.isUserCreated
                ? 'bg-gradient-to-r from-indigo-950/70 to-slate-900/80 border-indigo-500/40 hover:border-indigo-400'
                : 'bg-slate-900/60 hover:bg-slate-900/85 border-white/10 hover:border-blue-500/40'
            }`}
          >
            <div className="flex items-center gap-3.5">
              <div className={`p-3 rounded-2xl border group-hover:scale-105 transition-transform shrink-0 ${
                sub.isUserCreated
                  ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30'
                  : 'bg-blue-500/15 text-blue-400 border-blue-500/25'
              }`}>
                <BookOpen className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h4 className="text-sm sm:text-base font-bold text-slate-100">{sub.name}</h4>
                  {sub.isUserCreated && (
                    <span className="px-2 py-0.5 rounded-md bg-indigo-500/20 border border-indigo-400/30 text-[10px] text-indigo-300 font-extrabold uppercase tracking-wide">
                      Mening testim
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-400 font-medium mt-0.5">
                  {sub.isUserCreated
                    ? `${sub.count || 0} ta savol • Maxsus test`
                    : `Blok: ${sub.key}`}
                </p>
              </div>
            </div>
            <ChevronRight className="w-5 h-5 text-slate-500 group-hover:text-slate-200 transition-colors shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}
