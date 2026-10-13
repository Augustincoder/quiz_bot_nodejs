'use strict';

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function prepareShuffledQuestions(rawQuestions) {
  const shuffledQ = shuffleArray(rawQuestions);
  return shuffledQ.map(q => {
    const correctText = q.options ? q.options[q.correct_index] : undefined;
    const options     = shuffleArray(q.options || []);
    return {
      question:      q.question,
      options,
      correct_index: options.indexOf(correctText),
      correct_text:  correctText,
    };
  });
}

module.exports = { prepareShuffledQuestions, shuffleArray };