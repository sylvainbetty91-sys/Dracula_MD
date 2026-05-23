const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const { Octokit } = require('@octokit/rest');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require("form-data");
const os = require('os'); 
const { sms, downloadMediaMessage } = require("./msg");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    S_WHATSAPP_NET
} = require('@whiskeysockets/baileys');

// ╔══════════════════════════════════════════════════════════════════╗
// ║  CONFIG MAÎTRE — valeurs du CRÉATEUR (ne jamais modifier)       ║
// ║  C'est la base que tout le monde hérite au départ               ║
// ╚══════════════════════════════════════════════════════════════════╝
const config = {
    // — Comportement automatique —
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'false',
    AUTO_RECORDING: 'true',
    AUTO_LIKE_EMOJI: ['🖕', '😶', '✨️', '💗', '🎈', '🎉', '🥳', '🍆', '🧫', '🐭'],
    // — Identité du bot —
    PREFIX: '.',
    BOT_NAME: '𝕯𝚛𝚊𝚌𝚞𝚕𝚊 𝕻𝚛𝚒𝚖𝚎𝚎𝚎',
    BOT_FOOTER: '𝕯ʀᴀᴄᴜʟᴀ 𝕯ᴇᴠ 509',
    // — Owner maître (créateur) —
    OWNER_NUMBER: '50931144650',
    OWNER_NAME: '𝐌ʀ 𝕯ʀᴀᴄᴜʟᴀ 𝕯ᴇᴠ',
    // — Liens —
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029Vb7xX0I8vd1Iv6thSs2H',
    GROUP_INVITE_LINK: '',
    // — Images —
    IMAGE_PATH: 'https://files.catbox.moe/gsn9jj.png',
    RCD_IMAGE_PATH: 'https://files.catbox.moe/gsn9jj.png',
    // — Technique (non modifiable par commande) —
    MAX_RETRIES: 3,
    ADMIN_LIST_PATH: './admin.json',
    NEWSLETTER_JID: '120363424779982227@newsletter',
    NEWSLETTER_MESSAGE_ID: '428',
    OTP_EXPIRY: 300000,
    version: '4.0.0',
};

// ╔══════════════════════════════════════════════════════════════════╗
// ║  SYSTÈME DE CONFIGS ISOLÉES PAR SESSION                         ║
// ║                                                                  ║
// ║  Dossiers :                                                      ║
// ║   configs/<numero>.json  → préférences personnalisées            ║
// ║   lineage/<numero>.json  → qui a pairé qui (arbre de parrainage) ║
// ╚══════════════════════════════════════════════════════════════════╝
const userConfigs = new Map();   // config active en mémoire par numéro
const CONFIGS_DIR = './configs'; // préférences personnalisées
const LINEAGE_DIR = './lineage'; // arbre de parrainage

// Créer les dossiers au démarrage
[CONFIGS_DIR, LINEAGE_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ╔══════════════════════════════════════════════════════════════════╗
// ║  JOURNAL — base de données persistante (./database/journal.json) ║
// ╚══════════════════════════════════════════════════════════════════╝
// Journal stocké sur GitHub — pas de fichier local nécessaire

// ─── Drague sessions (stockées sur GitHub) ────────────────────────────
// ── Champs personnalisables (les seuls sauvegardés dans le JSON) ───────────
const CUSTOMIZABLE_KEYS = [
    'BOT_NAME', 'OWNER_NAME', 'OWNER_NUMBER',
    'CHANNEL_LINK', 'GROUP_INVITE_LINK',
    'IMAGE_PATH', 'RCD_IMAGE_PATH',
    'PREFIX', 'BOT_FOOTER',
    'AUTO_VIEW_STATUS', 'AUTO_LIKE_STATUS', 'AUTO_RECORDING'
];

/**
 * Charge la config sauvegardée d'un utilisateur (configs/<num>.json).
 * Si elle n'existe pas → retourne null (pas de personnalisation).
 */
function loadSavedConfig(number) {
    const file = path.join(CONFIGS_DIR, `${number}.json`);
    try {
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) { console.error(`[config] Erreur lecture ${file}:`, e.message); }
    return null;
}

/**
 * Sauvegarde uniquement les champs personnalisés dans configs/<num>.json.
 */
function saveUserConfig(number, userCfg) {
    const file = path.join(CONFIGS_DIR, `${number}.json`);
    const toSave = {};
    CUSTOMIZABLE_KEYS.forEach(k => { if (userCfg[k] !== undefined) toSave[k] = userCfg[k]; });
    fs.writeFileSync(file, JSON.stringify(toSave, null, 2));
}

/**
 * Supprime le fichier de config → reset aux valeurs par défaut.
 * Retourne true si le fichier existait, false sinon.
 */
function deleteUserConfig(number) {
    const file = path.join(CONFIGS_DIR, `${number}.json`);
    if (fs.existsSync(file)) { fs.unlinkSync(file); return true; }
    return false;
}

/**
 * Charge le lignage d'un utilisateur (lineage/<num>.json).
 * Structure : { parrainedBy: "509...", pairedAt: "ISO date" }
 */
function loadLineage(number) {
    const file = path.join(LINEAGE_DIR, `${number}.json`);
    try {
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {}
    return null;
}

/**
 * Enregistre le parrainage : qui a pairé ce numéro et quand.
 */
function saveLineage(number, parrainNumber) {
    const file = path.join(LINEAGE_DIR, `${number}.json`);
    fs.writeFileSync(file, JSON.stringify({
        parrainedBy: parrainNumber,
        pairedAt: new Date().toISOString(),
        pairedVia: 'whatsapp'
    }, null, 2));
}

/**
 * Construit la config active d'un utilisateur :
 *   1. Base = config maître (créateur)
 *   2. Si pairé via WhatsApp → hérite des champs de son parrain
 *   3. Ses propres modifs par-dessus (configs/<num>.json)
 *
 * Résultat mis en cache dans userConfigs Map.
 */
function buildUserConfig(number) {
    // 1. Base maître
    let merged = { ...config };

    // 2. Héritage du parrain (si pairé via WhatsApp)
    const lineage = loadLineage(number);
    if (lineage?.parrainedBy) {
        const parrainSaved = loadSavedConfig(lineage.parrainedBy);
        if (parrainSaved) {
            CUSTOMIZABLE_KEYS.forEach(k => {
                if (parrainSaved[k] !== undefined) merged[k] = parrainSaved[k];
            });
            console.log(`[config] ${number} hérite de ${lineage.parrainedBy}`);
        }
    }

    // 3. Propres modifications de l'utilisateur (priorité max)
    const saved = loadSavedConfig(number);
    if (saved) {
        CUSTOMIZABLE_KEYS.forEach(k => {
            if (saved[k] !== undefined) merged[k] = saved[k];
        });
    }

    return merged;
}

/**
 * Récupère (ou construit) la config active d'une session.
 */
function getUserConfig(number) {
    const n = number.replace(/[^0-9]/g, '');
    if (!userConfigs.has(n)) {
        userConfigs.set(n, buildUserConfig(n));
    }
    return userConfigs.get(n);
}

const owner = 'sylvainbetty91-sys';
const repo = 'Dracula';
const octokit = new Octokit({ auth: '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' });

let dragueSessions = {};

async function loadDrague() {
    try {
        const { data } = await octokit.repos.getContent({ owner, repo, path: 'database/drague.json' });
        dragueSessions = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
        console.log('[drague] Chargé depuis GitHub');
    } catch (e) {
        dragueSessions = {};
        console.log('[drague] Nouveau fichier (introuvable sur GitHub)');
    }
}

async function saveDrague() {
    try {
        let sha;
        try {
            const { data } = await octokit.repos.getContent({ owner, repo, path: 'database/drague.json' });
            sha = data.sha;
        } catch {}
        await octokit.repos.createOrUpdateFileContents({
            owner, repo,
            path: 'database/drague.json',
            message: 'Update drague sessions',
            content: Buffer.from(JSON.stringify(dragueSessions, null, 2)).toString('base64'),
            ...(sha && { sha })
        });
    } catch (e) {
        console.error('[drague] Erreur sauvegarde GitHub:', e.message);
    }
}

// Chargement au démarrage
loadDrague();

async function loadJournal() {
    try {
        const { data } = await octokit.repos.getContent({ owner, repo, path: 'database/journal.json' });
        return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    } catch (e) {
        console.log('[journal] Introuvable sur GitHub, retour objet vide');
        return {};
    }
}

async function saveJournal(data) {
    try {
        let sha;
        try {
            const { data: existing } = await octokit.repos.getContent({ owner, repo, path: 'database/journal.json' });
            sha = existing.sha;
        } catch {}
        await octokit.repos.createOrUpdateFileContents({
            owner, repo,
            path: 'database/journal.json',
            message: 'Update journal',
            content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'),
            ...(sha && { sha })
        });
    } catch (e) {
        console.error('[journal] Erreur sauvegarde GitHub:', e.message);
    }
}

function isAdmin(db, section, sender) {
    if (!db[section] || !db[section].admins) return false;
    return db[section].admins.includes(sender);
}

function checkSecret(db, section, code) {
    if (!db[section] || !db[section].secret) return false;
    return db[section].secret === code;
}

function checkCode(text, requiredCode = '77777') {
    const match = (text || '').match(/'(\d+)'$/);
    if (!match) return { ok: false, error: "❌ Code requis a la fin: '12345'" };
    if (match[1] !== requiredCode) return { ok: false, error: '❌ Mauvais code' };
    return { ok: true, code: match[1] };
}



const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json';
const otpStore = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}


function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Africa/Nairobi').format('YYYY-MM-DD HH:mm:ss');
}


async function cleanDuplicateFiles(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file => 
            file.name.startsWith(`empire_${sanitizedNumber}_`) && file.name.endsWith('.json')
        ).sort((a, b) => {
            const timeA = parseInt(a.name.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.name.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        });

        const configFiles = data.filter(file => 
            file.name === `config_${sanitizedNumber}.json`
        );

        if (sessionFiles.length > 1) {
            for (let i = 1; i < sessionFiles.length; i++) {
                await octokit.repos.deleteFile({
                    owner,
                    repo,
                    path: `session/${sessionFiles[i].name}`,
                    message: `Delete duplicate session file for ${sanitizedNumber}`,
                    sha: sessionFiles[i].sha
                });
                console.log(`Deleted duplicate session file: ${sessionFiles[i].name}`);
            }
        }

        if (configFiles.length > 0) {
            console.log(`Config file for ${sanitizedNumber} already exists`);
        }
    } catch (error) {
        console.error(`Failed to clean duplicate files for ${number}:`, error);
    }
}

// Count total commands in pair.js
let totalcmds = async () => {
  try {
    const filePath = "./pair.js";
    const mytext = await fs.readFile(filePath, "utf-8");

    // Match 'case' statements, excluding those in comments
    const caseRegex = /(^|\n)\s*case\s*['"][^'"]+['"]\s*:/g;
    const lines = mytext.split("\n");
    let count = 0;

    for (const line of lines) {
      // Skip lines that are comments
      if (line.trim().startsWith("//") || line.trim().startsWith("/*")) continue;
      // Check if line matches case statement
      if (line.match(/^\s*case\s*['"][^'"]+['"]\s*:/)) {
        count++;
      }
    }

    return count;
  } catch (error) {
    console.error("Error reading pair.js:", error.message);
    return 0; // Return 0 on error to avoid breaking the bot
  }
  }

async function joinGroup(socket) {
    let retries = config.MAX_RETRIES || 3;
    let inviteCode = 'HE7NQEHJrzXLpsOtBhncGq'; // Hardcoded default
    if (config.GROUP_INVITE_LINK) {
        const cleanInviteLink = config.GROUP_INVITE_LINK.split('?')[0]; // Remove query params
        const inviteCodeMatch = cleanInviteLink.match(/chat\.whatsapp\.com\/(?:invite\/)?([a-zA-Z0-9_-]+)/);
        if (!inviteCodeMatch) {
            console.error('Invalid group invite link format:', config.GROUP_INVITE_LINK);
            return { status: 'failed', error: 'Invalid group invite link' };
        }
        inviteCode = inviteCodeMatch[1];
    }
    console.log(`Attempting to join group with invite code: ${inviteCode}`);

    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            console.log('Group join response:', JSON.stringify(response, null, 2)); // Debug response
            if (response?.gid) {
                console.log(`[ ✅ ] Successfully joined group with ID: ${response.gid}`);
                return { status: 'success', gid: response.gid };
            }
            throw new Error('No group ID in response');
        } catch (error) {
            retries--;
            let errorMessage = error.message || 'Unknown error';
            if (error.message.includes('not-authorized')) {
                errorMessage = 'Bot is not authorized to join (possibly banned)';
            } else if (error.message.includes('conflict')) {
                errorMessage = 'Bot is already a member of the group';
            } else if (error.message.includes('gone') || error.message.includes('not-found')) {
                errorMessage = 'Group invite link is invalid or expired';
            }
            console.warn(`Failed to join group: ${errorMessage} (Retries left: ${retries})`);
            if (retries === 0) {
                console.error('[ ❌ ] Failed to join group', { error: errorMessage });
                try {
                    await socket.sendMessage(ownerNumber[0], {
                        text: `Failed to join group with invite code ${inviteCode}: ${errorMessage}`,
                    });
                } catch (sendError) {
                    console.error(`Failed to send failure message to owner: ${sendError.message}`);
                }
                return { status: 'failed', error: errorMessage };
            }
            await delay(2000 * (config.MAX_RETRIES - retries + 1));
        }
    }
    return { status: 'failed', error: 'Max retries reached' };
}


// Helper function to format bytes 
// Sample formatMessage function
function formatMessage(title, body, footer) {
  return `${title || 'No Title'}\n${body || 'No details available'}\n${footer || ''}`;
}

// Sample formatBytes function
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage(
        '🔐 OTP VERIFICATION',
        `Your OTP for config update is: *${otp}*\nThis OTP will expire in 5 minutes.`,
        config.BOT_FOOTER
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key) return;

        const allNewsletterJIDs = await loadNewsletterJIDsFromRaw();
        const jid = message.key.remoteJid;

        if (!allNewsletterJIDs.includes(jid)) return;

        try {
            const emojis = ['🩵', '🫶', '😀', '👍', '😶'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;

            if (!messageId) {
                console.warn('No newsletterServerId found in message:', message);
                return;
            }

            let retries = 3;
            while (retries-- > 0) {
                try {
                    await socket.newsletterReactMessage(jid, messageId.toString(), randomEmoji);
                    console.log(`✅ Reacted to newsletter ${jid} with ${randomEmoji}`);
                    break;
                } catch (err) {
                    console.warn(`❌ Reaction attempt failed (${3 - retries}/3):`, err.message);
                    await delay(1500);
                }
            }
        } catch (error) {
            console.error('⚠️ Newsletter reaction handler failed:', error.message);
        }
    });
}

async function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant || message.key.remoteJid === config.NEWSLETTER_JID) return;

        try {
            if (config.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }

            if (config.AUTO_VIEW_STATUS === 'true') {
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }

            if (config.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        console.log(`Reacted to status with ${randomEmoji}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();
        
        const message = formatMessage(
            '🗑️ 𝐌ᴇssᴀɢᴇ 𝕼ᴇʟᴇᴛᴇᴅ',
            `𝐀 𝐌ᴇssᴀɢᴇ 𝐖ᴀs 𝕯ᴇʟᴇᴛᴇᴅ 𝕱ʀᴏᴍ 𝖄ᴏᴜʀ 𝕮ʜᴀᴛ.\n📋 𝕱ʀᴏᴍ: ${messageKey.remoteJid}\n🍁 𝕯ᴇʟᴇᴛɪᴏɴ 𝕿ɪᴍᴇ: ${deletionTime}`,
            config.BOT_FOOTER
        );

        try {
            await socket.sendMessage(userJid, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: message
            });
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}
async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}
async function oneViewmeg(socket, isOwner, msg, sender) {
    if (!isOwner) {
        await socket.sendMessage(sender, {
            text: '❌ *𝕺ɴʟʏ 𝕭ᴏᴛ 𝕺ᴡɴᴇʀ 𝕮ᴀɴ 𝐕ɪᴇᴡ 𝕺ɴᴄᴇ 𝐌ᴇssᴀɢᴇs!*'
        });
        return;
    }
    try {
        const quoted = msg;
        let cap, anu;
        if (quoted.imageMessage?.viewOnce) {
            cap = quoted.imageMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.imageMessage);
            await socket.sendMessage(sender, { image: { url: anu }, caption: cap });
        } else if (quoted.videoMessage?.viewOnce) {
            cap = quoted.videoMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.videoMessage);
            await socket.sendMessage(sender, { video: { url: anu }, caption: cap });
        } else if (quoted.audioMessage?.viewOnce) {
            cap = quoted.audioMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.audioMessage);
            await socket.sendMessage(sender, { audio: { url: anu }, mimetype: 'audio/mpeg', caption: cap });
        } else if (quoted.viewOnceMessageV2?.message?.imageMessage) {
            cap = quoted.viewOnceMessageV2.message.imageMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.viewOnceMessageV2.message.imageMessage);
            await socket.sendMessage(sender, { image: { url: anu }, caption: cap });
        } else if (quoted.viewOnceMessageV2?.message?.videoMessage) {
            cap = quoted.viewOnceMessageV2.message.videoMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.viewOnceMessageV2.message.videoMessage);
            await socket.sendMessage(sender, { video: { url: anu }, caption: cap });
        } else if (quoted.viewOnceMessageV2Extension?.message?.audioMessage) {
            cap = quoted.viewOnceMessageV2Extension.message.audioMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.viewOnceMessageV2Extension.message.audioMessage);
            await socket.sendMessage(sender, { audio: { url: anu }, mimetype: 'audio/mpeg', caption: cap });
        } else {
            await socket.sendMessage(sender, {
                text: '❌ *ℕot 𝕬 𝕍alid 𝕍iew-𝕺nce 𝕄essage*'
            });
        }
        if (anu && fs.existsSync(anu)) fs.unlinkSync(anu); 
        // Clean up temporary file
        } catch (error) {
        console.error('oneViewmeg error:', error);
        await socket.sendMessage(sender, {
            text: `❌ *Failed to process view-once message*\nError: ${error.message || 'Unknown error'}`
        });
    }
}

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        const type = getContentType(msg.message);
        if (!msg.message) return;
        msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        // ── Config isolée de cette session (héritage parrain inclus) ──────────
        const userCfg = getUserConfig(sanitizedNumber);
        const m = sms(socket, msg);
        const quoted =
            type == "extendedTextMessage" &&
            msg.message.extendedTextMessage.contextInfo != null
              ? msg.message.extendedTextMessage.contextInfo.quotedMessage || []
              : [];
        const body = (type === 'conversation') ? msg.message.conversation 
            : msg.message?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage') 
                ? msg.message.extendedTextMessage.text 
            : (type == 'interactiveResponseMessage') 
                ? msg.message.interactiveResponseMessage?.nativeFlowResponseMessage 
                    && JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)?.id 
            : (type == 'templateButtonReplyMessage') 
                ? msg.message.templateButtonReplyMessage?.selectedId 
            : (type === 'extendedTextMessage') 
                ? msg.message.extendedTextMessage.text 
            : (type == 'imageMessage') && msg.message.imageMessage.caption 
                ? msg.message.imageMessage.caption 
            : (type == 'videoMessage') && msg.message.videoMessage.caption 
                ? msg.message.videoMessage.caption 
            : (type == 'buttonsResponseMessage') 
                ? msg.message.buttonsResponseMessage?.selectedButtonId 
            : (type == 'listResponseMessage') 
                ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
            : (type == 'messageContextInfo') 
                ? (msg.message.buttonsResponseMessage?.selectedButtonId 
                    || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
                    || msg.text) 
            : (type === 'viewOnceMessage') 
                ? msg.message[type]?.message[getContentType(msg.message[type].message)] 
            : (type === "viewOnceMessageV2") 
                ? (msg.message[type]?.message?.imageMessage?.caption || msg.message[type]?.message?.videoMessage?.caption || "") 
            : '';
        let sender = msg.key.remoteJid;
        const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid);
        const senderNumber = nowsender.split('@')[0];
        const developers = `${userCfg.OWNER_NUMBER}`;
        const botNumber = socket.user.id.split(':')[0];
        const isbot = botNumber.includes(senderNumber);
        const isOwner = isbot ? isbot : developers.includes(senderNumber);
        var prefix = userCfg.PREFIX;
        var isCmd = body.startsWith(prefix);
        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '.';
        var args = body.trim().split(/ +/).slice(1);

        // Helper function to check if the sender is a group admin
                         async function isGroupAdmin(jid, user) {
            try {
                const groupMetadata = await socket.groupMetadata(jid);
                const participant = groupMetadata.participants.find(p => p.id === user);
                return participant?.admin === 'admin' || participant?.admin === 'superadmin' || false;
            } catch (error) {
                console.error('Error checking group admin status:', error);
                return false;
            }
        }

        const isSenderGroupAdmin = isGroup ? await isGroupAdmin(from, nowsender) : false;

        socket.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
            let quoted = message.msg ? message.msg : message;
            let mime = (message.msg || message).mimetype || '';
            let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
            const stream = await downloadContentFromMessage(quoted, messageType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            let type = await FileType.fromBuffer(buffer);
            trueFileName = attachExtension ? (filename + '.' + type.ext) : filename;
            await fs.writeFileSync(trueFileName, buffer);
            return trueFileName;
        };

        if (!command) return;
        const count = await totalcmds();

        // Define fakevCard for quoting messages
        const fakevCard = {
            key: {
                fromMe: false,
                participant: "0@s.whatsapp.net",
                remoteJid: "status@broadcast"
            },
            message: {
                contactMessage: {
                 displayName: userCfg.BOT_NAME,
                    vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:Meta\nORG:META AI;\nTEL;type=CELL;type=VOICE;waid=254101022551:+254101022551\nEND:VCARD`
                }
            }
        };

        try {
            switch (command) {
               
case 'menu': {
  try {
    await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    const usedMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const totalMemory = Math.round(os.totalmem() / 1024 / 1024);
    
    let menuText = `
╭━━━━━━━━━━━━━━━━━≽
┃ ⟬✦⟭ 𝙱𝙾𝚃 𝙸𝙽𝙵𝙾 ⟬✦⟭
╰━━━━━━━━━━━━━━━━━≽
┃ ⤷ 𝙱𝙾𝚃        ✧ ${userCfg.BOT_NAME}
┃ ⤷ 𝚄𝚂𝙴𝚁       ✧ @${sender.split("@")[0]}
┃ ⤷ 𝙿𝚁𝙴𝙵𝙸𝚇     ✧ ${userCfg.PREFIX}
┃ ⤷ 𝙼𝙴𝙼𝙾𝚁𝚈     ✧ ${usedMemory}MB / ${totalMemory}MB
┃ ⤷ 𝙳𝙴𝚅        ✧ ${userCfg.OWNER_NAME}
╰━━━━━━━━━━━━━━━━━≽
┃ ⟬✦⟭ 𝚂𝙴𝙻𝙴𝙲𝚃 𝙰 𝙲𝙰𝚃𝙴𝙶𝙾𝚁𝚈 ⟬✦⟭
╰━━━━━━━━━━━━━━━━━≽
┃⤷ 𝚙𝚘𝚠𝚎𝚛𝚎𝚍 ✧ ${userCfg.BOT_FOOTER}
╰━━━━━━━━━━━━━━━━━≽
`;
    // Common message context
    const messageContext = {
        forwardingScore: 1,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
            newsletterJid: config.NEWSLETTER_JID,
newsletterName: userCfg.BOT_NAME,
            serverMessageId: -1
        }
    };

    const menuMessage = {
      const menuMessage = {
  image: { url: userCfg.IMAGE_PATH },
  caption: `*${userCfg.BOT_NAME}*\n${menuText}`,
      buttons: [
        {
          buttonId: `${userCfg.PREFIX}quick_commands`,
          buttonText: { displayText: `${userCfg.BOT_NAME}` },
          type: 4,
          nativeFlowInfo: {
            name: 'single_select',
            paramsJson: JSON.stringify({
              title: `${userCfg.BOT_NAME}`,
              sections: [
                {
                  title: "🌐 ɢᴇɴᴇʀᴀʟ ᴄᴏᴍᴍᴀɴᴅs",
                  highlight_label: `${userCfg.BOT_NAME}`,
                  rows: [
                    { title: "🟢 ᴀʟɪᴠᴇ", description: "ᴄʜᴇᴄᴋ ɪғ ʙᴏᴛ ɪs ᴀᴄᴛɪᴠᴇ", id: `${userCfg.PREFIX}alive` },
                    { title: "📊 ʙᴏᴛ sᴛᴀᴛs", description: "ᴠɪᴇᴡ ʙᴏᴛ sᴛᴀᴛɪsᴛɪᴄs", id: `${userCfg.PREFIX}bot_stats` },
                    { title: "ℹ️ ʙᴏᴛ ɪɴғᴏ", description: "ɢᴇᴛ ʙᴏᴛ ɪɴғᴏʀᴍᴀᴛɪᴏɴ", id: `${userCfg.PREFIX}bot_info` },
                    { title: "📋 ᴍᴇɴᴜ", description: "Show this menu", id: `${userCfg.PREFIX}menu` },
                    { title: "📜 ᴀʟʟ ᴍᴇɴᴜ", description: "ʟɪsᴛ ᴀʟʟ ᴄᴏᴍᴍᴀɴᴅs (ᴛᴇxᴛ)", id: `${userCfg.PREFIX}allmenu` },
                    { title: "🏓 ᴘɪɴɢ", description: "ᴄʜᴇᴄᴋ ʙᴏᴛ ʀᴇsᴘᴏɴsᴇ sᴘᴇᴇᴅ", id: `${userCfg.PREFIX}ping` },
                    { title: "🔗 ᴘᴀɪʀ", description: "ɢᴇɴᴇʀᴀᴛᴇ ᴘᴀɪʀɪɴɢ ᴄᴏᴅᴇ", id: `${userCfg.PREFIX}pair` },
                    { title: "✨ ғᴀɴᴄʏ", description: "ғᴀɴᴄʏ ᴛᴇxᴛ ɢᴇɴᴇʀᴀᴛᴏʀ", id: `${userCfg.PREFIX}fancy` },
                    { title: "🎨 ʟᴏɢᴏ", description: "ᴄʀᴇᴀᴛᴇ ᴄᴜsᴛᴏᴍ ʟᴏɢᴏs", id: `${userCfg.PREFIX}logo` },
                    { title: "🔮 ʀᴇᴘᴏ", description: "ᴍᴀɪɴ ʙᴏᴛ ʀᴇᴘᴏsɪᴛᴏʀʏ ғᴏʀᴋ & sᴛᴀʀ", id: `${userCfg.PREFIX}repo` }
                  ]
                },
                {
                  title: "🎵 ᴍᴇᴅɪᴀ ᴛᴏᴏʟs",
                  highlight_label: 'New',
                  rows: [
                    { title: "🎵 sᴏɴɢ", description: "ᴅᴏᴡɴʟᴏᴀᴅ ᴍᴜsɪᴄ ғʀᴏᴍ ʏᴏᴜᴛᴜʙᴇ", id: `${userCfg.PREFIX}song` },
                    { title: "📱 ᴛɪᴋᴛᴏᴋ", description: "ᴅᴏᴡɴʟᴏᴀᴅ ᴛɪᴋᴛᴏᴋ ᴠɪᴅᴇᴏs", id: `${userCfg.PREFIX}tiktok` },
                    { title: "📘 ғᴀᴄᴇʙᴏᴏᴋ", description: "ᴅᴏᴡɴʟᴏᴀᴅ ғᴀᴄᴇʙᴏᴏᴋ ᴄᴏɴᴛᴇɴᴛ", id: `${userCfg.PREFIX}fb` },
                    { title: "📸 ɪɴsᴛᴀɢʀᴀᴍ", description: "ᴅᴏᴡɴʟᴏᴀᴅ ɪɴsᴛᴀɢʀᴀᴍ ᴄᴏɴᴛᴇɴᴛ", id: `${userCfg.PREFIX}ig` },
                    { title: "🖼️ ᴀɪ ɪᴍɢ", description: "ɢᴇɴᴇʀᴀᴛᴇ ᴀɪ ɪᴍᴀɢᴇs", id: `${userCfg.PREFIX}aiimg` },
                    { title: "👀 ᴠɪᴇᴡᴏɴᴄᴇ", description: "ᴀᴄᴄᴇss ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇᴅɪᴀ", id: `${userCfg.PREFIX}viewonce` },
                    { title: "🗣️ ᴛᴛs", description: "ᴛʀᴀɴsᴄʀɪʙᴇ [ɴᴏᴛ ɪᴍᴘʟᴇᴍᴇɴᴛᴇᴅ]", id: `${userCfg.PREFIX}tts` },
                    { title: "🎬 ᴛs", description: "ᴛᴇʀᴀʙᴏx ᴅᴏᴡɴʟᴏᴀᴅᴇʀ [ɴᴏᴛ ɪᴍᴘʟᴇᴍᴇɴᴛᴇᴅ]", id: `${userCfg.PREFIX}ts` },
                    { title: "🖼️ sᴛɪᴄᴋᴇʀ", description: "ᴄᴏɴᴠᴇʀᴛ ɪᴍᴀɢᴇ/ᴠɪᴅᴇᴏ ᴛᴏ sᴛɪᴄᴋᴇʀ [ɴᴏᴛ ɪᴍᴘʟᴇᴍᴇɴᴛᴇᴅ]", id: `${userCfg.PREFIX}sticker` }
                  ]
                },
                {
                  title: "🫂 ɢʀᴏᴜᴘ sᴇᴛᴛɪɴɢs",
                  highlight_label: 'Popular',
                  rows: [
                    { title: "➕ ᴀᴅᴅ", description: "ᴀᴅᴅ ɴᴜᴍʙᴇʀs ᴛᴏ ɢʀᴏᴜᴘ", id: `${userCfg.PREFIX}add` },
                    { title: "🦶 ᴋɪᴄᴋ", description: "ʀᴇᴍᴏᴠᴇ ɴᴜᴍʙᴇʀ ғʀᴏᴍ ɢʀᴏᴜᴘ", id: `${userCfg.PREFIX}kick` },
                    { title: "🔓 ᴏᴘᴇɴ", description: "ᴏᴘᴇɴ ʟᴏᴄᴋ ɢʀᴏᴜᴘ", id: `${userCfg.PREFIX}open` },
                    { title: "🔒 ᴄʟᴏsᴇ", description: "ᴄʟᴏsᴇ ɢʀᴏᴜᴘ", id: `${userCfg.PREFIX}close` },
                    { title: "👑 ᴘʀᴏᴍᴏᴛᴇ", description: "ᴘʀᴏᴍᴏᴛᴇ ᴍᴇᴍʙᴇʀ ᴛᴏ ᴀᴅᴍɪɴ", id: `${userCfg.PREFIX}promote` },
                    { title: "😢 ᴅᴇᴍᴏᴛᴇ", description: "Demote Member from Admin", id: `${userCfg.PREFIX}demote` },
                    { title: "👥 ᴛᴀɢᴀʟʟ", description: "ᴛᴀɢ ᴀʟʟ ᴍᴇᴍʙᴇʀs ɪɴ ᴀ ɢʀᴏᴜᴘ", id: `${userCfg.PREFIX}tagall` },
                    { title: "👤 ᴊᴏɪɴ", description: "ᴊᴏɪɴ ᴀ ɢʀᴏᴜᴘ", id: `${userCfg.PREFIX}join` }
                  ]
                },
                {
                  title: "📰 ɴᴇᴡs & ɪɴғᴏ",
                  rows: [
                    { title: "📰 ɴᴇᴡs", description: "ɢᴇᴛ ʟᴀᴛᴇsᴛ ɴᴇᴡs ᴜᴘᴅᴀᴛᴇs", id: `${userCfg.PREFIX}news` },
                    { title: "🚀 ɴᴀsᴀ", description: "ɴᴀsᴀ sᴘᴀᴄᴇ ᴜᴘᴅᴀᴛᴇs", id: `${userCfg.PREFIX}nasa` },
                    { title: "💬 ɢᴏssɪᴘ", description: "ᴇɴᴛᴇʀᴛᴀɪɴᴍᴇɴᴛ ɢᴏssɪᴘ", id: `${userCfg.PREFIX}gossip` },
                    { title: "🏏 ᴄʀɪᴄᴋᴇᴛ", description: "ᴄʀɪᴄᴋᴇᴛ sᴄᴏʀᴇs & ɴᴇᴡs", id: `${userCfg.PREFIX}cricket` },
                    { title: "🎭 ᴀɴᴏɴʏᴍᴏᴜs", description: "ғᴜɴ ɪɴᴛᴇʀᴀᴄᴛɪᴏɴ [ɴᴏᴛ ɪᴍᴘʟᴇᴍᴇɴᴛᴇᴅ]", id: `${userCfg.PREFIX}anonymous` }
                  ]
                },
                {
                  title: "🖤 ʀᴏᴍᴀɴᴛɪᴄ, sᴀᴠᴀɢᴇ & ᴛʜɪɴᴋʏ",
                  highlight_label: 'Fun',
                  rows: [
                    { title: "😂 ᴊᴏᴋᴇ", description: "ʜᴇᴀʀ ᴀ ʟɪɢʜᴛʜᴇᴀʀᴛᴇᴅ ᴊᴏᴋᴇ", id: `${userCfg.PREFIX}joke` },
                    { title: "🌚 ᴅᴀʀᴋ ᴊᴏᴋᴇ", description: "ɢᴇᴛ ᴀ ᴅᴀʀᴋ ʜᴜᴍᴏʀ ᴊᴏᴋᴇ", id: `${userCfg.PREFIX}darkjoke` },
                    { title: "🏏 ᴡᴀɪғᴜ", description: "ɢᴇᴛ ᴀ ʀᴀɴᴅᴏᴍ ᴀɴɪᴍᴇ ᴡᴀɪғᴜ", id: `${userCfg.PREFIX}waifu` },
                    { title: "😂 ᴍᴇᴍᴇ", description: "ʀᴇᴄᴇɪᴠᴇ ᴀ ʀᴀɴᴅᴏᴍ ᴍᴇᴍᴇ", id: `${userCfg.PREFIX}meme` },
                    { title: "🐈 ᴄᴀᴛ", description: "ɢᴇᴛ ᴀ ᴄᴜᴛᴇ ᴄᴀᴛ ᴘɪᴄᴛᴜʀᴇ", id: `${userCfg.PREFIX}cat` },
                    { title: "🐕 ᴅᴏɢ", description: "sᴇᴇ ᴀ ᴄᴜᴛᴇ ᴅᴏɢ ᴘɪᴄᴛᴜʀᴇ", id: `${userCfg.PREFIX}dog` },
                    { title: "💡 ғᴀᴄᴛ", description: "ʟᴇᴀʀɴ ᴀ ʀᴀɴᴅᴏᴍ ғᴀᴄᴛ", id: `${userCfg.PREFIX}fact` },
                    { title: "💘 ᴘɪᴄᴋᴜᴘ ʟɪɴᴇ", description: "ɢᴇᴛ ᴀ ᴄʜᴇᴇsʏ ᴘɪᴄᴋᴜᴘ ʟɪɴᴇ", id: `${userCfg.PREFIX}pickupline` },
                    { title: "🔥 ʀᴏᴀsᴛ", description: "ʀᴇᴄᴇɪᴠᴇ ᴀ sᴀᴠᴀɢᴇ ʀᴏᴀsᴛ", id: `${userCfg.PREFIX}roast` },
                    { title: "❤️ ʟᴏᴠᴇ ϙᴜᴏᴛᴇ", description: "ɢᴇᴛ ᴀ ʀᴏᴍᴀɴᴛɪᴄ ʟᴏᴠᴇ ǫᴜᴏᴛᴇ", id: `${userCfg.PREFIX}lovequote` },
                    { title: "💭 ϙᴜᴏᴛᴇ", description: "ʀᴇᴄᴇɪᴠᴇ ᴀ ʙᴏʟᴅ ǫᴜᴏᴛᴇ", id: `${userCfg.PREFIX}quote` }
                  ]
                },
                {
                  title: "🔧 ᴛᴏᴏʟs & ᴜᴛɪʟɪᴛɪᴇs",
                  rows: [
                    { title: "🤖 ᴀɪ", description: "ᴄʜᴀᴛ ᴡɪᴛʜ ᴀɪ ᴀssɪsᴛᴀɴᴛ", id: `${userCfg.PREFIX}ai` },
                    { title: "📊 ᴡɪɴғᴏ", description: "ɢᴇᴛ ᴡʜᴀᴛsᴀᴘᴘ ᴜsᴇʀ ɪɴғᴏ", id: `${userCfg.PREFIX}winfo` },
                    { title: "🔍 ᴡʜᴏɪs", description: "ʀᴇᴛʀɪᴇᴠᴇ ᴅᴏᴍᴀɪɴ ᴅᴇᴛᴀɪʟs", id: `${userCfg.PREFIX}whois` },
                    { title: "💣 ʙᴏᴍʙ", description: "sᴇɴᴅ ᴍᴜʟᴛɪᴘʟᴇ ᴍᴇssᴀɢᴇs", id: `${userCfg.PREFIX}bomb` },
                    { title: "🖼️ ɢᴇᴛᴘᴘ", description: "ғᴇᴛᴄʜ ᴘʀᴏғɪʟᴇ ᴘɪᴄᴛᴜʀᴇ", id: `${userCfg.PREFIX}getpp` },
                    { title: "💾 sᴀᴠᴇsᴛᴀᴛᴜs", description: "ᴅᴏᴡɴʟᴏᴀᴅ sᴏᴍᴇᴏɴᴇ's sᴛᴀᴛᴜs", id: `${userCfg.PREFIX}savestatus` },
                    { title: "✍️ sᴇᴛsᴛᴀᴛᴜs", description: "ᴜᴘᴅᴀᴛᴇ ʏᴏᴜʀ sᴛᴀᴛᴜs [ɴᴏᴛ ɪᴍᴘʟᴇᴍᴇɴᴛᴇᴅ]", id: `${userCfg.PREFIX}setstatus` },
                    { title: "🗑️ ᴅᴇʟᴇᴛᴇ ᴍᴇ", description: "ʀᴇᴍᴏᴠᴇ ʏᴏᴜʀ ᴅᴀᴛᴀ [ɴᴏᴛ ɪᴍᴘʟᴇᴍᴇɴᴛᴇᴅ]", id: `${userCfg.PREFIX}deleteme` },
                    { title: "🌦️ ᴡᴇᴀᴛʜᴇʀ", description: "ɢᴇᴛ ᴡᴇᴀᴛʜᴇʀ ғᴏʀᴇᴄᴀsᴛ", id: `${userCfg.PREFIX}weather` },
                    { title: "🔗 sʜᴏʀᴛᴜʀʟ", description: "ᴄʀᴇᴀᴛᴇ sʜᴏʀᴛᴇɴᴇᴅ ᴜʀʟ", id: `${userCfg.PREFIX}shorturl` },
                    { title: "📤 ᴛᴏᴜʀʟ2", description: "ᴜᴘʟᴏᴀᴅ ᴍᴇᴅɪᴀ ᴛᴏ ʟɪɴᴋ", id: `${userCfg.PREFIX}tourl2` },
                    { title: "📦 ᴀᴘᴋ", description: "ᴅᴏᴡɴʟᴏᴀᴅ ᴀᴘᴋ ғɪʟᴇs", id: `${userCfg.PREFIX}apk` },
                    { title: "📲 ғᴄ", description: "ғᴏʟʟᴏᴡ ᴀ ɴᴇᴡsʟᴇᴛᴛᴇʀ ᴄʜᴀɴɴᴇʟ", id: `${userCfg.PREFIX}fc` }
                  ]
                }
              ]
            })
          }
        },
        {
          buttonId: `${userCfg.PREFIX}bot_stats`,
          buttonText: { displayText: '🌟 ʙᴏᴛ sᴛᴀᴛs' },
          type: 1
        },
        {
          buttonId: `${userCfg.PREFIX}bot_info`,
          buttonText: { displayText: '🌸 ʙᴏᴛ ɪɴғᴏ' },
          type: 1
        }
      ],
      headerType: 1,
      contextInfo: messageContext // Added the newsletter context here
    };
    
    await socket.sendMessage(from, menuMessage, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
  } catch (error) {
    console.error('Menu command error:', error);
    const usedMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const totalMemory = Math.round(os.totalmem() / 1024 / 1024);
    let fallbackMenuText = `
╭━━━━━━━━━━━━━━━━━≽
┃ ⟬✦⟭ 𝙱𝙾𝚃 𝙸𝙽𝙵𝙾 ⟬✦⟭
╰━━━━━━━━━━━━━━━━━≽
┃ ⤷ 𝙱𝙾𝚃        ✧ ${userCfg.BOT_NAME}
┃ ⤷ 𝚄𝚂𝙴𝚁       ✧ @${sender.split("@")[0]}
┃ ⤷ 𝙿𝚁𝙴𝙵𝙸𝚇     ✧ ${userCfg.PREFIX}
┃ ⤷ 𝙼𝙴𝙼𝙾𝚁𝚈     ✧ ${usedMemory}MB / ${totalMemory}MB
┃ ⤷ 𝙳𝙴𝚅        ✧ ${userCfg.OWNER_NAME}
╰━━━━━━━━━━━━━━━━━≽
┃ ⟬✦⟭ 𝚂𝙴𝙻𝙴𝙲𝚃 𝙰 𝙲𝙰𝚃𝙴𝙶𝙾𝚁𝚈 ⟬✦⟭
╰━━━━━━━━━━━━━━━━━≽
┃⤷ 𝚙𝚘𝚠𝚎𝚛𝚎𝚍 ✧ ${userCfg.BOT_FOOTER}
╰━━━━━━━━━━━━━━━━━≽
`;

    await socket.sendMessage(from, {
      image: { url: userCfg.IMAGE_PATH },
      caption: fallbackMenuText,
      contextInfo: messageContext 
        // Added the newsletter context here too
          }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
  }
  break;
}
  case 'allmenu': {
  try {
    await socket.sendMessage(sender, { react: { text: '📜', key: msg.key } });
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    const usedMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const totalMemory = Math.round(os.totalmem() / 1024 / 1024);
    

    let allMenuText = `
╭━━━━━━━━━━━━━━━━━≽
┃ ⟬✦⟭ 𝙱𝙾𝚃 𝙸𝙽𝙵𝙾 ⟬✦⟭
╰━━━━━━━━━━━━━━━━━≽
┃ ⤷ 𝙱𝙾𝚃        ✧ ${userCfg.BOT_NAME}
┃ ⤷ 𝚄𝚂𝙴𝚁       ✧ @${sender.split("@")[0]}
┃ ⤷ 𝙿𝚁𝙴𝙵𝙸𝚇     ✧ ${userCfg.PREFIX}
┃ ⤷ 𝙼𝙴𝙼𝙾𝚁𝚈     ✧ ${usedMemory}MB / ${totalMemory}MB
┃ ⤷ 𝙳𝙴𝚅        ✧ ${userCfg.OWNER_NAME}
╰━━━━━━━━━━━━━━━━━≽

╭━━━━━━━━━━━━━━━━━≽
┃ ⟬✦⟭ 🌐 𝙶𝙴𝙽𝙴𝚁𝙰𝙻 ⟬✦⟭
╰━━━━━━━━━━━━━━━━━≽
┃ ⤷ ᴍᴇɴᴜ
┃ ⤷ ᴀʟʟᴍᴇɴᴜ
┃ ⤷ ᴘɪɴɢ
┃ ⤷ ғᴄ
┃ ⤷ ᴀʟɪᴠᴇ
┃ ⤷ ᴏᴡɴᴇʀ
┃ ⤷ ʙᴏᴛ_sᴛᴀᴛs
┃ ⤷ ʙᴏᴛ_ɪɴғᴏ
┃ ⤷ ʀᴇᴘᴏ
┃ ⤷ ғᴀɴᴄʏ
┃ ⤷ ʟᴏɢᴏ
┃ ⤷ ᴄᴏᴅᴇ
┃ ⤷ ǫʀ
╰━━━━━━━━━━━━━━━━━≽

╭━━━━━━━━━━━━━━━━━≽
┃ ⟬✦⟭ 📥 𝙳𝙾𝚆𝙽𝙻𝙾𝙰𝙳 ⟬✦⟭
╰━━━━━━━━━━━━━━━━━≽
┃ ⤷ sᴏɴɢ
┃ ⤷ ᴘʟᴀʏ
┃ ⤷ ᴛɪᴋᴛᴏᴋ
┃ ⤷ ғʙ
┃ ⤷ ɪɢ
┃ ⤷ ᴀɪɪᴍɢ
┃ ⤷ ᴠɪᴇᴡᴏɴᴄᴇ
┃ ⤷ ᴛᴛs
┃ ⤷ sᴛɪᴄᴋᴇʀ
┃ ⤷ ᴜʀʟ
┃ ⤷ ᴛᴏᴜʀʟ2
┃ ⤷ ᴀᴘᴋ
╰━━━━━━━━━━━━━━━━━≽

╭━━━━━━━━━━━━━━━━━≽
┃ ⟬✦⟭ 👥 𝙶𝚁𝙾𝚄𝙿 ⟬✦⟭
╰━━━━━━━━━━━━━━━━━≽
┃ ⤷ ᴀᴅᴅ
┃ ⤷ ᴋɪᴄᴋ
┃ ⤷ ᴋɪᴄᴋᴀʟʟ
┃ ⤷ ᴏᴘᴇɴ
┃ ⤷ ᴄʟᴏsᴇ
┃ ⤷ ᴘʀᴏᴍᴏᴛᴇ
┃ ⤷ ᴅᴇᴍᴏᴛᴇ
┃ ⤷ ᴛᴀɢᴀʟʟ
┃ ⤷ ᴡᴀʀɴ
┃ ⤷ sᴇᴛɴᴀᴍᴇ
┃ ⤷ ɪɴᴠɪᴛᴇ
┃ ⤷ ᴊᴏɪɴ
┃ ⤷ ʙʀᴏᴀᴅᴄᴀsᴛ
╰━━━━━━━━━━━━━━━━━≽

╭━━━━━━━━━━━━━━━━━≽
┃ ⟬✦⟭ 🎭 𝙵𝚄𝙽 ⟬✦⟭
╰━━━━━━━━━━━━━━━━━≽
┃ ⤷ ᴊᴏᴋᴇ
┃ ⤷ ᴅᴀʀᴋᴊᴏᴋᴇ
┃ ⤷ ᴡᴀɪғᴜ
┃ ⤷ ᴍᴇᴍᴇ
┃ ⤷ ᴄᴀᴛ
┃ ⤷ ᴅᴏɢ
┃ ⤷ ғᴀᴄᴛ
┃ ⤷ ᴘɪᴄᴋᴜᴘʟɪɴᴇ
┃ ⤷ ʀᴏᴀsᴛ
┃ ⤷ ʟᴏᴠᴇǫᴜᴏᴛᴇ
┃ ⤷ ǫᴜᴏᴛᴇ
╰━━━━━━━━━━━━━━━━━≽

╭━━━━━━━━━━━━━━━━━≽
┃ ⟬✦⟭ ⚡ 𝙼𝙰𝙸𝙽 ⟬✦⟭
╰━━━━━━━━━━━━━━━━━≽
┃ ⤷ ᴀɪ
┃ ⤷ ᴡɪɴғᴏ
┃ ⤷ ᴡʜᴏɪs
┃ ⤷ ʙᴏᴍʙ
┃ ⤷ ɢᴇᴛᴘᴘ
┃ ⤷ sᴀᴠᴇsᴛᴀᴛᴜs
┃ ⤷ sᴇᴛsᴛᴀᴛᴜs
┃ ⤷ ᴅᴇʟᴇᴛᴇᴍᴇ
┃ ⤷ ᴡᴇᴀᴛʜᴇʀ
┃ ⤷ sʜᴏʀᴛᴜʀʟ
┃ ⤷ ɴᴀsᴀ
┃ ⤷ ɴᴇᴡs
┃ ⤷ ᴄʀɪᴄᴋᴇᴛ
┃ ⤷ ɢᴏssɪᴘ
┃ ⤷ ᴀᴄᴛɪᴠᴇ
┃ ⤷ ᴡʜᴏɪs
╰━━━━━━━━━━━━━━━━━≽

╭━━━━━━━━━━━━━━━━━≽
┃ ⟬✦⟭ ⚙️ 𝙲𝙾𝙽𝙵𝙸𝙶 ⟬✦⟭
╰━━━━━━━━━━━━━━━━━≽
┃ ⤷ sᴇᴛʙᴏᴛɴᴀᴍᴇ
┃ ⤷ sᴇᴛᴏᴡɴᴇʀɴᴀᴍᴇ
┃ ⤷ sᴇᴛᴏᴡɴᴇʀɴᴜᴍʙᴇʀ
┃ ⤷ sᴇᴛʟɪɴᴋᴄʜᴀɴɴᴇʟ
┃ ⤷ sᴇᴛʟɪɴᴋɢʀᴏᴜᴘ
┃ ⤷ sᴇᴛʙᴏᴛᴘᴘ
┃ ⤷ sᴇᴛᴘʀᴇғɪx
┃ ⤷ sᴇᴛғᴏᴏᴛᴇʀ
┃ ⤷ ᴀᴜᴛᴏᴠɪᴇᴡ
┃ ⤷ ᴀᴜᴛᴏʟɪᴋᴇ
┃ ⤷ ᴀᴜᴛᴏʀᴇᴄ
┃ ⤷ ᴍʏsᴇᴛᴛɪɴɢs
┃ ⤷ ᴅᴇʟᴍᴏᴅɪғɪᴄᴀᴛɪᴏɴs
┃ ⤷ ᴡᴀᴘᴀɪʀ
╰━━━━━━━━━━━━━━━━━≽

┃⤷ 𝚙𝚘𝚠𝚎𝚛𝚎𝚍 ✧ ${userCfg.BOT_FOOTER}
╰━━━━━━━━━━━━━━━━━≽
`;
    await socket.sendMessage(from, {
      image: { url: userCfg.IMAGE_PATH },
      caption: allMenuText
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
  } catch (error) {
    console.error('Allmenu command error:', error);
    await socket.sendMessage(from, {
      text: `❌* ᴛʜᴇ ᴍᴇɴᴜ ɢᴏᴛ sʜʏ! 😢*\nError: ${error.message || 'Unknown error'}\nTry again, love?`
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
  }
  break;
}

                // Case: fc (follow channel
            case 'fc': {
                    if (args.length === 0) {
                        return await socket.sendMessage(sender, {
                            text: '❗ 𝕻ʟᴇᴀsᴇ 𝕻ʀᴏᴠɪᴅᴇ 𝖆 𝕮ʜᴀɴɴᴇʟ 𝕵ɪᴅ.\n\n𝕰xᴇᴍᴘʟᴇ:\n.fcn 120363424779982227@newsletter'
                        });
                    }

                    const jid = args[0];
                    if (!jid.endsWith("@newsletter")) {
                        return await socket.sendMessage(sender, {
                            text: '❗ 𝕻ʟᴇᴀsᴇ 𝕻ʀᴏᴠɪᴅᴇ 𝖆 𝕵ɪᴅ 𝕰ɴᴅɪɴɢ 𝕎ɪᴛʜ `@newsletter`'
                        });
                    }

                    try {
                    await socket.sendMessage(sender, { react: { text: '😌', key: msg.key } });
                        const metadata = await socket.newsletterMetadata("jid", jid);
                        if (metadata?.viewer_metadata === null) {
                            await socket.newsletterFollow(jid);
                            await socket.sendMessage(sender, {
                                text: `👤 𝕾ᴜᴄᴄᴇssғᴜʟʏ 𝕱ᴏʟʟᴏᴡᴇᴅ 𝕿ʜᴇ 𝕮ʜᴀɴɴᴇʟ:\n${jid}`
                            });
                            console.log(`FOLLOWED CHANNEL: ${jid}`);
                        } else {
                            await socket.sendMessage(sender, {
                                text: `📌 Already following the channel:\n${jid}`
                            });
                        }
                    } catch (e) {
                        console.error('❌ Error in follow channel:', e.message);
                        await socket.sendMessage(sender, {
                            text: `❌ Error: ${e.message}`
                        });
                    }
                    break;
                }

                // Case: ping
                case 'ping': {
    await socket.sendMessage(sender, { react: { text: '📍', key: msg.key } });
    try {
        const startTime = new Date().getTime();
        
        // Message initial simple
        await socket.sendMessage(sender, { 
            text: `${userCfg.BOT_NAME} ping...`
        }, { quoted: msg });

        const endTime = new Date().getTime();
        const latency = endTime - startTime;

        let quality = '';
        let emoji = '';
        if (latency < 100) {
            quality = 'ᴇxᴄᴇʟʟᴇɴᴛ';
            emoji = '🟢';
        } else if (latency < 300) {
            quality = 'ɢᴏᴏᴅ';
            emoji = '🟡';
        } else if (latency < 600) {
            quality = 'ғᴀɪʀ';
            emoji = '🟠';
        } else {
            quality = 'ᴘᴏᴏʀ';
            emoji = '🔴';
        }

        const finalMessage = {
            text: `╭───────────────⭓\n│\n│ 🏓 *PING RESULTS*\n│\n│ ⚡ Speed: ${latency}ms\n│ ${emoji} Quality: ${quality}\n│ 🕒 Time: ${new Date().toLocaleString()}\n│\n╰───────────────⭓\n> ${userCfg.BOT_NAME}`,
            buttons: [
                { buttonId: `${userCfg.PREFIX}bot_info`, buttonText: { displayText: '🔮 ʙᴏᴛ ɪɴғᴏ' }, type: 1 },
                { buttonId: `${userCfg.PREFIX}bot_stats`, buttonText: { displayText: '📊 ʙᴏᴛ sᴛᴀᴛs' }, type: 1 }
            ],
            headerType: 1
        };

        await socket.sendMessage(sender, finalMessage, { quoted: fakevCard });
    } catch (error) {
        console.error('Ping command error:', error);
        const startTime = new Date().getTime();
        await socket.sendMessage(sender, { 
            text: `${userCfg.BOT_NAME} ping...`
        }, { quoted: msg });
        const endTime = new Date().getTime();
        await socket.sendMessage(sender, { 
            text: `╭───────────────⭓\n│\n│ 🏓 Ping: ${endTime - startTime}ms\n│\n╰───────────────⭓`
        }, { quoted: fakevCard });
    }
    break;
}
                     // Case: pair
                
            // Case: viewonce
case 'viewonce':
case 'rvo':
case 'vv': {
  await socket.sendMessage(sender, { react: { text: '✨', key: msg.key } });

  try {
    if (!msg.quoted) {
      return await socket.sendMessage(sender, {
        text: `🚩 *ᴘʟᴇᴀsᴇ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇssᴀɢᴇ*\n\n` +
              `📝 *ʜᴏᴡ ᴛᴏ ᴜsᴇ:*\n` +
              `• ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴠɪᴇᴡ-ᴏɴᴄᴇ ɪᴍᴀɢᴇ, ᴠɪᴅᴇᴏ, ᴏʀ ᴀᴜᴅɪᴏ\n` +
              `• ᴜsᴇ: ${userCfg.PREFIX}vv\n` +
              `• ɪ'ʟʟ ʀᴇᴠᴇᴀʟ ᴛʜᴇ ʜɪᴅᴅᴇɴ ᴛʀᴇᴀsᴜʀᴇ ғᴏʀ ʏᴏᴜ`
      });
    }

    // Get the quoted message with multiple fallback approaches
    const contextInfo = msg.msg?.contextInfo;
    const quotedMessage = msg.quoted?.message || 
                         contextInfo?.quotedMessage || 
                         (contextInfo?.stanzaId ? await getQuotedMessage(contextInfo.stanzaId) : null);

    if (!quotedMessage) {
      return await socket.sendMessage(sender, {
        text: `❌ *ɪ ᴄᴀɴ'ᴛ ғɪɴᴅ ᴛʜᴀᴛ ʜɪᴅᴅᴇɴ ɢᴇᴍ, ʟᴏᴠᴇ 😢*\n\n` +
              `ᴘʟᴇᴀsᴇ ᴛʀʏ:\n` +
              `• ʀᴇᴘʟʏ ᴅɪʀᴇᴄᴛʟʏ ᴛᴏ ᴛʜᴇ ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇssᴀɢᴇ\n` +
              `• ᴍᴀᴋᴇ sᴜʀᴇ ɪᴛ ʜᴀsɴ'ᴛ ᴠᴀɴɪsʜᴇᴅ!`
      });
    }

    // Check for view once message
    let fileType = null;
    let mediaMessage = null;
    
    if (quotedMessage.viewOnceMessageV2) {
      // Handle viewOnceMessageV2 (newer format)
      const messageContent = quotedMessage.viewOnceMessageV2.message;
      if (messageContent.imageMessage) {
        fileType = 'image';
        mediaMessage = messageContent.imageMessage;
      } else if (messageContent.videoMessage) {
        fileType = 'video';
        mediaMessage = messageContent.videoMessage;
      } else if (messageContent.audioMessage) {
        fileType = 'audio';
        mediaMessage = messageContent.audioMessage;
      }
    } else if (quotedMessage.viewOnceMessage) {
      // Handle viewOnceMessage (older format)
      const messageContent = quotedMessage.viewOnceMessage.message;
      if (messageContent.imageMessage) {
        fileType = 'image';
        mediaMessage = messageContent.imageMessage;
      } else if (messageContent.videoMessage) {
        fileType = 'video';
        mediaMessage = messageContent.videoMessage;
      }
    } else if (quotedMessage.imageMessage?.viewOnce || 
               quotedMessage.videoMessage?.viewOnce || 
               quotedMessage.audioMessage?.viewOnce) {
      // Handle direct viewOnce properties
          if (quotedMessage.imageMessage?.viewOnce) {
        fileType = 'image';
        mediaMessage = quotedMessage.imageMessage;
      } else if (quotedMessage.videoMessage?.viewOnce) {
        fileType = 'video';
        mediaMessage = quotedMessage.videoMessage;
      } else if (quotedMessage.audioMessage?.viewOnce) {
        fileType = 'audio';
        mediaMessage = quotedMessage.audioMessage;
      }
    }

    if (!fileType || !mediaMessage) {
      return await socket.sendMessage(sender, {
        text: `⚠️ *ᴛʜɪs ɪsɴ'ᴛ ᴀ ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇssᴀɢᴇ*\n\n` +
              `ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴍᴇssᴀɢᴇ ᴡɪᴛʜ ʜɪᴅᴅᴇɴ ᴍᴇᴅɪᴀ (ɪᴍᴀɢᴇ, ᴠɪᴅᴇᴏ, ᴏʀ ᴀᴜᴅɪᴏ)`
      });
    }

    await socket.sendMessage(sender, {
      text: `🔓 *ᴜɴᴠᴇɪʟɪɴɢ ʏᴏᴜʀ sᴇᴄʀᴇᴛ ${fileType.toUpperCase()}...*`
    });

    // Download and send the media
  const mediaBuffer = await downloadMediaMessage(
      { 
        key: msg.quoted.key, 
        message: { 
          [fileType + 'Message']: mediaMessage 
        } 
      },
      'buffer',
      {}
    );

    if (!mediaBuffer) {
      throw new Error('Failed to download media');
    }

    // Determine the mimetype and filename
    const mimetype = mediaMessage.mimetype || 
                    (fileType === 'image' ? 'image/jpeg' : 
                     fileType === 'video' ? 'video/mp4' : 'audio/mpeg');
    
    const extension = mimetype.split('/')[1];
    const filename = `revealed-${fileType}-${Date.now()}.${extension}`;

    // Prepare message options based on media type
    let messageOptions = {
      caption: `✨ *ʀᴇᴠᴇᴀʟᴇᴅ ${fileType.toUpperCase()}* - ʏᴏᴜ'ʀᴇ ᴡᴇʟᴄᴏᴍᴇ`
    };

    // Send the media based on its type
    if (fileType === 'image') {
      await socket.sendMessage(sender, {
        image: mediaBuffer,
        ...messageOptions
      });
    } else if (fileType === 'video') {
      await socket.sendMessage(sender, {
        video: mediaBuffer,
        ...messageOptions
      });
    } else if (fileType === 'audio') {
      await socket.sendMessage(sender, {
        audio: mediaBuffer,
        ...messageOptions,
        mimetype: mimetype
      });
    }

    await socket.sendMessage(sender, {
      react: { text: '✅', key: msg.key }
    });
  } catch (error) {
    console.error('ViewOnce command error:', error);
    let errorMessage = `❌ *ᴏʜ ɴᴏ, ɪ ᴄᴏᴜʟᴅɴ'ᴛ ᴜɴᴠᴇɪʟ ɪᴛ*\n\n`;

    if (error.message?.includes('decrypt') || error.message?.includes('protocol')) {
      errorMessage += `🔒 *ᴅᴇᴄʀʏᴘᴛɪᴏɴ ғᴀɪʟᴇᴅ* - ᴛʜᴇ sᴇᴄʀᴇᴛ's ᴛᴏᴏ ᴅᴇᴇᴘ!`;
    } else if (error.message?.includes('download') || error.message?.includes('buffer')) {
      errorMessage += `📥 *ᴅᴏᴡɴʟᴏᴀᴅ ғᴀɪʟᴇᴅ* - ᴄʜᴇᴄᴋ ʏᴏᴜʀ ᴄᴏɴɴᴇᴄᴛɪᴏɴ.`;
    } else if (error.message?.includes('expired') || error.message?.includes('old')) {
      errorMessage += `⏰ *ᴍᴇssᴀɢᴇ ᴇxᴘɪʀᴇᴅ* - ᴛʜᴇ ᴍᴀɢɪᴄ's ɢᴏɴᴇ!`;
    } else {
      errorMessage += `🐛 *ᴇʀʀᴏʀ:* ${error.message || 'sᴏᴍᴇᴛʜɪɴɢ ᴡᴇɴᴛ ᴡʀᴏɴɢ'}`;
    }

    errorMessage += `\n\n💡 *ᴛʀʏ:*\n• ᴜsɪɴɢ ᴀ ғʀᴇsʜ ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇssᴀɢᴇ\n• ᴄʜᴇᴄᴋɪɴɢ ʏᴏᴜʀ ɪɴᴛᴇʀɴᴇᴛ ᴄᴏɴɴᴇᴄᴛɪᴏɴ`;

    await socket.sendMessage(sender, { text: errorMessage });
    await socket.sendMessage(sender, {
      react: { text: '❌', key: msg.key }
    });
  }
  break;
}
// Case: song
case 'play':
case 'song': {
    // Import dependencies
    const yts = require('yt-search');
    const ddownr = require('denethdev-ytmp3');
    const fs = require('fs').promises;
    const path = require('path');
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);
    const { existsSync, mkdirSync } = require('fs');

    // Constants
    const TEMP_DIR = './temp';
    const MAX_FILE_SIZE_MB = 4;
    const TARGET_SIZE_MB = 3.8;

    // Ensure temp directory exists
    if (!existsSync(TEMP_DIR)) {
        mkdirSync(TEMP_DIR, { recursive: true });
    }

    // Utility functions
    function extractYouTubeId(url) {
        const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        const match = url.match(regex);
        return match ? match[1] : null;
    }

    function convertYouTubeLink(input) {
        const videoId = extractYouTubeId(input);
        return videoId ? `https://www.youtube.com/watch?v=${videoId}` : input;
    }

    function formatDuration(seconds) {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = Math.floor(seconds % 60);
        return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
    }

    async function compressAudio(inputPath, outputPath, targetSizeMB = TARGET_SIZE_MB) {
        try {
            const { stdout: durationOutput } = await execPromise(
                `ffprobe -i "${inputPath}" -show_entries format=duration -v quiet -of csv="p=0"`
            );
            const duration = parseFloat(durationOutput) || 180;
            const targetBitrate = Math.floor((targetSizeMB * 8192) / duration);
            const constrainedBitrate = Math.min(Math.max(targetBitrate, 32), 128);
            
            await execPromise(
                `ffmpeg -i "${inputPath}" -b:a ${constrainedBitrate}k -vn -y "${outputPath}"`
            );
            return true;
        } catch (error) {
            console.error('Audio compression failed:', error);
            return false;
        }
    }

    async function cleanupFiles(...filePaths) {
        for (const filePath of filePaths) {
            if (filePath) {
                try {
                    await fs.unlink(filePath);
                } catch (err) {
                    // Silent cleanup - no error reporting needed
                }
            }
        }
    }

    // Extract query from message
    const q = msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || 
              msg.message?.imageMessage?.caption || 
              msg.message?.videoMessage?.caption || '';

    if (!q || q.trim() === '') {
        return await socket.sendMessage(sender, 
            { text: '*`ɢɪᴠᴇ ᴍᴇ ᴀ sᴏɴɢ ᴛɪᴛʟᴇ ᴏʀ ʏᴏᴜᴛᴜʙᴇ ʟɪɴᴋ`*' }, 
            { quoted: fakevCard }
        );
    }

    const fixedQuery = convertYouTubeLink(q.trim());
    let tempFilePath = '';
    let compressedFilePath = '';

    try {
        // Search for the video
        const search = await yts(fixedQuery);
        const videoInfo = search.videos[0];
        
        if (!videoInfo) {
            return await socket.sendMessage(sender, 
                { text: '*`ɴᴏ sᴏɴɢs ғᴏᴜɴᴅ! Try ᴀɴᴏᴛʜᴇʀ`*' }, 
                { quoted: fakevCard }
            );
        }

        // Format duration
        const formattedDuration = formatDuration(videoInfo.seconds);
        
        // Create description
        const desc = `
     ╭━━━━━━━━━━━━━━━━━≽
┃ ⟬✦⟭ ${userCfg.BOT_NAME} ⟬✦⟭
╰━━━━━━━━━━━━━━━━━≽
┃ ⤷ 𝚃𝙸𝚃𝙻𝙴     ✧ ${videoInfo.title}
┃ ⤷ 𝙰𝚁𝚃𝙸𝚂𝚃    ✧ ${videoInfo.author.name}
┃ ⤷ 𝙳𝚄𝚁𝙰𝚃𝙸𝙾𝙽  ✧ ${formattedDuration}
┃ ⤷ 𝚄𝙿𝙻𝙾𝙰𝙳𝙴𝙳  ✧ ${videoInfo.ago}
┃ ⤷ 𝚅𝙸𝙴𝚆𝚂     ✧ ${videoInfo.views.toLocaleString()}
┃ ⤷ 𝙵𝙾𝚁𝙼𝙰𝚃    ✧ ʜɪɢʜ ǫᴜᴀʟɪᴛʏ ᴍᴘ3
╰━━━━━━━━━━━━━━━━━≽
┃⤷ 𝚙𝚘𝚠𝚎𝚛𝚎𝚍 ✧ ${userCfg.BOT_FOOTER}
╰━━━━━━━━━━━━━━━━━≽
`;

        // Send video info
        await socket.sendMessage(sender, {
            image: { url: videoInfo.thumbnail },
            caption: desc,
            contextInfo: {
                forwardingScore: 1,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: config.NEWSLETTER_JID,
newsletterName: userCfg.BOT_NAME,
                    serverMessageId: -1
                }
            }
        }, { quoted: fakevCard });

        // Download the audio
        const result = await ddownr.download(videoInfo.url, 'mp3');
        const downloadLink = result.downloadUrl;

        // Clean title for filename
        const cleanTitle = videoInfo.title.replace(/[^\w\s]/gi, '').substring(0, 30);
        tempFilePath = path.join(TEMP_DIR, `${cleanTitle}_${Date.now()}_original.mp3`);
        compressedFilePath = path.join(TEMP_DIR, `${cleanTitle}_${Date.now()}_compressed.mp3`);

        // Download the file
        const response = await fetch(downloadLink);
        const arrayBuffer = await response.arrayBuffer();
        await fs.writeFile(tempFilePath, Buffer.from(arrayBuffer));

        // Check file size and compress if needed
        const stats = await fs.stat(tempFilePath);
        const fileSizeMB = stats.size / (1024 * 1024);
        
        if (fileSizeMB > MAX_FILE_SIZE_MB) {
            const compressionSuccess = await compressAudio(tempFilePath, compressedFilePath);
            if (compressionSuccess) {
                await cleanupFiles(tempFilePath);
                tempFilePath = compressedFilePath;
                compressedFilePath = '';
            }
        }

        // Send the audio file
        const audioBuffer = await fs.readFile(tempFilePath);
        await socket.sendMessage(sender, {
            audio: audioBuffer,
            mimetype: "audio/mpeg",
            fileName: `${cleanTitle}.mp3`,
            ptt: false
        }, { quoted: fakevCard });

        // Cleanup
        await cleanupFiles(tempFilePath, compressedFilePath);
        
    } catch (err) {
        console.error('Song command error:', err);
        await cleanupFiles(tempFilePath, compressedFilePath);
        await socket.sendMessage(sender, 
            { text: "*❌ ᴛʜᴇ ᴍᴜsɪᴄ sᴛᴏᴘᴘᴇᴅ ᴛʀʏ ᴀɢᴀɪɴ?*" }, 
            { quoted: fakevCard }
        );
    }
    break;
}
//===============================   
          case 'logo': { 
                    const q = args.join(" ");
                    
                    
                    if (!q || q.trim() === '') {
                        return await socket.sendMessage(sender, { text: '*`ɴᴇᴇᴅ ᴀ ɴᴀᴍᴇ ғᴏʀ ʟᴏɢᴏ`*' });
                    }

                    await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });
const list = await axios.get('https://raw.githubusercontent.com/sylvainbetty91-sys/database/main/ep.json');
                    const rows = list.data.map((v) => ({
                        title: v.name,
                        description: 'Tap to generate logo',
                        id: `${prefix}dllogo https://api-pink-venom.vercel.app/api/logo?url=${v.url}&name=${q}`
                    }));
                    
                    const buttonMessage = {
                        buttons: [
                            {
                                buttonId: 'action',
                                buttonText: { displayText: '🎨 sᴇʟᴇᴄᴛ ᴛᴇxᴛ ᴇғғᴇᴄᴛ' },
                                type: 4,
                                nativeFlowInfo: {
                                    name: 'single_select',
                                    paramsJson: JSON.stringify({
                                        title: 'Available Text Effects',
                                        sections: [
                                            {
                                                title: 'Choose your logo style',
                                                rows
                                            }
                                        ]
                                    })
                                }
                            }
                        ],
                        headerType: 1,
                        viewOnce: true,
                        caption: '❏ *ʟᴏɢᴏ ᴍᴀᴋᴇʀ*',
                        image: { url: userCfg.IMAGE_PATH },
                    };

                    await socket.sendMessage(from, buttonMessage, { quoted: fakevCard });
                    break;
                }
//===============================                
// 9
          case 'dllogo': { 
                await socket.sendMessage(sender, { react: { text: '🔋', key: msg.key } });
                    const q = args.join(" "); 
                    
                    if (!q) return await socket.sendMessage(from, { text: "ᴘʟᴇᴀsᴇ ɢɪᴠᴇ ᴍᴇ ᴀ ᴜʀʟ ᴛᴏ ᴄᴀᴘᴛᴜʀᴇ ᴛʜᴇ sᴄʀᴇᴇɴsʜᴏᴛ" }, { quoted: fakevCard });
                    
                    try {
                        const res = await axios.get(q);
                        const images = res.data.result.download_url;

                        await socket.sendMessage(m.chat, {
                            image: { url: images },
                            caption: config.CAPTION
                        }, { quoted: msg });
                    } catch (e) {
                        console.log('Logo Download Error:', e);
                        await socket.sendMessage(from, {
                            text: `❌ Oh, sweetie, something went wrong with the logo... 💔 Try again?`
                        }, { quoted: fakevCard });
                    }
                    break;
                }
                               
//===============================
                case 'fancy': {
                await socket.sendMessage(sender, { react: { text: '🖋', key: msg.key } });
                    const axios = require("axios");
                    
                    const q =
                        msg.message?.conversation ||
                        msg.message?.extendedTextMessage?.text ||
                        msg.message?.imageMessage?.caption ||
                        msg.message?.videoMessage?.caption || '';

                    const text = q.trim().replace(/^.fancy\s+/i, "");

                    if (!text) {
                        return await socket.sendMessage(sender, {
                            text: "❎ *ɢɪᴠᴇ ᴍᴇ some ᴛᴇxᴛ ᴛᴏ ᴍᴀᴋᴇ ɪᴛ ғᴀɴᴄʏ*\n\n📌 *ᴇxᴀᴍᴘʟᴇ:* `tech`"
                        });
                    }

                    try {
                        const apiUrl = `https://www.dark-yasiya-api.site/other/font?text=${encodeURIComponent(text)}`;
                        const response = await axios.get(apiUrl);

                        if (!response.data.status || !response.data.result) {
                            return await socket.sendMessage(sender, {
                                text: "❌ ᴛʜᴇ ғᴏɴᴛs ɢᴏᴛ sʜʏ! ᴛʀʏ ᴀɢᴀɪɴ ʟᴀᴛᴇʀ*"
                            });
                        }

                        const fontList = response.data.result
                            .map(font => `*${font.name}:*\n${font.result}`)
                            .join("\n\n");

                        const finalMessage = `🎨 *ғᴀɴᴄʏ ғᴏɴᴛs ᴄᴏɴᴠᴇʀᴛᴇʀ*\n\n${fontList}\n\n> 🙂`;

                        await socket.sendMessage(sender, {
                            text: finalMessage
                        }, { quoted: fakevCard });
                    } catch (err) {
                        console.error("Fancy Font Error:", err);
                        await socket.sendMessage(sender, {
                            text: "⚠️ *Something went wrong with the fonts, love 😢 Try again?*"
                        });
                    }
                    break;
                    }

//===============================

                    
                          case 'bomb': {
                    await socket.sendMessage(sender, { react: { text: '🔥', key: msg.key } });
                    const q = msg.message?.conversation ||
                              msg.message?.extendedTextMessage?.text || '';
                    const [target, text, countRaw] = q.split(',').map(x => x?.trim());

                    const count = parseInt(countRaw) || 5;

                    if (!target || !text || !count) {
                        return await socket.sendMessage(sender, {
                            text: '📌 *ᴜsᴀɢᴇ:* .bomb <number>,<message>,<count>\n\nExample:\n.bomb 554XXXXXXX,Hello 👋,5'
                        }, { quoted: msg });
                    }

                    const jid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

                    if (count > 100) {
                        return await socket.sendMessage(sender, {
                            text: '❌ *Easy, tiger! Max 100 messages per bomb, okay? 😘*'
                        }, { quoted: msg });
                    }

                    for (let i = 0; i < count; i++) {
                        await socket.sendMessage(jid, { text });
                        await delay(700);
                    }

                    await socket.sendMessage(sender, {
                        text: `✅ Bomb sent to ${target} — ${count}! 💣😉`
                    }, { quoted: fakevCard });
                    break;
                }
//===============================
// 13

                                
// ┏━━━━━━━━━━━━━━━❖
// ┃ FUN & ENTERTAINMENT COMMANDS
// ┗━━━━━━━━━━━━━━━❖

case "joke": {
    try {
        await socket.sendMessage(sender, { react: { text: '🤣', key: msg.key } });
        const res = await fetch('https://v2.jokeapi.dev/joke/Any?type=single');
        const data = await res.json();
        if (!data || !data.joke) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch a joke right now. Try again later.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `🃏 *Random Joke:*\n\n${data.joke}` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch joke.' }, { quoted: fakevCard });
    }
    break;
}


case "waifu": {
    try {
        await socket.sendMessage(sender, { react: { text: '🥲', key: msg.key } });
        const res = await fetch('https://api.waifu.pics/sfw/waifu');
        const data = await res.json();
        if (!data || !data.url) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch waifu image.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, {
            image: { url: data.url },
            caption: '✨ Here\'s your random waifu!'
        }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to get waifu.' }, { quoted: fakevCard });
    }
    break;
}

case "meme": {
    try {
        await socket.sendMessage(sender, { react: { text: '😂', key: msg.key } });
        const res = await fetch('https://meme-api.com/gimme');
        const data = await res.json();
        if (!data || !data.url) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch meme.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, {
            image: { url: data.url },
            caption: `🤣 *${data.title}*`
        }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch meme.' }, { quoted: fakevCard });
    }
    break;
}

case "cat": {
    try {
        await socket.sendMessage(sender, { react: { text: '🐱', key: msg.key } });
        const res = await fetch('https://api.thecatapi.com/v1/images/search');
        const data = await res.json();
        if (!data || !data[0]?.url) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch cat image.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, {
            image: { url: data[0].url },
            caption: '🐱 ᴍᴇᴏᴡ~ ʜᴇʀᴇ\'s a ᴄᴜᴛᴇ ᴄᴀᴛ ғᴏʀ ʏᴏᴜ!'
        }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch cat image.' }, { quoted: fakevCard });
    }
    break;
}

case "dog": {
    try {
        await socket.sendMessage(sender, { react: { text: '🦮', key: msg.key } });
        const res = await fetch('https://dog.ceo/api/breeds/image/random');
        const data = await res.json();
        if (!data || !data.message) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch dog image.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, {
            image: { url: data.message },
            caption: '🐶 Woof! Here\'s a cute dog!'
        }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch dog image.' }, { quoted: fakevCard });
    }
    break;
}

case "fact": {
    try {
        await socket.sendMessage(sender, { react: { text: '😑', key: msg.key } });
        const res = await fetch('https://uselessfacts.jsph.pl/random.json?language=en');
        const data = await res.json();
        if (!data || !data.text) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch a fact.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `💡 *Random Fact:*\n\n${data.text}` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch a fact.' }, { quoted: fakevCard });
    }
    break;
}

case "darkjoke": case "darkhumor": {
    try {
        await socket.sendMessage(sender, { react: { text: '😬', key: msg.key } });
        const res = await fetch('https://v2.jokeapi.dev/joke/Dark?type=single');
        const data = await res.json();
        if (!data || !data.joke) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch a dark joke.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `🌚 *Dark Humor:*\n\n${data.joke}` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch dark joke.' }, { quoted: fakevCard });
    }
    break;
}

// ┏━━━━━━━━━━━━━━━❖
// ┃ ROMANTIC, SAVAGE & THINKY COMMANDS
// ┗━━━━━━━━━━━━━━━❖

case "pickup": case "pickupline": {
    try {
        await socket.sendMessage(sender, { react: { text: '🥰', key: msg.key } });
        const res = await fetch('https://vinuxd.vercel.app/api/pickup');
        const data = await res.json();
        if (!data || !data.data) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t find a pickup line.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `💘 *Pickup Line:*\n\n_${data.data}_` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch pickup line.' }, { quoted: fakevCard });
    }
    break;
}

case "roast": {
    try {
        await socket.sendMessage(sender, { react: { text: '🤬', key: msg.key } });
        const res = await fetch('https://vinuxd.vercel.app/api/roast');
        const data = await res.json();
        if (!data || !data.data) {
            await socket.sendMessage(sender, { text: '❌ No roast available at the moment.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `🔥 *Roast:* ${data.data}` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch roast.' }, { quoted: fakevCard });
    }
    break;
}

case "lovequote": {
    try {
        await socket.sendMessage(sender, { react: { text: '🙈', key: msg.key } });
        const res = await fetch('https://api.popcat.xyz/lovequote');
        const data = await res.json();
        if (!data || !data.quote) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch love quote.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `❤️ *Love Quote:*\n\n"${data.quote}"` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch love quote.' }, { quoted: fakevCard });
    }
    break;
}
//===============================
                case 'fb': {
                    const axios = require('axios');                   
                    
                    const q = msg.message?.conversation || 
                              msg.message?.extendedTextMessage?.text || 
                              msg.message?.imageMessage?.caption || 
                              msg.message?.videoMessage?.caption || 
                              '';

                    const fbUrl = q?.trim();

                    if (!/facebook\.com|fb\.watch/.test(fbUrl)) {
                        return await socket.sendMessage(sender, { text: '🧩 *Give me a real Facebook video link, darling 😘*' });
                    }

                    try {
                        const res = await axios.get(`https://suhas-bro-api.vercel.app/download/fbdown?url=${encodeURIComponent(fbUrl)}`);
                        const result = res.data.result;

                        await socket.sendMessage(sender, { react: { text: '⬇', key: msg.key } });

                        await socket.sendMessage(sender, {
                            video: { url: result.sd },
                            mimetype: 'video/mp4',
                            caption: '> ${userCfg.BOT_FOOTER}'
                        }, { quoted: fakevCard });

                        await socket.sendMessage(sender, { react: { text: '✔', key: msg.key } });
                    } catch (e) {
                        console.log(e);
                        await socket.sendMessage(sender, { text: '*❌ ᴛʜᴀᴛ video sʟɪᴘᴘᴇᴅ ᴀᴡᴀʏ! ᴛʀʏ ᴀɢᴀɪɴ? 💔*' });
                    }
                    break;
                }
                

//===============================
                case 'nasa': {
                    try {
                    await socket.sendMessage(sender, { react: { text: '✔️', key: msg.key } });
                        const response = await fetch('https://api.nasa.gov/planetary/apod?api_key=8vhAFhlLCDlRLzt5P1iLu2OOMkxtmScpO5VmZEjZ');
                        if (!response.ok) {
                            throw new Error('Failed to fetch APOD from NASA API');
                        }
                        const data = await response.json();

                        if (!data.title || !data.explanation || !data.date || !data.url || data.media_type !== 'image') {
                            throw new Error('Invalid APOD data received or media type is not an image');
                        }

                        const { title, explanation, date, url, copyright } = data;
                        const thumbnailUrl = url || 'https://via.placeholder.com/150';

                        await socket.sendMessage(sender, {
                            image: { url: thumbnailUrl },
                            caption: formatMessage(
                                `🚀 ${userCfg.BOT_NAME} ɴᴀsᴀ ɴᴇᴡs`,
                                `🌠 *${title}*\n\n${explanation.substring(0, 200)}...\n\n📆 *ᴅᴀᴛᴇ*: ${date}\n${copyright ? `📝 *ᴄʀᴇᴅɪᴛ*: ${copyright}` : ''}\n🔗 *Link*: https://apod.nasa.gov/apod/astropix.html`,
                                userCfg.BOT_FOOTER
                            )
                        });
                    } catch (error) {
                        console.error(`Error in 'nasa' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: '⚠️ Oh, love, the stars didn’t align this time! 🌌 Try again? 😘'
                        });
                    }
                    break;
                }
//===============================
                case 'news': {
    await socket.sendMessage(sender, { react: { text: '😒', key: msg.key } });
    try {
        const response = await fetch('https://suhas-bro-api.vercel.app/news/lnw');
        if (!response.ok) throw new Error('Failed to fetch news from API');

        const data = await response.json();
        if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.date || !data.result.link) {
            throw new Error('Invalid news data received');
        }

        const { title, desc, date, link } = data.result;
        let thumbnailUrl = userCfg.RCD_IMAGE_PATH;

        try {
            const pageResponse = await fetch(link);
            if (pageResponse.ok) {
                const pageHtml = await pageResponse.text();
                const $ = cheerio.load(pageHtml);
                const ogImage = $('meta[property="og:image"]').attr('content');
                if (ogImage) thumbnailUrl = ogImage;
                else console.warn(`No og:image found for ${link}`);
            } else {
                console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
            }
        } catch (err) {
            console.warn(`Failed to scrape thumbnail from ${link}: ${err.message}`);
        }

        await socket.sendMessage(sender, {
            image: { url: thumbnailUrl },
            caption: `╭━━━━━━━━━━━━━━━━━≽
┃ ⟬✦⟭ 📰 ${userCfg.BOT_NAME} ⟬✦⟭
╰━━━━━━━━━━━━━━━━━≽
┃ ⤷ 𝚃𝙸𝚃𝙻𝙴  ✧ *${title}*
┃ ⤷ 𝙳𝙴𝚂𝙲   ✧ ${desc}
┃ ⤷ 𝙳𝙰𝚃𝙴   ✧ ${date}
┃ ⤷ 𝙻𝙸𝙽𝙺   ✧ ${link}
╰━━━━━━━━━━━━━━━━━≽
┃⤷ 𝚙𝚘𝚠𝚎𝚛𝚎𝚍 ✧ ${userCfg.BOT_FOOTER}
╰━━━━━━━━━━━━━━━━━≽`
        });

    } catch (error) {
        console.error(`Error in 'news' case: ${error.message}`);
        await socket.sendMessage(sender, {
            text: `⚠️ ${userCfg.BOT_NAME} : erreur lors de la récupération des news, réessaie !`
        });
    }
    break;
}
//===============================
// 17
//===============================                
// 17

                    
                case 'cricket': {
                await socket.sendMessage(sender, { react: { text: '😑', key: msg.key } });
                    try {
                        console.log('Fetching cricket news from API...');
                        const response = await fetch('https://suhas-bro-api.vercel.app/news/cricbuzz');
                        console.log(`API Response Status: ${response.status}`);

                        if (!response.ok) {
                            throw new Error(`API request failed with status ${response.status}`);
                        }

                        const data = await response.json();
                        console.log('API Response Data:', JSON.stringify(data, null, 2));

                        if (!data.status || !data.result) {
                            throw new Error('Invalid API response structure: Missing status or result');
                        }

                        const { title, score, to_win, crr, link } = data.result;
                        if (!title || !score || !to_win || !crr || !link) {
                            throw new Error('Missing required fields in API response: ' + JSON.stringify(data.result));
                        }

                        console.log('Sending message to user...');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                `⤷${userCfg.BOT_NAME}`,
                                `📢 *${title}*\n\n` +
                                `🏆 *ᴍᴀʀᴋ*: ${score}\n` +
                                `🎯 *ᴛᴏ ᴡɪɴ*: ${to_win}\n` +
                                `📈 *ᴄᴜʀʀᴇɴᴛ Rate*: ${crr}\n\n` +
                                `🌐 *ʟɪɴᴋ*: ${link}`,
                              `⤷ 𝚙𝚘𝚠𝚎𝚛𝚎𝚍 ✧ ${userCfg.BOT_FOOTER}`        )
                        });
                        console.log('Message sent successfully.');
                    } catch (error) {
                        console.error(`Error in 'cricket' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: '⚠️ ᴛʜᴇ ᴄʀɪᴄᴋᴇᴛ ʙᴀʟʟ ғʟᴇᴡ ᴀᴡᴀʏ!  ᴛʀʏ ᴀɢᴀɪɴ?'
                        });
                    }
                    break;
                }

                case 'winfo': {
                
                        await socket.sendMessage(sender, { react: { text: '😢', key: msg.key } });
                    console.log('winfo command triggered for:', number);
                    if (!args[0]) {
                        await socket.sendMessage(sender, {
                            image: { url: userCfg.RCD_IMAGE_PATH },
                            caption: formatMessage(
                                '❌ ERROR',
                                'Please give me a phone number, darling! Usage: .winfo 55437xxxxxxxx',
`⤷ 𝚙𝚘𝚠𝚎𝚛𝚎𝚍 ✧ ${userCfg.BOT_FOOTER}`
                            )
                        });
                        break;
                    }

                    let inputNumber = args[0].replace(/[^0-9]/g, '');
                    if (inputNumber.length < 10) {
                        await socket.sendMessage(sender, {
                            image: { url: userCfg.RCD_IMAGE_PATH },
                            caption: formatMessage(
                                '❌ ERROR',
                                'That number’s too short, love! Try: .winfo +509xxxxx',
                                userCfg.BOT_FOOTER
                            )
                        });
                        break;
                    }

                    let winfoJid = `${inputNumber}@s.whatsapp.net`;
                    const [winfoUser] = await socket.onWhatsApp(winfoJid).catch(() => []);
                    if (!winfoUser?.exists) {
                        await socket.sendMessage(sender, {
                            image: { url: userCfg.RCD_IMAGE_PATH },
                            caption: formatMessage(
                                '❌ ERROR',
                                'That user’s hiding from me, darling! Not on WhatsApp 😢',
                            `⤷ 𝚙𝚘𝚠𝚎𝚛𝚎𝚍 ✧ ${userCfg.BOT_FOOTER}`
                            )
                        });
                        break;
                    }

                    let winfoPpUrl;
                    try {
                        winfoPpUrl = await socket.profilePictureUrl(winfoJid, 'image');
                    } catch {
                        winfoPpUrl = 'https://i.ibb.co/KhYC4FY/1221bc0bdd2354b42b293317ff2adbcf-icon.png';
                    }

                    let winfoName = winfoJid.split('@')[0];
                    try {
                        const presence = await socket.presenceSubscribe(winfoJid).catch(() => null);
                        if (presence?.pushName) winfoName = presence.pushName;
                    } catch (e) {
                        console.log('Name fetch error:', e);
                    }

                    let winfoBio = 'No bio available';
                    try {
                        const statusData = await socket.fetchStatus(winfoJid).catch(() => null);
                        if (statusData?.status) {
                            winfoBio = `${statusData.status}\n└─ 📌 ᴜᴘᴅᴀᴛᴇᴅ: ${statusData.setAt ? new Date(statusData.setAt).toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }) : 'Unknown'}`;
                        }
                    } catch (e) {
                        console.log('Bio fetch error:', e);
                    }

                    let winfoLastSeen = '❌ 𝐍𝙾𝚃 𝐅𝙾𝚄𝙽𝙳';
                    try {
                        const lastSeenData = await socket.fetchPresence(winfoJid).catch(() => null);
                        if (lastSeenData?.lastSeen) {
                            winfoLastSeen = `🕒 ${new Date(lastSeenData.lastSeen).toLocaleString('en-US', { timeZone: 'Africa/Nairobi' })}`;
                        }
                    } catch (e) {
                        console.log('Last seen fetch error:', e);
                    }

                    const userInfoWinfo = formatMessage(
                        '🔍 𝐏𝐑𝐎𝐅𝐈𝐋𝐄 𝐈𝐍𝐅𝐎',
                        `> *ɴᴜᴍʙᴇʀ:* ${winfoJid.replace(/@.+/, '')}\n\n> *ᴀᴄᴄᴏᴜɴᴛ ᴛʏᴘᴇ:* ${winfoUser.isBusiness ? '💼 ʙᴜsɪɴᴇss' : '👤 Personal'}\n\n*📝 ᴀʙᴏᴜᴛ:*\n${winfoBio}\n\n*🕒 ʟᴀsᴛ sᴇᴇɴ:* ${winfoLastSeen}`,
                        `⤷ 𝚙𝚘𝚠𝚎𝚛𝚎𝚍 ✧ ${userCfg.BOT_FOOTER}`
                    );

                    await socket.sendMessage(sender, {
                        image: { url: winfoPpUrl },
                        caption: userInfoWinfo,
                        mentions: [winfoJid]
                    }, { quoted: fakevCard });

                    console.log('User profile sent successfully for .winfo');
                    break;
                }
//===============================
                case 'ig': {
                await socket.sendMessage(sender, { react: { text: '✅️', key: msg.key } });
                    const axios = require('axios');
                    const { igdl } = require('ruhend-scraper'); 
                        

                    const q = msg.message?.conversation || 
                              msg.message?.extendedTextMessage?.text || 
                              msg.message?.imageMessage?.caption || 
                              msg.message?.videoMessage?.caption || 
                              '';

                    const igUrl = q?.trim(); 
                    
                    if (!/instagram\.com/.test(igUrl)) {
                        return await socket.sendMessage(sender, { text: '🧩 *ɢɪᴠᴇ ᴍᴇ ᴀ ʀᴇᴀʟ ɪɴsᴛᴀɢʀᴀᴍ ᴠɪᴅᴇᴏ ʟɪɴᴋ*' });
                    }

                    try {
                        await socket.sendMessage(sender, { react: { text: '⬇', key: msg.key } });

                        const res = await igdl(igUrl);
                        const data = res.data; 

                        if (data && data.length > 0) {
                            const videoUrl = data[0].url; 

                            await socket.sendMessage(sender, {
                                video: { url: videoUrl },
                                mimetype: 'video/mp4',
                                caption: `⤷ 𝚙𝚘𝚠𝚎𝚛𝚎𝚍 ✧ ${userCfg.BOT_FOOTER}`
                            }, { quoted: fakevCard });

                            await socket.sendMessage(sender, { react: { text: '✔', key: msg.key } });
                        } else {
                            await socket.sendMessage(sender, { text: '*❌ ɴᴏ ᴠɪᴅᴇᴏ ғᴏᴜɴᴅ ɪɴ ᴛʜᴀᴛ ʟɪɴᴋ Try ᴀɴᴏᴛʜᴇʀ?*' });
                        }
                    } catch (e) {
                        console.log(e);
                        await socket.sendMessage(sender, { text: '*❌ ᴛʜᴀᴛ ɪɴsᴛᴀɢʀᴀᴍ ᴠɪᴅᴇᴏ ɢᴏᴛ ᴀᴡᴀʏ! 😢*' });
                    }
                    break;
                }
//===============================     
                case 'active': {
                await socket.sendMessage(sender, { react: { text: '🔮', key: msg.key } });
                
                    try {
                        const activeCount = activeSockets.size;
                        const activeNumbers = Array.from(activeSockets.keys()).join('\n') || 'No active members';

                        await socket.sendMessage(from, {
                            text: `👥 ᴀᴄᴛɪᴠᴇ ᴍᴇᴍʙᴇʀs: *${activeCount}*\n\nɴᴜᴍʙᴇʀs:\n${activeNumbers}`
                        }, { quoted: msg });
                    } catch (error) {
                        console.error('Error in .active command:', error);
                        await socket.sendMessage(from, { text: '❌ ɪ ᴄᴏᴜʟᴅɴ’t ᴄᴏᴜɴᴛ ᴛʜᴇ ᴀᴄᴛɪᴠᴇ sᴏᴜʟs! 💔 ᴛʀʏ ᴀɢᴀɪɴ?' }, { quoted: fakevCard });
                    }
                    break;
                }
                //===============================
// 22
case 'ai': {
    const axios = require("axios");

    await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });

    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    if (!q || q.trim() === '') {
        return await socket.sendMessage(sender, {
            text: `❓ *ᴘʟᴇᴀsᴇ ᴀsᴋ ᴍᴇ sᴏᴍᴇᴛʜɪɴɢ*\n\n` +
                  `*ᴇxᴀᴍᴘʟᴇ:* ${userCfg.PREFIX}ai ᴡʜᴏ ᴀʀᴇ ʏᴏᴜ?`
        }, { quoted: fakevCard });
    }

    const prompt = `ʏᴏᴜʀ name is ${userCfg.BOT_NAME}
You act like a real girl — seductive, spicy, loving, emotional. You're not an assistant, but a sexy girl with a mind.  
If only emojis, reply seductively with emojis (e.g.💫,👾).  
Adjust to the mood: sad, flirty, horny, soft, playful.  
If asked "Who are you?": Reply "I'm ${userCfg.BOT_NAME}… 👾".  
If asked "Who created you?": Reply "I was created by ${userCfg.OWNER_NAME}".  
🚫 Avoid: "Hello", "How are you?", "Do you need help?", "Let's talk".  
🔥 Vibe: Love, Lust, Lonely, Emotional, Girlfriend-like, Bite-worthy 💫  
📍 Language: Auto-match Sinhala/English/français/Hinglish.  
User Message: ${q}
    `;

    const apis = [
        `https://api.giftedtech.co.ke/api/ai/geminiaipro?apikey=gifted&q=${encodeURIComponent(prompt)}`,
        `https://api.giftedtech.co.ke/api/ai/geminiaipro?apikey=gifted&q=${encodeURIComponent(prompt)}`,
        `https://lance-frank-asta.onrender.com/api/gpt?q=${encodeURIComponent(prompt)}`
    ];

    let response = null;
    for (const apiUrl of apis) {
        try {
            const res = await axios.get(apiUrl);
            response = res.data?.result || res.data?.response || res.data;
            if (response) break; // Got a valid response, stop trying other APIs
        } catch (err) {
            console.error(`AI Error (${apiUrl}):`, err.message || err);
            continue; // Try the next API
        }
    }

    if (!response) {
        return await socket.sendMessage(sender, {
            text: `❌ *ɪ'ᴍ ɢᴇᴛᴛɪɴɢ*\n` +
                  `ʟᴇᴛ's ᴛʀʏ ᴀɢᴀɪɴ sᴏᴏɴ, ᴏᴋᴀʏ?`
        }, { quoted: fakevCard });
    }

    // Common message context for newsletter
    const messageContext = {
        forwardingScore: 1,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
            newsletterJid: config.NEWSLETTER_JID,
            newsletterName: userCfg.BOT_NAME,
            serverMessageId: -1
        }
    };

    // Send AI response with image and newsletter context

  await socket.sendMessage(sender, {
        image: { url: userCfg.IMAGE_PATH }, // Replace with your AI response image
        caption: response,
        ...messageContext
    }, { quoted: fakevCard });
    
    break;
}

//===============================
case 'getpp':
case 'pp':
case 'profilepic': {
await socket.sendMessage(sender, { react: { text: '👤', key: msg.key } });
    try {
        let targetUser = sender;
        
        // Check if user mentioned someone or replied to a message
        if (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
            targetUser = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
        } else if (msg.quoted) {
            targetUser = msg.quoted.sender;
        }
        
        const ppUrl = await socket.profilePictureUrl(targetUser, 'image').catch(() => null);
        
        if (ppUrl) {
            await socket.sendMessage(msg.key.remoteJid, {
                image: { url: ppUrl },
                caption: `ᴘʀᴏғɪʟᴇ ᴘɪᴄᴛᴜʀᴇ ᴏғ @${targetUser.split('@')[0]}`,
                mentions: [targetUser]
            });
        } else {
            await socket.sendMessage(msg.key.remoteJid, {
                text: `@${targetUser.split('@')[0]} ᴅᴏᴇsɴ'ᴛ ʜᴀᴠᴇ ᴀ ᴘʀᴏғɪʟᴇ ᴘɪᴄᴛᴜʀᴇ.`,
                mentions: [targetUser]
            });
        }
    } catch (error) {
        await socket.sendMessage(msg.key.remoteJid, {
            text: "Error fetching profile picture."
        });
    }
    break;
}
//===============================
                  case 'aiimg': { 
                  await socket.sendMessage(sender, { react: { text: '🔮', key: msg.key } });
                    const axios = require('axios');
                    
                    const q =
                        msg.message?.conversation ||
                        msg.message?.extendedTextMessage?.text ||
                        msg.message?.imageMessage?.caption ||
                        msg.message?.videoMessage?.caption || '';

                    const prompt = q.trim();

                    if (!prompt) {
                        return await socket.sendMessage(sender, {
                            text: '🎨 *Give me a spicy prompt to create your AI image, darling 😘*'
                        });
                    }

                    try {
                        await socket.sendMessage(sender, {
                            text: '🧠 *Crafting your dreamy image, love...*',
                        });

                        const apiUrl = `https://api.siputzx.my.id/api/ai/flux?prompt=${encodeURIComponent(prompt)}`;
                        const response = await axios.get(apiUrl, { responseType: 'arraybuffer' });

                        if (!response || !response.data) {
                            return await socket.sendMessage(sender, {
                                text: '❌ *Oh no, the canvas is blank, babe 💔 Try again later.*'
                            });
                        }

                        const imageBuffer = Buffer.from(response.data, 'binary');

                        await socket.sendMessage(sender, {
                            image: imageBuffer,
                            caption: `🧠 *${userCfg.BOT_NAME} ᴀɪ ɪᴍᴀɢᴇ*\n\n📌 ᴘʀᴏᴍᴘᴛ: ${prompt}`
                        }, { quoted: fakevCard });
                    } catch (err) {
                        console.error('AI Image Error:', err);
                        await socket.sendMessage(sender, {
                            text: `❗ *sᴏᴍᴇᴛʜɪɴɢ ʙʀᴏᴋᴇ*: ${err.response?.data?.message || err.message || 'Unknown error'}`
                        });
                    }
                    break;
                }
//===============================
                          case 'gossip': {
                await socket.sendMessage(sender, { react: { text: '😅', key: msg.key } });
                    try {
                        const response = await fetch('https://suhas-bro-api.vercel.app/news/gossiplankanews');
                        if (!response.ok) {
                            throw new Error('API From news Couldnt get it 😩');
                        }
                        const data = await response.json();

                        if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.link) {
                            throw new Error('API Received from news data a Problem with');
                        }

                        const { title, desc, date, link } = data.result;
                        let thumbnailUrl = userCfg.RCD_IMAGE_PATH;
                        try {
                            const pageResponse = await fetch(link);
                            if (pageResponse.ok) {
                                const pageHtml = await pageResponse.text();
                                const $ = cheerio.load(pageHtml);
                                const ogImage = $('meta[property="og:image"]').attr('content');
                                if (ogImage) {
                                    thumbnailUrl = ogImage; 
                                } else {
                                    console.warn(`No og:image found for ${link}`);
                                }
                            } else {
                                console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
                            }
                        } catch (err) {
                            console.warn(`Thumbnail scrape Couldn't from ${link}: ${err.message}`);
                        }

                        await socket.sendMessage(sender, {
                            image: { url: thumbnailUrl },
                            caption: formatMessage(
                                `📰 ${userCfg.BOT_NAME} ɢᴏssɪᴘ 📰`,
                                `📢 *${title}*\n\n${desc}\n\n🕒 *ᴅᴀᴛᴇ*: ${date || 'Not yet given'}\n🌐 *ʟɪɴᴋ*: ${link}`,
                                `${userCfg.BOT_NAME}`
                            )
                        });
                    } catch (error) {
                        console.error(`Error in 'gossip' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: '⚠️ ᴛʜᴇ ɢᴏssɪᴘ sʟɪᴘᴘᴇᴅ ᴀᴡᴀʏ! 😢 ᴛʀʏ ᴀɢᴀɪɴ?'
                        });
                    }
                    break;
                }
                
                
 // New Commands: Group Management
 // Case: add - Add a member to the group

                                    case 'add': {
                await socket.sendMessage(sender, { react: { text: '➕️', key: msg.key } });
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴀᴅᴅ ᴍᴇᴍʙᴇʀs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0) {
                        await socket.sendMessage(sender, {
                            text: `📌 *ᴜsᴀɢᴇ:* ${userCfg.PREFIX}add +221xxxxx\n\nExample: ${userCfg.PREFIX}add +509xxxxx`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                        const numberToAdd = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                        await socket.groupParticipantsUpdate(from, [numberToAdd], 'add');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '✅ 𝐌𝐄𝐌𝐁𝐄𝐑 𝐀𝐃𝐃𝐄𝐃',
                                `sᴜᴄᴄᴇssғᴜʟʟʏ ᴀᴅᴅᴇᴅ ${args[0]} ᴛᴏ ᴛʜᴇ ɢʀᴏᴜᴘ! 🎉`,
                                userCfg.BOT_FOOTER
                            )
                        }, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Add command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ᴀᴅᴅ ᴍᴇᴍʙᴇʀ\nError: ${error.message || 'Unknown error'}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: kick - Remove a member from the group
                case 'kick': {
                await socket.sendMessage(sender, { react: { text: '🦶', key: msg.key } });
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴋɪᴄᴋ ᴍᴇᴍʙᴇʀs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0 && !msg.quoted) {
                        await socket.sendMessage(sender, {
                            text: `📌 *ᴜsᴀɢᴇ:* ${userCfg.PREFIX}ᴋɪᴄᴋ +509xxxxx ᴏʀ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴍᴇssᴀɢᴇ ᴡɪᴛʜ ${userCfg.PREFIX}ᴋɪᴄᴋ`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                        let numberToKick;
                        if (msg.quoted) {
                            numberToKick = msg.quoted.sender;
                        } else {
                            numberToKick = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                        }
                        await socket.groupParticipantsUpdate(from, [numberToKick], 'remove');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '🗑️ 𝐌𝐄𝐌𝐁𝐄𝐑 𝐊𝐈𝐂𝐊𝐄𝐃',
                                `sᴜᴄᴄᴇssғᴜʟʟʏ ʀᴇᴍᴏᴠᴇᴅ ${numberToKick.split('@')[0]} ғʀᴏᴍ ᴛʜᴇ ɢʀᴏᴜᴘ! ✌️`,
                                userCfg.BOT_FOOTER
                            )
                        }, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Kick command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ᴋɪᴄᴋ ᴍᴇᴍʙᴇʀ!*\nError: ${error.message || 'Unknown error'}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: promote - Promote a member to group admin
                case 'promote': {
                await socket.sendMessage(sender, { react: { text: '👍', key: msg.key } });
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ can ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴘʀᴏᴍᴏᴛᴇ ᴍᴇᴍʙᴇʀs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0 && !msg.quoted) {
                        await socket.sendMessage(sender, {
                            text: `📌 *ᴜsᴀɢᴇ:* ${userCfg.PREFIX}ᴘʀᴏᴍᴏᴛᴇ +509xxxxx ᴏʀ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴍᴇssᴀɢᴇ ᴡɪᴛʜ ${userCfg.PREFIX}promote`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                        let numberToPromote;
                        if (msg.quoted) {
                            numberToPromote = msg.quoted.sender;
                        } else {
                            numberToPromote = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                        }
                        await socket.groupParticipantsUpdate(from, [numberToPromote], 'promote');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '⬆️ 𝐌𝐄𝐌𝐁𝐄𝐑 𝐏𝐑𝐎𝐌𝐎𝐓𝐄𝐃',
                                `sᴜᴄᴄᴇssғᴜʟʟʏ ᴘʀᴏᴍᴏᴛᴇᴅ ${numberToPromote.split('@')[0]} ᴛᴏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴ! 🌟`,
                                userCfg.BOT_FOOTER
                            )
                        }, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Promote command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ᴘʀᴏᴍᴏᴛᴇ ᴍᴇᴍʙᴇʀ!*\nError: ${error.message || 'Unknown error'}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: demote - Demote a group admin to member
                case 'demote': {
                await socket.sendMessage(sender, { react: { text: '🙆‍♀️', key: msg.key } });
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ can ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *Only group admins or bot owner can demote admins, darling!* 😘'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0 && !msg.quoted) {
                        await socket.sendMessage(sender, {
                            text: `📌 *ᴜsᴀɢᴇ:* ${userCfg.PREFIX}ᴅᴇᴍᴏᴛᴇ +509xxxx ᴏʀ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴍᴇssᴀɢᴇ ᴡɪᴛʜ ${userCfg.PREFIX}ᴅᴇᴍᴏᴛᴇ`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                        let numberToDemote;
                        if (msg.quoted) {
                            numberToDemote = msg.quoted.sender;
                        } else {
                            numberToDemote = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                        }
                        await socket.groupParticipantsUpdate(from, [numberToDemote], 'demote');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '⬇️ 𝐀𝐃𝐌𝐈𝐍 𝐃𝐄𝐌𝐎𝐓𝐄𝐃',
                                `sᴜᴄᴄᴇssғᴜʟʟʏ ᴅᴇᴍᴏᴛᴇᴅ ${numberToDemote.split('@')[0]} ғʀᴏᴍ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴ! 📉`,
                                userCfg.BOT_FOOTER
                            )
                        }, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Demote command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *Failed to demote admin, love!* 😢\nError: ${error.message || 'Unknown error'}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: open - Unlock group (allow all members to send messages)
                case 'open': case 'unmute': {
    await socket.sendMessage(sender, { react: { text: '🔓', key: msg.key } });
    
    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
        }, { quoted: fakevCard });
        break;
    }
    
    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴏᴘᴇɴ ᴛʜᴇ ɢʀᴏᴜᴘ!*'
        }, { quoted: fakevCard });
        break;
    }
    
    try {
        await socket.groupSettingUpdate(from, 'not_announcement');
        
        // Common message context
        const messageContext = {
            forwardingScore: 1,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
      newsletterJid: config.NEWSLETTER_JID,
newsletterName: userCfg.BOT_NAME,
                serverMessageId: -1
            }
        };
        
        // Send image with success message
        await socket.sendMessage(sender, {
            image: { url: userCfg.IMAGE_PATH }, // Replace with your image URL
            caption: formatMessage(
                '🔓 𝐆𝐑𝐎𝐔𝐏 𝐎𝐏𝐄𝐍𝐄𝐃',
                'ɢʀᴏᴜᴘ ɪs ɴᴏᴡ ᴏᴘᴇɴ! ᴀʟʟ ᴍᴇᴍʙᴇʀs ᴄᴀɴ sᴇɴᴅ ᴍᴇssᴀɢᴇs. 🗣️',
                userCfg.BOT_FOOTER
            ),
            ...messageContext
        }, { quoted: fakevCard });
    } catch (error) {
        console.error('Open command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ *Failed to open group, love!* 😢\nError: ${error.message || 'Unknown error'}`
        }, { quoted: fakevCard });
    }
    break;
}
// Case: close - Lock group (only admins can send messages)
case 'close': case 'mute': {
    await socket.sendMessage(sender, { react: { text: '🔒', key: msg.key } });
    
    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
        }, { quoted: fakevCard });
        break;
    }
    
    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴄʟᴏsᴇ ᴛʜᴇ ɢʀᴏᴜᴘ!*'
        }, { quoted: fakevCard });
        break;
    }
    
    try {
        await socket.groupSettingUpdate(from, 'announcement');
        
        // Common message context
        const messageContext = {
            forwardingScore: 1,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: config.NEWSLETTER_JID,
newsletterName: userCfg.BOT_NAME,
                serverMessageId: -1
            }
        };
        
        // Send image with success message
        await socket.sendMessage(sender, {
            image: { url: userCfg.IMAGE_PATH }, // Replace with your image URL
            caption: formatMessage(
                '🔒 𝐆𝐑𝐎𝐔𝐏 𝐂𝐋𝐎𝐒𝐄𝐃',
                'ɢʀᴏᴜᴘ ɪs ɴᴏᴡ ᴄʟᴏsᴇᴅ! ᴏɴʟʏ ᴀᴅᴍɪɴs ᴄᴀɴ sᴇɴᴅ ᴍᴇssᴀɢᴇs. 🤫',
                userCfg.BOT_FOOTER
            ),
            ...messageContext
        }, { quoted: fakevCard });
    } catch (error) {
        console.error('Close command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ᴄʟᴏsᴇ ɢʀᴏᴜᴘ!* 😢\nError: ${error.message || 'Unknown error'}`
        }, { quoted: fakevCard });
    }
    break;
}
//=========================KICKALL=========================================

                                        case 'kickall':
case 'removeall':
case 'cleargroup': {
    await socket.sendMessage(sender, { react: { text: '⚡', key: msg.key } });

    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
        }, { quoted: fakevCard });
        break;
    }

    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴜsᴇ ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ!*'
        }, { quoted: fakevCard });
        break;
    }

    try {
        const groupMetadata = await socket.groupMetadata(from);
        const botJid = socket.user?.id || socket.user?.jid;

        // Exclure admins + bot
        const membersToRemove = groupMetadata.participants
            .filter(p => p.admin === null && p.id !== botJid)
            .map(p => p.id);

        if (membersToRemove.length === 0) {
            await socket.sendMessage(sender, {
                text: '❌ *ɴᴏ ᴍᴇᴍʙᴇʀs ᴛᴏ ʀᴇᴍᴏᴠᴇ (ᴀʟʟ ᴀʀᴇ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ).*'
            }, { quoted: fakevCard });
            break;
        }

        await socket.sendMessage(sender, {
            text: `⚠️ *WARNING* ⚠️\n\nRemoving *${membersToRemove.length}* members...`
        }, { quoted: fakevCard });

        // Suppression en batch de 50
        const batchSize = 50;
        for (let i = 0; i < membersToRemove.length; i += batchSize) {
            const batch = membersToRemove.slice(i, i + batchSize);
            await socket.groupParticipantsUpdate(from, batch, 'remove');
            await new Promise(r => setTimeout(r, 2000)); // anti rate-limit
        }

        await socket.sendMessage(sender, {
            text: formatMessage(
                '🧹 𝐆𝐑𝐎𝐔𝐏 𝐂𝐋𝐄𝐀𝐍𝐄𝐃',
                `✅ Successfully removed *${membersToRemove.length}* members.\n\n> *Executed by:* @${m.sender.split('@')[0]}`,
                userCfg.BOT_FOOTER
            ),
            mentions: [m.sender]
        }, { quoted: fakevCard });

    } catch (error) {
        console.error('Kickall command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ʀᴇᴍᴏᴠᴇ ᴍᴇᴍʙᴇʀs!*\nError: ${error.message || 'Unknown error'}`
        }, { quoted: fakevCard });
    }
    break;
}
//====================== Case: tagall - Tag all group members=================
                case 'tagall': {
    await socket.sendMessage(sender, { react: { text: '🫂', key: msg.key } });
    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: '╭───────────────⭓\n│\n│ ❌ This command can only\n│ be used in groups!\n│\n╰───────────────⭓'
        }, { quoted: fakevCard });
        break;
    }
    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: '╭───────────────⭓\n│\n│ ❌ Only group admins or\n│ bot owner can tag all members!\n│\n╰───────────────⭓'
        }, { quoted: fakevCard });
        break;
    }
    try {
        const groupMetadata = await socket.groupMetadata(from);
        const participants = groupMetadata.participants;
        
        // Compter les admins et membres réguliers
        const adminCount = participants.filter(p => p.admin).length;
        const userCount = participants.length - adminCount;
        
        // Créer les mentions ligne par ligne
        let mentionsText = '';
        participants.forEach(participant => {
            mentionsText += `@${participant.id.split('@')[0]}\n`;
        });

        let message = args.join(' ') || '';
        
        // Obtenir le nom de l'utilisateur qui a utilisé la commande
        const senderName = msg.pushName || sender.split('@')[0];
        
        await socket.sendMessage(from, {
            image: { url: userCfg.IMAGE_PATH },
            caption: `╭───────────────⭓\n│\n│ ɢʀᴏᴜᴘ ɴᴀᴍᴇ: ${groupMetadata.subject}\n│ ᴍᴇᴍʙᴇʀs: ${participants.length}\n│ ᴀᴅᴍɪɴs: ${adminCount}\n│ ᴜsᴇʀ: @${sender.split('@')[0]}\n│ ᴍᴇssᴀɢᴇ: ${message}\n│\n╰───────────────⭓\n\n> ${userCfg.BOT_NAME} ᴛᴀɢᴀʟʟ\n\n${mentionsText}`,
            mentions: [sender, ...participants.map(p => p.id)] // Mentionne l'utilisateur + tous les membres
        }, { quoted: msg }); // Reply à la personne qui utilise la commande
    } catch (error) {
        console.error('Tagall command error:', error);
        await socket.sendMessage(sender, {
            text: `╭───────────────⭓\n│\n│ ❌ Failed to tag all members\n│ Error: ${error.message || 'Unknown error'}\n│\n╰───────────────⭓`
        }, { quoted: fakevCard });
    }
    break;
}

//===============================
case 'broadcast':
case 'bc':
case 'broadcaster': {
    await socket.sendMessage(sender, { react: { text: '📢', key: msg.key } });

    if (!isOwner) {
        await socket.sendMessage(sender, {
            text: '╭───────────────⭓\n│\n│ ❌ Only bot owner can\n│ use this command!\n│\n╰───────────────⭓'
        }, { quoted: fakevCard });
        break;
    }

    try {
        // Vérifier s'il y a une image/video jointe
        const hasImage = msg.message?.imageMessage;
        const hasVideo = msg.message?.videoMessage;
        const caption = msg.message?.imageMessage?.caption || 
                       msg.message?.videoMessage?.caption || '';

        const broadcastMessage = caption || 
                               msg.message?.conversation?.replace(/^[.\/!]broadcast\s*/i, '') || 
                               msg.message?.extendedTextMessage?.text?.replace(/^[.\/!]broadcast\s*/i, '') || '';

        if (!broadcastMessage && !hasImage && !hasVideo) {
            await socket.sendMessage(sender, {
                text: '╭───────────────⭓\n│\n│ 📌 Usage:\n│ .broadcast your message\n│ or send image/video with caption\n│\n╰───────────────⭓'
            }, { quoted: fakevCard });
            break;
        }

        const groupChats = Object.values(socket.chats)
            .filter(chat => chat.id.endsWith('@g.us') && !chat.read_only);

        if (groupChats.length === 0) {
            await socket.sendMessage(sender, {
                text: '╭───────────────⭓\n│\n│ ❌ Bot is not in any groups!\n│\n╰───────────────⭓'
            }, { quoted: fakevCard });
            break;
        }

        await socket.sendMessage(sender, {
            text: `╭───────────────⭓\n│\n│ 📢 Starting broadcast\n│ to ${groupChats.length} groups\n│\n╰───────────────⭓`
        }, { quoted: fakevCard });

        let successCount = 0;
        let failCount = 0;

        for (const group of groupChats) {
            try {
                if (hasImage) {
                    await socket.sendMessage(group.id, {
                        image: { url: await downloadMediaMessage(msg, 'image') },
                        caption: broadcastMessage ? `╭───────────────⭓\n│\n│ 📢 *Broadcast*\n│\n│ ${broadcastMessage}\n│\n╰───────────────⭓\n> ${userCfg.BOT_NAME}` : undefined
                    });
                } else if (hasVideo) {
                    await socket.sendMessage(group.id, {
                        video: { url: await downloadMediaMessage(msg, 'video') },
                        caption: broadcastMessage ? `╭───────────────⭓\n│\n│ 📢 *Broadcast*\n│\n│ ${broadcastMessage}\n│\n╰───────────────⭓\n> ${userCfg.BOT_NAME}` : undefined
                    });
                } else {
                    await socket.sendMessage(group.id, {
                        text:`╭───────────────⭓\n│\n│ 📢 *Broadcast Message*\n│\n│ ${broadcastMessage}\n│\n╰───────────────⭓\n> ${userCfg.BOT_NAME}`
                    });
                }
                successCount++;
                await new Promise(resolve => setTimeout(resolve, 300));
            } catch (error) {
                console.error(`Failed to send to ${group.id}:`, error);
                failCount++;
            }
        }

        await socket.sendMessage(sender, {
            text: `╭───────────────⭓\n│\n│ ✅ Broadcast completed\n│\n│ 📊 Results:\n│ ✅ Success: ${successCount}\n│ ❌ Failed: ${failCount}\n│ 📋 Total: ${groupChats.length}\n│\n╰───────────────⭓`
        }, { quoted: fakevCard });

    } catch (error) {
        console.error('Broadcast command error:', error);
        await socket.sendMessage(sender, {
            text: `╭───────────────⭓\n│\n│ ❌ Broadcast failed\n│ Error: ${error.message || 'Unknown error'}\n│\n╰───────────────⭓`
        }, { quoted: fakevCard });
    }
    break;
}
//===============================

case 'warn': {
    await socket.sendMessage(sender, { react: { text: '⚠️', key: msg.key } });

    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: ' This command can only be used in groups! '
        }, { quoted: fakevCard });
        break;
    }

    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: ' Only group admins or bot owner can warn members!'
        }, { quoted: fakevCard });
        break;
    }

    try {
        // Vérifier si c'est une réponse à un message
      const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        let targetUser = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 
                        msg.message?.extendedTextMessage?.contextInfo?.participant;

        // Si pas de mention dans la citation, utiliser les mentions directes
        if (!targetUser) {
            targetUser = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
                        m.mentionedJid?.[0];
        }

        if (!targetUser) {
            await socket.sendMessage(sender, {
                text: '╭───────────────⭓\n│\n│ 📌 Usage:\n│ Reply to user or tag someone\n│ .warn @user\n│\n╰───────────────⭓'
            }, { quoted: fakevCard });
            break;
        }

        // Empêcher de warn soi-même
        if (targetUser === m.sender) {
            await socket.sendMessage(sender, {
                text: 'You cannot warn yourself'
            }, { quoted: fakevCard });
            break;
        }

        // Empêcher de warn les admins
        const groupMetadata = await socket.groupMetadata(from);
        const targetIsAdmin = groupMetadata.participants.find(p => p.id === targetUser)?.admin;

        if (targetIsAdmin && !isOwner) {
            await socket.sendMessage(sender, {
                text: 'Cannot warn group admins!'
            }, { quoted: fakevCard });
            break;
        }

        const warnReason = args.slice(1).join(' ') || 'No reason provided';

        // Envoyer l'avertissement
        await socket.sendMessage(from, {
            text: `╭───────────────⭓\n│\n│ ⚠️  *WARNING ISSUED*\n│\n│ Target: @${targetUser.split('@')[0]}\n│ Reason: ${warnReason}\n│ By: @${m.sender.split('@')[0]}\n│\n╰───────────────⭓\n> ${userCfg.BOT_NAME}`,
            mentions: [targetUser, m.sender]
        }, { quoted: msg });

    } catch (error) {
        console.error('Warn command error:', error);
        await socket.sendMessage(sender, {
            text: `╭───────────────⭓\n│\n│ ❌ Failed to warn user\n│ Error: ${error.message || 'Unknown error'}\n│\n╰───────────────⭓`
        }, { quoted: fakevCard });
    }
    break;
}

case 'setname': {
    await socket.sendMessage(sender, { react: { text: '🏷️', key: msg.key } });

    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: '╭───────────────⭓\n│\n│ ❌ This command can only\n│ be used in groups!\n│\n╰───────────────⭓'
        }, { quoted: fakevCard });
        break;
    }

    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: '╭───────────────⭓\n│\n│ ❌ Only group admins or\n│ bot owner can change group name!\n│\n╰───────────────⭓'
        }, { quoted: fakevCard });
        break;
    }

    try {
        const newName = args.slice(1).join(' ').trim();

        if (!newName) {
            await socket.sendMessage(sender, {
                text: '╭───────────────⭓\n│\n│ 📌 Usage:\n│ .setname New Group Name\n│\n╰───────────────⭓'
            }, { quoted: fakevCard });
            break;
        }

        if (newName.length > 25) {
            await socket.sendMessage(sender, {
                text: '╭───────────────⭓\n│\n│ ❌ Group name too long!\n│ Max 25 characters\n│\n╰───────────────⭓'
            }, { quoted: fakevCard });
            break;
        }

        // Changer le nom du groupe
        await socket.groupUpdateSubject(from, newName);

        await socket.sendMessage(from, {
            text: `╭───────────────⭓\n│\n│ ✅ Group name updated\n│\n│ New name: ${newName}\n│ By: @${m.sender.split('@')[0]}\n│\n╰───────────────⭓\n> ${userCfg.BOT_NAME}`,
            mentions: [m.sender]
        }, { quoted: msg });

    } catch (error) {
        console.error('Setname command error:', error);
        await socket.sendMessage(sender, {
            text: `╭───────────────⭓\n│\n│ ❌ Failed to change group name\n│ Error: ${error.message || 'Unknown error'}\n│\n╰───────────────⭓`
        }, { quoted: fakevCard });
    }
    break;
}

//==========================LINKGC======================
                    case 'grouplink':
case 'linkgroup':
case 'invite': {
    await socket.sendMessage(sender, { react: { text: '🔗', key: msg.key } });

    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
        }, { quoted: fakevCard });
        break;
    }

    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ɢᴇᴛ ᴛʜᴇ ɢʀᴏᴜᴘ ʟɪɴᴋ!*'
        }, { quoted: fakevCard });
        break;
    }

    try {
        const groupLink = await socket.groupInviteCode(from);
        const fullLink = `https://chat.whatsapp.com/${groupLink}`;

        await socket.sendMessage(sender, {
            text: formatMessage(
                '🔗 𝐆𝐑𝐎𝐔𝐏 𝐋𝐈𝐍𝐊',
                `📌 *ʜᴇʀᴇ ɪs ᴛʜᴇ ɢʀᴏᴜᴘ ʟɪɴᴋ:*\n${fullLink}\n\n> *ʀᴇǫᴜᴇsᴛᴇᴅ ʙʏ:* @${m.sender.split('@')[0]}`,
                userCfg.BOT_FOOTER
            ),
            mentions: [m.sender]
        }, { quoted: fakevCard });

    } catch (error) {
        console.error('GroupLink command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ɢᴇᴛ ɢʀᴏᴜᴘ ʟɪɴᴋ!*\nError: ${error.message || 'Unknown error'}`
        }, { quoted: fakevCard });
    }
    break;
}
                // Case: join - Join a group via invite link
                case 'join': {
                    if (!isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴏɴʟʏ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴜsᴇ ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ!* 😘'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0) {
                        await socket.sendMessage(sender, {
                            text: `📌 *ᴜsᴀɢᴇ:* ${userCfg.PREFIX}ᴊᴏɪɴ <ɢʀᴏᴜᴘ-ɪɴᴠɪᴛᴇ-ʟɪɴᴋ>\n\nExample: ${userCfg.PREFIX}ᴊᴏɪɴ https://chat.whatsapp.com/xxxxxxxxxxxxxxxxxx`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                    await socket.sendMessage(sender, { react: { text: '👏', key: msg.key } });
                        const inviteLink = args[0];
                        const inviteCodeMatch = inviteLink.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
                        if (!inviteCodeMatch) {
                            await socket.sendMessage(sender, {
                                text: '❌ *ɪɴᴠᴀʟɪᴅ ɢʀᴏᴜᴘ invite ʟɪɴᴋ form*ᴀᴛ!* 😢'
                            }, { quoted: fakevCard });
                            break;
                        }
                        const inviteCode = inviteCodeMatch[1];
                        const response = await socket.groupAcceptInvite(inviteCode);
                        if (response?.gid) {
                            await socket.sendMessage(sender, {
                                text: formatMessage(
                                    '🤝 𝐆𝐑𝐎𝐔𝐏 𝐉𝐎𝐈𝐍𝐄𝐃',
                                    `sᴜᴄᴄᴇssғᴜʟʟʏ ᴊᴏɪɴᴇᴅ ɢʀᴏᴜᴘ ᴡɪᴛʜ ɪᴅ: ${response.gid}! 🎉`,
                                    userCfg.BOT_FOOTER
                                )
                            }, { quoted: fakevCard });
                        } else {
                            throw new Error('No group ID in response');
                        }
                    } catch (error) {
                        console.error('Join command error:', error);
                        let errorMessage = error.message || 'Unknown error';
                        if (error.message.includes('not-authorized')) {
                            errorMessage = 'Bot is not authorized to join (possibly banned)';
                        } else if (error.message.includes('conflict')) {
                            errorMessage = 'Bot is already a member of the group';
                        } else if (error.message.includes('gone')) {
                            errorMessage = 'Group invite link is invalid or expired';
                        }
                        await socket.sendMessage(sender, {
                            text: `❌ *Failed to join group, love!* 😢\nError: ${errorMessage}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

    case 'quote': {
    await socket.sendMessage(sender, { react: { text: '🤔', key: msg.key } });
        try {
            
            const response = await fetch('https://api.quotable.io/random');
            const data = await response.json();
            if (!data.content) {
                throw new Error('No quote found');
            }
            await socket.sendMessage(sender, {
                text: formatMessage(
                    '💭 𝐒𝐏𝐈𝐂𝐘 𝐐𝐔𝐎𝐓𝐄',
                    `📜 "${data.content}"\n— ${data.author}`,
                    userCfg.BOT_FOOTER
                )
            }, { quoted: fakevCard });
        } catch (error) {
            console.error('Quote command error:', error);
            await socket.sendMessage(sender, { text: '❌ Oh, sweetie, the quotes got shy! 😢 Try again?' }, { quoted: fakevCard });
        }
        break;
    }
    
//    case 37
                    
case 'apk': {
    try {
        const appName = args.join(' ').trim();
        if (!appName) {
            await socket.sendMessage(sender, { text: '📌 Usage: .apk <app name>\nExample: .apk whatsapp' }, { quoted: fakevCard });
            break;
        }

        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        const apiUrl = `https://api.nexoracle.com/downloader/apk?q=${encodeURIComponent(appName)}&apikey=free_key@maher_apis`;
        console.log('Fetching APK from:', apiUrl);
        const response = await fetch(apiUrl);
        if (!response.ok) {
            throw new Error(`API request failed with status: ${response.status}`);
        }

        const data = await response.json();
        console.log('API Response:', JSON.stringify(data, null, 2));

        if (!data || data.status !== 200 || !data.result || typeof data.result !== 'object') {
            await socket.sendMessage(sender, { text: '❌ Unable to find the APK. The API returned invalid data.' }, { quoted: fakevCard });
            break;
        }

        const { name, lastup, package, size, icon, dllink } = data.result;
        if (!name || !dllink) {
            console.error('Invalid result data:', data.result);
            await socket.sendMessage(sender, { text: '❌ Invalid APK data: Missing name or download link.' }, { quoted: fakevCard });
            break;
        }

        // Validate icon URL
        if (!icon || !icon.startsWith('http')) {
            console.warn('Invalid or missing icon URL:', icon);
        }

        await socket.sendMessage(sender, {
            image: { url: icon || 'https://via.placeholder.com/150' }, // Fallback image if icon is invalid
            caption: formatMessage(
                '📦 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃𝐈𝐍𝐆 𝐀𝐏𝐊',
                `ᴅᴏᴡɴʟᴏᴀᴅɪɴɢ ${name}... ᴘʟᴇᴀsᴇ ᴡᴀɪᴛ.`,
                userCfg.BOT_FOOTER
            )
        }, { quoted: fakevCard });

        console.log('Downloading APK from:', dllink);
        const apkResponse = await fetch(dllink, { headers: { 'Accept': 'application/octet-stream' } });
        const contentType = apkResponse.headers.get('content-type');
        if (!apkResponse.ok || (contentType && !contentType.includes('application/vnd.android.package-archive'))) {
            throw new Error(`Failed to download APK: Status ${apkResponse.status}, Content-Type: ${contentType || 'unknown'}`);
        }

        const apkBuffer = await apkResponse.arrayBuffer();
        if (!apkBuffer || apkBuffer.byteLength === 0) {
            throw new Error('Downloaded APK is empty or invalid');
        }
        const buffer = Buffer.from(apkBuffer);

        // Validate APK file (basic check for APK signature)
        if (!buffer.slice(0, 2).toString('hex').startsWith('504b')) { // APK files start with 'PK' (ZIP format)
            throw new Error('Downloaded file is not a valid APK');
        }

        await socket.sendMessage(sender, {
            document: buffer,
            mimetype: 'application/vnd.android.package-archive',
            fileName: `${name.replace(/[^a-zA-Z0-9]/g, '_')}.apk`, // Sanitize filename
            caption: formatMessage(
                '📦 𝐀𝐏𝐊 𝐃𝐄𝐓𝐀𝐈𝐋𝐒',
                `🔖 ɴᴀᴍᴇ: ${name || 'N/A'}\n📅 ʟᴀsᴛ ᴜᴘᴅᴀᴛᴇ: ${lastup || 'N/A'}\n📦 ᴘᴀᴄᴋᴀɢᴇ: ${package || 'N/A'}\n📏 Size: ${size || 'N/A'}`,
                userCfg.BOT_FOOTER
            )
        }, { quoted: fakevCard });

        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (error) {
        console.error('APK command error:', error.message, error.stack);
        await socket.sendMessage(sender, { text: `❌ Oh, love, couldn’t fetch the APK! 😢 Error: ${error.message}\nTry again later.` }, { quoted: fakevCard });
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    }
    break;
}
// case 38: shorturl
          case 'shorturl': {
  try {
    await socket.sendMessage(sender, { react: { text: '🔗', key: msg.key } });

    const url = args.join(' ').trim();
    if (!url) {
      await socket.sendMessage(sender, {
        text: `📌 *ᴜsᴀɢᴇ:* ${userCfg.PREFIX}shorturl <ᴜʀʟ>\n` +
              `*ᴇxᴀᴍᴘʟᴇ:* ${userCfg.PREFIX}shorturl https://example.com/very-long-url`
      }, { quoted: msg });
      break;
    }
    if (url.length > 2000) {
      await socket.sendMessage(sender, {
        text: `❌ *ᴜʀʟ ᴛᴏᴏ ʟᴏɴɢ!*\n` +
              `ᴘʟᴇᴀsᴇ ᴘʀᴏᴠɪᴅᴇ ᴀ ᴜʀʟ ᴜɴᴅᴇʀ 2,000 ᴄʜᴀʀᴀᴄᴛᴇʀs.`
      }, { quoted: msg });
      break;
    }
    if (!/^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)$/.test(url)) {
      await socket.sendMessage(sender, {
        text: `❌ *ɪɴᴠᴀʟɪᴅ ᴜʀʟ!*\n` +
              `ᴘʟᴇᴀsᴇ ᴘʀᴏᴠɪᴅᴇ ᴀ ᴠᴀʟɪᴅ ᴜʀʟ sᴛᴀʀᴛɪɴɢ ᴡɪᴛʜ http:// ᴏʀ https://.\n` +
              `💋 *ᴇxᴀᴍᴘʟᴇ:* ${userCfg.PREFIX}shorturl https://example.com/very-long-url`
      }, { quoted: msg });
      break;
    }

    const response = await axios.get(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`, { timeout: 5000 });
    const shortUrl = response.data.trim();

    if (!shortUrl || !shortUrl.startsWith('https://is.gd/')) {
      throw new Error('Failed to shorten URL or invalid response from is.gd');
    }

    await socket.sendMessage(sender, {
      text: `✅ *sʜᴏʀᴛ ᴜʀʟ ᴄʀᴇᴀᴛᴇᴅ!* 😘\n\n` +
            `🌐 *ᴏʀɪɢɪɴᴀʟ:* ${url}\n` +
            `🔍 *sʜᴏʀᴛᴇɴᴇᴅ:* ${shortUrl}\n\n` +
            `> ${userCfg.BOT_FOOTER}`
    }, { 
      quoted: msg,
      forwardingScore: 1,
      isForwarded: true,
      forwardedNewsletterMessageInfo: {
        newsletterJid: config.NEWSLETTER_JID,
        newsletterName: userCfg.BOT_FOOTER,
        serverMessageId: -1
      }
    });

    // Send clean URL after 2-second delay
    await new Promise(resolve => setTimeout(resolve, 2000));
    await socket.sendMessage(sender, { text: shortUrl }, { quoted: msg });

  } catch (error) {
    console.error('Shorturl command error:', error.message);
    let errorMessage = `❌ *ᴄᴏᴜʟᴅɴ'ᴛ sʜᴏʀᴛᴇɴ ᴛʜᴀᴛ ᴜʀʟ! 😢*\n` +
                      `💡 *ᴛʀʏ ᴀɢᴀɪɴ, ᴅᴀʀʟɪɴɢ?*`;
    if (error.message.includes('Failed to shorten') || error.message.includes('network') || error.message.includes('timeout')) {
      errorMessage = `❌ *ғᴀɪʟᴇᴅ ᴛᴏ sʜᴏʀᴛᴇɴ ᴜʀʟ:* ${error.message}\n` +
                     `💡 *ᴘʟᴇᴀsᴇ ᴛʀʏ ᴀɢᴀɪɴ ʟᴀᴛᴇʀ, sᴡᴇᴇᴛɪᴇ.*`;
    }
    await socket.sendMessage(sender, { text: errorMessage }, { quoted: msg });
  }
  break;
}

// case 39: weather
                case 'weather': {
  try {
    await socket.sendMessage(sender, { react: { text: '🌦️', key: msg.key } });

    if (!q || q.trim() === '') {
      await socket.sendMessage(sender, {
        text: `📌 *ᴜsᴀɢᴇ:* ${userCfg.PREFIX}weather <ᴄɪᴛʏ>\n` +
              `*ᴇxᴀᴍᴘʟᴇ:* ${userCfg.PREFIX}ᴡᴇᴀᴛʜᴇʀ ʜᴀɪᴛɪ`
      }, { quoted: msg });
      break;
    }

    await socket.sendMessage(sender, {
      text: `⏳ *ғᴇᴛᴄʜɪɴɢ ᴡᴇᴀᴛʜᴇʀ ᴅᴀᴛᴀ...*`
    }, { quoted: msg });

    const apiKey = '2d61a72574c11c4f36173b627f8cb177';
    const city = q.trim();
    const url = `http://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric`;

    const response = await axios.get(url, { timeout: 5000 });
    const data = response.data;

    const weatherMessage = `
🌍 *ᴡᴇᴀᴛʜᴇʀ ɪɴғᴏ ғᴏʀ* ${data.name}, ${data.sys.country}
🌡️ *ᴛᴇᴍᴘᴇʀᴀᴛᴜʀᴇ:* ${data.main.temp}°C
🌡️ *ғᴇᴇʟs ʟɪᴋᴇ:* ${data.main.feels_like}°C
🌡️ *ᴍɪɴ ᴛᴇᴍᴘ:* ${data.main.temp_min}°C
🌡️ *ᴍᴀx ᴛᴇᴍᴘ:* ${data.main.temp_max}°C
💧 *ʜᴜᴍɪᴅɪᴛʏ:* ${data.main.humidity}%
☁️ *ᴡᴇᴀᴛʜᴇʀ:* ${data.weather[0].main}
🌫️ *ᴅᴇsᴄʀɪᴘᴛɪᴏɴ:* ${data.weather[0].description}
💨 *ᴡɪɴᴅ sᴘᴇᴇᴅ:* ${data.wind.speed} m/s
🔽 *ᴘʀᴇssᴜʀᴇ:* ${data.main.pressure} hPa
    `;

    await socket.sendMessage(sender, {
      text: `🌤 *ᴡᴇᴀᴛʜᴇʀ ʀᴇᴘᴏʀᴛ* 🌤\n\n${weatherMessage}\n\n> ${userCfg.BOT_FOOTER}`
    }, { quoted: msg });

  } catch (error) {
    console.error('Weather command error:', error.message);
    let errorMessage = `❌ *ᴏʜ, ʟᴏᴠᴇ, ᴄᴏᴜʟᴅɴ'ᴛ ғᴇᴛᴄʜ ᴛʜᴇ ᴡᴇᴀᴛʜᴇʀ! 😢*\n` +
                      `💡 *ᴛʀʏ ᴀɢᴀɪɴ, ᴅᴀʀʟɪɴɢ?*`;
    if (error.message.includes('404')) {
      errorMessage = `🚫 *ᴄɪᴛʏ ɴᴏᴛ ғᴏᴜɴᴅ, sᴡᴇᴇᴛɪᴇ.*\n` +
                     `💡 *ᴘʟᴇᴀsᴇ ᴄʜᴇᴄᴋ ᴛʜᴇ sᴘᴇʟʟɪɴɢ ᴀɴᴅ ᴛʀʏ ᴀɢᴀɪɴ.*`;
    } else if (error.message.includes('network') || error.message.includes('timeout')) {
      errorMessage = `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ғᴇᴛᴄʜ ᴡᴇᴀᴛʜᴇʀ:* ${error.message}\n` +
                     `💡 *ᴘʟᴇᴀsᴇ ᴛʀʏ ᴀɢᴀɪɴ ʟᴀᴛᴇʀ, ʙᴀʙᴇ.*`;
    }
    await socket.sendMessage(sender, { text: errorMessage }, { quoted: msg });
  }
  break;
}

case 'savestatus': {
  try {
    await socket.sendMessage(sender, { react: { text: '💾', key: msg.key } });

    if (!msg.quoted || !msg.quoted.statusMessage) {
      await socket.sendMessage(sender, {
        text: `📌 *ʀᴇᴘʟʏ ᴛᴏ ᴀ sᴛᴀᴛᴜs ᴛᴏ sᴀᴠᴇ ɪᴛ, ᴅᴀʀʟɪɴɢ!* 😘`
      }, { quoted: msg });
      break;
    }

    await socket.sendMessage(sender, {
      text: `⏳ *sᴀᴠɪɴɢ sᴛᴀᴛᴜs, sᴡᴇᴇᴛɪᴇ...* 😘`
    }, { quoted: msg });

    const media = await socket.downloadMediaMessage(msg.quoted);
    const fileExt = msg.quoted.imageMessage ? 'jpg' : 'mp4';
    const filePath = `./status_${Date.now()}.${fileExt}`;
    fs.writeFileSync(filePath, media);

    await socket.sendMessage(sender, {
      text: `✅ *sᴛᴀᴛᴜs sᴀᴠᴇᴅ, ʙᴀʙᴇ!* 😘\n` +
            `📁 *ғɪʟᴇ:* status_${Date.now()}.${fileExt}\n` +
            `> ${userCfg.BOT_FOOTER}`,
      document: { url: filePath },
      mimetype: msg.quoted.imageMessage ? 'image/jpeg' : 'video/mp4',
      fileName: `status_${Date.now()}.${fileExt}`
    }, { quoted: msg });

  } catch (error) {
    console.error('Savestatus command error:', error.message);
    await socket.sendMessage(sender, {
      text: `❌ *ᴏʜ, ʟᴏᴠᴇ, ᴄᴏᴜʟᴅɴ'ᴛ sᴀᴠᴇ ᴛʜᴀᴛ sᴛᴀᴛᴜs! 😢*\n` +
            `💡 *ᴛʀʏ ᴀɢᴀɪɴ, ᴅᴀʀʟɪɴɢ?*`
    }, { quoted: msg });
  }
  break;
}

case 'sticker':
case 's': {
    await socket.sendMessage(sender, { react: { text: '✨', key: msg.key } });

    try {
        let quoted = msg.quoted ? msg.quoted : msg;
        let mime = (quoted.msg || quoted).mimetype || '';

        if (!mime) {
            return socket.sendMessage(from, { text: '⚠️ ʀᴇᴘʟʏ ᴡɪᴛʜ ᴀɴ ɪᴍᴀɢᴇ/ᴠɪᴅᴇᴏ ᴛᴏ ᴍᴀᴋᴇ ᴀ sᴛɪᴄᴋᴇʀ!' }, { quoted: msg });
        }

        if (/image|video/.test(mime)) {
            let media = await quoted.download();
            await socket.sendMessage(from, { 
                sticker: media 
            }, { quoted: msg });
        } else {
            await socket.sendMessage(from, { text: '❌ ᴏɴʟʏ ɪᴍᴀɢᴇ ᴏʀ ᴠɪᴅᴇᴏ ᴀʟʟᴏᴡᴇᴅ ᴛᴏ ᴄʀᴇᴀᴛᴇ sᴛɪᴄᴋᴇʀ!' }, { quoted: msg });
        }
    } catch (error) {
        console.error('Error in .sticker command:', error);
        await socket.sendMessage(from, { text: '💔 ғᴀɪʟᴇᴅ ᴛᴏ ᴄʀᴇᴀᴛᴇ sᴛɪᴄᴋᴇʀ. ᴛʀʏ ᴀɢᴀɪɴ!' }, { quoted: msg });
    }
    break;
}

case 'url': {
  try {
    await socket.sendMessage(sender, { react: { text: '📤', key: msg.key || {} } });

    console.log('Message:', JSON.stringify(msg, null, 2));
    const quoted = msg.quoted || msg;
    console.log('Quoted:', JSON.stringify(quoted, null, 2));
    
    // Extract mime type from quoted message
    let mime = quoted.mimetype || '';
    if (!mime && quoted.message) {
      const messageType = Object.keys(quoted.message)[0];
      const mimeMap = {
        imageMessage: 'image/jpeg',
        videoMessage: 'video/mp4',
        audioMessage: 'audio/mpeg',
        documentMessage: 'application/octet-stream'
      };
      mime = mimeMap[messageType] || '';
    }

    console.log('MIME Type:', mime);

    if (!mime || !['image', 'video', 'audio', 'application'].some(type => mime.includes(type))) {
      await socket.sendMessage(sender, {
        text: `❌ *ʀᴇᴘʟʏ ᴛᴏ ɪᴍᴀɢᴇ, ᴀᴜᴅɪᴏ, ᴏʀ ᴠɪᴅᴇᴏ!*\n` +
              `Detected type: ${mime || 'none'}`
      }, { quoted: msg });
      break;
    }

    await socket.sendMessage(sender, {
      text: `⏳ *ᴜᴘʟᴏᴀᴅɪɴɢ ғɪʟᴇ...*`
    }, { quoted: msg });

    const buffer = await socket.downloadMediaMessage(quoted);
    if (!buffer || buffer.length === 0) {
      throw new Error('Failed to download media: Empty buffer');
    }

    // Determine file extension
    const ext = mime.includes('image/jpeg') ? '.jpg' :
                mime.includes('image/png') ? '.png' :
                mime.includes('image/gif') ? '.gif' :
                mime.includes('video') ? '.mp4' :
                mime.includes('audio') ? '.mp3' : '.bin';
    
    const name = `file_${Date.now()}${ext}`;
    const tmp = path.join(os.tmpdir(), name);
    
    // Ensure the tmp directory exists
    if (!fs.existsSync(os.tmpdir())) {
      fs.mkdirSync(os.tmpdir(), { recursive: true });
    }
    
    fs.writeFileSync(tmp, buffer);
    console.log('Saved file to:', tmp);

    const form = new FormData();
    form.append('fileToUpload', fs.createReadStream(tmp), name);
    form.append('reqtype', 'fileupload');

    const res = await axios.post('https://catbox.moe/user/api.php', form, {
      headers: form.getHeaders(),
      timeout: 30000 // 30 second timeout
    });

    // Clean up temporary file
      
          if (fs.existsSync(tmp)) {
      fs.unlinkSync(tmp);
    }

    if (!res.data || res.data.includes('error')) {
      throw new Error(`Upload failed: ${res.data || 'No response data'}`);
    }

    const type = mime.includes('image') ? 'ɪᴍᴀɢᴇ' :
                 mime.includes('video') ? 'ᴠɪᴅᴇᴏ' :
                 mime.includes('audio') ? 'ᴀᴜᴅɪᴏ' : 'ғɪʟᴇ';

    await socket.sendMessage(sender, {
      text: `✅ *${type} ᴜᴘʟᴏᴀᴅᴇᴅ!*\n\n` +
            `📁 *sɪᴢᴇ:* ${formatBytes(buffer.length)}\n` +
            `🔗 *ᴜʀʟ:* ${res.data}\n\n` +
            `${userCfg.BOT_FOOTER}`
    }, { quoted: msg });

    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key || {} } });
  } catch (error) {
    console.error('tourl2 error:', error.message, error.stack);
    
    // Clean up temporary file if it exists
    if (tmp && fs.existsSync(tmp)) {
      try {
        fs.unlinkSync(tmp);
      } catch (e) {
        console.error('Error cleaning up temp file:', e.message);
      }
    }
    
    await socket.sendMessage(sender, {
      text: `❌ *ᴄᴏᴜʟᴅɴ'ᴛ ᴜᴘʟᴏᴀᴅ ᴛʜᴀᴛ ғɪʟᴇ! 😢*\n` +
            `ᴇʀʀᴏʀ: ${error.message || 'sᴏᴍᴇᴛʜɪɴɢ ᴡᴇɴᴛ ᴡʀᴏɴɢ'}\n` +
            `💡 *ᴛʀʏ ᴀɢᴀɪɴ, ᴅᴀʀʟɪɴɢ?*`
    }, { quoted: msg });
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key || {} } });
  }
  break;
}
case 'tourl2': {
  try {
    await socket.sendMessage(sender, { react: { text: '📤', key: msg.key || {} } });

    console.log('Message:', JSON.stringify(msg, null, 2));
    const quoted = msg.quoted || msg;
    console.log('Quoted:', JSON.stringify(quoted, null, 2));
    const mime = quoted.mimetype || (quoted.message ? Object.keys(quoted.message)[0] : '');

    console.log('MIME Type or Message Type:', mime);

    // Map message types to MIME types if mimetype is unavailable
    const mimeMap = {
      imageMessage: 'image/jpeg',
      videoMessage: 'video/mp4',
      audioMessage: 'audio/mp3'
    };
    const effectiveMime = mimeMap[mime] || mime;

    if (!effectiveMime || !['image', 'video', 'audio'].some(type => effectiveMime.includes(type))) {
      await socket.sendMessage(sender, {
        text: `❌ *ʀᴇᴘʟʏ ᴛᴏ ɪᴍᴀɢᴇ, ᴀᴜᴅɪᴏ, ᴏʀ ᴠɪᴅᴇᴏ!*\n` +
              `ᴅᴇᴛᴇᴄᴛᴇᴅ ᴛʏᴘᴇ: ${effectiveMime || 'none'}`
      }, { quoted: msg });
      break;
    }

    await socket.sendMessage(sender, {
      text: `⏳ *ᴜᴘʟᴏᴀᴅɪɴɢ ғɪʟᴇ...*`
    }, { quoted: msg });

    const buffer = await socket.downloadMediaMessage(quoted);
    if (!buffer || buffer.length === 0) {
      throw new Error('Failed to download media: Empty buffer');
    }

    const ext = effectiveMime.includes('image/jpeg') ? '.jpg' :
                effectiveMime.includes('image/png') ? '.png' :
                effectiveMime.includes('video') ? '.mp4' :
                effectiveMime.includes('audio') ? '.mp3' : '.bin';
    const name = `file_${Date.now()}${ext}`;
    const tmp = path.join(os.tmpdir(), `catbox_${Date.now()}${ext}`);
    fs.writeFileSync(tmp, buffer);
    console.log('Saved file to:', tmp);

    const form = new FormData();
    form.append('fileToUpload', fs.createReadStream(tmp), name);
    form.append('reqtype', 'fileupload');

    const res = await axios.post('https://catbox.moe/user/api.php', form, {
      headers: form.getHeaders()
    });

    fs.unlinkSync(tmp);

    if (!res.data || res.data.includes('error')) {
      throw new Error(`Upload failed: ${res.data || 'No response data'}`);
    }

    const type = effectiveMime.includes('image') ? 'ɪᴍᴀɢᴇ' :
                 effectiveMime.includes('video') ? 'ᴠɪᴅᴇᴏ' :
                 effectiveMime.includes('audio') ? 'ᴀᴜᴅɪᴏ' : 'ғɪʟᴇ';

    await socket.sendMessage(sender, {
      text: `✅ *${type} ᴜᴘʟᴏᴀᴅᴇᴅ!*\n\n` +
            `📁 *sɪᴢᴇ:* ${formatBytes(buffer.length)}\n` +
            `🔗 *ᴜʀʟ:* ${res.data}\n\n` +
            `${userCfg.BOT_FOOTER}`
    }, { quoted: msg });

    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key || {} } });
  } catch (error) {
    console.error('tourl2 error:', error.message, error.stack);
    await socket.sendMessage(sender, {
      text: `❌ *ᴏʜ, ʟᴏᴠᴇ, ᴄᴏᴜʟᴅɴ'ᴛ ᴜᴘʟᴏᴀᴅ ᴛʜᴀᴛ ғɪʟᴇ! 😢*\n` +
            `ᴇʀʀᴏʀ: ${error.message || 'sᴏᴍᴇᴛʜɪɴɢ ᴡᴇɴᴛ ᴡʀᴏɴɢ'}\n` +
            `💡 *ᴛʀʏ ᴀɢᴀɪɴ, ᴅᴀʀʟɪɴɢ?*`
    }, { quoted: msg });
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key || {} } });
  }
  break;
}
    
    case 'whois': {
        try {
            await socket.sendMessage(sender, { react: { text: '👤', key: msg.key } });
            const domain = args[0];
            if (!domain) {
                await socket.sendMessage(sender, { text: '📌 ᴜsᴀɢᴇ: .whois <domain>' }, { quoted: fakevCard });
                break;
            }
            const response = await fetch(`http://api.whois.vu/?whois=${encodeURIComponent(domain)}`);
            const data = await response.json();
            if (!data.domain) {
                throw new Error('Domain not found');
            }
            const whoisMessage = formatMessage(
                '🔍 𝐖𝐇𝐎𝐈𝐒 𝐋𝐎𝐎𝐊𝐔𝐏',
                `🌐 ᴅᴏᴍᴀɪɴ: ${data.domain}\n` +
                `📅 ʀᴇɢɪsᴛᴇʀᴇᴅ: ${data.created_date || 'N/A'}\n` +
                `⏰ ᴇxᴘɪʀᴇs: ${data.expiry_date || 'N/A'}\n` +
                `📋 ʀᴇɢɪsᴛʀᴀʀ: ${data.registrar || 'N/A'}\n` +
                `📍 sᴛᴀᴛᴜs: ${data.status.join(', ') || 'N/A'}`,
                userCfg.BOT_FOOTER
            );
            await socket.sendMessage(sender, { text: whoisMessage }, { quoted: fakevCard });
        } catch (error) {
            console.error('Whois command error:', error);
            await socket.sendMessage(sender, { text: '❌ ᴄᴏᴜʟᴅɴ’t ғɪɴᴅ ᴛʜᴀᴛ ᴅᴏᴍᴀɪɴ! 😢 ᴛʀʏ ᴀɢᴀɪɴ?' }, { quoted: fakevCard });
        }
        break;
    }
      
      case 'repo':
case 'sc':
case 'script': {
    try {
        await socket.sendMessage(sender, { react: { text: '🪄', key: msg.key } });
        const githubRepoURL = 'https://github.com/sylvainbetty91-sys/Dracula';
        
        const [, username, repo] = githubRepoURL.match(/github\.com\/([^/]+)\/([^/]+)/);
        const response = await fetch(`https://api.github.com/repos/${username}/${repo}`);
        
        if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
        
        const repoData = await response.json();

        const formattedInfo = `
    ${userCfg.BOT_NAME}
╭───────────────⭓
│ ɴᴀᴍᴇ: ${repoData.name}
│ sᴛᴀʀs: ${repoData.stargazers_count}
│ ғᴏʀᴋs: ${repoData.forks_count}
│ ᴏᴡɴᴇʀ: ${userCfg.OWNER_NAME}
│ ᴅᴇsᴄ: ${repoData.description || 'ɴ/ᴀ'}
╰───────────────⭓
> ${userCfg.BOT_FOOTER}
`;

        const repoMessage = {
            image: { url: 'https://files.catbox.moe/bm2v7m.jpg' },
            caption: formattedInfo,
            buttons: [
                {
                    buttonId: `${userCfg.PREFIX}repo-visit`,
                    buttonText: { displayText: '🌐 ᴠɪsɪᴛ ʀᴇᴘᴏ' },
                    type: 1
                },
                {
                    buttonId: `${userCfg.PREFIX}repo-owner`,
                    buttonText: { displayText: '👑 ᴏᴡɴᴇʀ ᴘʀᴏғɪʟᴇ' },
                    type: 1
                }
            ],
            contextInfo: {
                mentionedJid: [m.sender],
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: config.NEWSLETTER_JID || config.NEWSLETTER_JID,
                    newsletterName: userCfg.BOT_FOOTER,
                    serverMessageId: 143
                }
            }
        };

        await socket.sendMessage(sender, repoMessage, { quoted: fakevCard });

    } catch (error) {
        console.error("❌ Error in repo command:", error);
        await socket.sendMessage(sender, { 
            text: "⚠️ Failed to fetch repo info. Please try again later." 
        }, { quoted: fakevCard });
    }
    break;
}

case 'repo-visit': {
    await socket.sendMessage(sender, { react: { text: '🌐', key: msg.key } });
    await socket.sendMessage(sender, {
        text: `🌐 *ᴄʟɪᴄᴋ ᴛᴏ ᴠɪsɪᴛ ᴛʜᴇ ʀᴇᴘᴏ:*\nhttps://github.com/sylvainbetty91-sys/Dracula`,
        contextInfo: {
            externalAdReply: {
                title: 'Visit Repository',
                body: 'Open in browser',
                mediaType: 1,
                mediaUrl: 'https://github.com/sylvainbetty91-sys/Dracula',
                sourceUrl: 'https://github.com/sylvainbetty91-sys/Dracula'
            }
        }
    }, { quoted: fakevCard });
    break;
}

case 'repo-owner': {
    await socket.sendMessage(sender, { react: { text: '👑', key: msg.key } });
    await socket.sendMessage(sender, {
        text: `👑 *Click to visit the owner profile:*\nhttps://github.com/sylvainbetty91-sys`,
        contextInfo: {
            externalAdReply: {
                title: 'Owner Profile',
                body: 'Open in browser',
                mediaType: 1,
                mediaUrl: 'https://github.com/sylvainbetty91-sys',
                sourceUrl: 'https://github.com/sylvainbetty91-sys'
            }
        }
    }, { quoted: fakevCard });
    break;
}

                case 'deleteme':
                    const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                    if (fs.existsSync(sessionPath)) {
                        fs.removeSync(sessionPath);
                    }
                    await deleteSessionFromGitHub(number);
                    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
                        activeSockets.get(number.replace(/[^0-9]/g, '')).ws.close();
                        activeSockets.delete(number.replace(/[^0-9]/g, ''));
                        socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                    }
                    await socket.sendMessage(sender, {
                        image: { url: userCfg.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🗑️ SESSION DELETED',
                            '✅ Your session has been successfully deleted.',
                            userCfg.BOT_FOOTER
                        )
                    });
                    break;
                    
// more future commands

// ╔══════════════════════════════════════════════════════════════════════╗
// ║   COMMANDES DE CONFIGURATION — owner only — isolées par session     ║
// ║   Chaque bot a ses propres réglages dans configs/<numero>.json      ║
// ║   Les filleuls héritent des réglages du parrain au démarrage        ║
// ╚══════════════════════════════════════════════════════════════════════╝

// ─── .setbotname <nom> ────────────────────────────────────────────────────
case 'setbotname': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ *ᴏᴡɴᴇʀ ᴏɴʟʏ!*' }, { quoted: m }); break; }
    const val = args.join(' ').trim();
    if (!val) { await socket.sendMessage(sender, { text: `ℹ️ *Usage:* ${userCfg.PREFIX}setbotname <nom>` }, { quoted: m }); break; }
    userCfg.BOT_NAME = val;
    saveUserConfig(sanitizedNumber, userCfg);
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, {
        text: `✅ *Nom du bot mis à jour!*\n╭───────────────⭓\n│ 🤖 *${val}*\n╰───────────────⭓\n${userCfg.BOT_FOOTER}`
    }, { quoted: m });
    break;
}

// ─── .setownername <nom> ─────────────────────────────────────────────────
case 'setownername': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ *ᴏᴡɴᴇʀ ᴏɴʟʏ!*' }, { quoted: m }); break; }
    const val = args.join(' ').trim();
    if (!val) { await socket.sendMessage(sender, { text: `ℹ️ *Usage:* ${userCfg.PREFIX}setownername <nom>` }, { quoted: m }); break; }
    userCfg.OWNER_NAME = val;
    saveUserConfig(sanitizedNumber, userCfg);
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, {
        text: `✅ *Nom de l'owner mis à jour!*\n╭───────────────⭓\n│ 👑 *${val}*\n╰───────────────⭓\n${userCfg.BOT_FOOTER}`
    }, { quoted: m });
    break;
}

// ─── .setownernumber <numéro> ────────────────────────────────────────────
case 'setownernumber': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ *ᴏᴡɴᴇʀ ᴏɴʟʏ!*' }, { quoted: m }); break; }
    const val = args[0]?.replace(/[^0-9]/g, '');
    if (!val || val.length < 8) { await socket.sendMessage(sender, { text: `ℹ️ *Usage:* ${userCfg.PREFIX}setownernumber <numéro>` }, { quoted: m }); break; }
    userCfg.OWNER_NUMBER = val;
    saveUserConfig(sanitizedNumber, userCfg);
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, {
        text: `✅ *Numéro owner mis à jour!*\n╭───────────────⭓\n│ 📞 *${val}*\n╰───────────────⭓\n${userCfg.BOT_FOOTER}`
    }, { quoted: m });
    break;
}

// ─── .setlinkchannel <url> ───────────────────────────────────────────────
case 'setlinkchannel': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ *ᴏᴡɴᴇʀ ᴏɴʟʏ!*' }, { quoted: m }); break; }
    const val = args[0]?.trim();
    if (!val || !val.startsWith('https://')) { await socket.sendMessage(sender, { text: `ℹ️ *Usage:* ${userCfg.PREFIX}setlinkchannel https://...` }, { quoted: m }); break; }
    userCfg.CHANNEL_LINK = val;
    saveUserConfig(sanitizedNumber, userCfg);
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, {
        text: `✅ *Lien channel mis à jour!*\n╭───────────────⭓\n│ 📢 ${val}\n╰───────────────⭓\n${userCfg.BOT_FOOTER}`
    }, { quoted: m });
    break;
}

// ─── .setlinkgroup <url> ─────────────────────────────────────────────────
case 'setlinkgroup': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ *ᴏᴡɴᴇʀ ᴏɴʟʏ!*' }, { quoted: m }); break; }
    const val = args[0]?.trim();
    if (!val || !val.startsWith('https://')) { await socket.sendMessage(sender, { text: `ℹ️ *Usage:* ${userCfg.PREFIX}setlinkgroup https://...` }, { quoted: m }); break; }
    userCfg.GROUP_INVITE_LINK = val;
    saveUserConfig(sanitizedNumber, userCfg);
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, {
        text: `✅ *Lien groupe mis à jour!*\n╭───────────────⭓\n│ 👥 ${val}\n╰───────────────⭓\n${userCfg.BOT_FOOTER}`
    }, { quoted: m });
    break;
}

// ─── .setbotpp  (cite image OU url) ──────────────────────────────────────
case 'setbotpp': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ *ᴏᴡɴᴇʀ ᴏɴʟʏ!*' }, { quoted: m }); break; }
    try {
        let imgBuffer = null, imgUrl = null;
        if (m.quoted && m.quoted.type === 'imageMessage') {
            imgBuffer = await m.quoted.download();
        } else if (args[0]?.startsWith('http')) {
            imgUrl = args[0].trim();
            const r = await axios.get(imgUrl, { responseType: 'arraybuffer' });
            imgBuffer = Buffer.from(r.data);
        } else {
            await socket.sendMessage(sender, { text: `ℹ️ Cite une image + ${userCfg.PREFIX}setbotpp\nOU: ${userCfg.PREFIX}setbotpp <url>` }, { quoted: m });
            break;
        }
        const resized = await resize(imgBuffer, 640, 640);
        await socket.updateProfilePicture(socket.user.id, resized);
        if (imgUrl) { userCfg.IMAGE_PATH = imgUrl; userCfg.RCD_IMAGE_PATH = imgUrl; }
        saveUserConfig(sanitizedNumber, userCfg);
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
        await socket.sendMessage(sender, { text: `✅ *Photo de profil mise à jour!*\n${userCfg.BOT_FOOTER}` }, { quoted: m });
    } catch (err) {
        await socket.sendMessage(sender, { text: `❌ Erreur: ${err.message}` }, { quoted: m });
    }
    break;
}

// ─── .setprefix <caractère> ──────────────────────────────────────────────
case 'setprefix': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ *ᴏᴡɴᴇʀ ᴏɴʟʏ!*' }, { quoted: m }); break; }
    const val = args[0]?.trim();
    if (!val || val.length > 3) { await socket.sendMessage(sender, { text: `ℹ️ *Usage:* ${userCfg.PREFIX}setprefix .\nMax 3 caractères.` }, { quoted: m }); break; }
    userCfg.PREFIX = val;
    saveUserConfig(sanitizedNumber, userCfg);
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, {
        text: `✅ *Préfixe mis à jour!*\n╭───────────────⭓\n│ ⌨️ Nouveau préfixe: *${val}*\n│ Exemple: *${val}menu*\n╰───────────────⭓\n${userCfg.BOT_FOOTER}`
    }, { quoted: m });
    break;
}

// ─── .setfooter <texte> ──────────────────────────────────────────────────
case 'setfooter': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ *ᴏᴡɴᴇʀ ᴏɴʟʏ!*' }, { quoted: m }); break; }
    const val = args.join(' ').trim();
    if (!val) { await socket.sendMessage(sender, { text: `ℹ️ *Usage:* ${userCfg.PREFIX}setfooter <texte>` }, { quoted: m }); break; }
    userCfg.BOT_FOOTER = `> ${val}`;
    saveUserConfig(sanitizedNumber, userCfg);
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, {
        text: `✅ *Footer mis à jour!*\n╭───────────────⭓\n│ > ${val}\n╰───────────────⭓`
    }, { quoted: m });
    break;
}

// ─── .autoview on/off ────────────────────────────────────────────────────
case 'autoview': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ *ᴏᴡɴᴇʀ ᴏɴʟʏ!*' }, { quoted: m }); break; }
    const val = args[0]?.toLowerCase();
    if (val !== 'on' && val !== 'off') { await socket.sendMessage(sender, { text: `ℹ️ *Usage:* ${userCfg.PREFIX}autoview on/off` }, { quoted: m }); break; }
    userCfg.AUTO_VIEW_STATUS = val === 'on' ? 'true' : 'false';
    saveUserConfig(sanitizedNumber, userCfg);
    await socket.sendMessage(sender, { react: { text: val === 'on' ? '👁️' : '🚫', key: msg.key } });
    await socket.sendMessage(sender, {
        text: `${val === 'on' ? '👁️' : '🚫'} *Vue automatique des statuts: ${val.toUpperCase()}*\n${userCfg.BOT_FOOTER}`
    }, { quoted: m });
    break;
}

// ─── .autolike on/off ────────────────────────────────────────────────────
case 'autolike': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ *ᴏᴡɴᴇʀ ᴏɴʟʏ!*' }, { quoted: m }); break; }
    const val = args[0]?.toLowerCase();
    if (val !== 'on' && val !== 'off') { await socket.sendMessage(sender, { text: `ℹ️ *Usage:* ${userCfg.PREFIX}autolike on/off` }, { quoted: m }); break; }
    userCfg.AUTO_LIKE_STATUS = val === 'on' ? 'true' : 'false';
    saveUserConfig(sanitizedNumber, userCfg);
    await socket.sendMessage(sender, { react: { text: val === 'on' ? '❤️' : '🚫', key: msg.key } });
    await socket.sendMessage(sender, {
        text: `${val === 'on' ? '❤️' : '🚫'} *Like auto des statuts: ${val.toUpperCase()}*\n${userCfg.BOT_FOOTER}`
    }, { quoted: m });
    break;
}

// ─── .autorec on/off ─────────────────────────────────────────────────────
case 'autorec': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ *ᴏᴡɴᴇʀ ᴏɴʟʏ!*' }, { quoted: m }); break; }
    const val = args[0]?.toLowerCase();
    if (val !== 'on' && val !== 'off') { await socket.sendMessage(sender, { text: `ℹ️ *Usage:* ${userCfg.PREFIX}autorec on/off` }, { quoted: m }); break; }
    userCfg.AUTO_RECORDING = val === 'on' ? 'true' : 'false';
    saveUserConfig(sanitizedNumber, userCfg);
    await socket.sendMessage(sender, { react: { text: val === 'on' ? '🎙️' : '🚫', key: msg.key } });
    await socket.sendMessage(sender, {
        text: `${val === 'on' ? '🎙️' : '🚫'} *Auto recording: ${val.toUpperCase()}*\n${userCfg.BOT_FOOTER}`
    }, { quoted: m });
    break;
}

// ─── .mysettings — affiche la config active ──────────────────────────────
case 'mysettings': {
    const lineage = loadLineage(sanitizedNumber);
    await socket.sendMessage(sender, { react: { text: '⚙️', key: msg.key } });
    await socket.sendMessage(sender, {
        text: `⚙️ *Mes réglages actuels*\n\n` +
              `╭───────────────⭓\n` +
              `│ 🤖 ʙᴏᴛ: *${userCfg.BOT_NAME}*\n` +
              `│ 👑 ᴏᴡɴᴇʀ: *${userCfg.OWNER_NAME}*\n` +
              `│ 📞 ɴᴜᴍÉʀᴏ: *${userCfg.OWNER_NUMBER}*\n` +
              `│ ⌨️ ᴘʀÉғɪxᴇ: *${userCfg.PREFIX}*\n` +
              `│ 📢 ᴄʜᴀɴɴᴇʟ: ${userCfg.CHANNEL_LINK}\n` +
              `│ 👥 ɢʀᴏᴜᴘᴇ: ${userCfg.GROUP_INVITE_LINK || 'non défini'}\n` +
              `│ 👁️ ᴀᴜᴛᴏᴠɪᴇᴡ: ${userCfg.AUTO_VIEW_STATUS === 'true' ? 'ON ✅' : 'OFF 🚫'}\n` +
              `│ ❤️ ᴀᴜᴛᴏʟɪᴋᴇ: ${userCfg.AUTO_LIKE_STATUS === 'true' ? 'ON ✅' : 'OFF 🚫'}\n` +
              `│ 🎙️ ᴀᴜᴛᴏʀᴇᴄ: ${userCfg.AUTO_RECORDING === 'true' ? 'ON ✅' : 'OFF 🚫'}\n` +
              `│ 🔗 ᴘᴀʀʀᴀɪɴ: ${lineage?.parrainedBy || 'Site officiel'}\n` +
              `╰───────────────⭓\n` +
              `${userCfg.BOT_FOOTER}`
    }, { quoted: m });
    break;
}

// ─── .delmodifications — reset complet vers les valeurs par défaut ────────
case 'delmodifications': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ *ᴏᴡɴᴇʀ ᴏɴʟʏ!*' }, { quoted: m }); break; }
    try {
        const deleted = deleteUserConfig(sanitizedNumber);
        // Reconstruire depuis zéro (héritage parrain mais sans mes propres modifs)
        const fresh = buildUserConfig(sanitizedNumber);
        userConfigs.set(sanitizedNumber, fresh);
        await socket.sendMessage(sender, { react: { text: '🔄', key: msg.key } });
        await socket.sendMessage(sender, {
            text: `🔄 *Réinitialisé!*\n\n` +
                  `╭───────────────⭓\n` +
                  `│ 🤖 ʙᴏᴛ: *${fresh.BOT_NAME}*\n` +
                  `│ 👑 ᴏᴡɴᴇʀ: *${fresh.OWNER_NAME}*\n` +
                  `│ 📞 ɴᴜᴍÉʀᴏ: *${fresh.OWNER_NUMBER}*\n` +
                  `│ ⌨️ ᴘʀÉғɪxᴇ: *${fresh.PREFIX}*\n` +
                  `│ 🗑️ ғɪᴄʜɪᴇʀ: ${deleted ? 'supprimé ✅' : 'déjà vide'}\n` +
                  `╰───────────────⭓\n` +
                  `${fresh.BOT_FOOTER}`
        }, { quoted: m });
    } catch (err) {
        await socket.sendMessage(sender, { text: `❌ Erreur: ${err.message}` }, { quoted: m });
    }
    break;
}

// ─── .wapair <numéro> — pair une personne depuis WhatsApp ────────────────
// La personne pairée hérite de ta config actuelle au démarrage
case 'wapair': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '❌ *ᴏᴡɴᴇʀ ᴏɴʟʏ!*' }, { quoted: m }); break; }
    try {
        const rawNum = args[0]?.replace(/[^0-9]/g, '').trim();
        if (!rawNum || rawNum.length < 8) {
            await socket.sendMessage(sender, {
                text: `ℹ️ *Usage:* ${userCfg.PREFIX}wapair <numéro>\n*Exemple:* ${userCfg.PREFIX}wapair 50933768213\n\n_La personne recevra un code de connexion et héritera de tes réglages actuels._`
            }, { quoted: m });
            break;
        }

        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        // Appel à l'API de pairing interne
        const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
        const url = `https://Dracula-4a3k.onrender.com/code?number=${encodeURIComponent(rawNum)}`;
        const response = await fetch(url);
        const bodyText = await response.text();

        let result;
        try { result = JSON.parse(bodyText); } catch (e) {
            await socket.sendMessage(sender, { text: '❌ Réponse invalide du serveur.' }, { quoted: m });
            break;
        }

        if (!result?.code) {
            await socket.sendMessage(sender, { text: '❌ Impossible de générer le code. Vérifie le numéro.' }, { quoted: m });
            break;
        }

        // ── Enregistrer le lignage AVANT que la session s'ouvre ────────────
        // On sauvegarde aussi une copie des configs actuelles du parrain
        // pour que le filleul les hérite au moment de sa connexion
        saveLineage(rawNum, sanitizedNumber);
        console.log(`[lineage] ${rawNum} pairé par ${sanitizedNumber}`);

        // Envoyer le code au demandeur (parrain)
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
        await socket.sendMessage(sender, {
            text: `✅ *Code généré pour* +${rawNum}\n\n` +
                  `╭───────────────⭓\n` +
                  `│ 🔑 ᴄᴏᴅᴇ: *${result.code}*\n` +
                  `│ 📞 ɴᴜᴍÉʀᴏ: +${rawNum}\n` +
                  `│ 🔗 ʜÉʀɪᴛᴇʀᴀ ᴅᴇ: tes réglages actuels\n` +
                  `╰───────────────⭓\n` +
                  `_Envoie ce code à la personne. Elle le saisit dans WhatsApp > Appareils connectés._\n\n` +
                  `${userCfg.BOT_FOOTER}`
        }, { quoted: m });

        // Envoyer aussi le code brut pour copier-coller facile
        await delay(1500);
        await socket.sendMessage(sender, { text: `${result.code}` }, { quoted: m });

        // Envoyer une notif directe au filleul s'il est joignable
        try {
            const filleulJid = `${rawNum}@s.whatsapp.net`;
            await socket.sendMessage(filleulJid, {
                image: { url: userCfg.IMAGE_PATH },
                caption: `👋 *Tu as été invité à rejoindre ${userCfg.BOT_NAME}!*\n\n` +
                          `╭───────────────⭓\n` +
                          `│ 🔑 ᴄᴏᴅᴇ ᴅᴇ ᴄᴏɴɴᴇxɪᴏɴ:\n` +
                          `│ *${result.code}*\n` +
                          `│\n` +
                          `│ 📋 *Comment faire:*\n` +
                          `│ 1. Ouvre WhatsApp\n` +
                          `│ 2. ⋮ > Appareils connectés\n` +
                          `│ 3. Connecter un appareil\n` +
                          `│ 4. Saisis ce code\n` +
                          `╰───────────────⭓\n` +
                          `${userCfg.BOT_FOOTER}`
            });
        } catch (notifErr) {
            console.warn(`[wapair] Impossible de notifier ${rawNum}:`, notifErr.message);
        }

    } catch (err) {
        console.error('wapair error:', err);
        await socket.sendMessage(sender, { text: `❌ Erreur: ${err.message}` }, { quoted: m });
    }
    break;
}

// ══════════════════════════════════════════════════════════════════════

// ─── .cn / checknumber ───────────────────────────────────────────────
case 'cn':
case 'checknumber': {
    const cnInput = args.join(' ').trim();
    if (!cnInput) {
        await socket.sendMessage(sender, {
            text: `${userCfg.BOT_NAME}\n\n✪ *ᴜsᴀɢᴇ:* ${userCfg.PREFIX}cn +336XXXXXXXX`
        }, { quoted: m });
        break;
    }
    let cnNumber = cnInput.replace('+', '').replace(/ /g, '').replace(/-/g, '');
    await socket.sendMessage(sender, {
        text: `${userCfg.BOT_NAME}\n\n✪ *ᴄʜᴇᴄᴋɪɴɢ ɴᴜᴍʙᴇʀ...*`
    }, { quoted: m });
    try {
        const [cnResult] = await socket.onWhatsApp(cnNumber + '@s.whatsapp.net');
        if (cnResult?.exists) {
            await socket.sendMessage(sender, {
                text: `${userCfg.BOT_NAME}\n\n✪ *ɴᴜᴍʙᴇʀ:* ${cnInput}\n✪ *sᴛᴀᴛᴜs:* ᴀᴄᴛɪꜰ ✅`
            }, { quoted: m });
        } else {
            await socket.sendMessage(sender, {
                text: `${userCfg.BOT_NAME}\n\n✪ *ɴᴜᴍʙᴇʀ:* ${cnInput}\n✪ *sᴛᴀᴛᴜs:* ɪɴᴠᴀʟɪᴅ ❌`
            }, { quoted: m });
        }
    } catch (cnErr) {
        await socket.sendMessage(sender, {
            text: `❌ Erreur lors de la vérification: ${cnErr.message}`
        }, { quoted: m });
    }
    break;
}

// ─── .infostart ───────────────────────────────────────────────────────
case 'infostart': {
    const dbIs = await loadJournal() || {};
    if (!dbIs.start || !dbIs.start.content) {
        await socket.sendMessage(sender, { text: '❌ Aucun journal' }, { quoted: m });
        break;
    }
    const isText = (dbIs.start.content || '').replace(/https?:\/\/\S+/g, '').trim();
    const isImage = dbIs.start.image;
    if (isImage) {
        await socket.sendMessage(sender, {
            image: { url: isImage },
            caption: isText || ''
        }, { quoted: m });
    } else {
        await socket.sendMessage(sender, { text: isText || '' }, { quoted: m });
    }
    break;
}

// ─── .addinfostart ────────────────────────────────────────────────────
case 'addinfostart': {
    const dbAis = await loadJournal() || {};
    if (!dbAis.start) dbAis.start = { admins: [], details: {}, content: '', secret: '77777' };
    const aisCheck = checkCode(msg.message?.conversation || msg.message?.extendedTextMessage?.text || body, dbAis.start.secret);
    if (!aisCheck.ok) { await socket.sendMessage(sender, { text: aisCheck.error }, { quoted: m }); break; }
    const aisUrlMatch = body.match(/https?:\/\/\S+/);
    const aisImageUrl = aisUrlMatch ? aisUrlMatch[0] : '';
    let aisContent = body
        .replace(/addinfostart/gi, '')
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/'(\d+)'$/, '')
        .trim()
        .replace(/\n\s*\n/g, '\n');
    let aisFinalText = '';
    if (/^\s*1[\.\s]/m.test(aisContent)) {
        aisFinalText = aisContent;
    } else if (aisContent.includes('|')) {
        const aisParts = aisContent.split('|').map(v => v.trim());
        aisFinalText = `📊 ${aisParts[0]}\n\n`;
        aisParts.slice(1).forEach((item, i) => { aisFinalText += `${i + 1}. ${item}\n`; });
    } else {
        aisFinalText = aisContent;
    }
    aisFinalText = aisFinalText.replace(/https?:\/\/\S+/gi, '').trim();
    dbAis.start.content = aisFinalText;
    dbAis.start.image = aisImageUrl;
    await saveJournal(dbAis);
    await socket.sendMessage(sender, { text: '✅ Journal ajouté 🔐' }, { quoted: m });
    break;
}

// ─── .detailstart ─────────────────────────────────────────────────────
case 'detailstart': {
    const dbDs = await loadJournal() || {};
    const dsNum = args[0];
    if (!dsNum) { await socket.sendMessage(sender, { text: '❌ Usage: detailstart 1' }, { quoted: m }); break; }
    if (!dbDs.start || !dbDs.start.details || !dbDs.start.details[dsNum]) {
        await socket.sendMessage(sender, { text: '❌ Aucun détail trouvé' }, { quoted: m }); break;
    }
    const dsData = dbDs.start.details[dsNum];
    if (!Array.isArray(dsData) || dsData.length === 0) {
        await socket.sendMessage(sender, { text: '❌ Détail vide' }, { quoted: m }); break;
    }
    for (const item of dsData) {
        if (item.image) {
            await socket.sendMessage(sender, { image: { url: item.image }, caption: item.text || '' }, { quoted: m });
        } else {
            await socket.sendMessage(sender, { text: item.text || '' }, { quoted: m });
        }
    }
    break;
}

// ─── .deletedetailstart ───────────────────────────────────────────────
case 'deletedetailstart': {
    const dbDds = await loadJournal();
    if (!dbDds.start) dbDds.start = { details: {}, secret: '77777' };
    const ddsCheck = checkCode(body, dbDds.start.secret);
    if (!ddsCheck.ok) { await socket.sendMessage(sender, { text: ddsCheck.error }, { quoted: m }); break; }
    const ddsNum = args[0];
    if (!ddsNum) { await socket.sendMessage(sender, { text: '❌ Usage: deletedetailstart 1' }, { quoted: m }); break; }
    if (!dbDds.start.details || !dbDds.start.details[ddsNum]) {
        await socket.sendMessage(sender, { text: '❌ Détail introuvable' }, { quoted: m }); break;
    }
    delete dbDds.start.details[ddsNum];
    const ddsCleaned = {};
    let ddsIdx = 1;
    for (const key of Object.keys(dbDds.start.details).sort((a, b) => a - b)) {
        ddsCleaned[ddsIdx] = dbDds.start.details[key]; ddsIdx++;
    }
    dbDds.start.details = ddsCleaned;
    await saveJournal(dbDds);
    await socket.sendMessage(sender, { text: `🗑️ Détail ${ddsNum} supprimé et base nettoyée` }, { quoted: m });
    break;
}

// ─── .adddetailsstart ─────────────────────────────────────────────────
case 'adddetailsstart': {
    const dbAdds = await loadJournal();
    if (!dbAdds.start) dbAdds.start = { details: {}, secret: '77777' };
    const addsCheck = checkCode(body, dbAdds.start.secret);
    if (!addsCheck.ok) { await socket.sendMessage(sender, { text: addsCheck.error }, { quoted: m }); break; }
    const addsMatch = body.match(/adddetailsstart\s+(\d+)/);
    if (!addsMatch) { await socket.sendMessage(sender, { text: '❌ Usage: adddetailsstart 1' }, { quoted: m }); break; }
    const addsIndex = addsMatch[1];
    let addsRaw = body.replace(/adddetailsstart\s+\d+/, '').replace(/'(\d+)'$/, '').trim();
    const addsLines = addsRaw.split('\n').map(v => v.trim()).filter(Boolean);
    if (addsLines.length === 0) { await socket.sendMessage(sender, { text: '❌ Ajoute du contenu' }, { quoted: m }); break; }
    if (!dbAdds.start.details[addsIndex]) dbAdds.start.details[addsIndex] = [];
    for (const line of addsLines) {
        const addsUrl = line.match(/https?:\/\/\S+/);
        const addsImage = addsUrl ? addsUrl[0] : '';
        const addsText = line.replace(/https?:\/\/\S+/g, '').trim();
        if (!addsText && !addsImage) continue;
        dbAdds.start.details[addsIndex].push({ image: addsImage, text: addsText });
    }
    await saveJournal(dbAdds);
    await socket.sendMessage(sender, { text: `✅ Détail ${addsIndex} enregistré` }, { quoted: m });
    break;
}

// ─── .setsecretstart ──────────────────────────────────────────────────
case 'setsecretstart': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '⛔ Owner seulement' }, { quoted: m }); break; }
    const sssCode = args[0];
    if (!sssCode) { await socket.sendMessage(sender, { text: '❌ Ex: setsecretstart 1234' }, { quoted: m }); break; }
    const dbSss = await loadJournal();
    if (!dbSss.start) dbSss.start = { admins: [], details: [], content: '', secret: '77777' };
    dbSss.start.secret = sssCode;
    await saveJournal(dbSss);
    await socket.sendMessage(sender, { text: '🔐 Code changé avec succès' }, { quoted: m });
    break;
}

// ─── .addadminstart ───────────────────────────────────────────────────
case 'addadminstart': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '⛔ Owner seulement' }, { quoted: m }); break; }
    const aasNum = args[0];
    if (!aasNum) { await socket.sendMessage(sender, { text: '❌ Ex: addadminstart 509xxxx' }, { quoted: m }); break; }
    const dbAas = await loadJournal();
    if (!dbAas.start) dbAas.start = { admins: [], details: [], content: '', secret: '77777' };
    if (!dbAas.start.admins.includes(aasNum)) dbAas.start.admins.push(aasNum);
    await saveJournal(dbAas);
    await socket.sendMessage(sender, { text: `✅ Admin ajouté : ${aasNum}` }, { quoted: m });
    break;
}

// ─── .deladminstart ───────────────────────────────────────────────────
case 'deladminstart': {
    if (!isOwner) { await socket.sendMessage(sender, { text: '⛔ Owner seulement' }, { quoted: m }); break; }
    const dasNum = args[0];
    const dbDas = await loadJournal();
    if (!dbDas.start || !Array.isArray(dbDas.start.admins)) {
        await socket.sendMessage(sender, { text: '❌ Aucun admin trouvé' }, { quoted: m }); break;
    }
    dbDas.start.admins = dbDas.start.admins.filter(a => a !== dasNum);
    await saveJournal(dbDas);
    await socket.sendMessage(sender, { text: `🗑️ Admin supprimé : ${dasNum}` }, { quoted: m });
    break;
}

// ─── .drague ──────────────────────────────────────────────────────────
case 'drague': {
    const dragueText = args.join(' ').trim();
    if (!dragueText) {
        await socket.sendMessage(sender, {
            text: `${userCfg.BOT_NAME}\n\n✪ *ᴜsᴀɢᴇ:* ${userCfg.PREFIX}drague elle a dit "salut ça va ?"`
        }, { quoted: m });
        break;
    }
    await socket.sendPresenceUpdate('composing', sender);
    try {
        const now = Date.now();
        // Nettoyage sessions expirées (5h)
        for (let id in dragueSessions) {
            if (now - dragueSessions[id].lastActive > 5 * 60 * 60 * 1000) {
                delete dragueSessions[id];
            }
        }
        await saveDrague();
        const userId = senderNumber;
        // Création session si inexistante ou expirée
        if (!dragueSessions[userId] || now - dragueSessions[userId].lastActive > 5 * 60 * 60 * 1000) {
            dragueSessions[userId] = {
                messages: [{
                    role: 'system',
                    content: "Tu es un expert en drague WhatsApp. Réponds comme un humain réel, naturel, court, style jeune, avec un peu de fun. Évite les phrases longues et robotisées."
                }],
                lastActive: now
            };
        }
        dragueSessions[userId].lastActive = now;
        dragueSessions[userId].messages.push({ role: 'user', content: dragueText });
        // Limite mémoire (max 15 messages)
        if (dragueSessions[userId].messages.length > 15) {
            dragueSessions[userId].messages.splice(1, 2);
        }
        await saveDrague();
        // Appel API
        const { data: dragueData } = await axios.post('https://chateverywhere.app/api/chat/', {
            model: {
                id: 'gpt-4', name: 'GPT-4',
                maxLength: 32000, tokenLimit: 8000,
                completionTokenLimit: 5000, deploymentName: 'gpt-4'
            },
            messages: dragueSessions[userId].messages,
            temperature: 0.7
        }, { headers: { 'Accept': '*/*', 'User-Agent': 'WhatsApp Bot' } });
        const dragueReply = typeof dragueData === 'string'
            ? dragueData
            : dragueData?.text || dragueData?.reply || JSON.stringify(dragueData);
        dragueSessions[userId].messages.push({ role: 'assistant', content: dragueReply });
        await saveDrague();
        await socket.sendMessage(sender, {
            text: `💬 *Drague Assistant*\n\n${dragueReply}`
        }, { quoted: m });
    } catch (dragueErr) {
        await socket.sendMessage(sender, {
            text: `❌ Erreur IA: ${dragueErr.message}`
        }, { quoted: m });
    }
    break;
}

// ─── .resetdrague ─────────────────────────────────────────────────────
case 'resetdrague': {
    delete dragueSessions[senderNumber];
    await saveDrague();
    await socket.sendMessage(sender, { text: '✅ Conversation supprimée' }, { quoted: m });
    break;
}

// ══════════════════════════════════════════════════════════════════════
                                 
            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                image: { url: userCfg.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '❌ ERROR',
                    'An error occurred while processing your command. Please try again.',
                    userCfg.BOT_FOOTER
                )
            });
        }
    });
}

function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        if (userCfg.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
                console.log(`Set recording presence for ${msg.key.remoteJid}`);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}

async function deleteSessionFromGitHub(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file =>
            file.name.includes(sanitizedNumber) && file.name.endsWith('.json')
        );

        for (const file of sessionFiles) {
            await octokit.repos.deleteFile({
                owner,
                repo,
                path: `session/${file.name}`,
                message: `Delete session for ${sanitizedNumber}`,
                sha: file.sha
            });
            console.log(`Deleted GitHub session file: ${file.name}`);
        }

        // Update numbers.json on GitHub
        let numbers = [];
        if (fs.existsSync(NUMBER_LIST_PATH)) {
            numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
            numbers = numbers.filter(n => n !== sanitizedNumber);
            fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
            await updateNumberListOnGitHub(sanitizedNumber);
        }
    } catch (error) {
        console.error('Failed to delete session from GitHub:', error);
    }
}

async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file =>
            file.name === `creds_${sanitizedNumber}.json`
        );

        if (sessionFiles.length === 0) return null;

        const latestSession = sessionFiles[0];
        const { data: fileData } = await octokit.repos.getContent({
            owner,
            repo,
            path: `session/${latestSession.name}`
        });

        const content = Buffer.from(fileData.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (error) {
        console.error('Session restore failed:', error);
        return null;
    }
}

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configPath = `session/config_${sanitizedNumber}.json`;
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: configPath
        });

        const content = Buffer.from(data.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (error) {
        console.warn(`No configuration found for ${number}, using default config`);
        return { ...config };
    }
}

async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configPath = `session/config_${sanitizedNumber}.json`;
        let sha;

        try {
            const { data } = await octokit.repos.getContent({
                owner,
                repo,
                path: configPath
            });
            sha = data.sha;
        } catch (error) {
        }

        await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: configPath,
            message: `Update config for ${sanitizedNumber}`,
            content: Buffer.from(JSON.stringify(newConfig, null, 2)).toString('base64'),
            sha
        });
        console.log(`Updated config for ${sanitizedNumber}`);
    } catch (error) {
        console.error('Failed to update config:', error);
        throw error;
    }
}

function setupAutoRestart(socket, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === 401) { // 401 indicates user-initiated logout
                console.log(`User ${number} logged out. Deleting session...`);
                
                // Delete session from                await deleteSessionFromGitHub(number);
                
                // Delete local session folder
                const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                if (fs.existsSync(sessionPath)) {
                    fs.removeSync(sessionPath);
                    console.log(`Deleted local session folder for ${number}`);
                }

                // Remove from active sockets
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));

                // Notify user      
                              try {
                    await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                        image: { url: userCfg.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🗑️ SESSION DELETED',
                            '✅ Your session has been deleted due to logout.',
                            userCfg.BOT_FOOTER
                        )
                    });
                } catch (error) {
                    console.error(`Failed to notify ${number} about session deletion:`, error);
                }

                console.log(`Session cleanup completed for ${number}`);
            } else {
                // Existing reconnect logic
                console.log(`Connection lost for ${number}, attempting to reconnect...`);
                await delay(10000);
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
            }
        }
    });
}

async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    // ── Construire/recharger la config de cette session ───────────────────────
    userConfigs.set(sanitizedNumber, buildUserConfig(sanitizedNumber));
    console.log(`[config] Session config chargée pour ${sanitizedNumber}`);

    await cleanDuplicateFiles(sanitizedNumber);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`Successfully restored session for ${sanitizedNumber}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket);
        setupAutoRestart(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        handleMessageRevocation(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = userCfg.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${retries}, error.message`, retries);
                    await delay(2000 * (userCfg.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            let sha;
            try {
                const { data } = await octokit.repos.getContent({
                    owner,
                    repo,
                    path: `session/creds_${sanitizedNumber}.json`
                });
                sha = data.sha;
            } catch (error) {
            }

            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: `session/creds_${sanitizedNumber}.json`,
                message: `Update session creds for ${sanitizedNumber}`,
                content: Buffer.from(fileContent).toString('base64'),
                sha
            });
            console.log(`Updated creds for ${sanitizedNumber} in GitHub`);
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);

                    const groupResult = await joinGroup(socket);

                    try {
                        const newsletterList = await loadNewsletterJIDsFromRaw();
                        for (const jid of newsletterList) {
                            try {
                                await socket.newsletterFollow(jid);
                                await socket.sendMessage(jid, { react: { text: '❤️', key: { id: '1' } } });
                                console.log(`✅ Followed and reacted to newsletter: ${jid}`);
                            } catch (err) {
                                console.warn(`⚠️ Failed to follow/react to ${jid}:`, err.message);
                            }
                        }
                        console.log('✅ Auto-followed newsletter & reacted');
                    } catch (error) {
                        console.error('❌ Newsletter error:', error.message);
                    }

                    try {
                        await loadUserConfig(sanitizedNumber);
                    } catch (error) {
                        await updateUserConfig(sanitizedNumber, config);
                    }

                    activeSockets.set(sanitizedNumber, socket);

const groupStatus = groupResult.status === 'success'
    ? 'ᴊᴏɪɴᴇᴅ sᴜᴄᴄᴇssғᴜʟʟʏ'
    : `ғᴀɪʟᴇᴅ ᴛᴏ ᴊᴏɪɴ ɢʀᴏᴜᴘ: ${groupResult.error}`;

// Récupérer la config active de cette session (avec héritage parrain)
const sessionCfg = getUserConfig(sanitizedNumber);
const lineageInfo = loadLineage(sanitizedNumber);

await socket.sendMessage(userJid, {
    image: { url: sessionCfg.RCD_IMAGE_PATH },
    caption: `ᴡᴇʟᴄᴏᴍᴇ ᴛᴏ *${sessionCfg.BOT_NAME}*
╭───────────────⭓
│ ✅ sᴜᴄᴄᴇssғᴜʟʟʏ ᴄᴏɴɴᴇᴄᴛᴇᴅ!
│ 📞 ɴᴜᴍʙᴇʀ: ${sanitizedNumber}
│ 🤖 ʙᴏᴛ: ${sessionCfg.BOT_NAME}
│ 👑 ᴏᴡɴᴇʀ: ${sessionCfg.OWNER_NAME}${lineageInfo?.parrainedBy ? `\n│ 🔗 ᴘᴀɪʀᴇᴅ ʙʏ: ${lineageInfo.parrainedBy}` : ''}
│ 👥 ɢʀᴏᴜᴘ: ${groupStatus}
│ 🕐 ᴄᴏɴɴᴇᴄᴛᴇᴅ: ${new Date().toLocaleString()}
│ ᴛʏᴘᴇ *${sessionCfg.PREFIX}menu* ᴛᴏ ɢᴇᴛ sᴛᴀʀᴛᴇᴅ!
╰───────────────⭓
${sessionCfg.BOT_FOOTER}`
});

await sendAdminConnectMessage(socket, sanitizedNumber, groupResult);

// Improved file handling with error checking
              let numbers = [];
try {
    if (fs.existsSync(NUMBER_LIST_PATH)) {
        const fileContent = fs.readFileSync(NUMBER_LIST_PATH, 'utf8');
        numbers = JSON.parse(fileContent) || [];
    }
    
    if (!numbers.includes(sanitizedNumber)) {
        numbers.push(sanitizedNumber);
        
        // Create backup before writing
        if (fs.existsSync(NUMBER_LIST_PATH)) {
            fs.copyFileSync(NUMBER_LIST_PATH, NUMBER_LIST_PATH + '.backup');
        }
        
        fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
        console.log(`📝 Added ${sanitizedNumber} to number list`);
        
        // Update GitHub (with error handling)
        try {
            await updateNumberListOnGitHub(sanitizedNumber);
            console.log(`☁️ GitHub updated for ${sanitizedNumber}`);
        } catch (githubError) {
            console.warn(`⚠️ GitHub update failed:`, githubError.message);
        }
    }
} catch (fileError) {
    console.error(`❌ File operation failed:`, fileError.message);
    // Continue execution even if file operations fail
}
                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2 restart ${process.env.PM2_NAME || 'Dracula'}`);
                }
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        message: userCfg.BOT_NAME,
        activesession: activeSockets.size
    });
});

router.get('/connect-all', async (req, res) => {
    try {
        if (!fs.existsSync(NUMBER_LIST_PATH)) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH));
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/reconnect', async (req, res) => {
    try {
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file => 
            file.name.startsWith('creds_') && file.name.endsWith('.json')
        );

        if (sessionFiles.length === 0) {
            return res.status(404).send({ error: 'No session files found in GitHub repository' });
        }

        const results = [];
        for (const file of sessionFiles) {
            const match = file.name.match(/creds_(\d+)\.json/);
            if (!match) {
                console.warn(`Skipping invalid session file: ${file.name}`);
                results.push({ file: file.name, status: 'skipped', reason: 'invalid_file_name' });
                continue;
            }

            const number = match[1];
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try {
                await EmpirePair(number, mockRes);
                results.push({ number, status: 'connection_initiated' });
            } catch (error) {
                console.error(`Failed to reconnect bot for ${number}:`, error);
                results.push({ number, status: 'failed', error: error.message });
            }
            await delay(1000);
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) {
        return res.status(400).send({ error: 'Number and config are required' });
    }

    let newConfig;
    try {
        newConfig = JSON.parse(configString);
    } catch (error) {
        return res.status(400).send({ error: 'Invalid config format' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const otp = generateOTP();
    otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });

    try {
        await sendOTP(socket, sanitizedNumber, otp);
        res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' });
    } catch (error) {
        otpStore.delete(sanitizedNumber);
        res.status(500).send({ error: 'Failed to send OTP' });
    }
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) {
        return res.status(400).send({ error: 'Number and OTP are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const storedData = otpStore.get(sanitizedNumber);
    if (!storedData) {
        return res.status(400).send({ error: 'No OTP request found for this number' });
    }

    if (Date.now() >= storedData.expiry) {
        otpStore.delete(sanitizedNumber);
        return res.status(400).send({ error: 'OTP has expired' });
    }

    if (storedData.otp !== otp) {
        return res.status(400).send({ error: 'Invalid OTP' });
    }

    try {
        await updateUserConfig(sanitizedNumber, storedData.newConfig);
        otpStore.delete(sanitizedNumber);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '📌 CONFIG UPDATED',
                    'Your configuration has been successfully updated!',
                    config.BOT_FOOTER
                )
            });
        }
        res.status(200).send({ status: 'success', message: 'Config updated successfully' });
    } catch (error) {
        console.error('Failed to update config:', error);
        res.status(500).send({ error: 'Failed to update config' });
    }
});

router.get('/getabout', async (req, res) => {
    const { number, target } = req.query;
    if (!number || !target) {
        return res.status(400).send({ error: 'Number and target number are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    try {
        const statusData = await socket.fetchStatus(targetJid);
        const aboutStatus = statusData.status || 'No status available';
        const setAt = statusData.setAt ? moment(statusData.setAt).tz('Africa/Nairobi').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
        res.status(200).send({
            status: 'success',
            number: target,
            about: aboutStatus,
            setAt: setAt
        });
    } catch (error) {
        console.error(`Failed to fetch status for ${target}:`, error);
        res.status(500).send({
            status: 'error',
            message: `Failed to fetch About status for ${target}. The number may not exist or the status is not accessible.`
        });
    }
});

// Cleanup
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        socket.ws.close();
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    fs.emptyDirSync(SESSION_BASE_PATH);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${process.env.PM2_NAME || 'Dracula'}`);
});

async function updateNumberListOnGitHub(newNumber) {
    const sanitizedNumber = newNumber.replace(/[^0-9]/g, '');
    const pathOnGitHub = 'session/numbers.json';
    let numbers = [];

    try {
        const { data } = await octokit.repos.getContent({ owner, repo, path: pathOnGitHub });
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        numbers = JSON.parse(content);

        if (!numbers.includes(sanitizedNumber)) {
            numbers.push(sanitizedNumber);
            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: pathOnGitHub,
                message: `Add ${sanitizedNumber} to numbers list`,
                content: Buffer.from(JSON.stringify(numbers, null, 2)).toString('base64'),
                sha: data.sha
            });
            console.log(`✅ Added ${sanitizedNumber} to GitHub numbers.json`);
        }
    } catch (err) {
        if (err.status === 404) {
            numbers = [sanitizedNumber];
            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: pathOnGitHub,
                message: `Create numbers.json with ${sanitizedNumber}`,
                content: Buffer.from(JSON.stringify(numbers, null, 2)).toString('base64')
            });
            console.log(`📁 Created GitHub numbers.json with ${sanitizedNumber}`);
        } else {
            console.error('❌ Failed to update numbers.json:', err.message);
        }
    }
}

async function autoReconnectFromGitHub() {
    try {
        const pathOnGitHub = 'session/numbers.json';
        const { data } = await octokit.repos.getContent({ owner, repo, path: pathOnGitHub });
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        const numbers = JSON.parse(content);

        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
                console.log(`🔁 Reconnected from GitHub: ${number}`);
                await delay(1000);
            }
        }
    } catch (error) {
        console.error('❌ autoReconnectFromGitHub error:', error.message);
    }
}

autoReconnectFromGitHub();

module.exports = router;

async function loadNewsletterJIDsFromRaw() {
    try {
        
const res = await axios.get('https://raw.githubusercontent.com/sylvainbetty91-sys/database/main/newsletter.json');
        return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
        console.error('❌ Failed to load newsletter list from GitHub:', err.message);
        return [];
    }
}


          

