import React from 'react';
import { ShieldCheck, CheckCircle2, XCircle, Send } from 'lucide-react';

export default function AdminPage() {
  return (
    <div className="space-y-6 pb-6">
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-6 h-6 text-purple-400" />
        <h2 className="text-lg font-bold text-slate-100">Admin Boshqaruv Paneli</h2>
      </div>

      {/* Broadcast Box */}
      <div className="glass-card p-4 space-y-3">
        <h3 className="text-sm font-bold text-slate-100">📢 Umumiy Xabar (Broadcast)</h3>
        <textarea
          placeholder="Barcha foydalanuvchilarga xabar matni..."
          rows={3}
          className="w-full rounded-xl bg-slate-900 border border-slate-800 p-3 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
        />
        <button className="w-full py-2 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition-all">
          <Send className="w-3.5 h-3.5" />
          <span>Xabar Yuborish</span>
        </button>
      </div>

      {/* Pending Payments */}
      <div className="space-y-3">
        <h3 className="text-sm font-bold text-slate-100">💎 Kutilayotgan PRO To'lovlar</h3>
        <div className="glass-card p-4 text-center text-xs text-slate-400 py-6">
          Hozircha kutilayotgan cheklar yo'q
        </div>
      </div>
    </div>
  );
}
