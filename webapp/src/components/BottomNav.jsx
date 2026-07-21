import React from 'react';
import { LayoutDashboard, BookOpen, AlertCircle, ShieldAlert } from 'lucide-react';

export default function BottomNav({ currentTab, onChangeTab, isAdmin }) {
  const navItems = [
    { id: 'dashboard', label: 'Asosiy', icon: LayoutDashboard },
    { id: 'subjects', label: 'Fanlar', icon: BookOpen },
    { id: 'mistakes', label: 'Xatolar', icon: AlertCircle },
    ...(isAdmin ? [{ id: 'admin', label: 'Admin', icon: ShieldAlert }] : [])
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 backdrop-blur-2xl bg-[#0A0E17]/90 border-t border-white/10 px-4 py-2.5">
      <div className="max-w-md sm:max-w-2xl lg:max-w-4xl mx-auto flex items-center justify-around">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onChangeTab(item.id)}
              className={`cursor-pointer flex flex-col items-center gap-1 py-1.5 px-4 rounded-2xl transition-all duration-200 active:scale-95 ${
                isActive
                  ? 'bg-blue-500/15 border border-blue-500/30 text-blue-400 font-bold shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
              }`}
            >
              <Icon className={`w-5 h-5 ${isActive ? 'text-blue-400' : 'text-slate-400'}`} />
              <span className="text-[11px] font-medium tracking-tight">{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
