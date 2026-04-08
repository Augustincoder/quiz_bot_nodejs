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
    const options     = [...q.options];
    const correctText = options[q.correct_index];
    shuffleArray(options);          // in-place shuffle
    for (let i = options.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [options[i], options[j]] = [options[j], options[i]];
    }
    return {
      question:      q.question,
      options,
      correct_index: options.indexOf(correctText),
      correct_text:  correctText,
    };
  });
}

module.exports = { prepareShuffledQuestions, shuffleArray };