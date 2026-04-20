const mockQuestions = {
  "brain-ring": [
    { id: "br1", text: "Qaysi sayyora Quyosh tizimida eng katta?", category: "Astronomiya", difficulty: "easy", correctAnswer: "Yupiter", timeLimit: 20, points: 1 },
    { id: "br2", text: "Amir Temur nechanchi yilda tug'ilgan?", category: "Tarix", difficulty: "medium", correctAnswer: "1336", timeLimit: 20, points: 1 },
    { id: "br3", text: "Dunyodagi eng katta ummon qaysi?", category: "Geografiya", difficulty: "easy", correctAnswer: "Tinch okeani", timeLimit: 20, points: 1 },
  ],
  kahoot: [
    { id: "k1", text: "Qaysi davlat eng katta maydonga ega?", category: "Geografiya", difficulty: "easy", correctAnswer: "Rossiya", options: ["AQSH", "Xitoy", "Rossiya", "Kanada"], timeLimit: 20, points: 10 },
    { id: "k2", text: "Davriy jadvalda birinchi element?", category: "Kimyo", difficulty: "easy", correctAnswer: "Vodorod", options: ["Geliy", "Vodorod", "Litiy", "Uglerod"], timeLimit: 20, points: 10 },
  ],
  zakovat: [
    { id: "z1", text: "Nisbiylik nazariyasini kim kashf etgan?", category: "Fizika", difficulty: "medium", correctAnswer: "Albert Eynshteyn", timeLimit: 60, points: 1 },
    { id: "z2", text: "O'zbekistondagi eng uzun daryo?", category: "Geografiya", difficulty: "medium", correctAnswer: "Amudaryo", timeLimit: 60, points: 1 },
    { id: "z3", text: "Qaysi davlat 2022-yilda FIFA Jahon chempionatini o'tkazdi?", category: "Sport", difficulty: "easy", correctAnswer: "Qatar", timeLimit: 60, points: 1 },
  ],
  erudit: [
    { id: "e1", text: "Qaysi matematik 'Pi' sonining dastlabki hisob-kitoblarini amalga oshirgan?", category: "Matematika", difficulty: "hard", correctAnswer: "Arximed", timeLimit: 15, points: 50 },
    { id: "e2", text: "Qaysi mamlakatda birinchi olimpiya o'yinlari o'tkazilgan?", category: "Tarix", difficulty: "medium", correctAnswer: "Gretsiya", timeLimit: 15, points: 30 },
    { id: "e3", text: "Qaysi element inson tanasida eng ko'p uchraydi?", category: "Biologiya", difficulty: "easy", correctAnswer: "Kislorod", timeLimit: 15, points: 10 },
  ],
};

function getQuestionsByMode(mode) {
  return mockQuestions[mode] || [];
}

/**
 * Returns the question payload WITHOUT the correctAnswer for secure client broadcast
 */
function getSecureQuestionPayload(question) {
  const { correctAnswer, ...secureQuestion } = question;
  return secureQuestion;
}

module.exports = {
  getQuestionsByMode,
  getSecureQuestionPayload,
};
