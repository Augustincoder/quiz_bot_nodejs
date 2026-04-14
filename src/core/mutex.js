'use strict';

// Bir vaqtda kelgan so'rovlarni navbatga tizuvchi "Qulf" (Lock) tizimi
class Mutex {
  constructor() { 
    this._locks = new Map(); 
  }

  async lock(key) {
    // Agar bu kalit bo'yicha jarayon ketayotgan bo'lsa, tugashini kutamiz
    while (this._locks.has(key)) {
      await this._locks.get(key);
    }
    
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    this._locks.set(key, promise);
    
    // Jarayon tugagach qulfni ochish uchun funksiya qaytaramiz
    return () => {
      this._locks.delete(key);
      release();
    };
  }
}

module.exports = new Mutex();