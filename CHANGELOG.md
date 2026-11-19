# Catatan Perubahan Digital War

Ringkasan fitur dan perbaikan, dari yang terbaru.

## Terbaru
- **Catatan jaringan saat bertarung di ring**: selama kamu bertarung (bukan penonton), game mencatat ping (diukur tiap 0,7 detik) dan setiap kali server tidak mengirim apa pun lebih dari 0,6 detik (nyandet). Di akhir pertarungan muncul popup 5 detik berisi penilaian BAIK / CUKUP / BURUK, lama bertarung, ping rata-rata (terendah, tertinggi), dan jumlah serta lama nyandet terlama. Bisa langsung ditutup dengan tombol × atau ketuk popup-nya; ada bar waktu yang menyusut. Buruk bila ping rata-rata 220 ms atau lebih, nyandet 2 kali atau lebih, satu nyandet 1,5 detik atau lebih, atau ping tertinggi 600 ms atau lebih.
- **Auto aim bola (mode non-FPS)**: teknik bola lempar dan Bola Biru langsung dilempar ke musuh terdekat dalam 40 unit (pemain dan penyamun/prajurit musuh), termasuk ketinggiannya. Bila tidak ada musuh, tetap bidik manual seperti biasa. Mode FPS tetap bidik sendiri. Bisa dimatikan di Pengaturan ("Auto aim bola", default hidup).
- **Notifikasi hasil tebasan ("Meleset: ..." / "Kena ...") kini default mati** dan dinyalakan sendiri di Pengaturan ("Notifikasi hasil tebasan"). Tombolnya bekerja di semua room, tidak perlu mode uji hit dari admin.
- **Suara klik pribadi saat teknik dipakai**: retak tajam lalu serpihan kaca berdenting, cukup keras, hanya terdengar oleh pemain yang menekan (bukan suara berjarak). Bunyi hanya bila teknik benar-benar jalan atau masuk mode bidik; saat cooldown, terkunci, atau slot kosong tidak ada bunyi, jadi kamu tahu tombolnya tertekan atau tidak.
- **Semua bola 2 kali lebih cepat** (bola lempar Byte Bolt, Loop Barrage, Null Pointer, Fork Bomb, dan Bola Biru; pengali `BALL_SPEED_MULT` di `server.js`). Tebasan dan gelombang angin tidak ikut. Jarak tempuh tetap sama (umur terbang dibagi dua), lengkung jatuhnya juga sama, dan tabrakan bola kini dicek sepanjang jalur sehingga bola cepat tidak melompati lawan.
- **Perbaikan bug tepi arena**: pemain yang berjalan sampai tepi ring tiba-tiba ditarik server ke tengah dan dihadapkan ke tengah (terasa seperti ada dinding tak terlihat). Penyebabnya batas klien (24,3) lebih jauh dari batas tarik server (24,2). Batas server sekarang diberi toleransi (24,2 jadi 25,5), jadi pemain bisa berjalan mulus sampai menempel di tepi.
- **Tembok Kode kini menahan semua bola**: Bola Biru raksasa berhenti di tembok (melukai tembok 24) dan tidak melukai yang di baliknya. Ledakan bola, Nova, dan slam juga tidak tembus tembok.
- **Teknik baru Tembok Kode (6464)**: memunculkan tembok bata solid di depan pemain. Tidak transparan, punya darah (150), retak 3 tahap dengan sprite retakan, lalu hancur menjadi serpihan. Menghalangi jalan pemain dan menahan bola, gelombang angin, tebasan, sinar, dan sniper (tebasan tidak tembus ke lawan di baliknya). Maksimal 2 tembok aktif per pemain, hilang sendiri setelah 15 detik. Darah, lebar, dan lamanya bisa diubah di admin (jenis `wall`). Teknik ini ditambahkan otomatis ke buku teknik yang sudah ada.
- **Dinding arena duel kini solid dan bisa dihancurkan**: dinding batu bata tidak transparan lagi, terdiri dari 32 bagian dengan darah 100 per bagian. Tebasan pedang (40), gelombang angin, bola dan ledakan, sinar, nova, dan slam melukai bagian yang kena (ledakan juga melukai bagian di sebelahnya). Makin rusak makin banyak retakan (3 tahap), lalu bagian itu hancur jadi lubang (bola dan sinar bisa lewat). Dinding pulih penuh tiap ronde baru. Petarung tetap tertahan di dalam ring. Kamera pemain di dalam ring tidak keluar menembus dinding.
- **Semua dorongan (knockback) dikali 2**: tebasan, gelombang angin, bola, ledakan, nova, slam, sinar, sniper, elang, bentrok pedang, dan serangan penyamun/prajurit. Pengalinya satu konstanta `KNOCK_MULT` di `server.js`.
- **Tebasan angin miring bergantian**: kiri, kanan, kiri, dan seterusnya untuk tiap penyerang.
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
