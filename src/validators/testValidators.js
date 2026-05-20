'use strict';
const { z } = require('zod');

// QATTIQ CHEKLOV OLIB TASHLANDI:
// Endi o'zbek kirill harflari, lotin harflari (o', g'), bo'sh joy (probel), 
// tire, nuqta, vergul, va tutuq belgisi (') ishlatilishiga ruxsat beriladi.
const nameRegex = /^[a-zA-Z0-9\s\-_.,'"\u0400-\u04FF\u0100-\u017F]+$/;

const SubjectSchema = z.string()
  .min(2, "Kamida 2 ta belgi bo'lishi kerak")
  .max(50, "Maksimal 50 ta belgi ruxsat etiladi")
  .regex(nameRegex, "Faqat harflar, raqamlar, probel va odatiy belgilar mumkin");

const BlockSchema = z.string()
  .min(2, "Kamida 2 ta belgi bo'lishi kerak")
  .max(50, "Maksimal 50 ta belgi ruxsat etiladi")
  .regex(nameRegex, "Faqat harflar, raqamlar, probel va odatiy belgilar mumkin");

function validateSubject(name) {
  const result = SubjectSchema.safeParse(name);
  if (!result.success) return result.error.errors[0].message;
  return null;
}

function validateBlockName(name) {
  const result = BlockSchema.safeParse(name);
  if (!result.success) return result.error.errors[0].message;
  return null;
}

module.exports = {
  validateSubject,
  validateBlockName
};