export const tg = window.Telegram?.WebApp;

export function initTelegramWebApp() {
  if (tg) {
    tg.ready();
    tg.expand();
    tg.setHeaderColor('#0f172a');
    tg.setBackgroundColor('#0f172a');
  }
}

export function triggerHaptic(type = 'medium') {
  if (tg?.HapticFeedback) {
    try {
      tg.HapticFeedback.impactOccurred(type);
    } catch (e) {
      // Ignored if unsupported
    }
  }
}

export function getInitData() {
  return tg?.initData || '';
}
