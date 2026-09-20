require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const qrcode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');
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
 * Generate Actionable Safety Guidance based on Finding Description & Risk Level
 */
function getRecommendedAction(description, riskLevel) {
  const descLower = (description || '').toLowerCase();

  if (descLower.includes('fire extinguisher') || descLower.includes('pemadam api')) {
    return '1. Gantikan alat pemadam api yang rosak/tamat tempoh dengan unit 9kg ABC sah.\n2. Pastikan tag pemeriksaan bomba lengkap dan digantung di tempat yang mudah dilihat.';
  }
  if (descLower.includes('scaffold') || descLower.includes('perancah') || descLower.includes('toe-board') || descLower.includes('guardrail')) {
    return '1. Hentikan kerja di kawasan perancah sehingga pembaikan selesai.\n2. Pasang toe-board standard, guardrail dan kemaskan ikatan safety netting.\n3. Dapatkan pemeriksaan semula daripada Scaffold Competent Person.';
  }
  if (descLower.includes('drain') || descLower.includes('longkang') || descLower.includes('maintenance')) {
    return '1. Lakukan kerja pembersihan dan servis saliran/longkang serta-merta.\n2. Pastikan tiada halangan aliran air bagi mengelakkan air bertakung dan risiko pembiakan nyamuk.';
  }
  if (descLower.includes('dam') || descLower.includes('check dam')) {
    return '1. Pasang check dam mengikut spesifikasi kawalan hakisan dan kelodak (ESCP).\n2. Bersihkan endapan kelodak yang terkumpul.';
  }
  if (descLower.includes('barricade') || descLower.includes('penghadang')) {
    return '1. Pasang penghadang keselamatan (hard barricade) di sekeliling zon kerja berisiko.\n2. Letakkan papan tanda amaran BAHAYA / DILARANG MASUK yang jelas.';
  }
  if (descLower.includes('signage') || descLower.includes('papan tanda')) {
    return '1. Pasang papan tanda keselamatan standard di lokasi yang ditetapkan.\n2. Pastikan tulisan terang dan tidak terlindung oleh bahan binaan.';
  }
  if (descLower.includes('waste') || descLower.includes('roro') || descLower.includes('sisa')) {
    return '1. Hubungi kontraktor sisa untuk pelupusan tong RORO serta-merta.\n2. Lakukan housekeeping di sekeliling tong sisa dan elakkan sisa melimpah ke laluan pejalan kaki.';
  }

  if (riskLevel === 'High') {
    return '1. HENTIKAN KERJA serta-merta di zon terlibat sehingga pembetulan dibuat.\n2. Maklumkan kepada Safety Officer untuk pengesahan pembetulan sebelum sambung semula kerja.';
  }

  return '1. Lakukan tindakan pembetulan dan pembersihan di lokasi serta-merta.\n2. Maklumkan kepada Safety Supervisor setelah keadaan disahkan selamat.';
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

  // 3. Send Closing Footer Link
  const footerMsg = `━━━━━━━━━━━━━━━━━━━━━\n` +
    `🔗 *Live Safety Dashboard:* https://ytcsafety.vercel.app/\n` +
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
 * Initialize Baileys WhatsApp Connection
 */
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
    browser: ['YTC Safety Bot', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQrCode = qr;
      qrDataUrl = await qrcode.toDataURL(qr);
      connectionStatus = 'qr_ready';
      console.log('\n[WhatsApp QR Code Ready] Buka browser di http://localhost:3000/qr atau Render link untuk scan.\n');
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('[Connection Closed] Reconnecting:', shouldReconnect);
      connectionStatus = 'disconnected';
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 5000);
      } else {
        console.log('[Logged Out] Sila scan semula QR code.');
        currentQrCode = null;
        qrDataUrl = null;
      }
    } else if (connection === 'open') {
      connectionStatus = 'connected';
      currentQrCode = null;
      qrDataUrl = null;
      botUser = sock.user;
      console.log('\n✅ [WhatsApp Connected!] Bot sedia bertugas sebagai:', botUser.name || botUser.id);
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
        .card { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.05); border: 1px solid #e2e8f0; overflow: hidden; }
        .header { background: #0f172a; color: #fff; padding: 24px; text-align: center; }
        .content { padding: 24px; }
        .status-badge { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 999px; font-weight: bold; font-size: 13px; }
        .btn { display: inline-block; padding: 12px 20px; border-radius: 12px; font-weight: bold; text-decoration: none; color: #fff; background: #0f172a; margin-top: 12px; text-align: center; }
        .btn-green { background: #10b981; }
        .btn-amber { background: #f59e0b; }
        .info-box { background: #f1f5f9; padding: 16px; border-radius: 12px; margin: 16px 0; font-size: 14px; }
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
            <p style="margin: 4px 0;"><strong>Pending Findings Aktif:</strong> <span style="color:#ef4444; font-weight:bold;">${pending.length} Isu</span></p>
            <p style="margin: 4px 0;"><strong>Semakan Terakhir:</strong> ${lastCheckTime || 'Belum dijalankan'}</p>
            <p style="margin: 4px 0;"><strong>Jadual Harian:</strong> 🌅 8:30 AM & 🌇 4:30 PM (MYT)</p>
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
        <p style="font-size:11px; color:#94a3b8; margin-bottom:0;">Halaman ini akan auto-refresh setiap 5 saat.</p>
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

// Manual Test Trigger
app.get('/test-blast', async (req, res) => {
  const result = await executeFindingsBlast('Manual Test via Web');
  res.redirect('/');
});

// ----------------------------------------------------
// CRON JOBS (Scheduled Automated Morning & Afternoon)
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
