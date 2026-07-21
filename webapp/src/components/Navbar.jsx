import React from 'react';
import { Flame, Sparkles, GraduationCap } from 'lucide-react';

export default function Navbar({ user, streak }) {
  return (
    <header className="sticky top-0 z-50 backdrop-blur-xl bg-[#0A0E17]/80 border-b border-white/10 px-4 sm:px-6 py-3.5">
      <div className="max-w-md sm:max-w-2xl lg:max-w-4xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="animate-subtle-float w-10 h-10 rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/25 border border-white/10">
            <GraduationCap className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-sm sm:text-base font-extrabold text-slate-100 leading-tight tracking-tight">Quiz Bot Pro</h1>
            <p className="text-xs text-slate-400 font-medium">
              {user ? `${user.first_name || 'Talaba'}` : 'Talaba'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {streak !== undefined && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs font-bold shadow-sm">
              <Flame className="w-3.5 h-3.5 fill-amber-500 text-amber-500 animate-pulse" />
              <span>{streak} kun</span>
            </div>
          )}

          {user?.isPremium && (
            <div className="animate-ambient flex items-center gap-1 px-3 py-1.5 rounded-full bg-gradient-to-r from-purple-600 to-blue-600 text-white text-[11px] font-extrabold shadow-md tracking-wide">
              <Sparkles className="w-3 h-3" />
              <span>PRO</span>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
