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

## Instalasi

### Opsi A — satu file, tanpa install (paling gampang)

Download [`dist/orkestra.js`](dist/orkestra.js), taruh di folder plugin opencode:

- Global (semua proyek): `~/.config/opencode/plugins/orkestra.js`
- Per proyek: `<proyek>/.opencode/plugins/orkestra.js`

Restart opencode. Selesai — tidak perlu `npm install` apa pun.

### Opsi B — via npm (setelah publish)

```jsonc
// ~/.config/opencode/opencode.json (global) atau opencode.json (proyek)
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-orkestra"]
}
```

opencode menginstall otomatis via bun saat startup.

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
bun test           # 23 unit test (claim registry, guard, edge cases)
bun run typecheck  # tsc --noEmit
```

Terverifikasi: 23 test lolos, `tsc` bersih, dan bundle ter-load di opencode 1.18.35 asli (agen `mandor`/`tukang` + command `/orkestra` terdaftar via API, alur claim → blokir → release → auto-release sesi mati teruji end-to-end).

## Catatan

- Klaim disimpan di `<proyek>/.opencode/orkestra/claims.json` (persist antar restart).
- Jika worker mati tanpa melepas klaim, mandor bisa melepas paksa: `orkestra_release` dengan `force: true`.
- Guard bersifat fail-open untuk path relatif yang tidak bisa di-resolve — tukang diinstruksikan memakai path absolut.
