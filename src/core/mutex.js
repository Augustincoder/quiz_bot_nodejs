'use strict';

// Bir vaqtda kelgan so'rovlarni qat'iy FIFO navbatiga tizuvchi va deadlocklardan himoyalangan "Qulf" (Lock) tizimi
class Mutex {
  constructor() {
    this._locks = new Map();
  }

  /**
   * Berilgan kalit bo'yicha eksklyuziv qulf (lock) oladi.
   * Qat'iy FIFO promise zanjiridan foydalanadi va deadlocklarning oldini olish uchun
   * xavfsizlik taymeriga (default: 15 soniya) ega.
   *
   * @param {string} key - Qulflanuvchi resurs identifikatori (masalan, `chatId`).
   * @param {number} [timeoutMs=15000] - Navbatda kutish yoki ushlab turish maksimal vaqti (ms).
   * @returns {Promise<() => void>} Qulfni bo'shatuvchi (unlock) funksiya.
   */
  async lock(key, timeoutMs = 15000) {
    const prev = this._locks.get(key) || Promise.resolve();

    let release;
    const next = new Promise((resolve) => {
      release = resolve;
    });

    this._locks.set(key, next);

    let released = false;
    let holdTimer = null;

    const doRelease = () => {
      if (released) return;
      released = true;
      if (holdTimer) clearTimeout(holdTimer);
      if (this._locks.get(key) === next) {
        this._locks.delete(key);
      }
      release();
    };

    let waitTimer = null;
    try {
      await Promise.race([
        prev.catch(() => {}),
        new Promise((_, reject) => {
          waitTimer = setTimeout(() => {
            reject(new Error(`Mutex queue timeout for key: ${key}`));
          }, timeoutMs);
        }),
      ]);
    } catch (err) {
      doRelease();
      throw err;
    } finally {
      if (waitTimer) clearTimeout(waitTimer);
    }

    holdTimer = setTimeout(() => {
      doRelease();
    }, timeoutMs);

    return doRelease;
  }
}

module.exports = new Mutex();