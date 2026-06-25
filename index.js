const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
} = require('@whiskeysockets/baileys');
const pino = require('pino');

// Variabel Penyimpanan di Memory
let searchQueue = []; 
let activeSessions = {}; 

async function startBot() {
    // Auth state akan menyimpan sesi agar tidak perlu login ulang setelah restart
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'info' }),
        browser: ['Bot Anonymous', 'Safari', '1.0.0'],
        printQRInTerminal: false // Kita pakai Pairing Code saja
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        // --- LOGIKA PAIRING CODE (FIXED) ---
        // Jika bot belum terdaftar dan statusnya sedang connecting, minta kode
        if (connection === 'connecting' && !sock.authState.creds.registered) {
            const phoneNumber = '6285608637146'; // Pastikan nomor benar
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                console.log(`\n========================================`);
                console.log(`📌 KODE TAUTAN WHATSAPP: ${code}`);
                console.log(`========================================\n`);
            } catch (err) {
                console.log('Gagal meminta Pairing Code:', err.message);
            }
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus. Alasan:', lastDisconnect.error?.message);
            
                        if (shouldReconnect) {
                console.log('Menunggu 10 detik sebelum menyambung ulang...');
                // Tambahkan jeda agar server WhatsApp tidak memblokir IP STB-mu
                await new Promise(resolve => setTimeout(resolve, 10000)); 
                process.exit(1); 
            }
        } else if (connection === 'open') {
            console.log('\n✅ BOT BERHASIL TERHUBUNG KE WHATSAPP!\n');
        }
    });

    // Menangani pesan masuk
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid.includes('@g.us')) return;

        const sender = msg.key.remoteJid; 
        const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || "";
        const command = textMessage.toLowerCase().trim();

        // 1. Perintah Cari Pasangan
        if (command === '/search' || command === '/start') {
            if (activeSessions[sender]) {
                await sock.sendMessage(sender, { text: "⚠️ Kamu masih dalam obrolan aktif. Ketik /stop untuk keluar dulu." });
                return;
            }
            if (searchQueue.includes(sender)) {
                await sock.sendMessage(sender, { text: "⏳ Kamu sudah ada di antrean. Menunggu pasangan..." });
                return;
            }

            if (searchQueue.length > 0) {
                const partner = searchQueue.shift(); 
                activeSessions[sender] = partner;
                activeSessions[partner] = sender;
                await sock.sendMessage(sender, { text: "✅ Pasangan ditemukan! Mulai mengobrol sekarang. (Ketik /stop untuk mengakhiri)" });
                await sock.sendMessage(partner, { text: "✅ Pasangan ditemukan! Mulai mengobrol sekarang. (Ketik /stop untuk mengakhiri)" });
                return;
            } else {
                searchQueue.push(sender);
                await sock.sendMessage(sender, { text: "🔍 Mencari pasangan... Silakan tunggu." });
                return;
            }
        }

        // 2. Perintah Berhenti Chat
        if (command === '/stop' || command === '/next') {
            if (searchQueue.includes(sender)) {
                searchQueue = searchQueue.filter(id => id !== sender);
                await sock.sendMessage(sender, { text: "❌ Pencarian dihentikan." });
                return;
            }
            const partner = activeSessions[sender];
            if (partner) {
                delete activeSessions[sender];
                delete activeSessions[partner];
                await sock.sendMessage(sender, { text: "🛑 Obrolan dihentikan." });
                await sock.sendMessage(partner, { text: "🛑 Pasanganmu telah meninggalkan obrolan." });
                if (command === '/next') {
                     searchQueue.push(sender);
                     await sock.sendMessage(sender, { text: "🔍 Mencari pasangan baru... Silakan tunggu." });
                }
                return;
            }
            await sock.sendMessage(sender, { text: "Kamu tidak sedang mengobrol. Ketik /search untuk mencari teman." });
            return;
        }

        // 3. Meneruskan Pesan
        const partner = activeSessions[sender];
        if (partner && !command.startsWith('/')) {
            try {
                const copyMessage = { forward: msg };
                await sock.sendMessage(partner, copyMessage);
            } catch (error) {
                console.error("Gagal meneruskan pesan:", error);
            }
            return;
        }

        // 4. Default
        if (!partner && !command.startsWith('/')) {
            await sock.sendMessage(sender, { text: "Halo! Ketik /search untuk mulai mengobrol secara anonim." });
        }
    });
}

startBot();
