import React from 'react';
import { Bot, X, Sparkles, Check } from 'lucide-react';

export default function AiExplanationModal({ isOpen, onClose, explanation, loading }) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/80 backdrop-blur-md animate-fadeIn">
      <div className="w-full max-w-md sm:max-w-lg backdrop-blur-2xl bg-[#0A0E17]/95 border border-white/15 rounded-3xl p-6 sm:p-7 shadow-2xl relative overflow-hidden transition-all">
        {/* iOS Liquid Glass Ambient Glow */}
        <div className="absolute -top-16 -right-16 w-40 h-40 bg-blue-500/20 rounded-full blur-3xl pointer-events-none" />

        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-blue-500/20 text-blue-400 border border-blue-400/30">
              <Bot className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-base sm:text-lg font-extrabold text-slate-100 tracking-tight">
                AI Shaxsiy Ustoz Izohi
              </h3>
              <p className="text-xs text-slate-400">Tezkor pedagogik tahlil</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="cursor-pointer p-2 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-white/10 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="min-h-[120px] flex items-center justify-center text-sm sm:text-base text-slate-300 leading-relaxed">
          {loading ? (
            <div className="flex flex-col items-center gap-3 py-8 text-slate-400">
              <Sparkles className="w-7 h-7 animate-spin text-blue-400" />
              <span className="text-sm font-medium">AI pedagogik tahlil tayyorlamoqda...</span>
            </div>
          ) : (
            <div className="py-2 space-y-3 w-full">
              <div className="p-4 rounded-2xl bg-slate-900/80 border border-white/10 text-slate-200 whitespace-pre-wrap leading-relaxed">
                {explanation}
              </div>
            </div>
          )}
        </div>

        <button
          onClick={onClose}
          className="cursor-pointer w-full mt-6 py-3.5 rounded-2xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-sm font-extrabold flex items-center justify-center gap-2 shadow-lg shadow-blue-500/25 transition-all duration-200 active:scale-95"
        >
          <Check className="w-4 h-4" />
          <span>Tushunarli</span>
        </button>
      </div>
    </div>
  );
}
