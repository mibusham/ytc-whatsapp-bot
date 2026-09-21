require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const qrcode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase Configuration
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xhuyehfiebcmoolfkumz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhodXllaGZpZWJjbW9vbGZrdW16Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM1MzgxNjEsImV4cCI6MjA3OTExNDE2MX0.DVy_g-cQTjc-pLjD348sd4JtYNKdN-2lx9A23DXUkO0';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const AUTH_DIR = path.resolve(__dirname, 'auth_info_baileys');

// Bot State
let sock = null;
let currentQrCode = null;
let qrDataUrl = null;
let connectionStatus = 'initializing'; // 'initializing', 'qr_ready', 'connected', 'disconnected'
let botUser = null;
let lastCheckTime = null;
let lastBlastResult = null;

// Target Group Configuration
const TARGET_GROUP_NAME = process.env.TARGET_GROUP_NAME || 'Workers Safety';

/**
 * Restore WhatsApp Auth Session from Supabase Cloud
 */
async function restoreAuthFromSupabase() {
  try {
    const { data, error } = await supabase
      .from('site_logs')
      .select('files')
      .eq('date', 'BOT_AUTH_STATE')
      .maybeSingle();

    if (error || !data || !data.files || typeof data.files !== 'object') {
      console.log('[Auth Persistence] Tiada sesi WhatsApp tersimpan di Supabase.');
      return false;
    }

    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    const files = data.files;
    let count = 0;
    for (const [filename, content] of Object.entries(files)) {
      if (filename && typeof content === 'string') {
        fs.writeFileSync(path.join(AUTH_DIR, filename), content, 'utf-8');
        count++;
      }
    }
    console.log(`[Auth Persistence] ✅ Berjaya restore ${count} fail sesi login WhatsApp dari Supabase!`);
    return count > 0;
  } catch (err) {
    console.error('[Auth Restore Error]:', err);
    return false;
  }
}

/**
 * Backup WhatsApp Auth Session to Supabase Cloud (Debounced)
 */
let saveDebounceTimer = null;
function backupAuthToSupabase() {
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(async () => {
    try {
      if (!fs.existsSync(AUTH_DIR)) return;
      const fileNames = fs.readdirSync(AUTH_DIR);
      if (fileNames.length === 0) return;

      const filesObj = {};
      for (const name of fileNames) {
        const fullPath = path.join(AUTH_DIR, name);
        if (fs.statSync(fullPath).isFile()) {
          filesObj[name] = fs.readFileSync(fullPath, 'utf-8');
        }
      }

      const { error } = await supabase
        .from('site_logs')
        .upsert({
          date: 'BOT_AUTH_STATE',
          files: filesObj
        }, { onConflict: 'date' });

      if (error) {
        console.error('[Auth Backup Error] Gagal simpan sesi ke Supabase:', error);
      } else {
        console.log(`[Auth Backup] ✅ Berjaya simpan ${fileNames.length} fail sesi WhatsApp ke Supabase Cloud.`);
      }
    } catch (err) {
      console.error('[Auth Backup Exception]:', err);
    }
  }, 2500);
}

/**
 * Fetch Pending Findings from Supabase for Everine site only
 */
async function fetchPendingFindings() {
  try {
    const { data, error } = await supabase
      .from('site_logs')
      .select('date, findings')
      .eq('date', 'EVERINE_2000-01-01');

    if (error) {
      console.error('[DB Error] Failed to fetch findings:', error);
      return [];
    }

    const pendingList = [];
    (data || []).forEach(row => {
      const findings = Array.isArray(row.findings) ? row.findings : [];
      findings.forEach(f => {
        if (f && f.status === 'pending') {
          pendingList.push({
            ...f,
            site: 'Everine'
          });
        }
      });
    });

    return pendingList;
  } catch (err) {
    console.error('[Exception] Error fetching findings:', err);
    return [];
  }
}

/**
 * Find Target WhatsApp Group JID
 */
async function findTargetGroup() {
  if (!sock) return null;
  try {
    const groups = await sock.groupFetchAllParticipating();
    const groupList = Object.values(groups);
    
    // Exact or partial match (case-insensitive)
    const target = groupList.find(g => 
      g.subject && g.subject.toLowerCase().includes(TARGET_GROUP_NAME.toLowerCase())
    );

    if (target) {
      console.log(`[Target Found] Found matching group: "${target.subject}" (${target.id})`);
      return target.id;
    }

    console.warn(`[Warning] No group matching "${TARGET_GROUP_NAME}" found. Available groups:`, groupList.map(g => g.subject));
    return null;
  } catch (err) {
    console.error('[Error] Failed to fetch groups:', err);
    return null;
  }
}

/**
 * Execute Blast: Send Pending Findings to WhatsApp Group
 */
async function executeFindingsBlast(triggerSource = 'Scheduled') {
  lastCheckTime = new Date().toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' });
  console.log(`\n========================================`);
  console.log(`[Blast Started] Trigger: ${triggerSource} at ${lastCheckTime}`);

  if (connectionStatus !== 'connected' || !sock) {
    const msg = 'Bot WhatsApp belum bersambung. Sila scan QR code terlebih dahulu.';
    console.warn(`[Abort] ${msg}`);
    lastBlastResult = { success: false, message: msg, time: lastCheckTime };
    return lastBlastResult;
  }

  const groupId = await findTargetGroup();
  if (!groupId) {
    const msg = `Group WhatsApp "${TARGET_GROUP_NAME}" tidak dijumpai. Pastikan bot dimasukkan ke dalam group.`;
    console.warn(`[Abort] ${msg}`);
    lastBlastResult = { success: false, message: msg, time: lastCheckTime };
    return lastBlastResult;
  }

  const pendingFindings = await fetchPendingFindings();
  console.log(`[Found] ${pendingFindings.length} pending findings in dashboard.`);

  if (pendingFindings.length === 0) {
    const cleanMsg = `✅ *STATUS KESELAMATAN TAPAK YTC: 100% COMPLIANT*\n📅 ${lastCheckTime}\n\nSemua isu keselamatan (hazards) telah diselesaikan. Tiada sebarang pending finding buat masa ini. Terima kasih atas kerjasama semua team!`;
    await sock.sendMessage(groupId, { text: cleanMsg });
    lastBlastResult = { success: true, count: 0, message: 'All clear, no pending findings.', time: lastCheckTime };
    return lastBlastResult;
  }

  // 1. Send Header Alert Message
  const headerMsg = `🚨 *PERINGATAN KESELAMATAN TAPAK — PENDING HAZARDS REPORT*\n` +
    `📍 *Tapak:* YTC Everine\n` +
    `📅 *Masa Semakan:* ${lastCheckTime}\n` +
    `⚠️ *Jumlah Isu Belum Selesai:* ${pendingFindings.length} Finding(s)\n\n` +
    `Perhatian kepada semua Penyelia, Mandur & Subcon:\n` +
    `Berikut adalah senarai isu keselamatan di tapak Everine yang dikesan dan memerlukan tindakan segera.`;

  await sock.sendMessage(groupId, { text: headerMsg });
  await new Promise(r => setTimeout(r, 1500));

  // 2. Send Each Finding with Photo & Concise Caption
  let sentCount = 0;
  for (let i = 0; i < pendingFindings.length; i++) {
    const f = pendingFindings[i];
    const riskBadge = f.riskLevel === 'High' ? '🔴 TINGGI (HIGH RISK)' : (f.riskLevel === 'Medium' ? '🟡 SEDERHANA' : '🟢 RENDAH');

    const caption = 
      `⚠️ *ISU KESELAMATAN #${i + 1} OF ${pendingFindings.length}*\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `📍 *Tapak Projek:* YTC Everine\n` +
      `🚨 *Tahap Risiko:* ${riskBadge}\n` +
      `📌 *Isu / Hazard:*\n"${f.description || 'Tiada keterangan'}"\n\n` +
      `⏰ *Status:* Belum Selesai (Pending)\n` +
      `📸 Sila ambil tindakan segera dan hantar bukti pembetulan.`;

    try {
      if (f.imageUrl && f.imageUrl.startsWith('http')) {
        console.log(`[Sending #${i + 1}] Image with caption: ${f.description}`);
        await sock.sendMessage(groupId, {
          image: { url: f.imageUrl },
          caption: caption
        });
      } else {
        console.log(`[Sending #${i + 1}] Text only: ${f.description}`);
        await sock.sendMessage(groupId, { text: caption });
      }
      sentCount++;
    } catch (sendErr) {
      console.error(`[Error Sending #${i + 1}]:`, sendErr);
    }

    // Delay between messages to avoid WhatsApp spam filters
    await new Promise(r => setTimeout(r, 2500));
  }

  // 3. Send Closing Footer Message (Tanpa sebarang link dashboard)
  const footerMsg = `━━━━━━━━━━━━━━━━━━━━━\n` +
    `_Mesej ini dihantar secara automatik oleh YTC Safety Inspection Bot._`;
  await sock.sendMessage(groupId, { text: footerMsg });

  lastBlastResult = {
    success: true,
    count: sentCount,
    message: `Berjaya hantar ${sentCount} isu keselamatan ke group "${TARGET_GROUP_NAME}".`,
    time: lastCheckTime
  };
  console.log(`[Blast Complete] ${lastBlastResult.message}\n========================================\n`);
  return lastBlastResult;
}

/**
 * Initialize Baileys WhatsApp Connection with Supabase Persistence
 */
async function connectToWhatsApp() {
  await restoreAuthFromSupabase();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
    browser: ['YTC Safety Bot', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    backupAuthToSupabase();
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQrCode = qr;
      qrDataUrl = await qrcode.toDataURL(qr);
      connectionStatus = 'qr_ready';
      console.log('\n[WhatsApp QR Code Ready] Buka browser di /qr untuk scan.\n');
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[Connection Closed] Status code: ${statusCode}, reconnecting: ${shouldReconnect}`);
      connectionStatus = 'disconnected';

      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 4000);
      } else {
        console.log('[Logged Out] WhatsApp logout dikesan. Memadamkan sesi lama.');
        await supabase.from('site_logs').delete().eq('date', 'BOT_AUTH_STATE');
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
        currentQrCode = null;
        qrDataUrl = null;
        setTimeout(connectToWhatsApp, 2000);
      }
    } else if (connection === 'open') {
      connectionStatus = 'connected';
      currentQrCode = null;
      qrDataUrl = null;
      botUser = sock.user;
      console.log('\n✅ [WhatsApp Connected!] Bot sedia bertugas sebagai:', botUser.name || botUser.id);
      backupAuthToSupabase();
    }
  });
}

// ----------------------------------------------------
// Express Web Server & Endpoints
// ----------------------------------------------------

// Home / Dashboard Status
app.get('/', async (req, res) => {
  const pending = await fetchPendingFindings();
  const statusColor = connectionStatus === 'connected' ? '#10b981' : (connectionStatus === 'qr_ready' ? '#f59e0b' : '#ef4444');
  const statusText = connectionStatus === 'connected' ? 'Connected (Online)' : (connectionStatus === 'qr_ready' ? 'Waiting for QR Scan' : 'Disconnected');

  res.send(`
    <!DOCTYPE html>
    <html lang="ms">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>YTC Safety WhatsApp Bot</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 24px; }
        .card { max-width: 620px; margin: 0 auto; background: #ffffff; border-radius: 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.05); border: 1px solid #e2e8f0; overflow: hidden; }
        .header { background: #0f172a; color: #fff; padding: 24px; text-align: center; }
        .content { padding: 24px; }
        .status-badge { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 999px; font-weight: bold; font-size: 13px; }
        .btn { display: inline-block; padding: 12px 20px; border-radius: 12px; font-weight: bold; text-decoration: none; color: #fff; background: #0f172a; margin-top: 12px; text-align: center; }
        .btn-green { background: #10b981; }
        .btn-amber { background: #f59e0b; }
        .info-box { background: #f1f5f9; padding: 16px; border-radius: 12px; margin: 16px 0; font-size: 14px; }
        .cloud-badge { background: #e0f2fe; color: #0369a1; padding: 4px 10px; border-radius: 6px; font-weight: 600; font-size: 12px; display: inline-block; margin-top: 6px; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <h2 style="margin:0;">👷‍♂️ YTC Safety WhatsApp Bot</h2>
          <p style="margin:6px 0 0 0; opacity: 0.8; font-size: 13px;">Auto-Blast Pending Findings ke Group WhatsApp</p>
        </div>
        <div class="content">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span>Status WhatsApp:</span>
            <span class="status-badge" style="background: ${statusColor}20; color: ${statusColor}; border: 1px solid ${statusColor}50;">
              <span style="width:8px; height:8px; border-radius:50%; background:${statusColor};"></span>
              ${statusText}
            </span>
          </div>

          <div class="info-box">
            <p style="margin: 4px 0;"><strong>Target Group:</strong> ${TARGET_GROUP_NAME}</p>
            <p style="margin: 4px 0;"><strong>Pending Findings Aktif:</strong> <span style="color:#ef4444; font-weight:bold;">${pending.length} Isu (Everine)</span></p>
            <p style="margin: 4px 0;"><strong>Semakan Terakhir:</strong> ${lastCheckTime || 'Belum dijalankan'}</p>
            <p style="margin: 4px 0;"><strong>Jadual Harian:</strong> 🌅 8:30 AM & 🌇 4:30 PM (MYT)</p>
            <div class="cloud-badge">☁️ Cloud Persistence: Sesi Disimpan di Supabase (Kekal)</div>
          </div>

          ${connectionStatus !== 'connected' ? `
            <a href="/qr" class="btn btn-amber" style="display:block;">📲 Scan QR Code WhatsApp Sekarang</a>
          ` : `
            <div style="display:flex; gap:10px;">
              <a href="/test-blast" class="btn btn-green" style="flex:1;">🚀 Tembak Blast Sekarang (Manual Test)</a>
              <a href="/groups" class="btn" style="flex:1; background:#475569;">📋 Senarai Group WhatsApp</a>
            </div>
          `}

          ${lastBlastResult ? `
            <div style="margin-top:20px; padding:12px; border-radius:8px; background:${lastBlastResult.success ? '#ecfdf5' : '#fef2f2'}; border:1px solid ${lastBlastResult.success ? '#a7f3d0' : '#fecaca'}; font-size:13px;">
              <strong>Keputusan Terkini:</strong> ${lastBlastResult.message}
            </div>
          ` : ''}

          <div style="margin-top: 24px; padding: 12px; background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px; font-size: 12px; color: #92400e;">
            <strong>🔗 Webhook URL untuk Cron-Job:</strong><br/>
            <code>https://ytc-safety-bot.onrender.com/api/blast</code><br/>
            <span style="opacity: 0.85;">Panggil URL ini melalui cron-job.org untuk auto-wake & blast jam 8:30 AM & 4:30 PM tanpa gagal.</span>
          </div>
        </div>
      </div>
    </body>
    </html>
  `);
});

// QR Code Display Page
app.get('/qr', (req, res) => {
  if (connectionStatus === 'connected') {
    return res.redirect('/');
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="ms">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Scan WhatsApp QR - YTC Safety Bot</title>
      <meta http-equiv="refresh" content="5">
      <style>
        body { font-family: -apple-system, sans-serif; background: #0f172a; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; text-align: center; padding: 20px; }
        .qr-card { background: #ffffff; color: #0f172a; padding: 24px; border-radius: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.3); max-width: 340px; }
        img { width: 250px; height: 250px; border-radius: 12px; }
      </style>
    </head>
    <body>
      <div class="qr-card">
        <h3 style="margin-top:0;">📱 Sambungkan WhatsApp</h3>
        <p style="font-size:12px; color:#64748b;">Buka WhatsApp di telefon &gt; Peranti Terpaut (Linked Devices) &gt; Pautkan Peranti (Link a Device):</p>
        ${qrDataUrl ? `<img src="${qrDataUrl}" alt="Scan QR" />` : `<p>Menjana QR code...</p>`}
        <p style="font-size:11px; color:#94a3b8; margin-bottom:0;">Halaman ini akan auto-refresh setiap 5 saat.<br/>Selepas berjaya disambung, sesi akan disimpan kekal ke Supabase.</p>
      </div>
    </body>
    </html>
  `);
});

// List All Participating Groups
app.get('/groups', async (req, res) => {
  if (connectionStatus !== 'connected' || !sock) {
    return res.send('<p>WhatsApp belum bersambung. <a href="/qr">Scan QR</a></p>');
  }
  try {
    const groups = await sock.groupFetchAllParticipating();
    const list = Object.values(groups).map(g => `<li><strong>${g.subject}</strong> (ID: <code>${g.id}</code>)</li>`).join('');
    res.send(`
      <div style="font-family:sans-serif; max-width:600px; margin:40px auto; padding:20px; border:1px solid #ddd; border-radius:12px;">
        <h2>📋 Senarai Group WhatsApp Yang Disertai Bot</h2>
        <p>Pastikan nama group di bawah sama dengan <code>TARGET_GROUP_NAME</code> dalam tetapan (.env):</p>
        <ul>${list || '<li>Tiada group dijumpai</li>'}</ul>
        <a href="/" style="display:inline-block; margin-top:20px;">&larr; Kembali ke Dashboard Bot</a>
      </div>
    `);
  } catch (err) {
    res.send(`<p>Ralat mengambil senarai group: ${err.message}</p>`);
  }
});

// Manual Test Trigger via Web Button
app.get('/test-blast', async (req, res) => {
  await executeFindingsBlast('Manual Test via Web');
  res.redirect('/');
});

// Dedicated Webhook Endpoint for Cron-Job.org / External Scheduler
app.all('/api/blast', async (req, res) => {
  const caller = req.ip || req.headers['x-forwarded-for'] || 'External Cron';
  console.log('[Webhook Call] Menerima panggilan /api/blast dari:', caller);

  // Return ultra-short HTTP 200 plain text so cron-job.org never triggers 'output too large' or timeout!
  res.status(200).type('text/plain').send('OK');

  // Run the blast asynchronously in background
  (async () => {
    try {
      // If cold-starting, wait up to 15 seconds for WhatsApp socket handshake
      if (connectionStatus !== 'connected') {
        console.log('[Webhook Background] Menunggu sambungan WhatsApp siap handshake...');
        for (let i = 0; i < 15; i++) {
          if (connectionStatus === 'connected') break;
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      if (connectionStatus !== 'connected') {
        console.error('[Webhook Background] Gagal: WhatsApp bot belum bersambung.');
        return;
      }

      await executeFindingsBlast('Cron Webhook (cron-job.org)');
    } catch (err) {
      console.error('[Webhook Background Error]:', err);
    }
  })();
});

// Health check / Uptime ping
app.get('/health', (req, res) => {
  res.status(200).type('text/plain').send('OK');
});

// ----------------------------------------------------
// CRON JOBS (Internal Node-Cron Backup)
// ----------------------------------------------------
// Morning Blast: 8:30 AM MYT
cron.schedule(process.env.CRON_MORNING || '30 8 * * *', () => {
  console.log('[Cron Trigger] Menjalankan Morning Safety Findings Blast...');
  executeFindingsBlast('Scheduled (Morning 8:30 AM)');
}, {
  timezone: 'Asia/Kuala_Lumpur'
});

// Afternoon Blast: 4:30 PM MYT
cron.schedule(process.env.CRON_AFTERNOON || '30 16 * * *', () => {
  console.log('[Cron Trigger] Menjalankan Afternoon Safety Findings Blast...');
  executeFindingsBlast('Scheduled (Afternoon 4:30 PM)');
}, {
  timezone: 'Asia/Kuala_Lumpur'
});

// Start Server & Connect WhatsApp
app.listen(PORT, () => {
  console.log(`[Server Ready] Bot Web Dashboard berjalan di port ${PORT}`);
  connectToWhatsApp();
});
