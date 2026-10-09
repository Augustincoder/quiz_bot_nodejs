'use strict';

process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'dummy_test_token';

const { socketAuthMiddleware } = require('../src/socket/auth');

function createMockSocket(auth = {}) {
  return {
    handshake: { auth },
    user: null
  };
}

async function runTests() {
  console.log('🧪 Starting Socket Auth Security & Mock Auth Tests...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`  ✅ Passed: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAILED: ${testName} ${details ? '— ' + details : ''}`);
      failed++;
    }
  }

  const originalEnv = process.env.NODE_ENV;
  const originalMock = process.env.ALLOW_MOCK_AUTH;

  try {
    // Test 1: Production environment + ALLOW_MOCK_AUTH='true' => Reject
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_MOCK_AUTH = 'true';
    let mockSocket = createMockSocket();
    let errResult = null;
    socketAuthMiddleware(mockSocket, (err) => { errResult = err; });
    assert(errResult instanceof Error && errResult.message.includes('Mock auth forbidden'),
      'Production mode rejects mock auth even if ALLOW_MOCK_AUTH is true');

    // Test 2: Unset NODE_ENV + ALLOW_MOCK_AUTH='true' => Reject
    delete process.env.NODE_ENV;
    process.env.ALLOW_MOCK_AUTH = 'true';
    mockSocket = createMockSocket();
    errResult = null;
    socketAuthMiddleware(mockSocket, (err) => { errResult = err; });
    assert(errResult instanceof Error && errResult.message.includes('Mock auth forbidden'),
      'Unset NODE_ENV rejects mock auth if ALLOW_MOCK_AUTH is true');

    // Test 3: Staging NODE_ENV + ALLOW_MOCK_AUTH='true' => Reject
    process.env.NODE_ENV = 'staging';
    process.env.ALLOW_MOCK_AUTH = 'true';
    mockSocket = createMockSocket();
    errResult = null;
    socketAuthMiddleware(mockSocket, (err) => { errResult = err; });
    assert(errResult instanceof Error && errResult.message.includes('Mock auth forbidden'),
      'Staging mode rejects mock auth if ALLOW_MOCK_AUTH is true');

    // Test 4: Development environment + ALLOW_MOCK_AUTH='true' => Allow
    process.env.NODE_ENV = 'development';
    process.env.ALLOW_MOCK_AUTH = 'true';
    mockSocket = createMockSocket();
    errResult = null;
    socketAuthMiddleware(mockSocket, (err) => { errResult = err; });
    assert(errResult === undefined && mockSocket.user && mockSocket.user.id.startsWith('mock_user_'),
      'Development mode allows mock auth when ALLOW_MOCK_AUTH is true');

    // Test 5: Test environment + ALLOW_MOCK_AUTH='true' => Allow
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_MOCK_AUTH = 'true';
    mockSocket = createMockSocket();
    errResult = null;
    socketAuthMiddleware(mockSocket, (err) => { errResult = err; });
    assert(errResult === undefined && mockSocket.user && mockSocket.user.id.startsWith('mock_user_'),
      'Test mode allows mock auth when ALLOW_MOCK_AUTH is true');

    // Test 6: Test environment + ALLOW_MOCK_AUTH='false' + no initData => Reject missing initData
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_MOCK_AUTH = 'false';
    mockSocket = createMockSocket();
    errResult = null;
    socketAuthMiddleware(mockSocket, (err) => { errResult = err; });
    assert(errResult instanceof Error && errResult.message.includes('Missing initData'),
      'When mock auth is disabled, missing initData returns error');

  } finally {
    if (originalEnv !== undefined) process.env.NODE_ENV = originalEnv;
    else delete process.env.NODE_ENV;

    if (originalMock !== undefined) process.env.ALLOW_MOCK_AUTH = originalMock;
    else delete process.env.ALLOW_MOCK_AUTH;
  }

  console.log(`\n📊 Socket Auth Security Test Results: ${passed} Passed, ${failed} Failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
