# 🎼 Orkestra

Plugin **opencode** untuk orkestrasi multi-agent yang rapi: pecah tugas besar menjadi unit-unit independen, kerjakan paralel dengan banyak agent sekaligus, **tanpa tabrakan kode** — dan setiap hasil diverifikasi sebelum dinyatakan selesai.

Ini adalah workflow yang dipakai sehari-hari untuk mengerjakan 10+ agent paralel tanpa satu file pun ditulis dua agent bersamaan.

## Cara kerja

```
Kamu: /orkestra buatkan fitur login + billing + notifikasi
        │
        ▼
┌─────────────┐
│   MANDOR    │  perencana + pengawas (tidak ikut ngoding fitur)
│  (primary)  │
└──────┬──────┘
       │ 1. pecah jadi unit independen + tulis brief tiap unit
       │ 2. bagi kepemilikan file (tanpa tumpang tindih)
       ▼
   ┌───────┴────────┬──────────────┐
   ▼                ▼              ▼
┌─────────┐   ┌──────────┐   ┌──────────┐
│ TUKANG  │   │  TUKANG  │   │  TUKANG  │  worker (subagent),
│ login   │   │ billing  │   │ notif    │  jalan PARALEL
└─────────┘   └──────────┘   └──────────┘
       │ 3. verifikasi tiap hasil (baca diff + jalankan test)
       ▼
  integrasi akhir oleh mandor → lapor
```

### Anti-tabrakan: klaim file

Sebelum menulis file apa pun, setiap tukang **wajib** memanggil `orkestra_claim` dengan nama tugas dan daftar file miliknya. Klaim dicatat per sesi agent, dan hook `tool.execute.before` **menolak** setiap `write`/`edit` ke file yang diklaim sesi lain:

```
⛔ Orkestra: "src/auth/login.ts" diklaim oleh tugas "auth-login"
(sesi lain). Satu file hanya boleh ditulis satu tugas dalam satu waktu.
```

Aturannya juga menangkap kasus tidak langsung: mengklaim direktori `src/auth` memblokir tulis ke `src/auth/token.ts`, dan sebaliknya. Klaim otomatis dilepas saat sesi worker selesai/mati.

### Yang didaftarkan plugin ini

| Nama | Jenis | Fungsi |
|---|---|---|
| `mandor` | agen (primary) | Orkestrator: pecah → brief → spawn paralel → verifikasi → integrasi |
| `tukang` | agen (subagent) | Worker satu unit kerja |
| `/orkestra` | command | Jalan pintas menjalankan workflow mandor |
| `orkestra_claim` | tool | Klaim file sebelum menulis (wajib bagi tukang) |
| `orkestra_release` | tool | Lepas klaim setelah selesai |
| `orkestra_status` | tool | Lihat siapa memegang file apa |

Mendukung **opencode V1** (≥ 1.18.29) dan **opencode V2** dalam satu bundle yang sama — host otomatis memakai adaptor yang sesuai. Di V2, agen `mandor`/`tukang` dan command `/orkestra` disediakan sebagai file definisi di `~/.config/opencode/agents/` dan `~/.config/opencode/commands/` (ditulis otomatis saat plugin pertama dimuat; definisi milikmu tidak akan ditimpa).

## Instalasi

### Opsi A — via npm (paling gampang, direkomendasikan)

Tambahkan ke `opencode.json` (global di `~/.config/opencode/opencode.json`, atau per proyek):

```jsonc
// opencode V1:
{ "$schema": "https://opencode.ai/config.json", "plugin": ["opencode-orkestra"] }

// opencode V2:
{ "$schema": "https://opencode.ai/config.json", "plugins": ["opencode-orkestra"] }
```

opencode menginstall otomatis via bun saat startup. Restart opencode, selesai.

### Opsi B — dari source

```bash
git clone https://github.com/willy911/orkestra.git
cd orkestra
bun install && bun run build
```

Lalu copy hasilnya ke folder plugin opencode:

- Global (semua proyek): `~/.config/opencode/plugins/orkestra.js` ← dari `dist/orkestra.js`
- Per proyek: `<proyek>/.opencode/plugins/orkestra.js` (di V2 folder ini dibaca otomatis)

Restart opencode. Selesai.

### Cek instalasi

Jalankan `/orkestra` di opencode — jika command dikenali, plugin aktif. Atau ganti agen ke `mandor`.

## Pemakaian

```
/orkestra buatkan modul auth (login, register, refresh token) + halaman billing
```

Mandor akan: memecah jadi unit, menulis brief, men-spawn beberapa `tukang` paralel, melacak progres di todo, memverifikasi tiap hasil (baca diff + test), mengerjakan integrasi akhir, lalu melapor.

Bisa juga manual: ganti agen ke `mandor`, lalu tulis permintaan seperti biasa.

## Kapan dipakai / kapan tidak

**Pakai** bila: 2+ pekerjaan independen, migrasi menyentuh banyak file dengan pola sama, satu agent perlu review hasil agent lain, codebase terlalu besar untuk satu context.

**Jangan** bila: pekerjaan saling bergantung (butuh output satu sama lain), tugas kecil yang selesai dalam satu pass, atau overhead orkestrasi lebih mahal dari manfaatnya.

## Struktur repo

```
orkestra/
├── dist/orkestra.js        # build mandiri — cukup copy 1 file ini untuk instalasi
├── prompt/
│   ├── mandor.md           # system prompt orkestrator (sumber kebenaran workflow)
│   ├── tukang.md           # system prompt worker
│   └── perintah-orkestra.md# template command /orkestra
├── src/
│   ├── index.ts            # plugin: daftar agen/command/tool/hook
│   ├── claims.ts           # claim registry + guard anti-tabrakan (murni, testable)
│   └── claims.test.ts      # 23 unit test
├── scripts/build.ts        # embed prompt → bundle satu file
├── contoh/opencode.json    # contoh konfigurasi
├── README.md
└── LICENSE (MIT)
```

Prompt di `prompt/*.md` adalah sumber kebenaran — `bun run build` meng-embed-nya ke bundle, jadi edit markdown lalu build ulang bila ingin mengubah perilaku agen.

## Development

```bash
bun install        # install dependensi
bun run build      # generate prompts + bundle dist/orkestra.js
bun test           # 70 unit test (claim registry, guard write/bash, TTL, lockfile, worktree/directory, apply_patch, v2 wiring, edge cases)
bun run typecheck  # tsc --noEmit
```

Terverifikasi: 70 test lolos, `tsc` bersih. Ter-load di opencode **V1** 1.18.35 (agen `mandor`/`tukang` + command `/orkestra` terdaftar via API, alur claim → blokir → release → auto-release sesi mati teruji end-to-end) dan **V2** 2.0.26 (plugin `active`, agen + command terdaftar via API, tools + guard + auto-release teruji via harness).

## Catatan

- Path relatif selalu dihitung dari direktori sesi (`tctx.directory`) secara konsisten di claim, release, status, dan guard — worktree hanya fallback. Jangan campur keduanya: inkonsistensi root membuat guard miss total.
- Klaim disimpan di `<proyek>/.opencode/orkestra/claims.json` (persist antar restart; ditulis atomik, di-reload tiap operasi, dan dimutasi di dalam lockfile O_EXCL agar dua proses opencode tidak saling menimpa — lock basi >5 detik otomatis dicuri, lock asing tidak pernah dihapus).
- Klaim kedaluwarsa otomatis setelah 6 jam; sesi yang masih aktif menulis otomatis memperpanjang (sliding TTL) sehingga tidak kehilangan klaim di tengah sesi panjang. Umur tampil di `orkestra_status`.
- Jika worker mati tanpa melepas klaim, mandor bisa melepas paksa: `orkestra_release` dengan `force: true`.
- Perintah shell juga diawasi (heuristic, hanya bila keyword di posisi command — `grep "patch"` tidak diblokir): `sed -i`/`perl -i`, redirect `>`, `rm`/`mv`/`ln`/`touch`/`chmod`, `tee`, `curl -o`/`wget -O`, `rsync`, `dd of=`, `git checkout`/`git restore`/`git stash pop`/`git reset --hard`/`git clean -f`, `git apply`, `patch`, `tar -x`/`unzip`, `find -delete`, `xargs` destruktif, dan skrip inline (`python -c`/`node -e`) yang menulis path klaim akan ditolak. Tool `apply_patch` (dipakai model-model baru di opencode V2 sebagai pengganti edit/write) juga dijaga: path di dalam `patchText` diekstrak dan dicek satu per satu. Operasi baca (`grep`/`cat`) tidak tersentuh. Verb shell hanya dikenali di luar daerah ber-quote (`grep -rn "touch"` lolos, `rm "/klaim/a.ts"` tetap diblokir). Ini bukan parsing shell yang sempurna — tetap tulis file via tool write/edit.
- Guard bersifat fail-open untuk path relatif yang tidak bisa di-resolve — tukang diinstruksikan memakai path absolut.
