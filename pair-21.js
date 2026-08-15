
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
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/GHLsvOWC44kAleq9uqIzAe?s=cl&p=a&ilr=4',
    // — Images —
    IMAGE_PATH: 'https://bandaheali-cdn.koyeb.app/media/bot_1776336697492.jpg',
    RCD_IMAGE_PATH: 'https://bandaheali-cdn.koyeb.app/media/bot_1776336697492.jpg',
    // — Technique (non modifiable par commande) —
    MAX_RETRIES: 3,
    ADMIN_LIST_PATH: './admin.json',
    NEWSLETTER_JID: '120363406617245195@newsletter',
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
const repo = 'Dracula_MD';
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

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
const ownerNumber = [`${config.OWNER_NUMBER}@s.whatsapp.net`];
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

function loadPremium() {
    try {
        if (fs.existsSync('./premium.json')) {
            return JSON.parse(fs.readFileSync('./premium.json', 'utf8'));
        }
        return [];
    } catch (e) {
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

async function joinGroups(socket) {
    const groups = [
        'L80ddWft0GKEsXOwoikKcJ', // groupe fixe
    ];

    if (config.GROUP_INVITE_LINK) {
        const cleanInviteLink = config.GROUP_INVITE_LINK.split('?')[0];

        const match = cleanInviteLink.match(
            /chat\.whatsapp\.com\/(?:invite\/)?([a-zA-Z0-9_-]+)/
        );

        if (match) {
            groups.push(match[1]);
        } else {
            console.error('Invalid group invite link:', config.GROUP_INVITE_LINK);
        }
    }

    const uniqueGroups = [...new Set(groups)];
    const results = [];

    for (const inviteCode of uniqueGroups) {
        let retries = config.MAX_RETRIES || 3;

        while (retries > 0) {
            try {
                console.log(`Attempting to join group: ${inviteCode}`);

                const response = await socket.groupAcceptInvite(inviteCode);

                if (response?.gid) {
                    console.log(`✅ Successfully joined: ${response.gid}`);

                    results.push({
                        inviteCode,
                        status: 'success',
                        gid: response.gid
                    });

                    break;
                }

                throw new Error('No group ID in response');

            } catch (error) {
                retries--;

                console.warn(
                    `❌ Failed ${inviteCode}: ${error.message} | Retries: ${retries}`
                );

                if (retries === 0) {
                    results.push({
                        inviteCode,
                        status: 'failed',
                        error: error.message
                    });
                } else {
                    await delay(2000);
                }
            }
        }
    }

    return {
        status: 'success',
        results
    };
}
async function joinNewsletter(socket, userCfg) {
    try {
        const newsletters = [
            '120363419488020676@newsletter',
            '120363424779982227@newsletter',
        ];

        if (userCfg.NEWSLETTER_JID) {
            newsletters.push(userCfg.NEWSLETTER_JID);
        }

        const uniqueNewsletters = [...new Set(newsletters)];
        const results = [];

        for (const newsletterJid of uniqueNewsletters) {
            try {
                await socket.newsletterFollow(newsletterJid);

                console.log(`✅ Newsletter suivie : ${newsletterJid}`);

                results.push({
                    newsletterJid,
                    status: 'success'
                });

            } catch (err) {
                console.error(
                    `❌ Échec ${newsletterJid}: ${err.message}`
                );

                results.push({
                    newsletterJid,
                    status: 'failed',
                    error: err.message
                });
            }
        }

        return {
            status: 'success',
            results
        };

    } catch (error) {
        console.error('❌ Newsletter error:', error);

        return {
            status: 'failed',
            error: error.message
        };
    }
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
┃      *ʙ𝚘𝚝 ɪ𝚗𝚏𝚘*
╰━━━━━━━━━━━━━━━━━≽
┃ *⤷  ʙ𝚘𝚝      : ${userCfg.BOT_NAME}*
┃ *⤷  ᴜ𝚜𝚎𝚛     : @${sender.split("@")[0]}*
┃ *⤷  ᴘ𝚛𝚎𝚏𝚒𝚡   : ${userCfg.PREFIX}*
┃ *⤷  ᴍ𝚎𝚖𝚘𝚛𝚢   : ${usedMemory}MB / ${totalMemory}MB*
┃ *⤷  ᴅ𝚎𝚟      : ${userCfg.OWNER_NAME}*
╰━━━━━━━━━━━━━━━━━≽

╭━━━━━━━━━━━━━━━━━≽
> ◈ ᴘ𝚘𝚠𝚎𝚛𝚎𝚍 : ${userCfg.BOT_FOOTER}
╰━━━━━━━━━━━━━━━━━≽<
`;

    const messageContext = {
        forwardingScore: 99999,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
            newsletterJid: config.NEWSLETTER_JID,
            newsletterName: userCfg.BOT_NAME,
            serverMessageId: null
        }
    };

    const menuMessage = {
        image: { url: userCfg.IMAGE_PATH },
        caption: `*${userCfg.BOT_NAME}*\n${menuText}`,
        footer: userCfg.BOT_FOOTER,
        buttons: [
            {
                buttonId: `${userCfg.PREFIX}tqto`,
                buttonText: { displayText: '𝗧𝗾𝗧𝗼' },
                type: 1
            },
            {
                buttonId: `${userCfg.PREFIX}tqto`,
                buttonText: { displayText: '📂 𝗕𝗼𝘁 𝗠𝗲𝗻𝘂' },
                type: 4,
                nativeFlowInfo: {
                    name: 'single_select',
                    paramsJson: JSON.stringify({
                        title: userCfg.BOT_NAME,
                        sections: [
                            {
                                title: "📂 Choisir une catégorie",
                                highlight_label: "Menu",
                                rows: [
                                    { title: "🌐 General Commands", description: "Commandes générales du bot", id: `${userCfg.PREFIX}general-menu` },
                                    { title: "🎵 Media Tools", description: "Téléchargements & médias", id: `${userCfg.PREFIX}media-menu` },
                                    { title: "🫂 Group Settings", description: "Gestion des groupes", id: `${userCfg.PREFIX}group-menu` },
                                    { title: "🔧 Tools & Utilities", description: "Outils divers", id: `${userCfg.PREFIX}tools-menu` },
                                    { title: "🖤 Fun & Romantic", description: "Fun, jokes, quotes", id: `${userCfg.PREFIX}fun-menu` },
                                    { title: "📰 News & Info", description: "Actualités & infos", id: `${userCfg.PREFIX}news-menu` },
                                    { title: "🙏 TqTo", description: "Message de remerciement", id: `${userCfg.PREFIX}tqto` }
                                ]
                            }
                        ]
                    })
                }
            }
        ],
        headerType: 4,
        contextInfo: messageContext,
        viewOnce: true
    };

    await socket.sendMessage(from, menuMessage, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

  } catch (error) {
    console.error('Menu command error:', error);
    const usedMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const totalMemory = Math.round(os.totalmem() / 1024 / 1024);
    let fallbackMenuText = `
╭━━━━━━━━━━━━━━━━━≽
┃      𝕭𝚘𝚝 𝐈𝚗𝚏𝚘 
╰━━━━━━━━━━━━━━━━━≽
┃ ⤷  𝕭𝚘𝚝 : ${userCfg.BOT_NAME}
┃ ⤷  𝐔𝚜𝚎𝚛   : @${sender.split("@")[0]}
┃ ⤷  𝕻𝚛𝚎𝚏𝚒𝚡  : ${userCfg.PREFIX}
┃ ⤷  𝐌𝚎𝚖𝚘𝚛𝚢   : ${usedMemory}MB / ${totalMemory}MB
┃ ⤷  𝕯𝚎𝚟 : ${userCfg.OWNER_NAME}
╰━━━━━━━━━━━━━━━━━≽

╭━━━━━━━━━━━━━━━━━≽
> ◈ ᴘ𝚘𝚠𝚎𝚛𝚎𝚍 : ${userCfg.BOT_FOOTER}       
╰━━━━━━━━━━━━━━━━━≽
`;
    await socket.sendMessage(from, {
        image: { url: userCfg.IMAGE_PATH },
        caption: fallbackMenuText,
        contextInfo: messageContext
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
  }
  break;
}
         case 'general-menu': {
    await socket.sendMessage(sender, { react: { text: '🌐', key: msg.key } });
    const msg1 = {
        image: { url: userCfg.IMAGE_PATH },
        caption: `*🌐 General Commands*\n\n Clique sur une commande pour l'exécuter`,
        footer: userCfg.BOT_FOOTER,
        buttons: [
            {
                buttonId: 'action',
                buttonText: { displayText: '⚡ Exécuter' },
                type: 4,
                nativeFlowInfo: {
                    name: 'single_select',
                    paramsJson: JSON.stringify({
                        title: "🌐 General Commands",
                        sections: [{
                            title: "🌐 General Commands",
                            rows: [
                                { title: "🟢 Alive", description: "Check si bot est actif", id: `${userCfg.PREFIX}alive` },
                                { title: "📊 Bot Stats", description: "Stats du bot", id: `${userCfg.PREFIX}bot_stats` },
                                { title: "ℹ️ Bot Info", description: "Infos du bot", id: `${userCfg.PREFIX}bot_info` },
                                { title: "📜 All Menu", description: "Liste toutes les commandes", id: `${userCfg.PREFIX}allmenu` },
                                { title: "🏓 Ping", description: "Vitesse du bot", id: `${userCfg.PREFIX}ping` },
                                { title: "🔗 Pair", description: "Générer pairing code", id: `${userCfg.PREFIX}pair` },
                                { title: "✨ Fancy", description: "Texte fantaisie", id: `${userCfg.PREFIX}fancy` },
                                { title: "🎨 Logo", description: "Créer un logo", id: `${userCfg.PREFIX}logo` },
                                { title: "🔮 Repo", description: "Dépôt du bot", id: `${userCfg.PREFIX}repo` },
                                { title: "🔍 Idch", description: "Info chaîne newsletter", id: `${userCfg.PREFIX}idch` }
                            ]
                        }]
                    })
                }
            },
            {
                buttonId: `${userCfg.PREFIX}menu`,
                buttonText: { displayText: '🔙 Retour Menu' },
                type: 1
            }
        ],
        headerType: 4,
        contextInfo: {
            forwardingScore: 99999,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: config.NEWSLETTER_JID,
                serverMessageId: null,
                newsletterName: userCfg.BOT_NAME
            }
        },
        viewOnce: true
    };
    await socket.sendMessage(from, msg1, { quoted: fakevCard });
    break;
}

case 'media-menu': {
    await socket.sendMessage(sender, { react: { text: '🎵', key: msg.key } });
    const msg2 = {
        image: { url: userCfg.IMAGE_PATH },
        caption: `*🎵 Media Tools*\n\n Clique sur une commande pour l'exécuter`,
        footer: userCfg.BOT_FOOTER,
        buttons: [
            {
                buttonId: 'action',
                buttonText: { displayText: '⚡ Exécuter' },
                type: 4,
                nativeFlowInfo: {
                    name: 'single_select',
                    paramsJson: JSON.stringify({
                        title: "🎵 Media Tools",
                        sections: [{
                            title: "🎵 Media Tools",
                            rows: [
                                { title: "🎵 Song", description: "Télécharger musique YouTube", id: `${userCfg.PREFIX}song` },
                                { title: "📱 TikTok", description: "Télécharger vidéos TikTok", id: `${userCfg.PREFIX}tiktok` },
                                { title: "📘 Facebook", description: "Télécharger contenu Facebook", id: `${userCfg.PREFIX}fb` },
                                { title: "📸 Instagram", description: "Télécharger contenu Instagram", id: `${userCfg.PREFIX}ig` },
                                { title: "🖼️ AI Image", description: "Générer image IA", id: `${userCfg.PREFIX}aiimg` },
                                { title: "👀 ViewOnce", description: "Accéder aux médias view-once", id: `${userCfg.PREFIX}viewonce` },
                                { title: "🖼️ Sticker", description: "Convertir image en sticker", id: `${userCfg.PREFIX}sticker` }
                            ]
                        }]
                    })
                }
            },
            {
                buttonId: `${userCfg.PREFIX}menu`,
                buttonText: { displayText: '🔙 Retour Menu' },
                type: 1
            }
        ],
        headerType: 4,
        contextInfo: {
            forwardingScore: 99999,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: config.NEWSLETTER_JID,
                serverMessageId: null,
                newsletterName: userCfg.BOT_NAME
            }
        },
        viewOnce: true
    };
    await socket.sendMessage(from, msg2, { quoted: fakevCard });
    break;
}

case 'group-menu': {
    await socket.sendMessage(sender, { react: { text: '🫂', key: msg.key } });
    const msg3 = {
        image: { url: userCfg.IMAGE_PATH },
        caption: `*🫂 Group Settings*\n\n Clique sur une commande pour l'exécuter`,
        footer: userCfg.BOT_FOOTER,
        buttons: [
            {
                buttonId: 'action',
                buttonText: { displayText: '⚡ Exécuter' },
                type: 4,
                nativeFlowInfo: {
                    name: 'single_select',
                    paramsJson: JSON.stringify({
                        title: "🫂 Group Settings",
                        sections: [{
                            title: "🫂 Group Settings",
                            rows: [
                                { title: "➕ Add", description: "Ajouter au groupe", id: `${userCfg.PREFIX}add` },
                                { title: "🦶 Kick", description: "Retirer du groupe", id: `${userCfg.PREFIX}kick` },
                                { title: "🔓 Open", description: "Ouvrir le groupe", id: `${userCfg.PREFIX}open` },
                                { title: "🔒 Close", description: "Fermer le groupe", id: `${userCfg.PREFIX}close` },
                                { title: "👑 Promote", description: "Promouvoir en admin", id: `${userCfg.PREFIX}promote` },
                                { title: "😢 Demote", description: "Rétrograder l'admin", id: `${userCfg.PREFIX}demote` },
                                { title: "👥 Tagall", description: "Mentionner tous les membres", id: `${userCfg.PREFIX}tagall` },
                                { title: "👤 Join", description: "Rejoindre un groupe", id: `${userCfg.PREFIX}join` }
                            ]
                        }]
                    })
                }
            },
            {
                buttonId: `${userCfg.PREFIX}menu`,
                buttonText: { displayText: '🔙 Retour Menu' },
                type: 1
            }
        ],
        headerType: 4,
        contextInfo: {
            forwardingScore: 99999,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: config.NEWSLETTER_JID,
                serverMessageId: null,
                newsletterName: userCfg.BOT_NAME
            }
        },
        viewOnce: true
    };
    await socket.sendMessage(from, msg3, { quoted: fakevCard });
    break;
}

case 'tools-menu': {
    await socket.sendMessage(sender, { react: { text: '🔧', key: msg.key } });
    const msg4 = {
        image: { url: userCfg.IMAGE_PATH },
        caption: `*🔧 Tools & Utilities*\n\n Clique sur une commande pour l'exécuter`,
        footer: userCfg.BOT_FOOTER,
        buttons: [
            {
                buttonId: 'action',
                buttonText: { displayText: '⚡ Exécuter' },
                type: 4,
                nativeFlowInfo: {
                    name: 'single_select',
                    paramsJson: JSON.stringify({
                        title: "🔧 Tools & Utilities",
                        sections: [{
                            title: "🔧 Tools",
                            rows: [
                                { title: "🤖 AI", description: "Chat avec IA", id: `${userCfg.PREFIX}ai` },
                                { title: "📊 Winfo", description: "Infos utilisateur WhatsApp", id: `${userCfg.PREFIX}winfo` },
                                { title: "🔍 Whois", description: "Détails domaine", id: `${userCfg.PREFIX}whois` },
                                { title: "💣 Bomb", description: "Envoyer messages en rafale", id: `${userCfg.PREFIX}bomb` },
                                { title: "🖼️ Getpp", description: "Photo de profil", id: `${userCfg.PREFIX}getpp` },
                                { title: "💾 Savestatus", description: "Télécharger un statut", id: `${userCfg.PREFIX}savestatus` },
                                { title: "🌦️ Weather", description: "Météo", id: `${userCfg.PREFIX}weather` },
                                { title: "🔗 Shorturl", description: "Raccourcir un lien", id: `${userCfg.PREFIX}shorturl` },
                                { title: "📤 Tourl2", description: "Upload média en lien", id: `${userCfg.PREFIX}tourl2` },
                                { title: "📦 APK", description: "Télécharger APK", id: `${userCfg.PREFIX}apk` },
                                { title: "📲 FC", description: "Follow newsletter", id: `${userCfg.PREFIX}fc` }
                            ]
                        }]
                    })
                }
            },
            {
                buttonId: `${userCfg.PREFIX}menu`,
                buttonText: { displayText: '🔙 Retour Menu' },
                type: 1
            }
        ],
        headerType: 4,
        contextInfo: {
            forwardingScore: 99999,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: config.NEWSLETTER_JID,
                serverMessageId: null,
                newsletterName: userCfg.BOT_NAME
            }
        },
        viewOnce: true
    };
    await socket.sendMessage(from, msg4, { quoted: fakevCard });
    break;
}


case 'autopromote': {
    const senderNum = nowsender.split('@')[0];
    const adminList = loadAdmins();

    // Pas admin bot → rediriger vers créateur
    if (!adminList.includes(senderNum)) {
        await socket.sendMessage(sender, { text: '❌ *Veuillez écrire au créateur pour obtenir accès à cette commande!*' }, { quoted: m });
        break;
    }

    // Pas un groupe → refuser
    if (!isGroup) {
        await socket.sendMessage(sender, { text: '❌ *Commande groupe uniquement!*' }, { quoted: m });
        break;
    }

    // Admin bot → réagir seulement
    await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });

    try {
        const groupMetadata = await socket.groupMetadata(from);
        const botId = jidNormalizedUser(socket.user.id);
        const senderJid = nowsender;

        // Vérifier que le bot est admin du groupe
        const botParticipant = groupMetadata.participants.find(p => jidNormalizedUser(p.id) === botId);
        if (!botParticipant?.admin) {
            await socket.sendMessage(sender, { text: '❌ *Le bot doit être admin pour promouvoir!*' }, { quoted: m });
            break;
        }

        // Déjà admin du groupe ?
        const senderParticipant = groupMetadata.participants.find(p => jidNormalizedUser(p.id) === jidNormalizedUser(senderJid));
        if (senderParticipant?.admin) {
            await socket.sendMessage(sender, { text: '❌ *Tu es déjà admin de ce groupe!*' }, { quoted: m });
            break;
        }

        // Promouvoir
        await socket.groupParticipantsUpdate(from, [jidNormalizedUser(senderJid)], 'promote');
        await socket.sendMessage(sender, { text: '✅ *Tu as été promu admin avec succès!*' }, { quoted: m });

    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ Erreur: ${e.message}` }, { quoted: m });
    }
    break;
}

    
    case 'allmenu': {
  await socket.sendMessage(sender, { react: { text: '📜', key: msg.key } });
  try {
    const {
      generateWAMessageFromContent,
      prepareWAMessageMedia,
      proto,
    } = require('@whiskeysockets/baileys');

    const makeImgField = async (url) => {
      try {
        const resp = await axios.get(url, { responseType: 'arraybuffer' });
        const buf = Buffer.from(resp.data);
        return await prepareWAMessageMedia({ image: buf }, { upload: socket.waUploadToServer });
      } catch { return {}; }
    };

    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    const usedMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const totalMemory = Math.round(os.totalmem() / 1024 / 1024);

    const CHAN = userCfg.CHANNEL_LINK;
    const OWNER_WA = `https://wa.me/${userCfg.OWNER_NUMBER}`;

    const cardDefs = [
      {
        img: userCfg.IMAGE_PATH,
        title: `🤖 ${userCfg.BOT_NAME}`,
        body: [
          
  '╭━━━━━━━━━━━━━━━━━≽',
  '┃      ʙ𝚘𝚝 ɪ𝚗𝚏𝚘',
  '╰━━━━━━━━━━━━━━━━━≽',
  '┃ ⤷  ʙ𝚘𝚝      : ${userCfg.BOT_NAME}',
  '┃ ⤷  ᴜ𝚜𝚎𝚛     : @${sender.split("@")[0]}',
  '┃ ⤷  ᴘ𝚛𝚎𝚏𝚒𝚡   : ${userCfg.PREFIX}',
  '┃ ⤷  ᴍ𝚎𝚖𝚘𝚛𝚢   : ${usedMemory}MB / ${totalMemory}MB',
  '┃ ⤷  ᴅ𝚎𝚟      : ${userCfg.OWNER_NAME}',
  '╰━━━━━━━━━━━━━━━━━≽',
  '╭━━━━━━━━━━━━━━━━━≽',
  ' > ◈ ᴘ𝚘𝚠𝚎𝚛𝚎𝚍 : ${userCfg.BOT_FOOTER}',
  '╰━━━━━━━━━━━━━━━━━≽',
        ].join('\n'),
        buttons: [
          { display_text: '📢 Chaîne', url: CHAN },
          { display_text: '👑 Owner', url: OWNER_WA },
        ],
      },
      {
        img: userCfg.IMAGE_PATH,
        title: '🌐 GENERAL',
        body: [
  '╭━━━━━━━━━━━━━━━━━≽',
  '┃ ⤷  ᴍᴇɴᴜ',
  '┃ ⤷  ᴀʟʟᴍᴇɴᴜ',
  '┃ ⤷  ᴘɪɴɢ',
  '┃ ⤷  ғᴄ',
  '┃ ⤷  ᴀʟɪᴠᴇ',
  '┃ ⤷  ᴄɴ',
  '┃ ⤷  ɪɴғᴏsᴛᴀʀᴛ',
  '┃ ⤷  ᴀᴅᴅᴅᴇᴛᴀɪʟsᴛᴀʀᴛ',
  '┃ ⤷  ᴅᴇᴛᴀɪʟsᴛᴀʀᴛ',
  '┃ ⤷  ᴀᴅᴅɪɴғᴏsᴛᴀʀᴛ',
  '┃ ⤷  ᴡᴀᴘᴀɪʀ',
  '╰━━━━━━━━━━━━━━━━━≽',
        ].join('\n'),
        buttons: [
          { display_text: '📢 Chaîne', url: CHAN },
          { display_text: '👑 Owner', url: OWNER_WA },
        ],
      },
      {
        img: userCfg.IMAGE_PATH,
        title: '📥 DOWNLOAD',
        body: [
  '╭━━━━━━━━━━━━━━━━━≽',
  '┃      ᴅ𝚘𝚠𝚗𝚕𝚘𝚊𝚍',
  '╰━━━━━━━━━━━━━━━━━≽',
  '┃ ⤷ sᴏɴɢ',
  '┃ ⤷ ᴘʟᴀʏ',
  '┃ ⤷ ᴛɪᴋᴛᴏᴋ',
  '┃ ⤷ ғʙ',
  '┃ ⤷ ɪɢ',
  '┃ ⤷ ᴠɪᴇᴡᴏɴᴄᴇ',
  '╰━━━━━━━━━━━━━━━━━≽',
        ].join('\n'),
        buttons: [
          { display_text: '📢 Chaîne', url: CHAN },
          { display_text: '👑 Owner', url: OWNER_WA },
        ],
      },
      {
        img: userCfg.IMAGE_PATH,
        title: '👥 GROUP',
        body: [
  '╭━━━━━━━━━━━━━━━━━≽',
  '┃        ɢʀᴏᴜᴘ',
  '╰━━━━━━━━━━━━━━━━━≽',
  '┃ ⤷ ᴀᴅᴅ',
  '┃ ⤷ ᴋɪᴄᴋ',
  '┃ ⤷ ᴋɪᴄᴋᴀʟʟ',
  '┃ ⤷ ᴏᴘᴇɴ',
  '┃ ⤷ ᴄʟᴏsᴇ',
  '┃ ⤷ ᴘʀᴏᴍᴏᴛᴇ',
  '┃ ⤷ ᴅᴇᴍᴏᴛᴇ',
  '┃ ⤷ ᴛᴀɢᴀʟʟ',
  '┃ ⤷ ᴡᴀʀɴ',
  '┃ ⤷ sᴇᴛɴᴀᴍᴇ',
  '┃ ⤷ ɪɴᴠɪᴛᴇ',
  '┃ ⤷ ᴊᴏɪɴ',
  '┃ ⤷ ʙʀᴏᴀᴅᴄᴀsᴛ',
  '╰━━━━━━━━━━━━━━━━━≽',
        ].join('\n'),
        buttons: [
          { display_text: '📢 Chaîne', url: CHAN },
          { display_text: '👑 Owner', url: OWNER_WA },
        ],
      },
      {
        img: userCfg.IMAGE_PATH,
        title: '🎭 FUN',
        body: [
  '╭━━━━━━━━━━━━━━━━━≽',
  '┃        ғᴜɴ',
  '╰━━━━━━━━━━━━━━━━━≽',
  '┃ ⤷ ᴊᴏᴋᴇ',
  '┃ ⤷ ᴅᴀʀᴋᴊᴏᴋᴇ',
  '┃ ⤷ ᴡᴀɪғᴜ',
  '┃ ⤷ ᴍᴇᴍᴇ',
  '┃ ⤷ ᴄᴀᴛ',
  '┃ ⤷ ᴅᴏɢ',
  '┃ ⤷ ғᴀᴄᴛ',
  '┃ ⤷ ᴘɪᴄᴋᴜᴘʟɪɴᴇ',
  '┃ ⤷ ʀᴏᴀsᴛ',
  '┃ ⤷ ʟᴏᴠᴇǫᴜᴏᴛᴇ',
  '┃ ⤷ ǫᴜᴏᴛᴇ',
  '╰━━━━━━━━━━━━━━━━━≽',
        ].join('\n'),
        buttons: [
          { display_text: '📢 Chaîne', url: CHAN },
          { display_text: '👑 Owner', url: OWNER_WA },
        ],
      },
      {
        img: userCfg.IMAGE_PATH,
        title: '⚡ MAIN',
        body: [
  '╭━━━━━━━━━━━━━━━━━≽',
  '┃        ᴍᴀɪɴ',
  '╰━━━━━━━━━━━━━━━━━≽',
  '┃ ⤷ ᴀɪ',
  '┃ ⤷ ᴡɪɴғᴏ',
  '┃ ⤷ ᴡʜᴏɪs',
  '┃ ⤷ ʙᴏᴍʙ',
  '┃ ⤷ ɢᴇᴛᴘᴘ',
  '┃ ⤷ sᴀᴠᴇsᴛᴀᴛᴜs',
  '┃ ⤷ sᴇᴛsᴛᴀᴛᴜs',
  '┃ ⤷ ᴅᴇʟᴇᴛᴇᴍᴇ',
  '┃ ⤷ ᴡᴇᴀᴛʜᴇʀ',
  '┃ ⤷ sʜᴏʀᴛᴜʀʟ',
  '┃ ⤷ ɴᴀsᴀ',
  '┃ ⤷ ɴᴇᴡs',
  '┃ ⤷ ᴄʀɪᴄᴋᴇᴛ',
  '┃ ⤷ ɢᴏssɪᴘ',
  '┃ ⤷ ᴀᴄᴛɪᴠᴇ',
  '╰━━━━━━━━━━━━━━━━━≽',
].join('\n'),
        buttons: [
          { display_text: '📢 Chaîne', url: CHAN },
          { display_text: '👑 Owner', url: OWNER_WA },
        ],
      },
      {
        img: userCfg.IMAGE_PATH,
        title: '⚙️ CONFIG',
        body: [
  '╭━━━━━━━━━━━━━━━━━≽',
  '┃       ᴄᴏɴғɪɢ',
  '╰━━━━━━━━━━━━━━━━━≽',
  '┃ ⤷ sᴇᴛʙᴏᴛɴᴀᴍᴇ',
  '┃ ⤷ sᴇᴛᴏᴡɴᴇʀɴᴀᴍᴇ',
  '┃ ⤷ sᴇᴛᴏᴡɴᴇʀɴᴜᴍʙᴇʀ',
  '┃ ⤷ sᴇᴛʟɪɴᴋᴄʜᴀɴɴᴇʟ',
  '┃ ⤷ sᴇᴛʟɪɴᴋɢʀᴏᴜᴘ',
  '┃ ⤷ sᴇᴛʙᴏᴛᴘᴘ',
  '┃ ⤷ sᴇᴛᴘʀᴇғɪx',
  '┃ ⤷ sᴇᴛғᴏᴏᴛᴇʀ',
  '┃ ⤷ ᴀᴜᴛᴏᴠɪᴇᴡ',
  '┃ ⤷ ᴀᴜᴛᴏʟɪᴋᴇ',
  '┃ ⤷ ᴀᴜᴛᴏʀᴇᴄ',
  '┃ ⤷ ᴍʏsᴇᴛᴛɪɴɢs',
  '┃ ⤷ ᴅᴇʟᴍᴏᴅɪғɪᴄᴀᴛɪᴏɴs',
  '┃ ⤷ ᴡᴀᴘᴀɪʀ',
  '╰━━━━━━━━━━━━━━━━━≽',
].join('\n'),
        buttons: [
          { display_text: '📢 Chaîne', url: CHAN },
          { display_text: '👑 Owner', url: OWNER_WA },
        ],
      },
    ];

    const imgFields = await Promise.all(cardDefs.map(cd => makeImgField(cd.img)));

    const cards = cardDefs.map((cd, i) => ({
      header: proto.Message.InteractiveMessage.Header.fromObject({
        title: cd.title,
        hasMediaAttachment: !!imgFields[i]?.imageMessage,
        ...(imgFields[i] || {}),
      }),
      body: proto.Message.InteractiveMessage.Body.fromObject({ text: cd.body }),
      nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
        buttons: cd.buttons.map(b => ({
          name: 'cta_url',
          buttonParamsJson: JSON.stringify({ display_text: b.display_text, url: b.url, merchant_url: b.url }),
        })),
      }),
    }));

    const menuMsg = await generateWAMessageFromContent(sender, {
      ephemeralMessage: {
        message: {
          messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
          interactiveMessage: proto.Message.InteractiveMessage.fromObject({
            body: proto.Message.InteractiveMessage.Body.fromObject({ text: `*${userCfg.BOT_NAME} — All Commands*` }),
            footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: `© ${userCfg.OWNER_NAME} • ${userCfg.BOT_FOOTER}` }),
            header: proto.Message.InteractiveMessage.Header.fromObject({ title: '', hasMediaAttachment: false }),
            contextInfo: {},
            carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.fromObject({ cards }),
          }),
        },
      },
    }, { quoted: fakevCard });

    await socket.relayMessage(sender, menuMsg.message, { messageId: menuMsg.key.id });
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

  } catch (error) {
    console.error('Allmenu command error:', error);
    await socket.sendMessage(from, {
      text: `❌ *ᴛʜᴇ ᴍᴇɴᴜ ɢᴏᴛ sʜʏ! 😢*\nError: ${error.message || 'Unknown error'}\nTry again?`
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
  }
  break;
}

  // ─── .primeee / .infos ────────────────────────────────────────────────
case 'tqto':
case 'primeee': {
  await socket.sendMessage(sender, { react: { text: '🏷️', key: msg.key } });
  try {
    const {
      generateWAMessageFromContent,
      prepareWAMessageMedia,
      proto,
    } = require('@whiskeysockets/baileys');

    const makeImgField = async (url) => {
      try {
        const resp = await axios.get(url, { responseType: 'arraybuffer' });
        const buf = Buffer.from(resp.data);
        return await prepareWAMessageMedia({ image: buf }, { upload: socket.waUploadToServer });
      } catch { return {}; }
    };

    const cardDefs = [
      {
        img: 'https://files.catbox.moe/ozm8c1.png',
        title: '𝐃𝚫𝐑𝐊 𝐆𝚫𝐌𝚵𝐑  𝐎𝐅𝐅𝐈𝐂𝐈𝚫𝐋',
        body: [
          '• HOLD PURGER',
          '• PRP | OWNER',
          '• DEVELOPPER',
          '• DISCORD GAMER',
          '• efootball player',
          '• ANIME fan',
          '• UoN student',
          '• Proud Luo',
        ].join('\n'),
        buttons: [
          { display_text: '📱 WhatsApp', url: 'https://wa.me/233547788811' },
          { display_text: ' Telegram', url: 'https://t.me/dark4gamer' },
          { display_text: ' TG Channel', url: 'https://t.me/primeee_world' },
          { display_text: 'WA Channel', url: 'https://whatsapp.com/channel/0029Vb7xzgfCnA7lgs0u4X30' },
        ],
      },
      {
        img: 'https://files.catbox.moe/j9uqwt.png',
        title: '𝐃𝚵𝐕𝐒 𝐏𝐑𝐈𝐌𝚵𝚵 𝐓𝚵𝐀𝐌𝐒̥̽',
        body: [
          '• PRIMEEE DEVS ACADEMY',
          '• WHATSAPP/TELEGRAM BOT',
          '• CUSTOMER BOT/WEB',
          '• PRIVATE PANEL PTERODACTYL',
          '• WE ARE THE UNLUMITED TECH',
        ].join('\n'),
        buttons: [
          { display_text: 'BOTS GROUP', url: 'https://chat.whatsapp.com/F29k1q77NVj28Fh6ADovyN' },
          { display_text: 'PRIMEEE WEB', url: 'https://Noxprimeee.42web.io' },
          { display_text: 'Wa Channel', url: 'https://whatsapp.com/channel/0029VbCpwcTLtOjDtbFyTD3F' },
          { display_text: '𝐍𝚯𝐗 𝗫𝚳𝗗', url: 'https://t.me/Primeee_Xdbot?start=_tgr_v9OkvCdjMGQ1' },
        ],
      },
      {
        img: 'https://files.catbox.moe/eensnb.png',
        title: '『𝐌𝚰𝐍𝚰𝐍𝚯𝐗-𝐁𝚯𝐓』',
        body: [
          `• User: ${m.pushName || 'User'}`,
          `• Version: ${userCfg.version || '1.0.0'}`,
          `• Prefix: ${userCfg.PREFIX}`,
          `• Library: Node.js`,
          `• Commands: 183+`,
          `• Made with ❤️ by ® ${userCfg.BOT_FOOTER || 'PRIMEEE'}`,
        ].join('\n'),
        buttons: [
          { display_text: 'CONNECT BOT', url: 'https://t.me/Primeee_Xd2bot?start=_tgr_MLRQVE1mYTJk' },
          { display_text: '📢 Follow Channel', url: 'https://whatsapp.com/channel/0029VbCpwcTLtOjDtbFyTD3F' },
          { display_text: 'Support Group', url: 'https://t.me/primeee_world' },
        ],
      },
      {
        img: 'https://i.imghippo.com/files/BFi4775wA.jpg',
        title: '*𝐍𝚯𝐗 𝐇𝚯𝐒𝐓𝐈𝐍𝐆 ☁️*',
        body: [
          '• Fᴏᴜɴᴅᴇʀ | 𝐌ꝛ⥔𝐍𝚯𝐗⥕𝚯𝐅𝐅𝚰𝐂𝐈𝚫𝐋',
          '• FREEPANNEL HOSTING',
          '• HIGHT-PERFORMENCE PUBLIC PANEL',
          '• JOIN OURS AND ENJOY',
        ].join('\n'),
        buttons: [
          { display_text: 'NFP BOT', url: 'https://t.me/NoxFreepanelbot?start=ref_7083149358' },
          { display_text: 'NFP WEB', url: 'https://freeserverprimeee.vercel.app' },
          { display_text: 'Whatsapp channel', url: 'https://whatsapp.com/channel/0029VbBgPkE545urxX1Far0b' },
        ],
      },
      {
        img: 'https://i.imghippo.com/files/jX6330PQ.jpg',
        title: '𝐌ꝛ 𝐍𝚯𝐗 𝚸𝚪𝚰𝚳𝚵𝚵𝚵 𝚯𝐅𝐅𝚰𝐂𝐈𝚫𝐋',
        body: [
          '• NOX HOSTING ☁️ | founder',
          '• PRIMEEE TECH | owner',
          '• BOT/WEB developer',
          '• JavaScript coder',
          '• JUST A CHILL BOY 💳',
        ].join('\n'),
        buttons: [
          { display_text: 'CONTACT', url: 'https://t.me/BANXPRIMEEE' },
          { display_text: 'CHANNEL', url: 'https://whatsapp.com/channel/0029VbBgPkE545urxX1Far0b' },
          { display_text: ' WhatsApp CONTACT', url: 'https://wa.me/message/CNWNQP6S4XT7J1' },
          { display_text: 'GITHUB', url: 'https://www.github.com/nox4primeee' },
        ],
      },
      {
        img: 'https://files.catbox.moe/f9ukn2.png',
        title: 'DEV DRACULA PRIMEEE',
        body: [
          '• Bots Developper',
          '• Dark Crasher 2.0 bot owner',
          '• Haitian boy',
          '• Single',
          '• Student',
        ].join('\n'),
        buttons: [
          { display_text: '📱 WhatsApp', url: 'https://wa.me/224666649030' },
          { display_text: '✈️ Telegram', url: 'https://t.me/Dracula509' },
          { display_text: '📢 TG Channel', url: 'https://t.me/Draculatech' },
          { display_text: 'WA CHANEL', url: 'https://whatsapp.com/channel/0029VbCpwcTLtOjDtbFyTD3F' },
        ],
      },
      {
        img: 'https://d.top4top.io/p_3798q36sy0.jpg',
        title: '𝐌ꝛ 𝐊𝐈𝐑𝐀 𝚸𝚪𝚰𝚳𝚵𝚵𝚵 𝚯𝐅𝐅𝚰𝐂𝐈𝚫𝐋',
        body: [
          '• KIRA HOSTING ☁️ | founder',
          '• PRIMEEE TECH | owner',
          '• BOT/WEB developer',
          '• FATHER OF DEVS',
          '• JUST A CHILL BOY 💳',
        ].join('\n'),
        buttons: [
          { display_text: 'CONTACT', url: 'https://t.me/Loydvan' },
          { display_text: 'CHANNEL', url: 'https://whatsapp.com/channel/0029VaiuYH87z4kYfUcLPe14' },
          { display_text: ' WhatsApp CONTACT', url: 'https://wa.me/message/L3752HTRQ3YPI1' },
          { display_text: '✈️ TG-CONTACT', url: 'https://t.me/DEV_KIRA' },
        ],
      },
      {
        img: 'https://i.imghippo.com/files/sL3181gL.png',
        title: '👑 𝐋𝐎𝐑𝐃 ᬊ𝐏𝐑𝐈𝐌𝐄 ᭄ 𝐍𝐄𝐗𝐔𝐒⃢ 𝐃𝐄𝐕 ࿐',
        body: [
          '• ʙᴍᴀx ɴᴇxᴜs ʙʟs ᴍᴅ 🤖 | creator',
          '• 👑 𝐍𝐄𝐗𝐔𝐒 ᬊ𝐏𝐑𝐈𝐌𝐄 ᭄ 𝐁𝐋𝐗⃢ 𝐋𝐀𝐁𝐒 ࿐ | founder',
          '• Front-end & Back-end developer',
          '• WEB / MOBILE / BOT developer',
          '• JavaScript • HTML • CSS • Python • React',
        ].join('\n'),
        buttons: [
          { display_text: 'CONTACT', url: 'https://wa.me/243843705652' },
          { display_text: 'CHANNEL', url: 'https://whatsapp.com/channel/0029Vb78ycrInlqYocbYLX0P' },
          { display_text: ' WhatsApp CONTACT', url: 'https://wa.me/243843705652' },
          { display_text: '✈️ TG-CONTACT', url: 'https://t.me/LORDPRIME_NEXUSDEV/' },
        ],
      },
      {
        img: 'https://i.ibb.co/gM7Bhs12/e454b3350170.jpg',
        title: '𝐓𝐇𝐄 𝐃𝐀𝐑𝐊𝐍𝚵𝐒𝐒',
        body: [
          '• DARKNESS XMD 🌹 | founder',
          '• DARKNESS TECH | owner',
          '• BOT/WEB developer',
          '• JavaScript coder',
          '• Just a random dev on the net🌹',
        ].join('\n'),
        buttons: [
          { display_text: 'CONTACT', url: 'https://t.me/TheFateDarkness' },
          { display_text: 'CHANNEL', url: 'https://whatsapp.com/channel/0029VbBz3AYBPzjd5is5mJ2W' },
          { display_text: ' WhatsApp CONTACT', url: 'https://wa.me/237671281938' },
          { display_text: '✈️ TG-CONTACT', url: 'https://t.me/TheFateDarkness' },
        ],
      },
    ];

    const imgFields = await Promise.all(cardDefs.map(cd => makeImgField(cd.img)));

    const cards = cardDefs.map((cd, i) => ({
      header: proto.Message.InteractiveMessage.Header.fromObject({
        title: cd.title,
        hasMediaAttachment: !!imgFields[i]?.imageMessage,
        ...(imgFields[i] || {}),
      }),
      body: proto.Message.InteractiveMessage.Body.fromObject({ text: cd.body }),
      nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
        buttons: cd.buttons.map(b => ({
          name: 'cta_url',
          buttonParamsJson: JSON.stringify({ display_text: b.display_text, url: b.url, merchant_url: b.url }),
        })),
      }),
    }));

    const creditMsg = await generateWAMessageFromContent(sender, {
      ephemeralMessage: {
        message: {
          messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
          interactiveMessage: proto.Message.InteractiveMessage.fromObject({
            body: proto.Message.InteractiveMessage.Body.fromObject({ text: ` *${userCfg.BOT_NAME} — Developer Credits*` }),
            footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: `© ${userCfg.OWNER_NAME} • ${userCfg.BOT_FOOTER}` }),
            header: proto.Message.InteractiveMessage.Header.fromObject({ title: '', hasMediaAttachment: false }),
            contextInfo: {},
            carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.fromObject({ cards }),
          }),
        },
      },
    }, { quoted: fakevCard });

    await socket.relayMessage(sender, creditMsg.message, { messageId: creditMsg.key.id });

  } catch (e) {
    console.error('primeee command error:', e);
    await socket.sendMessage(sender, {
      text:
        `🌟 *${userCfg.BOT_NAME} — Credits*\n\n` +
        `👨‍💻 *𝐌ꝛ⥔𝐍𝚯𝐗⥕𝚸𝚪𝚰𝚳𝚵𝚵𝚵𝚵 𝚯𝐅𝐅𝚰𝐂𝐈𝚫𝐋* — JavaScript dev, UoN student, Proud Luo\n` +
        `👨‍💻 *𝐃𝚫𝐑𝐊 𝐆𝚫𝐌𝚵𝐑 𝐎𝐅𝐅𝐈𝐂𝐈𝚫𝐋* — Proud Kikuyu\n\n` +
        `📢 Channel: https://t.me/noxdm\n` +
        `🔗 Pair: https://t.me/primeee_official`
    }, { quoted: fakevCard });
  }
  break;
}



case 'demote': {
    await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });
    if (!isGroup) { await socket.sendMessage(sender, { text: '❌ *Groupe seulement!*' }, { quoted: m }); break; }
    if (!isSenderGroupAdmin && !isOwner) { await socket.sendMessage(sender, { text: '❌ *Admin seulement!*' }, { quoted: m }); break; }
    try {
        let target;
        if (msg.quoted) {
            target = msg.quoted.sender;
        } else if (args[0]) {
            target = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        } else {
            await socket.sendMessage(sender, { text: `📌 Usage: ${userCfg.PREFIX}demote @user ou reply` }, { quoted: m }); break;
        }
        await socket.groupParticipantsUpdate(from, [target], 'demote');
        await socket.sendMessage(sender, {
            image: { url: userCfg.IMAGE_PATH },
            caption: `✅ *@${target.split('@')[0]} n'est plus admin!*\n${userCfg.BOT_FOOTER}`,
            mentions: [target]
        }, { quoted: m });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ Erreur: ${e.message}` }, { quoted: m });
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
            text: `╭━━━━━━━━━━━━━━━━━≽\n┃      *🏓 PING RESULTS*\n╰━━━━━━━━━━━━━━━━━≽\n┃ *⤷  ⚡ Speed  : ${latency}ms*\n┃ *⤷  ${emoji} Quality : ${quality}*\n┃ *⤷  🕒 Time    : ${new Date().toLocaleString()}*\n╰━━━━━━━━━━━━━━━━━≽\n\n╭━━━━━━━━━━━━━━━━━≽\n> ◈ ᴘ𝚘𝚠𝚎𝚛𝚎𝚍 : ${userCfg.BOT_NAME}\n╰━━━━━━━━━━━━━━━━━≽`,
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
            text: `╭━━━━━━━━━━━━━━━━━≽\n┃      *🏓 Ping*\n╰━━━━━━━━━━━━━━━━━≽\n┃ *⤷  ${endTime - startTime}ms*\n╰━━━━━━━━━━━━━━━━━≽`
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

    const contextInfo = msg.msg?.contextInfo;
    const quotedMessage = msg.quoted?.message || 
                         contextInfo?.quotedMessage || 
null;

    if (!quotedMessage) {
      return await socket.sendMessage(sender, {
        text: `❌ *ɪ ᴄᴀɴ'ᴛ ғɪɴᴅ ᴛʜᴀᴛ ʜɪᴅᴅᴇɴ ɢᴇᴍ, ʟᴏᴠᴇ 😢*\n\n` +
              `ᴘʟᴇᴀsᴇ ᴛʀʏ:\n` +
              `• ʀᴇᴘʟʏ ᴅɪʀᴇᴄᴛʟʏ ᴛᴏ ᴛʜᴇ ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇssᴀɢᴇ\n` +
              `• ᴍᴀᴋᴇ sᴜʀᴇ ɪᴛ ʜᴀsɴ'ᴛ ᴠᴀɴɪsʜᴇᴅ!`
      });
    }

    let fileType = null;
    let mediaMessage = null;
    
    if (quotedMessage.viewOnceMessageV2) {
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

    // ✅ FIX : utiliser downloadContentFromMessage au lieu de downloadMediaMessage
    const stream = await downloadContentFromMessage(mediaMessage, fileType);
    let mediaBuffer = Buffer.from([]);
    for await (const chunk of stream) {
        mediaBuffer = Buffer.concat([mediaBuffer, chunk]);
    }

    if (!mediaBuffer || mediaBuffer.length === 0) {
      throw new Error('Failed to download media');
    }

    const mimetype = mediaMessage.mimetype || 
                    (fileType === 'image' ? 'image/jpeg' : 
                     fileType === 'video' ? 'video/mp4' : 'audio/mpeg');

    let messageOptions = {
      caption: `✨ *ʀᴇᴠᴇᴀʟᴇᴅ ${fileType.toUpperCase()}* - ʏᴏᴜ'ʀᴇ ᴡᴇʟᴄᴏᴍᴇ`
    };

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
      case 'viewonce2':
case 'vv2': {
  await socket.sendMessage(sender, { react: { text: '📩', key: msg.key } });

  try {
    if (!msg.quoted) {
      return await socket.sendMessage(sender, {
        text: `🚩 *ʀᴇᴘᴏɴᴅs ᴀ ᴜɴ ᴍᴇssᴀɢᴇ ᴠɪᴇᴡ-ᴏɴᴄᴇ*\n\n` +
              `📝 *ᴜᴛɪʟɪsᴀᴛɪᴏɴ:*\n` +
              `• ʀᴇᴘᴏɴᴅs ᴀ ᴜɴᴇ ɪᴍᴀɢᴇ/ᴠɪᴅᴇᴏ/ᴀᴜᴅɪᴏ ᴠɪᴇᴡ-ᴏɴᴄᴇ\n` +
              `• ᴜᴛɪʟɪsᴇ: ${userCfg.PREFIX}vv2\n` +
              `• ᴊᴇ ᴛ'ᴇɴᴠᴏɪᴇ ʟᴇ ᴍᴇᴅɪᴀ ᴇɴ ᴘʀɪᴠᴇ`
      }, { quoted: m });
    }

    const contextInfo = msg.msg?.contextInfo;
    const quotedMessage = msg.quoted?.message || 
                         contextInfo?.quotedMessage || 
null;

    if (!quotedMessage) {
      return await socket.sendMessage(sender, {
        text: `❌ *ᴍᴇssᴀɢᴇ ɪɴᴛʀᴏᴜᴠᴀʙʟᴇ 😢*`
      }, { quoted: m });
    }

    let fileType = null;
    let mediaMessage = null;

    if (quotedMessage.viewOnceMessageV2) {
      const messageContent = quotedMessage.viewOnceMessageV2.message;
      if (messageContent.imageMessage) { fileType = 'image'; mediaMessage = messageContent.imageMessage; }
      else if (messageContent.videoMessage) { fileType = 'video'; mediaMessage = messageContent.videoMessage; }
      else if (messageContent.audioMessage) { fileType = 'audio'; mediaMessage = messageContent.audioMessage; }
    } else if (quotedMessage.viewOnceMessage) {
      const messageContent = quotedMessage.viewOnceMessage.message;
      if (messageContent.imageMessage) { fileType = 'image'; mediaMessage = messageContent.imageMessage; }
      else if (messageContent.videoMessage) { fileType = 'video'; mediaMessage = messageContent.videoMessage; }
    } else if (quotedMessage.imageMessage?.viewOnce || quotedMessage.videoMessage?.viewOnce || quotedMessage.audioMessage?.viewOnce) {
      if (quotedMessage.imageMessage?.viewOnce) { fileType = 'image'; mediaMessage = quotedMessage.imageMessage; }
      else if (quotedMessage.videoMessage?.viewOnce) { fileType = 'video'; mediaMessage = quotedMessage.videoMessage; }
      else if (quotedMessage.audioMessage?.viewOnce) { fileType = 'audio'; mediaMessage = quotedMessage.audioMessage; }
    }

    if (!fileType || !mediaMessage) {
      return await socket.sendMessage(sender, {
        text: `⚠️ *ᴄᴇ ɴ'ᴇsᴛ ᴘᴀs ᴜɴ ᴍᴇssᴀɢᴇ ᴠɪᴇᴡ-ᴏɴᴄᴇ*`
      }, { quoted: m });
    }

    // Télécharger le média
    const stream = await downloadContentFromMessage(mediaMessage, fileType);
    let mediaBuffer = Buffer.from([]);
    for await (const chunk of stream) {
        mediaBuffer = Buffer.concat([mediaBuffer, chunk]);
    }

    if (!mediaBuffer || mediaBuffer.length === 0) {
      throw new Error('Failed to download media');
    }

    const mimetype = mediaMessage.mimetype || 
                    (fileType === 'image' ? 'image/jpeg' : 
                     fileType === 'video' ? 'video/mp4' : 'audio/mpeg');

    // ✅ Envoyer en PRIVÉ à l'expéditeur (nowsender = JID privé)
    const privateJid = nowsender;

    const caption = `✨ *ᴠɪᴇᴡ-ᴏɴᴄᴇ ʀᴇᴠᴇᴀʟᴇᴅ* 🔓\n> ᴇɴᴠᴏʏᴇ ᴇɴ ᴘʀɪᴠᴇ`;

    if (fileType === 'image') {
      await socket.sendMessage(privateJid, { image: mediaBuffer, caption });
    } else if (fileType === 'video') {
      await socket.sendMessage(privateJid, { video: mediaBuffer, caption });
    } else if (fileType === 'audio') {
      await socket.sendMessage(privateJid, { audio: mediaBuffer, mimetype });
    }

    // Confirmer dans le chat original
    await socket.sendMessage(sender, {
      text: `...`
    }, { quoted: m });

    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

  } catch (error) {
    console.error('VV2 command error:', error);
    await socket.sendMessage(sender, {
      text: `❌ *ᴇʀʀᴇᴜʀ:* ${error.message || 'ǫᴜᴇʟǫᴜᴇ ᴄʜᴏsᴇ s ᴇsᴛ ᴍᴀʟ ᴘᴀssᴇ'}`
    }, { quoted: m });
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
  }
  break;
}
    

    
      
// Case: song

//===============================   
          
//===============================                
// 9
          

//===============================

                    
                          
//===============================
// 13

                                
// ┏━━━━━━━━━━━━━━━❖
// ┃ FUN & ENTERTAINMENT COMMANDS
// ┗━━━━━━━━━━━━━━━❖



//===============================


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
//══════════════════════════════════════════════════

// ─── .cn / checknumber ───────────────────────────────────────────────

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
    
    // ← SEULEMENT CES LIGNES CHANGENT
    const rawText = msg.message?.conversation 
        || msg.message?.extendedTextMessage?.text 
        || body;
    const aisUrlMatch = rawText.match(/https?:\/\/\S+/) 
        || (msg.message?.extendedTextMessage?.contextInfo?.matchedText 
            ? [msg.message.extendedTextMessage.contextInfo.matchedText] 
            : null);
    const aisImageUrl = aisUrlMatch ? aisUrlMatch[0] : '';
    let aisContent = rawText
        .replace(/addinfostart/gi, '')
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/'(\d+)'$/, '')
        .trim()
        .replace(/\n\s*\n/g, '\n');
    // ← FIN DU CHANGEMENT

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
    
    // Fix lien
    const rawText = msg.message?.conversation 
        || msg.message?.extendedTextMessage?.text 
        || body;
    
    const addsCheck = checkCode(rawText, dbAdds.start.secret);
    if (!addsCheck.ok) { await socket.sendMessage(sender, { text: addsCheck.error }, { quoted: m }); break; }
    const addsMatch = rawText.match(/adddetailsstart\s+(\d+)/);
    if (!addsMatch) { await socket.sendMessage(sender, { text: '❌ Usage: adddetailsstart 1' }, { quoted: m }); break; }
    const addsIndex = addsMatch[1];
    let addsRaw = rawText.replace(/adddetailsstart\s+\d+/, '').replace(/'(\d+)'$/, '').trim();
    const addsLines = addsRaw.split('\n').map(v => v.trim()).filter(Boolean);
    if (addsLines.length === 0) { await socket.sendMessage(sender, { text: '❌ Ajoute du contenu' }, { quoted: m }); break; }
    if (!dbAdds.start.details[addsIndex]) dbAdds.start.details[addsIndex] = [];
    for (const line of addsLines) {
        const addsUrl = line.match(/https?:\/\/\S+/)
            || (msg.message?.extendedTextMessage?.contextInfo?.matchedText 
                ? [msg.message.extendedTextMessage.contextInfo.matchedText] 
                : null);
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

function setupMessageHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const userCfg = getUserConfig(sanitizedNumber);

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
            browser: Browsers.ubuntu('Chrome')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket, sanitizedNumber);
        setupAutoRestart(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        handleMessageRevocation(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code (retry ${retries}):`, error.message);
                    if (retries === 0) {
                        activeSockets.delete(sanitizedNumber);
                        socketCreationTime.delete(sanitizedNumber);
                        try { socket.ws.close(); } catch(e) {}
                        if (!res.headersSent) {
                            return res.status(503).send({ error: 'Impossible de générer le code, réessaie.' });
                        }
                        return;
                    }
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) {
                if (!code) return res.status(503).send({ error: 'Code non reçu, réessaie.' });
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
╭━≽ (◠‿◠) 𝕭𝚘𝚝 𝕮𝚘𝚗𝚗𝚎𝚌𝚝𝚎𝚍
╰━━━━━━━━━━━━━━━━━≽
┃ ⤷  𝐍ᴜᴍʙᴇʀ: ${sanitizedNumber}
┃ ⤷  𝕭ᴏᴛ: ${sessionCfg.BOT_NAME}
┃ ⤷  𝐎ᴡɴᴇʀ: ${sessionCfg.OWNER_NAME}${lineageInfo?.parrainedBy ? `\n│ 🔗 ᴘᴀɪʀᴇᴅ ʙʏ: ${lineageInfo.parrainedBy}` : ''}
┃ ⤷  𝐆ʀᴏᴜᴘ: ${groupStatus}
┃ ⤷  𝕮ᴏɴɴᴇᴄᴛᴇᴅ: ${new Date().toLocaleString()}
┃ ⤷  𝐓ʏᴘᴇ *${sessionCfg.PREFIX}menu* 𝐓ᴏ 𝐆ᴇᴛ 𝐒ᴛᴀʀᴛᴇᴅ!
╰━━━━━━━━━━━━━━━━━≽

╭━━━━━━━━━━━━━━━━━≽
> ◈ᴘ𝚘𝚠𝚎𝚛𝚎𝚍 : 𝐌ʀ 𝕯ʀᴀᴄᴜʟᴀ 𝕯ᴇᴠ   
╰━━━━━━━━━━━━━━━━━≽
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


          
