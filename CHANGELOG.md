# Catatan Perubahan Digital War

Ringkasan fitur dan perbaikan, dari yang terbaru.

## Terbaru
- **Perbaikan iPhone dan Android**: tata letak mengikuti ukuran layar sebenarnya (visualViewport), halaman tidak bisa digeser/dizoom/ditarik di iOS, tombol slot lebih responsif, dan tombol layar penuh di iPhone menampilkan petunjuk "Tambah ke Layar Utama" (Safari iPhone tidak mendukung API layar penuh). Di Android, layar penuh otomatis masuk lagi setelah dialog izin mikrofon.
- **Busur tebasan 2D dihapus** (efeknya kini hanya gelombang angin). **Bola/panah yang terkena tebasan atau gelombang dipukul balik ke penembaknya.**
- **Tebasan angin**: gelombang bulan sabit pendek yang menyertai tebasan pedang, jangkauan bertambah sedikit (sekitar 8 unit), 20 damage.
- **Arena diperbesar 2 kali lipat luasnya** (radius 18 jadi 25, tinggi langit-langit 20) dan digeser sedikit ke selatan agar tidak menempel desa.
- **Dinding dan langit-langit transparan di arena**: terlihat saat duel dimulai lalu memudar; serangan tidak keluar ring dan meledak di dinding.
- **Tebasan tipis 3D**: jejak tabung bulan sabit yang meruncing (tebal di ujung depan, menipis ke belakang) dengan inti putih, menggantikan busur datar yang lebar.
- **Menu Pengaturan: Tampilkan body fisika** (kerangka badan karakter 2D dan jangkauan tebasan).
- **Elang menyerang sasaranmu**, bukan acak. **Menu pengaturan** (auto aim pedang, getar layar, efek kena, indikator jaringan), dan **damage pedang jadi 40** (2 kali lipat).
- **Mode uji hit** (admin) menampilkan alasan serangan meleset, kerucut tebasan FPS dilebarkan ke 50 derajat, panduan singkat dan papan juara di arena, cadangan data (unduh dan pulihkan) di admin, serta `tools/loadtest.js` untuk uji beban pemain virtual.
- **Perbaikan bug**: penyamun dan prajurit selalu dianggap berada di ketinggian 0, jadi di area berbukit tebasanmu tidak mengenai mereka dan mereka tidak bisa memukulmu (selisih tinggi dianggap terlalu jauh). Sekarang tinggi mereka mengikuti tanah, dan panah ditembakkan dari ketinggian yang benar.
- **Mode room Arena Duel 1 vs 1** (dipilih admin saat membuat room): ring duel dengan antrian, pemenang tetap bertarung melawan penantang berikutnya, hitungan mundur, dan papan nama petarung beserta antrian.
- **Efek kena**: selubung kaca bercahaya di badan korban selama 0.5 detik (plus bola biru untuk bola/panah), tanpa garis kerangka.
- **Tebasan terasa lebih kena**: jangkauan serang 2.9 jadi 3.3 (sama dengan panjang efek tebasan), toleransi tinggi lebih longgar, ada tulisan KEBAL saat lawan sedang kebal, korban terpental sesaat di layar penyerang, dan layar bergetar halus saat tebasanmu mengenai.
- **Indikator jaringan** (ikon sinyal dan ping) di atas layar.
- **Bola bisa ditebas** (hancur) dan **bola yang kena perisai dari depan dipantulkan balik** ke penembak.
- **Musuh mengejar lebih jauh**: penyamun (34 unit, batas kejar 56), prajurit benteng (40 unit, batas 36), pengawal (30 unit).
- **Tebasan FPS** mengikuti arah + (atas/bawah) dan musuh hanya kena bila ada di arah itu; **dash** tanpa cooldown.
- **Sembunyikan tombol**: tombol baru (ikon kotak-kotak) di kolom kiri, atau tekan `H`, menyembunyikan semua tombol (serang, lompat, slot teknik, buku, dll). Setelah kamera diputar sedikit, muncul tombol "Tampilkan tombol" di atas layar untuk mengembalikannya.
- **Perbaikan visual**: z-fighting di bagian atas pintu dan kasur diperbaiki. Nama benteng hanya terlihat dalam jarak 34 unit (sebelumnya 150). Tombol silang buku teknik kini tepat di tengah lingkaran.
- **Suara berjarak**: tiap jenis suara punya jarak dengar sendiri (tebasan dan pukulan sekitar 24-26 unit, ledakan 55, tanduk benteng 70), dengan penurunan volume lebih tajam dan batas 4 suara pelan per 150 ms.
- **Chat**: tampilan baru berbentuk gelembung, input bulat, tombol silang, dan feed layar disembunyikan saat chat terbuka.
- **Tombol serang** besar di pojok kanan bawah, layout tombol dan slot disesuaikan untuk layar landscape pendek.
- **FPS**: rumah selalu solid (atap dan dinding tidak transparan).
- **Benteng**: lantai diturunkan dan diberi tekstur ubin supaya karakter menapak.
- **Skenario pembuka**: jalan FPS ke desa dan ngobrol dengan Warga Desa, bisa dilewati.
- **Dash** mengikuti arah gerak, tanpa bidik.
- **Pertempuran**: tebasan pedang 20 damage dengan knockback, bentrok pedang (keduanya terpental, bunyi besi), bola digital keluar setinggi mata dan mendorong korban, bar darah musuh merah dan milik sendiri hijau, perisai baru yang lebih estetik.

## Sebelumnya
- Server satu file tanpa dependensi (`server.js`), halaman admin (room, voice, mode pilih teknik, buku teknik), nama tanpa login.
- Teknik kode angka 1-9 dengan 5 slot, banyak teknik (bola lempar, nova, elang, naik elang, ranjau, sniper, dll).
- Danau dan menyelam, goa kelelawar dengan peti sniper, tidur memulihkan darah, spawn di pojok peta, air mancur desa.
- Benteng yang bisa direbut dengan prajurit penjaga dan pengawal, kamp penyamun.
- Voice chat WebRTC dan chat teks, suara sintetis lebih dari 60 efek, kamera FPS, tema Poppins biru-hitam-putih.
