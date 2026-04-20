const crypto = require("crypto");
const { BOT_TOKEN } = require("../config/config");

function validateTelegramInitData(initData) {
  if (!initData) return false;

  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get("hash");
  if (!hash) return false;
  urlParams.delete("hash");
  
  const keys = Array.from(urlParams.keys()).sort();
  const dataCheckString = keys.map(key => `${key}=${urlParams.get(key)}`).join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN || "").digest();
  const hex = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  return hex === hash;
}

const socketAuthMiddleware = (socket, next) => {
  try {
    const initData = socket.handshake.auth?.initData;
    const isMockAuthEnabled = process.env.ALLOW_MOCK_AUTH === "true";

    // 1. Local Bypass
    if (isMockAuthEnabled) {
      let userObj = { id: "mock_user_" + Math.floor(Math.random()*10000), first_name: "MockUser" };
      if (initData) {
        const params = new URLSearchParams(initData);
        const userStr = params.get("user");
        if (userStr) {
          try {
            userObj = JSON.parse(decodeURIComponent(userStr));
          } catch(e) {}
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
    console.error("Socket auth error:", error);
    next(new Error("Authentication error: Internal validation failure"));
  }
};

module.exports = { socketAuthMiddleware };
