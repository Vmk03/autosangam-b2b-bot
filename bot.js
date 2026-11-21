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
    timestamp: new Date().toISOString(),
    uptimeMinutes: Math.floor(process.uptime() / 60)
  }));
});
server.listen(PORT, () => {
  console.log(`🌐 Keep-Alive HTTP health server is running on port ${PORT}`);
});

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
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length > 10 && digits.endsWith(digits.slice(-10))) {
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

    if (snap.empty) return null;
    const doc = snap.docs[0];
    const data = doc.data();

    // Check approval status
    if (data.status !== 'approved' || data.isSuspended === true || data.isDeleted === true) {
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

// ==========================================
// TELEGRAM MESSAGE HANDLERS
// ==========================================

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

  // 1. Phone number (10 digits starting with 6-9)
  const phoneMatch = text.match(/\b[6-9]\d{9}\b/);
  const customerPhone = phoneMatch ? phoneMatch[0] : null;

  // 2. Google Maps or any URL
  const urlMatch = text.match(/https?:\/\/[^\s]+/);
  const mapUrl = urlMatch ? urlMatch[0] : null;

  // 3. Remove phone and url to find route
  let remaining = text;
  if (customerPhone) remaining = remaining.replace(customerPhone, ' ');
  if (mapUrl) remaining = remaining.replace(mapUrl, ' ');
  remaining = remaining.trim();

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

// Handle Voice / Audio messages
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

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
        `🎤 உங்கள் ஆடியோ பெறப்பட்டது!${routeNote}\nவாடிக்கையாளரின் 10 இலக்க மொபைல் எண் (மற்றும் வழித்தடம் / மேப் லிங்க்) அனுப்பவும்:\n\n(எ.கா: 9876543210 காந்திபுரம் டு பீளமேடு)`
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
          `📍 வழித்தடம் பெறப்பட்டது:\n${routeDisplay}\n\nவாடிக்கையாளரின் 10 இலக்க மொபைல் எண்ணை அனுப்பவும் (எ.கா: 9876543210):`
        );
      }

      return bot.sendMessage(
        chatId,
        `⚠️ தயவுசெய்து சரியான 10 இலக்க மொபைல் எண்ணை அனுப்பவும் (எ.கா: 9876543210 காந்திபுரம் டு பீளமேடு):`
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

    // Schedule exact expiry cleanup right after timeout (2 minutes)
    setTimeout(() => {
      runAutoCleanup().catch(() => {});
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
// User's specific request: Auto-delete expired audio without manual admin clicking!
// ==========================================
const notifiedAcceptedRideIds = new Set();
const notifiedExpiredRideIds = new Set();
const notifiedCompletedRideIds = new Set();

async function runAutoCleanup() {
  try {
    console.log('🧹 [Auto-Cleanup] Checking for expired B2B audio files in Cloudinary & Firestore...');
    const now = admin.firestore.Timestamp.now();

    // Query pending rides without needing any composite index
    const pendingSnap = await db.collection('rides')
      .where('status', '==', 'pending')
      .limit(50)
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

      // Only clean up B2B audio (customer rides don't have audio)
      if (data.audioUrl) {
        const publicId = getPublicIdFromUrl(data.audioUrl);
        if (publicId) {
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
// Notifies posting driver when another driver accepts the ride!
// ==========================================
function startRideStatusListener() {
  console.log('👀 Listening for B2B ride status updates...');

  // Listen for accepted rides in real-time
  db.collection('rides')
    .where('status', '==', 'accepted')
    .onSnapshot((snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added' || change.type === 'modified') {
          const ride = change.doc.data();
          const rideId = change.doc.id;
          const chatId = ride.telegramChatId;

          if (chatId && !notifiedAcceptedRideIds.has(rideId)) {
            notifiedAcceptedRideIds.add(rideId);
            const acceptedBy = ride.acceptedBy || {};
            const driverName = acceptedBy.name || 'ஓட்டுநர்';
            const vehicleNumber = acceptedBy.vehicleNumber || 'Auto';
            const driverPhone = acceptedBy.phone || 'கிடைக்கவில்லை';
            const photoUrl = acceptedBy.photoUrl || acceptedBy.driverPhoto || acceptedBy.selfieUrl || '';
            const messageId = ride.telegramMessageId;

            const acceptedText = `புக்கிங் வெற்றிகரமாக எடுக்கப்பட்டது\n\nபெயர்: ${driverName}\nவண்டி எண்: ${vehicleNumber}\nபோன் நம்பர்: ${driverPhone}`;

            const replyMarkup = (photoUrl && photoUrl.startsWith('http'))
              ? {
                  inline_keyboard: [
                    [
                      {
                        text: '📷 டிரைவர் படம் பார்க்க',
                        url: photoUrl
                      }
                    ]
                  ]
                }
              : undefined;

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
        }
      });
    }, (error) => {
      console.error('Ride status listener error:', error.message);
    });

  // Listen for cancelled rides in real-time
  db.collection('rides')
    .where('status', '==', 'cancelled')
    .onSnapshot((snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added' || change.type === 'modified') {
          const ride = change.doc.data();
          const rideId = change.doc.id;
          const chatId = ride.telegramChatId;

          if (chatId && !notifiedExpiredRideIds.has(rideId)) {
            notifiedExpiredRideIds.add(rideId);
            const messageId = ride.telegramMessageId;
            const cancelledText = '❌ புக்கிங் ரத்து செய்யப்பட்டது';
            if (messageId) {
              bot.editMessageText(cancelledText, { chat_id: chatId, message_id: messageId })
                .catch(() => {
                  bot.sendMessage(chatId, cancelledText).catch(() => { });
                });
            } else {
              bot.sendMessage(chatId, cancelledText).catch(() => { });
            }
          }
        }
      });
    }, (error) => {
      console.error('Ride cancellation listener error:', error.message);
    });

  // Listen for completed rides in real-time and notify with final fare!
  db.collection('rides')
    .where('status', '==', 'completed')
    .onSnapshot((snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added' || change.type === 'modified') {
          const ride = change.doc.data();
          const rideId = change.doc.id;
          const chatId = ride.telegramChatId;

          if (chatId && !notifiedCompletedRideIds.has(rideId)) {
            notifiedCompletedRideIds.add(rideId);
            // Only notify if ride completed recently (within last 10 minutes) or modified live
            const completedAt = ride.completedAt?.toDate ? ride.completedAt.toDate() : (ride.completedAt ? new Date(ride.completedAt) : null);
            const isRecent = !completedAt || (Date.now() - completedAt.getTime()) < 10 * 60 * 1000;
            if (!isRecent && change.type === 'added') {
              return;
            }

            const totalFare = ride.totalFare || ride.fare || ride.meterData?.totalAmount || 0;
            const fareStr = Math.round(totalFare);
            const completedText = `✅ பயணம் முடிந்தது (கட்டணம்: ₹${fareStr})`;

            bot.sendMessage(chatId, completedText).catch(() => { });
          }
        }
      });
    }, (error) => {
      console.error('Ride completion listener error:', error.message);
    });
}

// Start Real-time listeners
startRideStatusListener();

// Run cleanup every 1 minute to immediately catch expired rides
setInterval(runAutoCleanup, 60 * 1000);
// Run once on startup after 10 seconds
setTimeout(runAutoCleanup, 10000);
