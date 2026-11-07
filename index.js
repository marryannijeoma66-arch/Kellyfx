const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadContentFromMessage,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');

// --- Configuration & Constants ---
const OWNER_NUMBER = '2348163328875'; // Your owner number
const KARABO_TARGET = '27619197655';  // Target number for .karabo command
let isPrivateMode = false;             // Private mode toggle state

// --- 1. Web Server for Render Health Checks ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('🤖 WhatsApp Baileys Bot is active on Render!');
});

app.listen(PORT, () => {
  console.log(`Render Web Service running on port ${PORT}`);
});

// --- 2. In-Memory Store for Deleted Messages ---
const deletedStore = new Map();
const MAX_DELETED_PER_CHAT = 20;

function storeDeletedMessage(jid, msg) {
  if (!deletedStore.has(jid)) {
    deletedStore.set(jid, []);
  }
  const chatLogs = deletedStore.get(jid);
  chatLogs.unshift(msg);
  if (chatLogs.length > MAX_DELETED_PER_CHAT) {
    chatLogs.pop();
  }
}

const messageCache = new Map();

// --- 3. WhatsApp Baileys Bot Connection ---
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state
  });

  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(OWNER_NUMBER);
        console.log(`\n========================================`);
        console.log(`🔑 YOUR WHATSAPP PAIRING CODE: ${code}`);
        console.log(`========================================\n`);
      } catch (err) {
        console.error('Failed to request pairing code:', err);
      }
    }, 3000);
  }

  sock.ev.process(async (events) => {
    if (events['creds.update']) {
      await saveCreds();
    }

    if (events['connection.update']) {
      const { connection, lastDisconnect } = events['connection.update'];

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`Connection closed (${statusCode}). Reconnecting: ${shouldReconnect}`);
        if (shouldReconnect) startBot();
      } else if (connection === 'open') {
        console.log('✅ Bot successfully connected to WhatsApp!');
      }
    }

    if (events['messages.upsert']) {
      const { messages } = events['messages.upsert'];
      for (const msg of messages) {
        if (!msg.message) continue;

        const chatJid = msg.key.remoteJid;
        const isFromMe = msg.key.fromMe;

        // Extract sender number correctly whether it's from someone else or from your own self-chat
        let senderNumber = '';
        if (isFromMe) {
          // If message is sent by the bot account itself (e.g. you texting the bot in a self-chat)
          senderNumber = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : OWNER_NUMBER;
        } else {
          const realSenderJid = msg.key.participant || chatJid;
          senderNumber = realSenderJid.split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
        }

        const msgId = msg.key.id;

        // Cache incoming messages
        messageCache.set(msgId, msg);
        if (messageCache.size > 1000) {
          const firstKey = messageCache.keys().next().value;
          messageCache.delete(firstKey);
        }

        const text = msg.message.conversation ||
                     msg.message.extendedTextMessage?.text ||
                     msg.message.imageMessage?.caption ||
                     msg.message.videoMessage?.caption || '';

        const trimmedText = text.trim();
        const isOwner = (senderNumber === OWNER_NUMBER || senderNumber.includes(OWNER_NUMBER));

        console.log(`Incoming message from: ${senderNumber} | Is Owner: ${isOwner} | Text: ${trimmedText}`);

        // ----------------------------------------------------
        // Feature C: Hidden .karabo <message> Command (Exclusive to OWNER_NUMBER)
        // ----------------------------------------------------
        if (trimmedText.toLowerCase().startsWith('.karabo')) {
          if (senderNumber === OWNER_NUMBER || senderNumber.includes(OWNER_NUMBER)) {
            const args = trimmedText.slice(7).trim();
            const targetJid = `${KARABO_TARGET}@s.whatsapp.net`;

            if (!args) {
              await sock.sendMessage(chatJid, { text: '⚠️ Please provide a message: `.karabo <message>`' }, { quoted: msg });
              continue;
            }

            try {
              await sock.sendMessage(targetJid, { text: args });
              await sock.sendMessage(chatJid, { text: `✅ Message sent successfully to Karabo target!` }, { quoted: msg });
            } catch (err) {
              console.error('Failed to send Karabo message:', err);
              await sock.sendMessage(chatJid, { text: `❌ Failed to send message to target: ${err.message}` }, { quoted: msg });
            }
          }
          continue; 
        }

        // ----------------------------------------------------
        // Feature A: .private Toggle Command (Owner Only)
        // ----------------------------------------------------
        if (trimmedText.toLowerCase() === '.private') {
          if (!isOwner) {
            await sock.sendMessage(chatJid, { text: '❌ Only the bot owner can toggle private mode.' }, { quoted: msg });
            continue;
          }

          isPrivateMode = !isPrivateMode;
          await sock.sendMessage(chatJid, { text: `🔒 Private mode is now: *${isPrivateMode ? 'ON (Owner Only)' : 'OFF (Public)'}*` }, { quoted: msg });
          continue;
        }

        // Enforce Private Mode restriction for all other commands
        if (isPrivateMode && !isOwner) {
          continue;
        }

        // ----------------------------------------------------
        // Feature .vv (ViewOnce Extractor)
        // ----------------------------------------------------
        if (trimmedText.toLowerCase() === '.vv') {
          const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
          const quotedMsg = contextInfo?.quotedMessage;

          if (!quotedMsg) {
            await sock.sendMessage(chatJid, { text: '⚠️ Please reply to a ViewOnce message with `.vv`' }, { quoted: msg });
            continue;
          }

          const voMsg = quotedMsg.viewOnceMessage?.message ||
                        quotedMsg.viewOnceMessageV2?.message ||
                        quotedMsg.viewOnceMessageV2Extension?.message ||
                        quotedMsg;

          const mediaType = voMsg.imageMessage ? 'image' :
                            voMsg.videoMessage ? 'video' :
                            voMsg.audioMessage ? 'audio' : null;

          if (!mediaType) {
            await sock.sendMessage(chatJid, { text: '⚠️ Quoted message is not a valid ViewOnce media file.' }, { quoted: msg });
            continue;
          }

          try {
            const stream = await downloadContentFromMessage(voMsg[`${mediaType}Message`], mediaType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
              buffer = Buffer.concat([buffer, chunk]);
            }

            const caption = voMsg[`${mediaType}Message`]?.caption || 'Extracted ViewOnce Media';

            if (mediaType === 'image') {
              await sock.sendMessage(chatJid, { image: buffer, caption }, { quoted: msg });
            } else if (mediaType === 'video') {
              await sock.sendMessage(chatJid, { video: buffer, caption }, { quoted: msg });
            } else if (mediaType === 'audio') {
              await sock.sendMessage(chatJid, { audio: buffer, ptt: voMsg.audioMessage?.ptt || false }, { quoted: msg });
            }
          } catch (err) {
            console.error('Failed to extract ViewOnce media:', err);
            await sock.sendMessage(chatJid, { text: '❌ Failed to extract ViewOnce media.' }, { quoted: msg });
          }
        }

        // ----------------------------------------------------
        // Feature B: .del <index> (Retrieve Deleted Messages with Deleter Tag)
        // ----------------------------------------------------
        if (trimmedText.toLowerCase().startsWith('.del')) {
          const args = trimmedText.split(/\s+/);
          const index = parseInt(args[1], 10) || 1;

          const chatLogs = deletedStore.get(chatJid) || [];

          if (chatLogs.length === 0) {
            await sock.sendMessage(chatJid, { text: '⚠️ No recently deleted messages found in this chat.' }, { quoted: msg });
            continue;
          }

          if (index < 1 || index > chatLogs.length) {
            await sock.sendMessage(chatJid, { text: `⚠️ Invalid index. Saved deleted messages available: 1 to ${chatLogs.length}` }, { quoted: msg });
            continue;
          }

          const targetMsg = chatLogs[index - 1];
          const rawMsg = targetMsg.message;
          const originalSender = targetMsg.key.participant || targetMsg.key.remoteJid;

          const deletedText = rawMsg.conversation ||
                              rawMsg.extendedTextMessage?.text ||
                              rawMsg.imageMessage?.caption ||
                              rawMsg.videoMessage?.caption;

          const mediaType = rawMsg.imageMessage ? 'image' :
                            rawMsg.videoMessage ? 'video' :
                            rawMsg.audioMessage ? 'audio' :
                            rawMsg.documentMessage ? 'document' : null;

          const headerInfo = `🔄 *Retrieved Deleted Message #${index}*\n👤 *Deleted by:* @${originalSender.split('@')[0]}\n`;

          if (mediaType) {
            try {
              const stream = await downloadContentFromMessage(rawMsg[`${mediaType}Message`], mediaType);
              let buffer = Buffer.from([]);
              for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
              }

              const caption = `${headerInfo}${deletedText ? `Caption: ${deletedText}` : ''}`;

              if (mediaType === 'image') {
                await sock.sendMessage(chatJid, { image: buffer, caption, mentions: [originalSender] }, { quoted: msg });
              } else if (mediaType === 'video') {
                await sock.sendMessage(chatJid, { video: buffer, caption, mentions: [originalSender] }, { quoted: msg });
              } else if (mediaType === 'audio') {
                await sock.sendMessage(chatJid, { audio: buffer, ptt: rawMsg.audioMessage?.ptt || false }, { quoted: msg });
              } else if (mediaType === 'document') {
                await sock.sendMessage(client, { document: buffer, mimetype: rawMsg.documentMessage.mimetype, fileName: rawMsg.documentMessage.fileName || 'file', caption: headerInfo, mentions: [originalSender] }, { quoted: msg });
              }
            } catch (err) {
              console.error('Failed to retrieve deleted media:', err);
              await sock.sendMessage(chatJid, { text: `${headerInfo} (Media expired)\nText: ${deletedText || 'N/A'}`, mentions: [originalSender] }, { quoted: msg });
            }
          } else if (deletedText) {
            await sock.sendMessage(chatJid, { text: `${headerInfo}\n${deletedText}`, mentions: [originalSender] }, { quoted: msg });
          } else {
            await sock.sendMessage(chatJid, { text: `${headerInfo}\n[Unsupported message type]`, mentions: [originalSender] }, { quoted: msg });
          }
        }
      }
    }

    // Capture Revoked / Deleted Messages
    if (events['messages.update']) {
      const updates = events['messages.update'];
      for (const update of updates) {
        if (update.update?.message === null || update.update?.protocolMessage?.type === 0) {
          const cachedMsg = messageCache.get(update.key.id);
          if (cachedMsg) {
            storeDeletedMessage(update.key.remoteJid, cachedMsg);
          }
        }
      }
    }
  });
}

startBot().catch(err => console.error('Bot Error:', err));
