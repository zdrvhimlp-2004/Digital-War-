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

- **Room**: buat room (nama, maksimal pemain 2 sampai 100, dan opsi **voice chat** aktif/mati), salin link, ubah nama atau kapasitas, hapus room, lihat siapa yang online.
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

Tekan slot kosong, ketik kode angka 1-9 di popup, tekan Pasang. Slot langsung menjadi tombol teknik. Ada 5 slot; tahan lama slot terisi untuk mengganti atau mengosongkan. Kode dicek oleh server.

**Bidik dulu**: teknik arah (peluru, sinar, bola biru, lesat, hantam) tidak langsung ditembakkan. Tekan slot untuk masuk mode bidik (garis dan lingkaran bidik muncul), geser kamera ke arah yang diinginkan (atas, bawah, samping), lalu tekan slot lagi atau tombol **Tembak**. Bidikan otomatis mengunci musuh yang ada di depan.

Teknik bawaan (semua bisa diubah di admin):

| Kode | Teknik | Jenis |
|---|---|---|
| 637 | Byte Bolt | peluru |
| 314 | Loop Barrage | 3 peluru menyebar |
| 8472 | Null Pointer | peluru cepat |
| 4242 | Fork Bomb | 5 peluru menyebar |
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
| 753 | Lag Dash | lesat ke depan |

### Mekanik lain

- **Benteng**: ada 3 benteng di peta. Dekati lalu tekan Aksi untuk merebut (3 detik, jangan bergerak jauh). Nama pemilik muncul di atas benteng. Pemilik mendapat 3 prajurit pedang dan 2 pemanah: 3 menjaga benteng dan 2 (1 pedang, 1 pemanah) mengikuti dan mengawal pemilik. Mereka menyerang musuh di sekitarnya dan tumbuh lagi kalau gugur. Benteng bisa direbut balik oleh pemain lain. Benteng reset kalau pemiliknya keluar.
- **Penyamun**: ada 3 kamp penyamun (tenda, pagar runcing, api unggun, bendera pedang bersilang) di sisi timur, barat, dan utara peta (terlihat sebagai titik merah di minimap). Tiap kamp dijaga 2 penyamun pedang, 2 pemanah, dan 1 brute yang menyerang semua pemain yang mendekat, dan muncul lagi 20 detik setelah gugur. Mengalahkan penyamun memulihkan 12 HP.
- **Suara**: lebih dari 60 efek suara sintetis (tanpa file audio): langkah berbeda di rumput, kayu, batu, pasir, dan air, suara tiap jenis teknik, denting pedang, tembakan panah, tanduk benteng, teriakan penyamun, detak jantung saat darah tipis, serta suasana (burung siang hari, jangkrik dan burung hantu malam hari, angin, air danau, api unggun, tetesan dan kelelawar di goa). Suara dari jauh lebih pelan.
- **Tameng**: perisai bulat polos kecil (warna sesuai karakter) di depan badan, menahan serangan dari depan. 3 serangan dalam 3 detik memecahkan tameng (tidak bisa dipakai 2,5 detik).
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
