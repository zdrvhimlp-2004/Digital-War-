# Digital War

Game multiplayer 2.5D (Three.js) untuk main bareng teman. Tanpa login pemain: cukup buka link room, tulis nama, pilih karakter.

Seluruh server, game, halaman admin, dan landing ada di **satu file: `server.js`**. Tidak ada dependency, tidak perlu `npm install`.

> Ini adalah dunia digital yang dibuat menggunakan kode-kode bukan asli. Di dunia ini kamu bisa mengeluarkan dan membuat hal-hal yang telah ditetapkan di buku. Jadi kamu hafalkan dan praktekkan untuk beradaptasi dan menyerang lawan.

## Menjalankan

Butuh Node.js 18 atau lebih baru.

```bash
node server.js          # atau: npm start
PORT=8080 node server.js
```

| Env | Fungsi | Default |
|---|---|---|
| `PORT` | port HTTP dan WebSocket | `3000` |
| `DATA_FILE` | lokasi file data | `./digital-war-data.json` |

Pemain butuh internet untuk memuat Three.js (cdnjs) dan font Poppins (Google Fonts) dari CDN.

## Halaman

| URL | Isi |
|---|---|
| `/` | landing, masukkan kode room |
| `/r/KODE` | game untuk satu room (link ini yang dibagikan ke teman) |
| `/admin` | halaman admin |

## Admin

Login awal: **`admin` / `admin`**. Segera ganti di tab **Akun** (ada peringatan selama masih default).

- **Room**: buat room (nama, maksimal pemain 2 sampai 100, opsi **voice chat** aktif/mati, dan opsi **mode pilih teknik**), salin link, ubah nama atau kapasitas, hapus room, lihat siapa yang online.
- **Buku Teknik**: tambah, ubah, hapus teknik digital (kode, jenis, damage, cooldown, dst.). Berlaku langsung ke semua room. Ada pengaturan untuk menampilkan buku di dalam game atau tidak.
- **Akun**: ganti password.

Password disimpan sebagai hash (scrypt) di file data. Login dibatasi 6 percobaan gagal per menit per IP.

## Cara main

1. Buka link room, baca cerita pembuka, tulis nama, pilih salah satu dari 8 karakter. Nama dan karakter tersimpan di browser.
2. Kalahkan lawan: serangan dasar, teknik digital, dan sniper dari peti goa.

### Kontrol

| Aksi | Keyboard | HP |
|---|---|---|
| Jalan / lari | WASD / Shift | joystick (setengah layar kiri) |
| Kamera | seret mouse, Q / R | geser layar kanan |
| Lompat (2x lebih tinggi) / naik saat berenang | Spasi | tombol Lompat |
| Serang | J | tombol Serang |
| Tahan (tameng) | K (tahan) | tombol Tahan |
| Selam / turun saat terbang | V | tombol Selam |
| Sniper | H | tombol Sniper |
| Pintu, kasur, peti, rebut benteng | E | tombol Aksi |
| Kamera FPS | C | tombol mata |
| Chat room | Enter | tombol chat |
| Mikrofon / suara room | | tombol mic dan speaker (hanya jika voice aktif) |
| Teknik slot 1 sampai 5 | 1 sampai 5 | 5 tombol di kanan |
| Buku teknik | B | tombol buku atau ketuk minimap |
| Papan skor | Tab | tombol piala |

### Teknik digital

Tekan slot kosong, ketik kode angka 1-9 di popup, tekan Pasang. Kalau admin mengaktifkan **mode pilih teknik** pada room, popup menampilkan daftar teknik beserta deskripsinya dan pemain tinggal memilih tanpa mengetik angka (kode tidak ditampilkan). Slot langsung menjadi tombol teknik. Ada 5 slot; tahan lama slot terisi untuk mengganti atau mengosongkan. Kode dicek oleh server.

**Bola lempar**: teknik peluru berbentuk bola besar bercahaya yang melengkung jatuh seperti dilempar. Bola meledak saat mengenai tanah atau musuh: yang kena langsung menerima damage penuh, dan pemain atau musuh di sekitar ledakan menerima percikan sekitar 60% (makin jauh makin kecil). Cahaya bola menerangi tanah di bawahnya dan meredup saat mendekati tanah. Ukuran bola dan radius ledakan bisa diatur per teknik di admin.

**Bidik dulu**: teknik arah (peluru, sinar, bola biru, lesat, hantam) tidak langsung ditembakkan. Tekan slot untuk masuk mode bidik (garis dan lingkaran bidik muncul), geser kamera ke arah yang diinginkan (atas, bawah, samping), lalu tekan slot lagi atau tombol **Tembak**. Bidikan manual penuh, tidak ada penguncian otomatis. Di **mode FPS** teknik arah langsung ditembakkan ke arah tanda + di tengah layar, tanpa mode bidik.

Teknik bawaan (semua bisa diubah di admin):

| Kode | Teknik | Jenis |
|---|---|---|
| 637 | Byte Bolt | bola besar lempar, meledak saat kena tanah atau musuh |
| 314 | Loop Barrage | 3 bola menyebar |
| 8472 | Null Pointer | bola besar cepat |
| 4242 | Fork Bomb | 5 bola menyebar |
| 858 | Bola Biru | bola raksasa berputar 3D, bisa diarahkan ke segala arah |
| 519 | Overflow Nova | ledakan area |
| 5551 | Freeze Frame | ledakan yang membekukan |
| 3735 | Laser Beam | sinar tembus |
| 2718 | Stack Overflow | lompat lalu hantam area |
| 1618 | Landmine | ranjau tak terlihat musuh, tidak hilang sampai diinjak (maks 6) |
| 481 | Elang Digital | panggil elang penyerang (punya darah 40, bisa diserang) |
| 1928 | Elang Kembar | panggil 2 elang |
| 7294 | Elang Tunggangan | terbang menunggangi elang selama 70 detik (elang punya darah 70 yang menyerap serangan) |
| 918 | Patch Heal | pulihkan HP |
| 9876 | Auto Backup | pulih bertahap |
| 246 | Firewall | perisai sementara |
| 1357 | Overclock | lari lebih cepat |
| 753 | Lag Dash | lesat ke arah gerakmu tanpa bidik (tekan kiri lalu dash, maka melesat ke kiri; tanpa input, ke arah hadap karakter) |
| 6193 | Meteor Drop | loncat sangat tinggi (sekitar 21 unit), kamera menghadap bawah, lalu 3 bola cepat dijatuhkan lurus ke bawah (22 damage per bola, meledak di tanah) |
| 4827 | Pedang Berputar | berputar 2 detik dengan dua pedang mengorbit, menebas semua musuh dalam radius 3,6 tiap 0,25 detik (14 damage per tebasan) sambil tetap bisa bergerak |
| 5316 | Cungkil | mencungkil musuh di depan (jarak 4,2) sampai terlontar sangat tinggi, 18 damage; musuh yang menahan atau kebal tidak terlontar |

### Mekanik lain

- **Benteng**: ada 3 benteng di peta. Dekati lalu tekan Aksi untuk merebut (3 detik, jangan bergerak jauh). Nama pemilik muncul di atas benteng. Pemilik mendapat 3 prajurit pedang dan 2 pemanah: 3 menjaga benteng dan 2 (1 pedang, 1 pemanah) mengikuti dan mengawal pemilik. Mereka menyerang musuh di sekitarnya dan tumbuh lagi kalau gugur. Benteng bisa direbut balik oleh pemain lain. Benteng reset kalau pemiliknya keluar.
- **Penyamun**: ada 3 kamp penyamun (tenda, pagar runcing, api unggun, bendera pedang bersilang) di sisi timur, barat, dan utara peta (terlihat sebagai titik merah di minimap). Tiap kamp dijaga 2 penyamun pedang, 2 pemanah, dan 1 brute yang menyerang semua pemain yang mendekat, dan muncul lagi 20 detik setelah gugur. Mengalahkan penyamun memulihkan 12 HP.
- **Skenario pembuka**: begitu masuk room, kamu otomatis berjalan dalam kamera FPS (semua tombol disembunyikan, ada bar sinematik) menuju desa dan bertemu seorang Warga Desa yang mengajak bicara (4 kalimat, teks mengetik). Ketuk layar atau tekan Spasi/Enter untuk lanjut, tombol "Lewati" atau Esc untuk melewati kapan saja.
- **Sembunyikan tombol**: tekan tombol kotak-kotak di kolom kiri (atau `H`) untuk menyembunyikan semua tombol. Putar kamera sedikit, lalu tekan "Tampilkan tombol" di atas layar untuk mengembalikannya. Riwayat lengkap ada di `CHANGELOG.md`.
- **Serangan FPS**: di kamera FPS tebasan pedang mengikuti arah tanda + termasuk ke atas dan ke bawah. Musuh hanya kena kalau berada di arah + (kerucut 50 derajat), dan efek tebasan miring mengikuti arah itu. **Dash** tidak punya cooldown dan bisa dipakai berulang; kebal sesaatnya hanya diberikan sekali per 0.7 detik.
- **Jarak kejar musuh**: penyamun mulai mengejar sejak pemain berada sekitar 34 unit dari kampnya (atau 32 unit dari penyamun itu sendiri) dan berani mengejar sampai 56 unit dari kamp. Prajurit benteng mengejar dalam 40 unit dari benteng (batas 36), dan pengawal dalam 30 unit dari pemiliknya.
- **Tebas dan pantul bola**: bola teknik yang melintas di depanmu hancur (meledak kecil tanpa damage, muncul "TEBAS!") kalau kamu menebasnya, dan kena tebasan FPS bila berada di arah +. Bola atau panah yang menghantam perisai dari depan dipantulkan balik ke penembaknya (muncul "MANTUL!") dengan damage yang sama, tanpa mengurangi daya tahan perisai.
- **Indikator jaringan**: di atas layar ada ikon sinyal 4 batang dengan angka ping (ms), dihitung tiap 2 detik. Hijau di bawah 70 ms, hijau muda sampai 130 ms, kuning sampai 220 ms, oranye di atas itu, dan merah "putus?" kalau lebih dari 6 detik tanpa balasan dari server.
- **Efek badan saat kena**: setiap kali ada yang terkena serangan (pemain, prajurit, penyamun, elang), selubung kaca bercahaya oranye muncul mengelilingi badannya selama 0.5 detik dengan cahaya di tanah, lalu memudar. Untuk serangan bola atau panah, area kenanya juga muncul sebagai bola biru transparan.
- **Arena Duel 1 vs 1**: di halaman admin, saat membuat room pilih "Mode room: Arena Duel 1 vs 1". Semua pemain muncul sebagai penonton di sekitar ring (di dunia yang sama, tanpa benteng dan penyamun aktif). Dua pemain pertama dari antrian masuk ring dengan hitungan mundur 3 detik, lalu bertarung sampai salah satu KO. Yang menang tetap di ring (darah dipulihkan, hitungan menang beruntun naik) dan menghadapi penantang berikutnya, sedangkan yang kalah masuk antrian paling belakang. Penonton tidak bisa menyerang atau terkena serangan dan tidak bisa masuk ring, petarung tidak bisa keluar ring. Kalau petarung keluar room, lawannya otomatis menang. Antrian dan nama petarung tampil di atas layar. Mode room tidak bisa diubah setelah room dibuat.
- **Mode uji hit (admin)**: centang "Mode uji hit" saat membuat room atau lewat tombol Ubah. Setiap serangan pedang yang meleset menampilkan alasannya di layar penyerang, misalnya "Penyamun: terlalu jauh (4.2 > 3.3)", "selisih tinggi", "di luar arah +", atau "ada di belakangmu". Serangan yang kena juga ditandai hijau.
- **Papan juara arena**: layar arena menampilkan tiga juara dengan total menang dan rekor menang beruntun, selain antrian. Pemain yang baru masuk arena mendapat panduan singkat satu kali (disimpan di perangkat).
- **Cadangan data**: di admin, tab Akun, "Unduh cadangan" menyimpan semua room, buku teknik, dan pengaturan ke satu file JSON (tanpa password admin). "Pulihkan" mengganti semua room dan teknik dengan isi file tersebut dan mengeluarkan pemain online.
- **Uji beban**: `node tools/loadtest.js 14 30` menjalankan 14 pemain virtual selama 30 detik dan melaporkan ping, jumlah pesan, dan koneksi putus (mode arena: tambahkan `duel` di akhir; variabel `BASE`, `ADMIN_USER`, `ADMIN_PASS`, `ROOM` bisa diatur). Pada uji lokal 14 pemain di dunia biasa: CPU server sekitar 3.5%, memori sekitar 80 MB, ping 0.4 ms rata-rata, tanpa koneksi putus.
- **Pengaturan**: tombol roda gigi di kolom kiri membuka menu pengaturan: Auto aim pedang (default mati, tebasan mengarah ke arah hadap karakter; kalau dinyalakan serangan otomatis menghadap musuh terdekat di depanmu), layar bergetar, efek badan saat kena, tampilkan body fisika, dan indikator jaringan. Pilihan disimpan di perangkat. Body fisika menampilkan kerangka badan karakter 2D saja (biru: kamu, merah: musuh, hijau: pasukan dan elangmu) dan cincin kuning jangkauan tebasan 3.3 unit.
- **Elang**: elang hanya menyerang musuh yang terakhir kamu serang (pedang atau teknik, berlaku 7 detik, termasuk prajurit dan penyamun). Tanpa sasaran, elang hanya mengitarimu.
- **Dinding arena**: ring duel punya dinding dan langit-langit transparan (silinder setinggi 20 unit, radius ring 25 unit). Dinding tampak berupa kisi biru saat hitungan mundur, lalu memudar setelah duel dimulai, tetapi tetap menahan: bola, panah, sinar, dan bola biru yang menyentuhnya meledak atau terpotong di dinding (dinding berkedip sebentar). Petarung tidak bisa keluar ring atau terbang melewati langit-langit.
- **Tebasan angin**: setiap tebasan pedang juga melepas gelombang angin pendek (bentuk bulan sabit putih kebiruan) yang meluncur sekitar 5 unit di depan, jadi jangkauan efektif bertambah sedikit (sekitar 8 unit). Busur tebasan 2D yang lama sudah dihapus: visual tebasan sekarang hanya gelombang ini. Gelombang memberi 20 damage dengan dorongan ringan pada musuh yang tidak terkena pedang, tidak mengenai musuh yang sama dua kali, bisa ditahan perisai (tanpa dipantulkan), dan bisa dihancurkan tebasan lawan. Bola dan panah teknik yang terkena tebasan pedang atau gelombang dipukul balik ke penembaknya dan menjadi milik penebas (muncul "PUKUL BALIK!"), sedikit lebih cepat dan dengan damage yang sama.
- **Pertempuran**: tebasan pedang bernilai 80 damage (tebasan angin 40) dan mendorong musuh (termasuk prajurit dan penyamun) ke belakang. Bola digital keluar dari ketinggian mata sedikit mengarah ke atas sehingga jatuh tepat di tanda +, langsung mendorong korban dan meledak. Bar darah musuh berwarna merah, sedangkan elang dan pasukan milikmu berwarna hijau. Kalau dua pemain saling menebas hampir bersamaan, pedang beradu (BENTROK!) dan keduanya terpental tanpa damage. Perisai berupa cakram bercahaya yang melayang sedikit di depan karakter.
- **Suara**: lebih dari 60 efek suara sintetis (tanpa file audio): langkah berbeda di rumput, kayu, batu, pasir, dan air, suara tiap jenis teknik, denting pedang, tembakan panah, tanduk benteng, teriakan penyamun, detak jantung saat darah tipis, serta suasana (burung siang hari, jangkrik dan burung hantu malam hari, angin, air danau, api unggun, tetesan dan kelelawar di goa). Semua suara berjarak: makin dekat sumbernya makin keras dan makin jauh makin pelan (turun cepat). Jarak dengar tiap jenis suara berbeda: suara pertempuran (tebasan, pukulan, panah, perisai) sekitar 24-26 unit, bola dan teknik 26-38 unit, langkah 16 unit, ledakan 55 unit, dan tanduk benteng atau tembakan sniper 60-70 unit. Suara jauh yang pelan dibatasi maksimal 4 per 150 ms supaya tidak ramai. Ini berlaku untuk langkah, serangan, teknik, pintu, benteng, penyamun, termasuk suara pemain lain (lompat, mendarat, berenang, dengkur) dan voice chat (terdengar sampai sekitar 40 unit; pemain di dalam goa tidak terdengar dari luar dan sebaliknya).
- **Tameng**: perisai bulat polos kecil (warna sesuai karakter) di depan badan, menahan serangan dari depan. 9 serangan tertahan dalam 3 detik memecahkan tameng (tidak bisa dipakai 2,5 detik). Tombol Tahan menampilkan sisa daya tahan, misalnya 6/9.
- **Air**: danau dengan dermaga, bisa berenang dan menyelam (ada bar napas). Menyelam menghindari peluru.
- **Goa kelelawar**: mulut goa di selatan desa. Isinya kelelawar dan peti berisi sniper (5 peluru, 45 damage, jarak 90 m, isi ulang peti tiap 60 detik). Pemain di dalam goa tidak terlihat dari luar dan sebaliknya, sehingga bisa bersembunyi atau bertarung di sana. Darah dan status tetap sama.
- **Tidur**: tidur di kasur dalam rumah memulihkan 6 HP per detik. Terkena serangan membangunkanmu.
- **Spawn**: acak di 8 titik tepi peta, bukan di tengah desa.
- **Chat dan voice**: chat teks untuk semua pemain di room. Voice (WebRTC) bisa dimatikan per room oleh admin; butuh HTTPS agar mikrofon diizinkan browser.
- **Siang dan malam** berjalan sama untuk semua pemain di satu room.

## Data dan keamanan

- Password admin, daftar room, dan buku teknik disimpan di `digital-war-data.json` (sudah masuk `.gitignore`). Simpan atau backup file ini.
- Posisi pemain dipercaya dari klien. Cocok untuk main bareng teman, bukan untuk kompetisi anti-curang.
- Untuk dipakai lewat internet, jalankan di belakang reverse proxy HTTPS (Nginx, Caddy, dsb.) dan pastikan WebSocket (`/ws`) diteruskan. Game otomatis memakai `wss://` bila halaman dibuka lewat HTTPS.

## Struktur

```
server.js        server HTTP + WebSocket + halaman game/admin/landing (satu file)
package.json
README.md
.gitignore
```
