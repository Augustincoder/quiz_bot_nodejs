import React from 'react';
import { Play, BookOpen, AlertTriangle, TrendingUp, Award, Sparkles, ChevronRight } from 'lucide-react';

export default function DashboardPage({ onNavigate, stats, streak }) {
  return (
    <div className="space-y-6 pb-6 animate-smooth-in">
      {/* iOS Liquid Glass Hero Card with subtle float & spell hover */}
      <div className="spell-card relative overflow-hidden rounded-3xl bg-gradient-to-br from-blue-600/25 via-indigo-600/20 to-purple-600/25 border border-white/15 p-6 sm:p-8 shadow-2xl backdrop-blur-2xl">
        <div className="absolute top-0 right-0 -mt-10 -mr-10 w-44 h-44 bg-blue-500/15 rounded-full blur-3xl pointer-events-none" />
        <div className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-blue-500/20 border border-blue-400/30 text-blue-300 text-xs font-bold mb-4 shadow-sm">
          <Sparkles className="w-3.5 h-3.5 animate-subtle-float" />
          <span>AI Shaxsiy Ustoz Yordamchisi</span>
        </div>
        <h2 className="text-xl sm:text-2xl font-extrabold text-white mb-2 tracking-tight">
          Imtihonga 100% tayyorgarlik
        </h2>
        <p className="text-sm sm:text-base text-slate-300 mb-6 leading-relaxed max-w-lg">
          AI Tutor sizning zaif nuqtalaringizni aniqlaydi va tezkor o'zlashtirishingizga yordam beradi.
        </p>
        <button
          onClick={() => onNavigate('subjects')}
          className="spell-button cursor-pointer w-full sm:w-auto px-7 py-3.5 rounded-2xl bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700 text-white font-extrabold flex items-center justify-center gap-2.5 shadow-xl shadow-blue-500/25"
        >
          <Play className="w-4 h-4 fill-white" />
          <span>Test Yechishni Boshlash</span>
        </button>
      </div>

      {/* Stats Grid - 2 columns on mobile, scale cleanly */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4">
        <div className="spell-card rounded-2xl backdrop-blur-xl bg-slate-900/60 border border-white/10 p-4 sm:p-5 flex items-center gap-3.5 shadow-lg">
          <div className="p-3 rounded-2xl bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 shrink-0">
            <Award className="w-6 h-6 animate-subtle-float" />
          </div>
          <div>
            <div className="text-xl sm:text-2xl font-extrabold text-slate-100 tracking-tight">{streak || 0}</div>
            <div className="text-xs text-slate-400 font-medium">Kunlik Streak</div>
          </div>
        </div>

        <div className="spell-card rounded-2xl backdrop-blur-xl bg-slate-900/60 border border-white/10 p-4 sm:p-5 flex items-center gap-3.5 shadow-lg">
          <div className="p-3 rounded-2xl bg-blue-500/15 text-blue-400 border border-blue-500/25 shrink-0">
            <TrendingUp className="w-6 h-6 animate-subtle-float" />
          </div>
          <div>
            <div className="text-xl sm:text-2xl font-extrabold text-slate-100 tracking-tight">{stats?.accuracy || '85%'}</div>
            <div className="text-xs text-slate-400 font-medium">O'rtacha aniqlik</div>
          </div>
        </div>
      </div>

      {/* Shortcuts Grid */}
      <div className="space-y-3">
        <h3 className="text-xs font-extrabold uppercase tracking-wider text-slate-400 px-1">
          Tezkor bo'limlar
        </h3>
        <div className="grid grid-cols-1 gap-3">
          <div
            onClick={() => onNavigate('subjects')}
            className="spell-card cursor-pointer rounded-2xl backdrop-blur-xl bg-slate-900/60 hover:bg-slate-900/85 border border-white/10 hover:border-blue-500/40 p-4 sm:p-5 flex items-center justify-between group shadow-lg"
          >
            <div className="flex items-center gap-3.5">
              <div className="p-3 rounded-2xl bg-blue-500/15 text-blue-400 border border-blue-500/25 group-hover:scale-105 transition-transform shrink-0">
                <BookOpen className="w-6 h-6" />
              </div>
              <div>
                <h4 className="text-sm sm:text-base font-bold text-slate-100">Fanlar va Bloklar</h4>
                <p className="text-xs text-slate-400 mt-0.5">Barcha rasmiy testlar ro'yxati</p>
              </div>
            </div>
            <ChevronRight className="w-5 h-5 text-slate-500 group-hover:text-slate-300 transition-colors shrink-0" />
          </div>

          <div
            onClick={() => onNavigate('mistakes')}
            className="spell-card cursor-pointer rounded-2xl backdrop-blur-xl bg-slate-900/60 hover:bg-slate-900/85 border border-white/10 hover:border-amber-500/40 p-4 sm:p-5 flex items-center justify-between group shadow-lg"
          >
            <div className="flex items-center gap-3.5">
              <div className="p-3 rounded-2xl bg-amber-500/15 text-amber-400 border border-amber-500/25 group-hover:scale-105 transition-transform shrink-0">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <h4 className="text-sm sm:text-base font-bold text-slate-100">Xatolar Hub & Flashcard</h4>
                <p className="text-xs text-slate-400 mt-0.5">Adashgan savollarni takrorlash va AI izoh</p>
              </div>
            </div>
            <ChevronRight className="w-5 h-5 text-slate-500 group-hover:text-slate-300 transition-colors shrink-0" />
          </div>
        </div>
      </div>
    </div>
  );
}
