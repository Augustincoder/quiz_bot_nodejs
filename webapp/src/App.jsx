import React, { useState, useEffect } from 'react';
import { initTelegramWebApp, getInitData } from './lib/telegram';
import { api, setSessionToken } from './lib/api';

import Navbar from './components/Navbar';
import BottomNav from './components/BottomNav';
import AiExplanationModal from './components/AiExplanationModal';

import DashboardPage from './pages/DashboardPage';
import SubjectsPage from './pages/SubjectsPage';
import StudyPage from './pages/StudyPage';
import MistakesPage from './pages/MistakesPage';
import AdminPage from './pages/AdminPage';

export default function App() {
  const [currentTab, setCurrentTab] = useState('dashboard');
  const [user, setUser] = useState(null);
  const [streak, setStreak] = useState(0);
  const [subjects, setSubjects] = useState([]);
  const [mistakes, setMistakes] = useState([]);
  const [loadingSubjects, setLoadingSubjects] = useState(false);
  const [loadingMistakes, setLoadingMistakes] = useState(false);

  // Active study session
  const [activeSubject, setActiveSubject] = useState(null);

  // AI Modal
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiExplanation, setAiExplanation] = useState('');
  const [aiLoading, setAiLoading] = useState(false);

  useEffect(() => {
    initTelegramWebApp();
    const initData = getInitData();

    if (initData) {
      api.auth(initData).then((res) => {
        if (res.success) {
          setSessionToken(res.token);
          setUser(res.user);
          loadStreak();
        }
      });
    } else {
      // Dev mode fallback
      setUser({ id: 'dev', first_name: 'Dev Mehmon', isPremium: true });
    }

    // Deep linking check for one-tap Telegram Bot -> WebApp subject launch
    try {
      const params = new URLSearchParams(window.location.search);
      const startParam = window.Telegram?.WebApp?.initDataUnsafe?.start_param || params.get('startapp') || '';
      const subjectKey = params.get('subject') || (startParam.startsWith('subj_') ? startParam.replace('subj_', '') : null);
      const tabKey = params.get('tab') || (startParam.startsWith('tab_') ? startParam.replace('tab_', '') : null);

      const subjectMap = {
        korporativ: { key: 'korporativ', name: '🎓 Korporativ Boshqaruv' },
        moliyaviy: { key: 'moliyaviy', name: '💰 Moliyaviy Hisob' },
        ekonometrika: { key: 'ekonometrika', name: '📈 Iqtisodiy tahlil' },
        math: { key: 'math', name: '🧮 Matematika' },
        tarix: { key: 'tarix', name: '🏛 Tarix' },
        english: { key: 'english', name: '🇬🇧 Ingliz tili' },
      };

      if (subjectKey) {
        setActiveSubject(subjectMap[subjectKey] || { key: subjectKey, name: `🎓 ${subjectKey.toUpperCase()}` });
      } else if (tabKey) {
        setCurrentTab(tabKey);
        if (tabKey === 'subjects') loadSubjects();
        if (tabKey === 'mistakes') loadMistakes();
      }
    } catch (e) {
      console.warn('Deep link parse error:', e);
    }
  }, []);

  const loadStreak = async () => {
    try {
      const res = await api.getStreak();
      if (res.success) setStreak(res.streak_days || 0);
    } catch (e) {}
  };

  const loadSubjects = async () => {
    setLoadingSubjects(true);
    try {
      const res = await api.getSubjects();
      if (res.success && res.subjects) setSubjects(res.subjects);
    } catch (e) {}
    setLoadingSubjects(false);
  };

  const loadMistakes = async () => {
    setLoadingMistakes(true);
    try {
      const res = await api.getMistakes();
      if (res.success && res.mistakes) setMistakes(res.mistakes);
    } catch (e) {}
    setLoadingMistakes(false);
  };

  const handleNavigate = (tab) => {
    setActiveSubject(null);
    setCurrentTab(tab);
    if (tab === 'subjects') loadSubjects();
    if (tab === 'mistakes') loadMistakes();
  };

  const handleSelectSubject = (sub) => {
    setActiveSubject(sub);
  };

  const handleExplain = async (payload) => {
    setAiModalOpen(true);
    setAiLoading(true);
    setAiExplanation('');
    try {
      const res = await api.explainMistake(payload);
      if (res.success) {
        setAiExplanation(res.explanation);
      } else {
        setAiExplanation(res.error || 'Izohlashda xatolik yuz berdi');
      }
    } catch (e) {
      setAiExplanation('Server bilan bog\'lanishda xatolik');
    }
    setAiLoading(false);
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#0A0E17] text-slate-100 font-sans antialiased selection:bg-blue-500 selection:text-white">
      <Navbar user={user} streak={streak} />

      <main className="flex-1 px-4 sm:px-6 md:px-8 pt-4 pb-24 max-w-md sm:max-w-2xl lg:max-w-4xl mx-auto w-full transition-all">
        {activeSubject ? (
          <StudyPage
            subject={activeSubject}
            onFinish={() => setActiveSubject(null)}
            onExplain={handleExplain}
          />
        ) : (
          <>
            {currentTab === 'dashboard' && (
              <DashboardPage
                onNavigate={handleNavigate}
                streak={streak}
              />
            )}

            {currentTab === 'subjects' && (
              <SubjectsPage
                subjects={subjects}
                loading={loadingSubjects}
                onSelectSubject={handleSelectSubject}
              />
            )}

            {currentTab === 'mistakes' && (
              <MistakesPage
                mistakes={mistakes}
                loading={loadingMistakes}
                onExplain={handleExplain}
              />
            )}

            {currentTab === 'admin' && <AdminPage />}
          </>
        )}
      </main>

      <BottomNav
        currentTab={currentTab}
        onChangeTab={handleNavigate}
        isAdmin={user?.id === 'admin'}
      />

      <AiExplanationModal
        isOpen={aiModalOpen}
        onClose={() => setAiModalOpen(false)}
        explanation={aiExplanation}
        loading={aiLoading}
      />
    </div>
  );
}
