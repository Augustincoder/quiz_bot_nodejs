let sessionToken = '';

export function setSessionToken(token) {
  sessionToken = token;
}

async function request(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(sessionToken ? { 'Authorization': `Bearer ${sessionToken}` } : {}),
    ...options.headers,
  };

  const res = await fetch(path, { ...options, headers });
  return res.json();
}

export const api = {
  auth: (initData) => request('/api/webapp/auth', {
    method: 'POST',
    body: JSON.stringify({ initData })
  }),
  getStreak: () => request('/api/webapp/streak'),
  getSubjects: () => request('/api/webapp/subjects'),
  getQuestions: (subject) => request('/api/webapp/questions?subject=' + encodeURIComponent(subject || 'korporativ')),
  getMistakes: () => request('/api/webapp/mistakes'),
  explainMistake: (payload) => request('/api/webapp/explain', {
    method: 'POST',
    body: JSON.stringify(payload)
  }),
  getStats: () => request('/api/webapp/stats'),
  finishTest: (payload) => request('/api/webapp/finish-test', {
    method: 'POST',
    body: JSON.stringify(payload)
  })
};
