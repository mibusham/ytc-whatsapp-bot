# 👷‍♂️ YTC Safety WhatsApp Bot (Render Deployment Guide)

Bot WhatsApp automatik untuk menyemak **Pending Safety Hazards / Findings** daripada dashboard **YTC Safety** (Supabase) dan mengepos gambar berserta arahan keselamatan tindakan ke dalam Group WhatsApp pekerja.

---

## 🚀 Panduan Setup & Deploy ke Render.com (Langkah demi Langkah)

### Langkah 1: Buat Repository GitHub Baru
1. Buka [GitHub](https://github.com/new) dan log masuk.
2. Buat repository baru, namakan: `ytc-whatsapp-bot`.
3. Setkan kepada **Public** atau **Private**.
4. Di terminal folder `ytc-whatsapp-bot`, jalankan:
   ```bash
   git init
   git add .
   git commit -m "Initial commit for YTC Safety WhatsApp Bot"
   git branch -M main
   git remote add origin https://github.com/USERNAME_ANDA/ytc-whatsapp-bot.git
   git push -u origin main
   ```

---

### Langkah 2: Deploy di Render Dashboard
1. Buka [Render Dashboard](https://dashboard.render.com/).
2. Klik butang **"+ New"** di atas kanan dan pilih **"Web Service"**.
3. Pilih **"Build and deploy from a Git repository"** dan klik **Next**.
4. Pilih repository `ytc-whatsapp-bot` yang baru anda push tadi.
5. Isi tetapan berikut:
   - **Name**: `ytc-safety-bot`
   - **Language / Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
6. Di bahagian bawah, klik **"Advanced"** > **"Add Environment Variable"**:
   - `SUPABASE_URL`: `https://xhuyehfiebcmoolfkumz.supabase.co`
   - `SUPABASE_KEY`: *(Key anon dari fail .env)*
   - `TARGET_GROUP_NAME`: `Workers Safety` *(atau nama group WhatsApp anda)*
   - `PORT`: `10000` *(atau default Render)*
7. Klik butang **"Deploy Web Service"**!

---

### Langkah 3: Sambungkan WhatsApp (Scan QR Sekali Sahaja)
1. Setelah Render selesai bina (status bertukar **"Live"**), buka URL Render anda:
   `https://ytc-safety-bot.onrender.com/qr`
2. Pada telefon pintar anda:
   - Buka WhatsApp.
   - Tekan **Settings (Tetapan)** > **Linked Devices (Peranti Terpaut)**.
   - Tekan **Link a Device (Pautkan Peranti)**.
   - Imbas QR Code yang terpapar di skrin link `/qr`.
3. Selesai! Bot anda kini disambungkan dan bersedia di Render.

---

### Langkah 4: Uji Penghantaran Mesej
1. Buka laman utama bot:
   `https://ytc-safety-bot.onrender.com/`
2. Anda akan nampak status **Connected (Online)** dan bilangan pending findings terkini.
3. Klik butang **"🚀 Tembak Blast Sekarang (Manual Test)"** untuk uji penghantaran ke group WhatsApp anda secara langsung!
4. Setiap hari pada jam **8:30 AM** dan **4:30 PM**, bot akan automatik memeriksa dan menghantar laporan.
