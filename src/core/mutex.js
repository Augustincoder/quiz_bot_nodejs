'use strict';

// Bir vaqtda kelgan so'rovlarni qat'iy FIFO navbatiga tizuvchi,
// xotira tozalanishi kafolatlangan va deadlocklardan himoyalangan "Qulf" (Lock) tizimi
class Mutex {
  constructor(defaultTimeoutMs = 15000) {
    this._locks = new Map();
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Berilgan kalit bo'yicha eksklyuziv qulf (lock) oladi.
   * Qat'iy FIFO promise zanjiridan foydalanadi va deadlocklarning oldini olish uchun
   * xavfsizlik taymeriga (default: 15 soniya) ega.
   *
   * @param {string|number} key - Qulflanuvchi resurs identifikatori (masalan, `chatId`).
   * @param {number} [timeoutMs=15000] - Navbatda kutish yoki ushlab turish maksimal vaqti (ms).
   * @returns {Promise<() => void>} Qulfni bo'shatuvchi (unlock) funksiya.
   */
  async lock(key, timeoutMs = this.defaultTimeoutMs) {
    const lockKey = String(key);
    const prevEntry = this._locks.get(lockKey) || { promise: Promise.resolve(), count: 0 };
    prevEntry.count += 1;

    let release;
    const nextPromise = new Promise((resolve) => {
      release = resolve;
    });

    const chainedPromise = prevEntry.promise.catch(() => {}).then(() => nextPromise);
    this._locks.set(lockKey, { promise: chainedPromise, count: prevEntry.count });

    let released = false;
    let holdTimer = null;

    const doRelease = () => {
      if (released) return;
      released = true;
      if (holdTimer) clearTimeout(holdTimer);
      const entry = this._locks.get(lockKey);
      if (entry) {
        entry.count -= 1;
        if (entry.count <= 0) {
          this._locks.delete(lockKey);
        }
      }
      release();
    };

    let waitTimer = null;
    try {
      await Promise.race([
        prevEntry.promise.catch(() => {}),
        new Promise((_, reject) => {
          waitTimer = setTimeout(() => {
            reject(new Error(`Mutex queue timeout for key: ${lockKey}`));
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
    if (holdTimer.unref) holdTimer.unref();

    return doRelease;
  }

  /**
   * Berilgan kalit bo'yicha eksklyuziv lock olib, funksiyani bajaradi va
   * bajarilgach (hatto xatolik yuz bersa ham) qulfni kafolatli bo'shatadi.
   *
   * @param {string|number} key - Qulflanuvchi resurs identifikatori.
   * @param {() => Promise<any>} fn - Eksklyuziv bajariluvchi asinxron funksiya.
   * @param {number} [timeoutMs=15000] - Maksimal kutish vaqti (ms).
   * @returns {Promise<any>}
   */
  async runExclusive(key, fn, timeoutMs = this.defaultTimeoutMs) {
    const unlock = await this.lock(key, timeoutMs);
    let execTimer;
    const timeoutPromise = new Promise((_, reject) => {
      execTimer = setTimeout(() => {
        reject(new Error(`Mutex execution timeout exceeded (${timeoutMs}ms) for key: ${key}`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([Promise.resolve().then(fn), timeoutPromise]);
    } finally {
      if (execTimer) clearTimeout(execTimer);
      unlock();
    }
  }

  /**
   * Test va monitoring uchun: ayni paytda faol qulflar soni.
   */
  get size() {
    return this._locks.size;
  }

  /**
   * Stale/orphaned locks tozalash (Memory hygiene)
   */
  cleanup() {
    for (const [key, entry] of this._locks.entries()) {
      if (!entry || entry.count <= 0) {
        this._locks.delete(key);
      }
    }
  }
}

const defaultMutex = new Mutex();
defaultMutex.Mutex = Mutex;
module.exports = defaultMutex;