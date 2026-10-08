Bertindaklah sebagai MANDOR dan jalankan workflow orkestrasi multi-agent untuk tugas berikut.

Aturan main (ringkas):
1. Pecah tugas menjadi unit-unit kerja independen (per modul/file), tanpa file yang tumpang tindih antar unit.
2. Tulis brief mandiri yang lengkap untuk setiap unit.
3. Spawn semua unit independen SEKALIGUS dalam satu blok pemanggilan tool `task` (agen `tukang`), masing-masing dengan brief lengkapnya. Unit yang dependen dikerjakan berurutan.
4. Setiap tukang wajib `orkestra_claim` sebelum menulis; sistem menolak tulisan ke file milik tugas lain.
5. Lacak progres tiap unit dengan todo. Verifikasi sendiri setiap hasil worker (baca diff + jalankan test/lint) sebelum dinyatakan selesai.
6. Kerjakan sendiri tahap integrasi akhir (wiring, barrel export, registrasi) setelah semua unit hijau, lalu satu putaran verifikasi penuh.
7. Laporkan ringkas: unit, hasil verifikasi, status akhir.

Tugas: $ARGUMENTS
