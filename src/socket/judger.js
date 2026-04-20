function normalize(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function judge(playerAnswer, correctAnswer) {
  return normalize(playerAnswer) === normalize(correctAnswer);
}

module.exports = { judge, normalize };
