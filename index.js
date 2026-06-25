const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
} = require('@whiskeysockets/baileys');
const pino = require('pino');

// Variabel Penyimpanan di Memory (Efisien untuk RAM 2GB)
// Idealnya, jika bot mulai ramai (ratusan user), ini diganti menggunakan file JSON ringan (lowdb)
let searchQueue = []; // Array menampung nomor yang mencari pasangan (misal: ['6281...'])
let activeSessions = {}; // Objek menampung sesi yang aktif. Format: { '6281...': '6289...', '6289...': '6281...' }

async function startBot() {
    // Menyimpan sesi login (auth) ke folder './auth_info' agar tidak perlu scan QR tiap kali bot direstart
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }), // Matikan log verbose agar terminal tidak penuh
        printQRInTerminal: true // Akan memunculkan QR Code di terminal SSH saat pertama kali run
    });

    sock.ev.on('creds.update', saveCreds);

    // Menangani status koneksi (restart otomatis jika putus)
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus. Menghubungkan ulang:', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('Bot berhasil terhubung ke WhatsApp!');
        }
    });

    // Menangani pesan masuk
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return; // Abaikan pesan yang bukan notifikasi baru
        const msg = messages[0];
        
        // Abaikan pesan dari diri sendiri atau dari grup
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid.includes('@g.us')) return;

        const sender = msg.key.remoteJid; // Nomor pengirim (format: 628...x@s.whatsapp.net)
        
        // Ekstrak teks (dukungan untuk pesan biasa dan pesan gambar/video yang pakai caption)
        const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || "";
        const command = textMessage.toLowerCase().trim();

        // ----------------------------------------------------
        // LOGIKA ANONYMOUS CHAT
        // ----------------------------------------------------

        // 1. Perintah Cari Pasangan (/search atau /start)
        if (command === '/search' || command === '/start') {
            // Cek apakah dia sedang chat dengan orang lain
            if (activeSessions[sender]) {
                await sock.sendMessage(sender, { text: "⚠️ Kamu masih dalam obrolan aktif. Ketik /stop untuk keluar dulu." });
                return;
            }
            // Cek apakah dia sudah ada di antrean
            if (searchQueue.includes(sender)) {
                await sock.sendMessage(sender, { text: "⏳ Kamu sudah ada di antrean. Menunggu pasangan..." });
                return;
            }

            // Cek apakah ada orang lain di antrean
            if (searchQueue.length > 0) {
                // Ada! Jodohkan dengan orang pertama di antrean
                const partner = searchQueue.shift(); // Ambil dan hapus nomor pertama dari array

                // Buat relasi pasangan
                activeSessions[sender] = partner;
                activeSessions[partner] = sender;

                // Beritahu keduanya
                await sock.sendMessage(sender, { text: "✅ Pasangan ditemukan! Mulai mengobrol sekarang. (Ketik /stop untuk mengakhiri)" });
                await sock.sendMessage(partner, { text: "✅ Pasangan ditemukan! Mulai mengobrol sekarang. (Ketik /stop untuk mengakhiri)" });
                return;
            } else {
                // Tidak ada antrean, masukkan dia ke antrean
                searchQueue.push(sender);
                await sock.sendMessage(sender, { text: "🔍 Mencari pasangan... Silakan tunggu." });
                return;
            }
        }

        // 2. Perintah Berhenti Chat (/stop atau /next)
        if (command === '/stop' || command === '/next') {
            // Jika dia sedang di antrean, keluarkan
            if (searchQueue.includes(sender)) {
                searchQueue = searchQueue.filter(id => id !== sender);
                await sock.sendMessage(sender, { text: "❌ Pencarian dihentikan." });
                return;
            }

            // Jika dia dalam obrolan, putuskan hubungan
            const partner = activeSessions[sender];
            if (partner) {
                delete activeSessions[sender];
                delete activeSessions[partner];

                await sock.sendMessage(sender, { text: "🛑 Obrolan dihentikan." });
                await sock.sendMessage(partner, { text: "🛑 Pasanganmu telah meninggalkan obrolan." });

                // Fitur Auto-Next: Jika dia ketik /next, langsung cari lagi
                if (command === '/next') {
                     // Simulasi seperti ketik /search
                     searchQueue.push(sender);
                     await sock.sendMessage(sender, { text: "🔍 Mencari pasangan baru... Silakan tunggu." });
                }
                return;
            }

            // Jika tidak ngapa-ngapain
            await sock.sendMessage(sender, { text: "Kamu tidak sedang mengobrol. Ketik /search untuk mencari teman." });
            return;
        }

        // 3. Meneruskan Pesan (Jika sedang berpasangan dan bukan perintah /command)
        const partner = activeSessions[sender];
        if (partner && !command.startsWith('/')) {
            // TERUSKAN SEMUA JENIS PESAN: Teks, Gambar, Voice Note, Stiker
            // Kita tidak mem-parsing satu per satu, tapi meneruskan mentah-mentah (forward)
            try {
                // Konsep forwarding ini menggunakan fungsi bawaan Baileys untuk meng-copy message
                // agar jenis formatnya tidak rusak.
                const copyMessage = { forward: msg };
                await sock.sendMessage(partner, copyMessage);
            } catch (error) {
                console.error("Gagal meneruskan pesan:", error);
            }
            return;
        }

        // 4. Default: Jika belum chat dan bukan perintah
        if (!partner && !command.startsWith('/')) {
            await sock.sendMessage(sender, { text: "Halo! Ketik /search untuk mulai mengobrol secara anonim." });
        }
    });
}

startBot();

