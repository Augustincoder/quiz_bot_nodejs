import React, { useState } from 'react';
import { 
  CheckCircle2, 
  XCircle, 
  Zap, 
  Shuffle, 
  Type, 
  AlignLeft, 
  Globe, 
  Flag 
} from 'lucide-react';

export default function SettingsModal({ isOpen, onClose }) {
  const [autoNextCorrect, setAutoNextCorrect] = useState(true);
  const [autoNextWrong, setAutoNextWrong] = useState(false);
  const [noAnim, setNoAnim] = useState(true);
  const [shuffle, setShuffle] = useState(false);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm animate-fadeIn">
      <div className="w-full max-w-lg bg-[#111a24] rounded-t-3xl border-t border-slate-800 p-5 pb-8 space-y-4 shadow-2xl">
        {/* Drag handle */}
        <div className="w-12 h-1.5 bg-slate-700 rounded-full mx-auto mb-2" />

        <div className="space-y-4">
          {/* Item 1 */}
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-emerald-500 flex items-center justify-center text-white">
                <CheckCircle2 className="w-5 h-5" />
              </div>
              <span className="text-sm font-semibold text-slate-100">To'g'ri javobda avtomatik o'tish</span>
            </div>
            <button
              onClick={() => setAutoNextCorrect(!autoNextCorrect)}
              className={`w-12 h-6 rounded-full transition-colors relative flex items-center px-1 ${
                autoNextCorrect ? 'bg-[#58cc02]' : 'bg-slate-700'
              }`}
            >
              <div className={`w-4 h-4 rounded-full bg-white transition-transform ${
                autoNextCorrect ? 'translate-x-6' : 'translate-x-0'
              }`} />
            </button>
          </div>

          <div className="h-[1px] bg-slate-800/60" />

          {/* Item 2 */}
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-rose-500 flex items-center justify-center text-white">
                <XCircle className="w-5 h-5" />
              </div>
              <span className="text-sm font-semibold text-slate-100">Xato javobda avtomatik o'tish</span>
            </div>
            <button
              onClick={() => setAutoNextWrong(!autoNextWrong)}
              className={`w-12 h-6 rounded-full transition-colors relative flex items-center px-1 ${
                autoNextWrong ? 'bg-[#58cc02]' : 'bg-slate-700'
              }`}
            >
              <div className={`w-4 h-4 rounded-full bg-white transition-transform ${
                autoNextWrong ? 'translate-x-6' : 'translate-x-0'
              }`} />
            </button>
          </div>

          <div className="h-[1px] bg-slate-800/60" />

          {/* Item 3 */}
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-purple-500 flex items-center justify-center text-white">
                <Zap className="w-5 h-5" />
              </div>
              <span className="text-sm font-semibold text-slate-100">Animatsiyasiz o'tish</span>
            </div>
            <button
              onClick={() => setNoAnim(!noAnim)}
              className={`w-12 h-6 rounded-full transition-colors relative flex items-center px-1 ${
                noAnim ? 'bg-[#58cc02]' : 'bg-slate-700'
              }`}
            >
              <div className={`w-4 h-4 rounded-full bg-white transition-transform ${
                noAnim ? 'translate-x-6' : 'translate-x-0'
              }`} />
            </button>
          </div>

          <div className="h-[1px] bg-slate-800/60" />

          {/* Item 4 */}
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-amber-500 flex items-center justify-center text-white">
                <Shuffle className="w-5 h-5" />
              </div>
              <span className="text-sm font-semibold text-slate-100">Variantlarni aralashtirish</span>
            </div>
            <button
              onClick={() => setShuffle(!shuffle)}
              className={`w-12 h-6 rounded-full transition-colors relative flex items-center px-1 ${
                shuffle ? 'bg-[#58cc02]' : 'bg-slate-700'
              }`}
            >
              <div className={`w-4 h-4 rounded-full bg-white transition-transform ${
                shuffle ? 'translate-x-6' : 'translate-x-0'
              }`} />
            </button>
          </div>

          <div className="h-[1px] bg-slate-800/60" />

          {/* Item 5 */}
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-fuchsia-500 flex items-center justify-center text-white">
                <Type className="w-5 h-5" />
              </div>
              <span className="text-sm font-semibold text-slate-100">Shrift o'lchami</span>
            </div>
            <span className="text-sm font-medium text-slate-400">O'rtacha</span>
          </div>

          <div className="h-[1px] bg-slate-800/60" />

          {/* Item 6 */}
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-cyan-500 flex items-center justify-center text-white">
                <AlignLeft className="w-5 h-5" />
              </div>
              <span className="text-sm font-semibold text-slate-100">Shrift uslubi</span>
            </div>
            <span className="text-sm font-medium text-slate-400">Yumshoq</span>
          </div>

          <div className="h-[1px] bg-slate-800/60" />

          {/* Item 7 */}
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-blue-500 flex items-center justify-center text-white">
                <Globe className="w-5 h-5" />
              </div>
              <span className="text-sm font-semibold text-slate-100">Ilova tili</span>
            </div>
            <span className="text-sm font-medium text-slate-400">O'zbekcha</span>
          </div>

          <div className="h-[1px] bg-slate-800/60" />

          {/* Item 8 */}
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-rose-500 flex items-center justify-center text-white">
                <Flag className="w-5 h-5" />
              </div>
              <span className="text-sm font-semibold text-slate-100">Xatolik haqida xabar berish</span>
            </div>
          </div>
        </div>

        {/* Save button matching screenshot */}
        <button
          onClick={onClose}
          className="w-full mt-4 py-3.5 rounded-2xl bg-[#58cc02] hover:bg-[#4cad00] text-white font-bold text-base shadow-lg shadow-green-500/20 active:scale-[0.98] transition-all"
        >
          Saqlash
        </button>
      </div>
    </div>
  );
}
