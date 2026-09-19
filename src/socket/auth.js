const crypto = require("crypto");
const { URLSearchParams } = require("url");
const { BOT_TOKEN } = require("../config/config");
const logger = require("../core/logger");

function validateTelegramInitData(initData) {
  if (!initData) return false;

  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get("hash");
    if (!hash) return false;
    urlParams.delete("hash");

    // Check expiration (24 hours) to prevent replay attacks
    const authDate = parseInt(urlParams.get("auth_date"), 10);
    if (authDate && (Math.floor(Date.now() / 1000) - authDate > 86400)) {
      return false;
    }

    const keys = Array.from(urlParams.keys()).sort();
    const dataCheckString = keys.map(key => `${key}=${urlParams.get(key)}`).join("\n");

    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN || "").digest();
    const hex = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

    return hex === hash;
  } catch {
    return false;
  }
}

const socketAuthMiddleware = (socket, next) => {
  try {
    const initData = socket.handshake.auth?.initData;
    const isMockAuthEnabled = process.env.ALLOW_MOCK_AUTH === "true";

    // 1. Local Bypass
    if (isMockAuthEnabled) {
      let userObj = { id: "mock_user_" + Math.floor(Math.random() * 10000), first_name: "MockUser" };
      if (initData) {
        const params = new URLSearchParams(initData);
        const userStr = params.get("user");
        if (userStr) {
          try {
            userObj = JSON.parse(decodeURIComponent(userStr));
          } catch {
            // ignore JSON parse error in mock mode
          }
        }
      }
      socket.user = userObj;
      return next();
    }

    // 2. Strict Telegram Auth
    if (!initData) {
      return next(new Error("Authentication error: Missing initData"));
    }

    if (!validateTelegramInitData(initData)) {
      return next(new Error("Authentication error: Invalid signature"));
    }

    const urlParams = new URLSearchParams(initData);
    const userStr = urlParams.get("user");
    if (userStr) {
      socket.user = JSON.parse(decodeURIComponent(userStr));
    } else {
      return next(new Error("Authentication error: Missing user context"));
    }

    next();
  } catch (error) {
    logger.error("Socket auth error:", { error: error.message });
    next(new Error("Authentication error: Internal validation failure"));
  }
};

module.exports = { validateTelegramInitData, socketAuthMiddleware };
