/**
 * TakaEarn — CPAGrip Global Postback (Vercel serverless)
 *
 * CPAGrip → Global Postback URL (example after deploy):
 *   https://YOUR-PROJECT.vercel.app/?userId={user_id}&payout={payout}&offerId={offer_id}&status={status}&trackingId={tracking_id}
 *
 * Password in CPAGrip dashboard: Im@d29tkr
 *
 * Required Vercel Environment Variables:
 *   FIREBASE_SERVICE_ACCOUNT  = full service-account JSON as one line
 *   (optional) CPAGRIP_PASSWORD = defaults to Im@d29tkr
 *   (optional) USD_TO_BDT      = defaults to 110
 */

const admin = require("firebase-admin");

const POSTBACK_PASSWORD = process.env.CPAGRIP_PASSWORD || "Im@d29tkr";
const DEFAULT_USD_TO_BDT = Number(process.env.USD_TO_BDT || 110);

function initFirebase() {
  if (admin.apps.length) return admin.firestore();

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error("Missing env FIREBASE_SERVICE_ACCOUNT");
  }

  let sa;
  try {
    sa = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON");
  }

  // Private keys in env often have literal \n — normalize
  if (sa.private_key && sa.private_key.includes("\\n")) {
    sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  }

  admin.initializeApp({
    credential: admin.credential.cert(sa),
  });

  return admin.firestore();
}

function pick(q, keys, fallback = "") {
  for (const k of keys) {
    if (q[k] !== undefined && q[k] !== null && String(q[k]).length) {
      return String(q[k]);
    }
  }
  return fallback;
}

async function creditWallet(db, userId, amount) {
  const FieldValue = admin.firestore.FieldValue;
  const walletRef = db.collection("wallets").doc(userId);
  await walletRef.set(
    {
      availableBalance: FieldValue.increment(amount),
      totalEarned: FieldValue.increment(amount),
      todayEarnings: FieldValue.increment(amount),
      updatedAt: Date.now(),
    },
    { merge: true }
  );
}

async function writeTransaction(db, userId, amount, offerId) {
  const ref = db.collection("transactions").doc(userId).collection("items").doc();
  await ref.set({
    transactionId: ref.id,
    userId,
    type: "OFFERWALL",
    amount,
    status: "COMPLETED",
    taskId: `cpagrip_${offerId}`,
    description: `CPAGrip offer #${offerId}`,
    createdAt: Date.now(),
  });
  return ref.id;
}

module.exports = async function handler(req, res) {
  // CORS / health
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    const q = { ...(req.query || {}), ...(req.body || {}) };

    const password = pick(q, ["password", "pass", "pwd"]);
    if (password !== POSTBACK_PASSWORD) {
      console.warn("CPAGrip: invalid password");
      res.statusCode = 403;
      res.end("FORBIDDEN");
      return;
    }

    const userId = pick(q, ["userId", "user_id", "subid", "sid", "s1"]).trim();
    const payoutRaw = parseFloat(pick(q, ["payout", "amount", "rate"], "0"));
    const offerId = pick(q, ["offerId", "offer_id", "campaign_id", "oid"], "unknown");
    const status = pick(q, ["status", "event"], "1").toLowerCase();
    const trackingId = pick(
      q,
      ["trackingId", "tracking_id", "click_id", "transaction_id"],
      `${userId}_${offerId}_${payoutRaw}`
    );

    const okStatuses = new Set(["1", "ok", "completed", "complete", "approved", "success", ""]);
    if (!okStatuses.has(status)) {
      console.log(`CPAGrip ignored status=${status} user=${userId}`);
      res.statusCode = 200;
      res.end("IGNORED_STATUS");
      return;
    }

    if (!userId || !Number.isFinite(payoutRaw) || payoutRaw <= 0) {
      console.warn("CPAGrip bad request", q);
      res.statusCode = 400;
      res.end("BAD_REQUEST");
      return;
    }

    const db = initFirebase();

    // Dedupe
    const logRef = db.collection("postbackLogs").doc(`cpagrip_${trackingId}`);
    const existing = await logRef.get();
    if (existing.exists) {
      res.statusCode = 200;
      res.end("DUPLICATE");
      return;
    }

    const userSnap = await db.collection("users").doc(userId).get();
    if (!userSnap.exists) {
      console.warn("CPAGrip unknown user", userId);
      res.statusCode = 404;
      res.end("USER_NOT_FOUND");
      return;
    }

    // Optional rate from Firestore settings
    let rate = DEFAULT_USD_TO_BDT;
    try {
      const settingsSnap = await db.collection("settings").doc("appSettings").get();
      if (settingsSnap.exists && settingsSnap.data().cpagripUsdToBdt) {
        rate = Number(settingsSnap.data().cpagripUsdToBdt) || rate;
      }
    } catch (_) {
      /* use default */
    }

    const amountBdt = Math.round(payoutRaw * rate * 100) / 100;

    await logRef.set({
      provider: "cpagrip",
      trackingId,
      userId,
      offerId,
      payoutUsd: payoutRaw,
      amountBdt,
      status,
      createdAt: Date.now(),
      raw: q,
    });

    await creditWallet(db, userId, amountBdt);
    await writeTransaction(db, userId, amountBdt, offerId);

    console.log(`CPAGrip credited ৳${amountBdt} → ${userId} offer=${offerId}`);
    res.statusCode = 200;
    res.end("OK");
  } catch (err) {
    console.error("CPAGrip postback error", err);
    res.statusCode = 500;
    res.end("ERROR");
  }
};
