const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('./config');

// 1. Initialize Firebase Admin
if (!admin.apps.length) {
  let credential = null;
  const saPath = path.join(__dirname, 'serviceAccountKey.json');

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
      const parsed = raw.startsWith('{') ? JSON.parse(raw) : JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
      credential = admin.credential.cert(parsed);
      console.log('🔑 Firebase initialized via FIREBASE_SERVICE_ACCOUNT env var');
    } catch (err) {
      console.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT:', err.message);
    }
  } else if (fs.existsSync(saPath)) {
    credential = admin.credential.cert(require(saPath));
    console.log('🔑 Firebase initialized via serviceAccountKey.json');
  }

  if (credential) {
    admin.initializeApp({
      credential,
      projectId: config.FIREBASE_PROJECT_ID
    });
  } else {
    admin.initializeApp({
      projectId: config.FIREBASE_PROJECT_ID
    });
    console.log('🔑 Firebase initialized via default credentials');
  }
}
const db = admin.firestore();

// 2. Start Keep-Alive HTTP Health Server (Required for Render Web Service)
const PORT = process.env.PORT || 10000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ONLINE',
    service: 'AutoSangam B2B Telegram Bot',
    version: '1.4.0-zero-read-opt',
    timestamp: new Date().toISOString(),
    uptimeMinutes: Math.floor(process.uptime() / 60)
  }));
});
server.listen(PORT, () => {
  console.log(`🌐 Keep-Alive HTTP health server is running on port ${PORT}`);
});

// Self-ping every 8 minutes to help keep Render alive
const SERVICE_URL = process.env.RENDER_EXTERNAL_URL || 'https://autosangam-b2b-bot.onrender.com';
setInterval(() => {
  axios.get(SERVICE_URL)
    .then(() => console.log('💓 Keep-alive ping sent to', SERVICE_URL))
    .catch((err) => console.warn('⚠️ Keep-alive ping warning:', err.message));
}, 8 * 60 * 1000);

// 2. Configure Cloudinary
cloudinary.config({
  cloud_name: config.CLOUDINARY.cloud_name,
  api_key: config.CLOUDINARY.api_key,
  api_secret: config.CLOUDINARY.api_secret,
});

// 3. Initialize Telegram Bot
if (!config.TELEGRAM_BOT_TOKEN || config.TELEGRAM_BOT_TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
  console.error('❌ TELEGRAM_BOT_TOKEN is missing or placeholder! Please set your valid bot token in the .env file.');
  process.exit(1);
}
const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });
bot.on('polling_error', (err) => {
  // Suppress transient DNS / timeout warnings
  if (err.code && err.code !== 'EFATAL') {
    console.warn('⚠️ Telegram polling notice:', err.message);
  }
});
console.log('🤖 AutoSangam B2B Telegram Bot is running...');

// In-memory sessions
// key: chatId -> { driver: {...}, pendingAudioFileId: '...' }
const sessions = new Map();

// Helper to normalize phone number to 10 digits
function normalizePhone(raw) {
  if (!raw) return '';
  const digits = raw.toString().replace(/\D/g, '');
  if (digits.length >= 10) {
    return digits.slice(-10);
  }
  return digits;
}

// Phone variants helper for Firestore query
function getPhoneVariants(phone10) {
  return [
    phone10,
    `+91${phone10}`,
    `91${phone10}`,
    `+91 ${phone10}`,
  ];
}

// Find verified driver in Firestore
async function findDriverByPhone(phone10) {
  try {
    const variants = getPhoneVariants(phone10);
    const snap = await db.collection('drivers')
      .where('phone', 'in', variants)
      .limit(1)
      .get();

    if (snap.empty) {
      // Check if they are a newly registered driver waiting for admin approval in driver_requests
      const reqSnap = await db.collection('driver_requests')
        .where('phone', 'in', variants)
        .limit(1)
        .get();
      if (!reqSnap.empty) {
        const reqData = reqSnap.docs[0].data();
        return { unapproved: true, name: reqData.name || 'ஓட்டுநர்' };
      }
      return null;
    }

    const doc = snap.docs[0];
    const data = doc.data();

    // In AutoSangam, drivers in the 'drivers' collection are already registered & approved!
    // They are only unapproved if explicitly marked suspended, deleted, or pending.
    const isSuspended = data.isSuspended === true || data.status === 'suspended' || data.blockedFromTelegram === true;
    const isDeleted = data.isDeleted === true || data.status === 'deleted';
    const isPending = data.status === 'pending' || data.subscriptionStatus === 'pending';

    if (isSuspended || isDeleted || isPending) {
      return { unapproved: true, name: data.name };
    }

    return {
      driverId: doc.id,
      name: data.name || 'ஓட்டுநர்',
      phone: phone10,
      photoUrl: data.photoUrl || data.driverPhoto || data.profilePhoto || '',
      vehicleNumber: data.vehicleNumber || '',
      district: data.district || config.RIDE_DEFAULTS.district
    };
  } catch (err) {
    console.error('Error looking up driver:', err.message);
    return null;
  }
}

// Upload audio buffer to Cloudinary
function uploadAudioToCloudinary(audioBuffer, rideId) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'video', // Cloudinary handles audio as video resource_type
        folder: config.CLOUDINARY.folder,
        public_id: rideId,
        upload_preset: config.CLOUDINARY.audio_preset
      },
      (error, result) => {
        if (error) {
          console.error('Cloudinary upload error:', error);
          reject(error);
        } else {
          resolve(result);
        }
      }
    );
    uploadStream.end(audioBuffer);
  });
}

// Extract Cloudinary public_id from URL
function getPublicIdFromUrl(url) {
  if (!url || !url.includes('cloudinary.com')) return null;
  try {
    const parts = url.split('/');
    const fileWithExt = parts[parts.length - 1];
    const fileName = fileWithExt.split('.')[0];
    const folder = parts[parts.length - 2];
    return `${folder}/${fileName}`;
  } catch (e) {
    return null;
  }
}

// Delete audio from Cloudinary
async function deleteCloudinaryAudio(audioUrl) {
  if (!audioUrl) return;
  const publicId = getPublicIdFromUrl(audioUrl);
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, {
      resource_type: 'video',
      invalidate: true
    });
    console.log(`🗑️ Deleted Cloudinary audio: ${publicId}`);
  } catch (e) {
    console.error(`Error deleting Cloudinary audio ${publicId}:`, e.message);
  }
}

// ==========================================
// TELEGRAM MESSAGE HANDLERS
// ==========================================

// Admin Configuration
const ADMIN_CHAT_IDS = new Set([
  '8987937018', 8987937018, // Vmk (Main Admin)
  '6402914481', 6402914481  // Test Admin
]);

const ADMIN_PHONES = new Set([
  '9750562127',
  '9944848421',
  '9790261161'
]);

function isAdminUser(chatId, fromId) {
  const cId = chatId ? String(chatId) : '';
  const fId = fromId ? String(fromId) : '';

  if (ADMIN_CHAT_IDS.has(cId) || ADMIN_CHAT_IDS.has(fId) || ADMIN_CHAT_IDS.has(Number(cId)) || ADMIN_CHAT_IDS.has(Number(fId))) {
    return true;
  }

  const session = sessions.get(chatId);
  if (session && session.driver) {
    const dPhone = normalizePhone(session.driver.phone);
    if (ADMIN_PHONES.has(dPhone)) return true;
  }

  return false;
}

// /admin command - displays admin dashboard in Telegram
bot.onText(/^\/admin/i, (msg) => {
  const chatId = msg.chat.id;
  console.log(`[Admin Command] /admin requested by chatId: ${chatId}, fromId: ${msg.from?.id}`);

  if (!isAdminUser(chatId, msg.from?.id)) {
    return bot.sendMessage(chatId, `⚠️ உங்கள் ஐடி (${chatId}) அட்மின் பட்டியலில் இல்லை. நீங்கள் நிர்வாகி கணக்கிலிருந்து முயற்சிக்கவும்.`);
  }

  bot.sendMessage(
    chatId,
    `👑 *AutoSangam Admin Controls:*\n\n` +
    `🚫 *டிரைவரை நீக்க / பிளாக் செய்ய:*\n` +
    `\`/block <10 இலக்க போன் நம்பர்>\`\n` +
    `_(எ.கா: \`/block 7339160730\`)_\n\n` +
    `✅ *மீண்டும் அனுமதிக்க / அன்-பிளாக் செய்ய:*\n` +
    `\`/unblock <10 இலக்க போன் நம்பர்>\`\n` +
    `_(எ.கா: \`/unblock 7339160730\`)_\n\n` +
    `🔍 *டிரைவர் விவரம் பார்க்க:*\n` +
    `\`/check <10 இலக்க போன் நம்பர்>\``,
    { parse_mode: 'Markdown' }
  );
});

// /block or /ban <phone> command
bot.onText(/^\/(?:block|ban)(?:\s+(.+))?/i, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdminUser(chatId, msg.from?.id)) {
    return bot.sendMessage(chatId, `⚠️ நீங்கள் நிர்வாகி (Admin) இல்லை.`);
  }

  const rawPhone = match ? match[1] : null;
  const phone = normalizePhone(rawPhone);
  if (!phone || phone.length !== 10) {
    return bot.sendMessage(chatId, '❌ பயன்படுத்தும் முறை:\n/block 9876543210 அல்லது /block +91 9876543210 (10 இலக்க போன் நம்பர் குறிப்பிடவும்)');
  }

  try {
    const variants = getPhoneVariants(phone);
    const snap = await db.collection('drivers').where('phone', 'in', variants).get();

    if (snap.empty) {
      return bot.sendMessage(chatId, `❌ இந்த எண் (${phone}) கொண்ட ஓட்டுநர் ஆட்டோ சங்கத்தில் காணப்படவில்லை.`);
    }

    let driverName = '';
    for (const doc of snap.docs) {
      driverName = doc.data().name || driverName;
      await doc.ref.update({
        isSuspended: true,
        blockedFromTelegram: true,
        status: 'suspended'
      });
    }

    // Invalidate any active in-memory session for this phone
    for (const [sChatId, sess] of sessions.entries()) {
      if (sess.driver && normalizePhone(sess.driver.phone) === phone) {
        sessions.delete(sChatId);
        bot.sendMessage(sChatId, '⚠️ உங்கள் ஓட்டுநர் கணக்கு நிர்வாகியால் இடைநிறுத்தப்பட்டுள்ளது.').catch(() => {});
      }
    }

    bot.sendMessage(chatId, `🚫 ஓட்டுநர் *${driverName || 'Driver'}* (${phone}) வெற்றிகரமாக பிளாக் செய்யப்பட்டார்.\n\nஇனி அவரால் Telegram Bot-ஐ பயன்படுத்த முடியாது.`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error blocking driver:', err.message);
    bot.sendMessage(chatId, `❌ பிளாக் செய்யும்போது பிழை: ${err.message}`);
  }
});

// /unblock or /unlock <phone> command
bot.onText(/^\/(?:unblock|unlock)(?:\s+(.+))?/i, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdminUser(chatId, msg.from?.id)) {
    return bot.sendMessage(chatId, `⚠️ நீங்கள் நிர்வாகி (Admin) இல்லை.`);
  }

  const rawPhone = match ? match[1] : null;
  const phone = normalizePhone(rawPhone);
  if (!phone || phone.length !== 10) {
    return bot.sendMessage(chatId, '❌ பயன்படுத்தும் முறை:\n/unblock 9876543210 அல்லது /unblock +91 9876543210 (10 இலக்க போன் நம்பர் குறிப்பிடவும்)');
  }

  try {
    const variants = getPhoneVariants(phone);
    const snap = await db.collection('drivers').where('phone', 'in', variants).get();

    if (snap.empty) {
      return bot.sendMessage(chatId, `❌ இந்த எண் (${phone}) கொண்ட ஓட்டுநர் ஆட்டோ சங்கத்தில் காணப்படவில்லை.`);
    }

    let driverName = '';
    for (const doc of snap.docs) {
      driverName = doc.data().name || driverName;
      await doc.ref.update({
        isSuspended: false,
        blockedFromTelegram: false,
        status: 'approved'
      });
    }

    bot.sendMessage(chatId, `✅ ஓட்டுநர் *${driverName || 'Driver'}* (${phone}) வெற்றிகரமாக மீண்டும் அனுமதிக்கப்பட்டார்!`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error unblocking driver:', err.message);
    bot.sendMessage(chatId, `❌ அன்-பிளாக் செய்யும்போது பிழை: ${err.message}`);
  }
});

// /check or /status <phone> command
bot.onText(/^\/(?:check|status)(?:\s+(.+))?/i, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdminUser(chatId, msg.from?.id)) {
    return bot.sendMessage(chatId, `⚠️ நீங்கள் நிர்வாகி (Admin) இல்லை.`);
  }

  const rawPhone = match ? match[1] : null;
  const phone = normalizePhone(rawPhone);
  if (!phone || phone.length !== 10) {
    return bot.sendMessage(chatId, '❌ பயன்படுத்தும் முறை:\n/check 9876543210 அல்லது /check +91 9876543210 (10 இலக்க போன் நம்பர் குறிப்பிடவும்)');
  }

  try {
    const variants = getPhoneVariants(phone);
    const snap = await db.collection('drivers').where('phone', 'in', variants).get();

    if (snap.empty) {
      return bot.sendMessage(chatId, `❌ இந்த எண் (${phone}) கொண்ட ஓட்டுநர் காணப்படவில்லை.`);
    }

    const doc = snap.docs[0];
    const data = doc.data();
    const isSusp = data.isSuspended === true || data.blockedFromTelegram === true || data.status === 'suspended';

    bot.sendMessage(
      chatId,
      `👤 *ஓட்டுநர் விவரம்:*\n\n` +
      `பெயர்: ${data.name || 'இல்லை'}\n` +
      `போன்: ${data.phone || phone}\n` +
      `வண்டி எண்: ${data.vehicleNumber || 'இல்லை'}\n` +
      `நிலை: ${isSusp ? '🚫 இடைநிறுத்தப்பட்டுள்ளது (Blocked)' : '✅ செயலில் உள்ளது (Active)'}`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Error checking driver:', err.message);
    bot.sendMessage(chatId, `❌ சரிபார்க்கும்போது பிழை: ${err.message}`);
  }
});

// /start command
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const session = sessions.get(chatId);

  if (session && session.driver) {
    return bot.sendMessage(
      chatId,
      `வணக்கம் ${session.driver.name} அண்ணா! 🛺\n\nநீங்கள் ஏற்கனவே ஆட்டோ சங்கம் B2B பாட்டில் இணைக்கப்பட்டுள்ளீர்கள்.\n\nபுதிய வாடகை போட:\n🎤 ஒரு வாய்ஸ் மெசேஜ் அனுப்பவும்.`
    );
  }

  // Ask driver to share contact
  bot.sendMessage(
    chatId,
    `வணக்கம்! ஆட்டோ சங்கம் B2B வாடகை பாட்டிற்கு வரவேற்கிறோம். 🛺\n\nநீங்கள் பதிவுசெய்த ஆட்டோ சங்கம் ஓட்டுநரா என்பதை உறுதிப்படுத்த கீழே உள்ள பட்டனை அழுத்தவும்:`,
    {
      reply_markup: {
        keyboard: [
          [{ text: '📱 எனது ஓட்டுநர் எண்ணை பகிர்க (Share Contact)', request_contact: true }]
        ],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    }
  );
});

// Handle Contact sharing for driver authentication
bot.on('contact', async (msg) => {
  const chatId = msg.chat.id;
  const rawPhone = msg.contact.phone_number;
  const phone10 = normalizePhone(rawPhone);

  bot.sendMessage(chatId, `🔍 உங்கள் ஓட்டுநர் கணக்கு சரிபார்க்கப்படுகிறது (${phone10})...`);

  const driver = await findDriverByPhone(phone10);
  if (!driver) {
    return bot.sendMessage(
      chatId,
      `❌ மன்னிக்கவும்! இந்த மொபைல் எண் (${phone10}) ஆட்டோ சங்கத்தில் பதிவு செய்யப்படவில்லை.\nதயவுசெய்து உங்கள் சங்க நிர்வாகியைத் தொடர்பு கொள்ளவும்.`,
      { reply_markup: { remove_keyboard: true } }
    );
  }

  if (driver.unapproved) {
    return bot.sendMessage(
      chatId,
      `⚠️ உங்கள் கணக்கு (${driver.name}) நிர்வாகியால் இன்னும் அங்கீகரிக்கப்படவில்லை அல்லது இடைநிறுத்தப்பட்டுள்ளது.`,
      { reply_markup: { remove_keyboard: true } }
    );
  }

  // Save session
  sessions.set(chatId, { driver });

  bot.sendMessage(
    chatId,
    `✅ உங்கள் கணக்கு உறுதி செய்யப்பட்டது, ${driver.name} அண்ணா! 🎉\n\nவண்டி எண்: ${driver.vehicleNumber || 'Auto'}\n\n🛺 இனி B2B வாடகை போட:\n1️⃣ ஒரு வாய்ஸ் மெசேஜ் (ஆடியோ) பேசவும்.\n2️⃣ வாடிக்கையாளரின் 10 இலக்க போன் நம்பரை அனுப்பவும்.`,
    { reply_markup: { remove_keyboard: true } }
  );
});

// Helper to extract customer phone, map URL, and pickup/drop route
function parseRideDetails(text) {
  if (!text) return {};

  // 1. Google Maps or any URL (extract first to protect URLs containing numbers)
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  const mapUrl = urlMatch ? urlMatch[0] : null;

  let remaining = text;
  if (mapUrl) remaining = remaining.replace(mapUrl, ' ');

  // 2. Customer Phone Number:
  // Supports:
  // - Clean 10 digits: 9876543210
  // - With country code: +919876543210, 919876543210, +91 9876543210, 09876543210
  // - Formatted with spaces / dashes: +91 98765 43210, +91-98765-43210, 98765-43210
  let customerPhone = null;
  // Match prefix: optional +91, 91, or 0 followed by 10-digit mobile starting with 6, 7, 8, or 9
  const phoneRegex = /(?:(?:\+|00)?91[\s.-]*|0)?([6-9](?:[\s.-]*\d){9})/;
  const phoneMatch = remaining.match(phoneRegex);

  if (phoneMatch) {
    const rawMatched = phoneMatch[0];
    const extracted10 = phoneMatch[1].replace(/\D/g, '');
    if (extracted10.length === 10) {
      customerPhone = extracted10;
      // Remove the full matched phone number (including +91 / spaces / dashes) from remaining text
      remaining = remaining.replace(rawMatched, ' ');
    }
  }

  // Clean any remaining standalone '+' or extra spaces left behind
  remaining = remaining.replace(/(?:^|\s)\+(?:\s|$)/g, ' ').replace(/\s+/g, ' ').trim();

  let pickupText = null;
  let dropText = null;

  // Separator for pickup and drop: to, டு, டூ, 2, -, –, —, ->, ➔, >, /, வரை, நோக்கி
  const separator = /\s*(?:to|டூ|டு|2|–|-|—|->|-->|➔|>|\/|வரை|நோக்கி)\s+/i;
  const parts = remaining.split(separator);

  if (parts.length >= 2 && parts[0].trim().length > 0 && parts[1].trim().length > 0) {
    pickupText = parts[0].trim();
    dropText = parts[1].trim();
  } else if (remaining.length > 1) {
    pickupText = remaining.trim();
  }

  return { customerPhone, mapUrl, pickupText, dropText };
}

// Helper to cancel an active or accepted ride
async function cancelActiveRide(chatId, specificRideId = null) {
  let rideDoc = null;

  if (specificRideId) {
    const doc = await db.collection('rides').doc(specificRideId).get();
    if (doc.exists) rideDoc = doc;
  }

  if (!rideDoc) {
    const session = sessions.get(chatId);
    if (session && session.latestRideId) {
      const doc = await db.collection('rides').doc(session.latestRideId).get();
      if (doc.exists) {
        const s = doc.data().status;
        if (s === 'pending' || s === 'accepted') {
          rideDoc = doc;
        }
      }
    }
  }

  if (!rideDoc) {
    // Search recent rides for this chatId
    const snap = await db.collection('rides')
      .where('telegramChatId', '==', chatId)
      .limit(10)
      .get();

    const activeDocs = snap.docs.filter(d => {
      const s = d.data().status;
      return s === 'pending' || s === 'accepted';
    });

    if (activeDocs.length > 0) {
      activeDocs.sort((a, b) => {
        const tA = a.data().createdAt?.toMillis ? a.data().createdAt.toMillis() : 0;
        const tB = b.data().createdAt?.toMillis ? b.data().createdAt.toMillis() : 0;
        return tB - tA;
      });
      rideDoc = activeDocs[0];
    }
  }

  if (!rideDoc) {
    return bot.sendMessage(chatId, 'ℹ️ தற்போது ரத்து செய்வதற்கு எந்த ஆக்டிவ் வாடகையும் இல்லை.');
  }

  const rideData = rideDoc.data();
  if (rideData.status === 'completed') {
    return bot.sendMessage(chatId, '⚠️ இந்த பயணம் ஏற்கனவே முடிந்துவிட்டது. ரத்து செய்ய முடியாது.');
  }
  if (rideData.status === 'cancelled') {
    return bot.sendMessage(chatId, 'ℹ️ இந்த வாடகை ஏற்கனவே ரத்து செய்யப்பட்டுவிட்டது.');
  }

  await rideDoc.ref.update({
    status: 'cancelled',
    cancelledBy: 'posting_driver_telegram',
    cancellationReason: 'வாடகை போட்ட ஓட்டுநர் ரத்து செய்துவிட்டார்',
    cancelledAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // Delete audio if exists
  if (rideData.audioUrl) {
    deleteCloudinaryAudio(rideData.audioUrl).catch(() => {});
  }

  // Update original status message in Telegram if exists
  if (rideData.telegramMessageId) {
    bot.editMessageText('❌ இந்த புக்கிங் ரத்து செய்யப்பட்டது', {
      chat_id: chatId,
      message_id: rideData.telegramMessageId
    }).catch(() => {});
  }

  return bot.sendMessage(chatId, '❌ உங்கள் புக்கிங் வெற்றிகரமாக ரத்து செய்யப்பட்டது!');
}

// Handle Inline button clicks (like cancel button)
bot.on('callback_query', async (query) => {
  const chatId = query.message?.chat?.id;
  const data = query.data;

  if (data && data.startsWith('cancel_')) {
    const rideId = data.replace('cancel_', '');
    bot.answerCallbackQuery(query.id, { text: 'ரத்து செய்யப்படுகிறது...' }).catch(() => {});
    await cancelActiveRide(chatId, rideId);
  }
});

// Handle Voice / Audio messages
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';

  // Cancel trigger: ❌, ✖️, ✕, ✗, ✘, x, X, cancel, /cancel, ரத்து
  const isCancel = /^(?:❌|✖️|✕|✗|✘|[xX]|cancel|\/cancel|ரத்து)$/u.test(text);
  if (isCancel) {
    return cancelActiveRide(chatId);
  }

  // Ignore commands and contact messages handled above
  if (msg.text && msg.text.startsWith('/')) return;
  if (msg.contact) return;

  const session = sessions.get(chatId);
  if (!session || !session.driver) {
    return bot.sendMessage(
      chatId,
      `⚠️ நீங்கள் இன்னும் பதிவு செய்யவில்லை. தயவுசெய்து /start என அனுப்பி உங்கள் ஓட்டுநர் எண்ணை உறுதிப்படுத்தவும்.`
    );
  }

  const driver = session.driver;

  // 1. Check if message is a Voice note or Audio file
  const fileId = msg.voice ? msg.voice.file_id : (msg.audio ? msg.audio.file_id : null);
  if (fileId) {
    const caption = msg.caption || '';
    const details = parseRideDetails(caption);

    if (details.customerPhone) {
      await processAndCreateRide(chatId, driver, fileId, details);
    } else {
      // Store pending audio file and any route text included in caption
      session.pendingAudioFileId = fileId;
      session.pendingPickupText = details.pickupText || null;
      session.pendingDropText = details.dropText || null;
      session.pendingMapUrl = details.mapUrl || null;
      sessions.set(chatId, session);

      const routeNote = details.pickupText
        ? `\n📍 வழித்தடம்: ${details.pickupText}${details.dropText ? ' ➔ ' + details.dropText : ''}\n`
        : '';

      bot.sendMessage(
        chatId,
        `🎤 உங்கள் ஆடியோ பெறப்பட்டது!${routeNote}\nவாடிக்கையாளரின் மொபைல் எண் (மற்றும் வழித்தடம் / மேப் லிங்க்) அனுப்பவும்:\n\n(எ.கா: +91 98765 43210 அல்லது 9876543210 காந்திபுரம் டு பீளமேடு)`
      );
    }
    return;
  }

  // 2. Check if message is text providing phone number and optional route / map URL
  if (msg.text) {
    const text = msg.text.trim();
    const details = parseRideDetails(text);

    if (!details.customerPhone) {
      // If it looks like a route (e.g. "காந்திபுரம் டு பீளமேடு") without a phone number yet:
      if (details.pickupText) {
        session.pendingPickupText = details.pickupText;
        session.pendingDropText = details.dropText;
        session.pendingMapUrl = details.mapUrl;
        sessions.set(chatId, session);

        const routeDisplay = details.dropText
          ? `${details.pickupText} ➔ ${details.dropText}`
          : details.pickupText;

        return bot.sendMessage(
          chatId,
          `📍 வழித்தடம் பெறப்பட்டது:\n${routeDisplay}\n\nவாடிக்கையாளரின் மொபைல் எண்ணை அனுப்பவும் (எ.கா: 9876543210 அல்லது +91 98765 43210):`
        );
      }

      return bot.sendMessage(
        chatId,
        `⚠️ தயவுசெய்து சரியான மொபைல் எண்ணை அனுப்பவும் (எ.கா: 9876543210 அல்லது +91 98765 43210 காந்திபுரம் டு பீளமேடு):`
      );
    }

    const pendingFileId = session.pendingAudioFileId || null;
    const finalPickupText = details.pickupText || session.pendingPickupText || null;
    const finalDropText = details.dropText || session.pendingDropText || null;
    const finalMapUrl = details.mapUrl || session.pendingMapUrl || null;

    // Clear pending state
    session.pendingAudioFileId = null;
    session.pendingPickupText = null;
    session.pendingDropText = null;
    session.pendingMapUrl = null;
    sessions.set(chatId, session);

    const mergedDetails = {
      customerPhone: details.customerPhone,
      pickupText: finalPickupText,
      dropText: finalDropText,
      mapUrl: finalMapUrl
    };

    await processAndCreateRide(chatId, driver, pendingFileId, mergedDetails);
  }
});

// Helper to download audio from Telegram, upload to Cloudinary, and create Firestore Ride
async function processAndCreateRide(chatId, driver, fileId, details) {
  let statusMsg = null;
  try {
    // Single status message as requested by user
    statusMsg = await bot.sendMessage(chatId, 'புக்கிங் சென்று கொண்டிருக்கிறது...');

    let audioUrl = '';
    if (fileId) {
      // 1. Get file link from Telegram
      const fileLink = await bot.getFileLink(fileId);

      // 2. Download audio file into buffer
      const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
      const audioBuffer = Buffer.from(response.data);

      // 3. Upload to Cloudinary
      const rideId = uuidv4();
      const uploadResult = await uploadAudioToCloudinary(audioBuffer, rideId);
      audioUrl = uploadResult.secure_url;
    }

    // 4. Create Firestore Ride Document
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (config.RIDE_DEFAULTS.timeoutSeconds * 1000));

    const rideDoc = {
      telegramChatId: chatId,
      telegramMessageId: statusMsg ? statusMsg.message_id : null,
      groupId: config.RIDE_DEFAULTS.groupId,
      sharedGroupIds: config.RIDE_DEFAULTS.sharedGroupIds,
      groupName: config.RIDE_DEFAULTS.groupName,
      groupCode: '',
      postedBy: {
        driverId: driver.driverId,
        name: driver.name,
        phone: driver.phone,
        photoUrl: driver.photoUrl || '',
        vehicleNumber: driver.vehicleNumber || ''
      },
      audioUrl: audioUrl,
      customerPhone: details.customerPhone,
      customerLocation: details.mapUrl || null,
      pickupText: details.pickupText || null,
      dropText: details.dropText || null,
      status: 'pending',
      isCustomerBooking: false, // STRICTLY B2B! Will show as CompactRideCard in driver app
      createdAt: admin.firestore.Timestamp.fromDate(now),
      expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
      district: driver.district || config.RIDE_DEFAULTS.district,
      audioListenedBy: [],
      targetDriverIds: []
    };

    const docRef = await db.collection('rides').add(rideDoc);
    console.log(`✅ [B2B Ride Created] ID: ${docRef.id} by ${driver.name} (Phone: ${details.customerPhone}, Route: ${details.pickupText || ''} -> ${details.dropText || ''}, Map: ${details.mapUrl || 'None'})`);

    // Track latest ride for this chat in session
    const currentSession = sessions.get(chatId) || { driver };
    currentSession.latestRideId = docRef.id;
    sessions.set(chatId, currentSession);

    // Schedule exact targeted expiry cleanup right after timeout (2 minutes)
    // This reads ONLY this single document (1 read cost) instead of scanning the entire collection!
    setTimeout(async () => {
      try {
        const freshDoc = await db.collection('rides').doc(docRef.id).get();
        if (!freshDoc.exists) return;
        const freshData = freshDoc.data();
        if (freshData.status === 'pending') {
          console.log(`⏰ [Auto-Expiry] Ride ${docRef.id} expired after timeout.`);
          if (freshData.telegramChatId && !notifiedExpiredRideIds.has(docRef.id)) {
            notifiedExpiredRideIds.add(docRef.id);
            const expiredText = '⏰ யாரும் புக்கிங் எடுக்கவில்லை - நேரம் முடிந்தது (காலாவதியானது)';
            if (freshData.telegramMessageId) {
              bot.editMessageText(expiredText, { chat_id: freshData.telegramChatId, message_id: freshData.telegramMessageId })
                .catch(() => {
                  bot.sendMessage(freshData.telegramChatId, expiredText).catch(() => {});
                });
            } else {
              bot.sendMessage(freshData.telegramChatId, expiredText).catch(() => {});
            }
          }

          if (freshData.audioUrl) {
            await deleteCloudinaryAudio(freshData.audioUrl);
          }

          await freshDoc.ref.delete();
          console.log(`🗑️ [Auto-Expiry] Expired pending ride ${docRef.id} deleted.`);
        }
      } catch (expErr) {
        console.error(`Error in targeted ride expiry for ${docRef.id}:`, expErr.message);
      }
    }, (config.RIDE_DEFAULTS.timeoutSeconds + 2) * 1000);
  } catch (error) {
    console.error('❌ Error creating B2B ride from bot:', error);
    if (statusMsg) {
      bot.editMessageText('புக்கிங் பதிவிட முடியவில்லை. மீண்டும் முயற்சிக்கவும்.', {
        chat_id: chatId,
        message_id: statusMsg.message_id
      }).catch(() => { });
    } else {
      bot.sendMessage(chatId, 'புக்கிங் பதிவிட முடியவில்லை. மீண்டும் முயற்சிக்கவும்.').catch(() => { });
    }
  }
}

// ==========================================
// 4. AUTOMATIC CLEANUP (Cloudinary & Firestore)
// Optimized: Zero-polling architecture to minimize Firestore read counts
// ==========================================
const notifiedAcceptedRideIds = new Set();
const notifiedExpiredRideIds = new Set();
const notifiedCompletedRideIds = new Set();

async function runAutoCleanup() {
  try {
    console.log('🧹 [Auto-Cleanup] Fallback check for expired pending B2B rides...');
    const now = admin.firestore.Timestamp.now();

    // Query pending rides only (lightweight, runs rarely)
    const pendingSnap = await db.collection('rides')
      .where('status', '==', 'pending')
      .limit(30)
      .get();

    const expiredDocs = pendingSnap.docs.filter(doc => {
      const exp = doc.data().expiresAt;
      return exp && exp.toMillis() <= now.toMillis();
    });

    if (expiredDocs.length === 0) {
      console.log('🧹 [Auto-Cleanup] No expired pending rides found.');
      return;
    }

    let deletedCount = 0;
    for (const doc of expiredDocs) {
      const data = doc.data();

      // Notify posting driver that the ride was not accepted and has expired
      if (data.telegramChatId && !notifiedExpiredRideIds.has(doc.id)) {
        notifiedExpiredRideIds.add(doc.id);
        const msgId = data.telegramMessageId;
        const expiredText = '⏰ யாரும் புக்கிங் எடுக்கவில்லை - நேரம் முடிந்தது (காலாவதியானது)';
        if (msgId) {
          bot.editMessageText(expiredText, { chat_id: data.telegramChatId, message_id: msgId })
            .catch(() => {
              bot.sendMessage(data.telegramChatId, expiredText).catch(() => { });
            });
        } else {
          bot.sendMessage(data.telegramChatId, expiredText).catch(() => { });
        }
      }

      // Only clean up B2B audio
      if (data.audioUrl) {
        await deleteCloudinaryAudio(data.audioUrl);
      }

      // Delete expired pending document from Firestore
      await doc.ref.delete();
      deletedCount++;
    }

    console.log(`🎉 [Auto-Cleanup] Successfully cleaned ${deletedCount} expired B2B rides & audio files!`);
  } catch (err) {
    console.error('❌ Error during auto-cleanup:', err.message);
  }
}

// ==========================================
// 5. REAL-TIME RIDE STATUS LISTENER
// Efficient single listener filtered by createdAt to avoid reading past history!
// ==========================================
function startRideStatusListener() {
  console.log('👀 Listening for B2B ride status updates...');

  // Start listening only for rides created recently (within last 15 minutes)
  // This avoids reading hundreds of past rides on Render boot/restart (saving 99% reads)!
  const listenerStartTime = admin.firestore.Timestamp.fromDate(new Date(Date.now() - 15 * 60 * 1000));

  db.collection('rides')
    .where('createdAt', '>=', listenerStartTime)
    .onSnapshot((snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added' || change.type === 'modified') {
          const ride = change.doc.data();
          const rideId = change.doc.id;
          const chatId = ride.telegramChatId;
          if (!chatId) return;

          // 1. Accepted Ride
          if (ride.status === 'accepted' && !notifiedAcceptedRideIds.has(rideId)) {
            notifiedAcceptedRideIds.add(rideId);
            const acceptedBy = ride.acceptedBy || {};
            const driverName = acceptedBy.name || 'ஓட்டுநர்';
            const vehicleNumber = acceptedBy.vehicleNumber || 'Auto';
            const driverPhone = acceptedBy.phone || 'கிடைக்கவில்லை';
            const photoUrl = acceptedBy.photoUrl || acceptedBy.driverPhoto || acceptedBy.selfieUrl || '';
            const messageId = ride.telegramMessageId;

            const acceptedText = `புக்கிங் வெற்றிகரமாக எடுக்கப்பட்டது\n\nபெயர்: ${driverName}\nவண்டி எண்: ${vehicleNumber}\nபோன் நம்பர்: ${driverPhone}\n\n💡 ரத்து செய்ய: ❌ என அனுப்பவும்`;

            const inlineButtons = [];
            if (photoUrl && photoUrl.startsWith('http')) {
              inlineButtons.push({
                text: '📷 படம்',
                url: photoUrl
              });
            }
            inlineButtons.push({
              text: '❌ வாடகை ரத்து செய்',
              callback_data: `cancel_${rideId}`
            });

            const replyMarkup = {
              inline_keyboard: [inlineButtons]
            };

            if (messageId) {
              bot.editMessageText(acceptedText, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: replyMarkup
              }).catch(() => {
                bot.sendMessage(chatId, acceptedText, { reply_markup: replyMarkup }).catch(() => {});
              });
            } else {
              bot.sendMessage(chatId, acceptedText, { reply_markup: replyMarkup }).catch(() => {});
            }
          }

          // 2. Cancelled Ride
          else if (ride.status === 'cancelled' && !notifiedExpiredRideIds.has(rideId)) {
            notifiedExpiredRideIds.add(rideId);
            const messageId = ride.telegramMessageId;
            const cancelledText = '❌ புக்கிங் ரத்து செய்யப்பட்டது';
            if (messageId) {
              bot.editMessageText(cancelledText, { chat_id: chatId, message_id: messageId })
                .catch(() => {
                  bot.sendMessage(chatId, cancelledText).catch(() => {});
                });
            } else {
              bot.sendMessage(chatId, cancelledText).catch(() => {});
            }

            // Immediately delete audio from Cloudinary
            if (ride.audioUrl) {
              deleteCloudinaryAudio(ride.audioUrl).catch(() => {});
            }
          }

          // 3. Completed Ride
          else if (ride.status === 'completed' && !notifiedCompletedRideIds.has(rideId)) {
            notifiedCompletedRideIds.add(rideId);
            const totalFare = ride.totalFare || ride.fare || ride.meterData?.totalAmount || 0;
            const fareStr = Math.round(totalFare);
            const completedText = `✅ பயணம் முடிந்தது (கட்டணம்: ₹${fareStr})`;

            bot.sendMessage(chatId, completedText).catch(() => {});

            // Immediately delete audio from Cloudinary
            if (ride.audioUrl) {
              deleteCloudinaryAudio(ride.audioUrl).catch(() => {});
            }
          }
        }
      });
    }, (error) => {
      console.error('Ride status listener error:', error.message);
    });
}

// Start Real-time listeners
startRideStatusListener();

// Run fallback cleanup once every 6 hours (gentle sanity sweep, saving read quota)
setInterval(runAutoCleanup, 6 * 60 * 60 * 1000);
// Run once on startup after 30 seconds
setTimeout(runAutoCleanup, 30000);
