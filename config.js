require('dotenv').config();

module.exports = {
  // Telegram Bot Token (Get this from @BotFather on Telegram)
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',

  // Firebase Configuration
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || 'autosangam-546bc',

  // Cloudinary Configuration
  CLOUDINARY: {
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dz8gefmjd',
    api_key: process.env.CLOUDINARY_API_KEY || '558134352914451',
    api_secret: process.env.CLOUDINARY_API_SECRET || 'KuN3Y6F7xW0Ji6N2qEF2S2656WI',
    audio_preset: 'autosangam_audio',
    folder: 'temp_bids_audio_48h'
  },

  // Default Ride Settings
  RIDE_DEFAULTS: {
    district: 'Coimbatore',
    timeoutSeconds: 120, // 2 minutes auto-expire
    sharedGroupIds: ['platform'],
    groupId: 'platform',
    groupName: 'AutoSangam'
  }
};
