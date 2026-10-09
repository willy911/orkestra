/**
 * claims.ts — jantung anti-tabrakan Orkestra.
 *
 * Ide sederhana: sebelum sebuah agen (sesi) menulis file, ia harus MENGKLAIM
 * file itu atas nama tugasnya. Klaim dicatat per sesi. Hook
 * `tool.execute.before` menolak setiap write/edit ke path yang diklaim oleh
 * sesi lain — termasuk upaya lewat shell (heuristic, lihat guardBashWrite).
 * Satu file = satu penulis dalam satu waktu.
 *
 * Modul ini murni (tidak bergantung API opencode) supaya bisa di-unit-test.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";

export interface Claim {
  /** path absolut yang diklaim (file atau direktori) */
  path: string;
  /** nama tugas pemilik, mis. "auth-login" */
  owner: string;
  /** sesi opencode pemilik klaim */
  sessionID: string;
  /** epoch ms saat diklaim */
  at: number;
}

/** Tool bawaan opencode yang menulis ke file. */
const WRITE_TOOLS = new Set(["write", "edit", "patch"]);

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

/** Ambil path target dari argumen tool tulis. null bila bukan tool tulis / tidak ada path. */
export function extractWritePath(toolName: string, args: unknown): string | null {
  if (!isWriteTool(toolName)) return null;
  const a = (args ?? {}) as Record<string, unknown>;
  const p = a["filePath"] ?? a["path"] ?? a["file"];
  return typeof p === "string" && p.length > 0 ? p : null;
}

function norm(p: string): string {
  let n = normalize(p);
  if (n.length > 1 && n.endsWith(sep)) n = n.slice(0, -1);
  return n;
}

/**
 * true jika dua path "bersinggungan": sama persis, atau satu adalah
 * direktori leluhur dari yang lain. Ini yang mencegah kasus:
 * - A klaim `src/auth/login.ts`, B menulis `src/auth` (direktori) → tabrakan
 * - A klaim `src/auth` (direktori), B menulis `src/auth/login.ts` → tabrakan
 */
export function overlaps(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  return x.startsWith(y + sep) || y.startsWith(x + sep);
}

/** Path relatif terhadap root; fallback ke absolut bila di luar root. */
export function rel(root: string, p: string): string {
  const abs = norm(isAbsolute(p) ? p : resolve(root, p));
  const r = norm(root);
  const prefix = r.endsWith(sep) ? r : r + sep;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
}

export type ClaimResult = { ok: true } | { ok: false; conflict: Claim };

/** Default TTL klaim: 6 jam. Mencegah klaim menggantung bila opencode crash. */
export const DEFAULT_CLAIM_TTL_MS = 6 * 3600 * 1000;

export class ClaimRegistry {
  private claims = new Map<string, Claim>();
  private lastTouchAt = new Map<string, number>();

  constructor(
    private persistPath?: string,
    private ttlMs: number = DEFAULT_CLAIM_TTL_MS,
  ) {
    this.refresh();
  }

  /**
   * Baca ulang dari disk. Membuat dua proses opencode di proyek yang sama
   * tidak saling menimpa klaim secara diam-diam: setiap operasi mulai dari
   * kondisi disk terbaru. Klaim kedaluwarsa (melewati TTL) ikut dibersihkan.
   */
  refresh(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, "utf8")) as Claim[];
      const now = Date.now();
      const next = new Map<string, Claim>();
      for (const c of raw) {
        if (!c || typeof c.path !== "string") continue;
        if (this.ttlMs > 0 && now - (c.at || 0) > this.ttlMs) continue; // kedaluwarsa
        const p = norm(c.path);
        next.set(p, { ...c, path: p });
      }
      this.claims = next;
    } catch {
      /* file korup = pertahankan state in-memory */
    }
  }

  /** Klaim satu atau beberapa path untuk sebuah tugas. Path relatif di-resolve terhadap cwd. */
  claim(paths: string[], owner: string, sessionID: string, cwd?: string): ClaimResult {
    return this.mutate(() => {
      for (const raw of paths) {
        const abs = norm(isAbsolute(raw) ? raw : resolve(cwd ?? process.cwd(), raw));
        for (const c of this.claims.values()) {
          if (c.sessionID !== sessionID && overlaps(c.path, abs) && c.owner !== owner) {
            return { ok: false, conflict: c };
          }
        }
      }
      const at = Date.now();
      for (const raw of paths) {
        const abs = norm(isAbsolute(raw) ? raw : resolve(cwd ?? process.cwd(), raw));
        // Klaim ulang oleh owner yang sama (mis. retry dari sesi baru) = pindah kepemilikan, bukan konflik.
        for (const [k, c] of this.claims) {
          if (c.owner === owner && overlaps(c.path, abs)) this.claims.delete(k);
        }
        this.claims.set(abs, { path: abs, owner, sessionID, at });
      }
      this.save();
      return { ok: true };
    });
  }

  /**
   * Lepas klaim. `target` bisa berupa path (melepas klaim yang bersinggungan)
   * atau nama owner. Mengembalikan jumlah klaim yang dilepas.
   */
  release(target: string, sessionID: string, force = false, cwd?: string): number {
    return this.mutate(() => {
      let n = 0;
      const absTarget = norm(isAbsolute(target) ? target : resolve(cwd ?? process.cwd(), target));
      for (const [k, c] of this.claims) {
        const byOwner = c.owner === target;
        const byPath = overlaps(c.path, absTarget);
        if ((byOwner || byPath) && (force || c.sessionID === sessionID)) {
          this.claims.delete(k);
          n++;
        }
      }
      if (n > 0) this.save();
      return n;
    });
  }

  /** Lepas semua klaim milik sebuah sesi (dipanggil saat sesi dihapus). */
  releaseSession(sessionID: string): number {
    return this.mutate(() => {
      let n = 0;
      for (const [k, c] of this.claims) {
        if (c.sessionID === sessionID) {
          this.claims.delete(k);
          n++;
        }
      }
      if (n > 0) this.save();
      return n;
    });
  }

  /**
   * Perbarui `at` klaim milik sebuah sesi = sliding TTL. Sesi yang masih
   * aktif (menulis via tool) tidak akan kehilangan klaim di tengah jalan;
   * sesi yang mati/crash berhenti menyentuh → kedaluwarsa normal.
   * Di-throttle 60 detik per sesi agar tidak menulis disk tiap tool call.
   */
  touch(sessionID: string): void {
    const now = Date.now();
    if (now - (this.lastTouchAt.get(sessionID) ?? 0) < 60000) return;
    this.lastTouchAt.set(sessionID, now);
    this.mutate(() => {
      let dirty = false;
      for (const c of this.claims.values()) {
        if (c.sessionID === sessionID) {
          c.at = now;
          dirty = true;
        }
      }
      if (dirty) this.save();
    });
  }

  /** Cek apakah sesi boleh menulis ke path absolut ini. */
  check(absPath: string, sessionID: string): Claim | null {
    this.refresh();
    const p = norm(absPath);
    for (const c of this.claims.values()) {
      if (c.sessionID !== sessionID && overlaps(c.path, p)) return c;
    }
    return null;
  }

  list(): Claim[] {
    this.refresh();
    return [...this.claims.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Jalankan mutasi di dalam lock antar-proses: refresh → ubah → save.
   * Menutup race Lost Update bila dua proses opencode mengklaim bersamaan.
   * Lock basi (>5 detik, mis. proses crash) otomatis dicuri.
   */
  private mutate<T>(fn: () => T): T {
    // Coba dapatkan lock beberapa kali dengan backoff; hanya sebagai
    // best-effort terakhir jalan tanpa lock (jendela Lost Update residual).
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.acquireLock()) {
        try {
          this.refresh();
          return fn();
        } finally {
          this.releaseLock();
        }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
    this.refresh();
    return fn();
  }

  private lockPath(): string {
    return `${this.persistPath}.lock`;
  }

  private lockToken: string | null = null;

  private acquireLock(): boolean {
    if (!this.persistPath) return true;
    const lp = this.lockPath();
    try {
      const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const fd = openSync(lp, "wx"); // O_CREAT|O_EXCL: gagal bila sudah ada
      writeSync(fd, token);
      closeSync(fd);
      this.lockToken = token;
      return true;
    } catch {
      try {
        const ts = parseInt(readFileSync(lp, "utf8").split(":")[1] || "0", 10);
        if (Date.now() - ts > 5000) {
          rmSync(lp, { force: true });
          return this.acquireLock();
        }
      } catch {
        /* abaikan, coba lagi di attempt berikutnya */
      }
      return false;
    }
  }

  private releaseLock(): void {
    if (!this.persistPath || !this.lockToken) return;
    try {
      // Hanya hapus bila isinya masih token milik kita (bisa dicuri proses lain).
      if (readFileSync(this.lockPath(), "utf8") === this.lockToken) {
        rmSync(this.lockPath(), { force: true });
      }
    } catch {
      /* abaikan */
    }
    this.lockToken = null;
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      // Tulis atomik (tmp + rename) agar pembaca lain tidak dapat JSON setengah tulis.
      const tmp = `${this.persistPath}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify([...this.claims.values()], null, 2));
      renameSync(tmp, this.persistPath);
    } catch {
      /* persist best-effort; registry in-memory tetap jalan */
    }
  }
}

export interface GuardVerdict {
  blocked?: string;
}

/**
 * Keputusan murni untuk hook `tool.execute.before` (tool write/edit/patch).
 * Mengembalikan pesan blokir bila tool tulis menarget path milik sesi lain.
 */
export function guardWrite(
  toolName: string,
  args: unknown,
  sessionID: string | undefined,
  reg: ClaimRegistry,
  cwd?: string,
): GuardVerdict {
  const raw = extractWritePath(toolName, args);
  if (!raw || !sessionID) return {};
  // Path relatif tanpa cwd yang jelas = tidak bisa diverifikasi → fail-open.
  if (!isAbsolute(raw) && !cwd) return {};
  const abs = norm(isAbsolute(raw) ? raw : resolve(cwd as string, raw));
  const hit = reg.check(abs, sessionID);
  if (!hit) return {};
  return {
    blocked:
      `⛔ Orkestra: "${raw}" diklaim oleh tugas "${hit.owner}" ` +
      `(sesi lain). Satu file hanya boleh ditulis satu tugas dalam satu waktu. ` +
      `Pilih file lain, atau minta mandor mengalokasikan ulang via orkestra_release.`,
  };
}

// ---------------------------------------------------------------------------
// Heuristic guard untuk perintah shell (bash).
//
// BUKAN parsing shell yang sempurna — itu lubang kelinci. Tujuannya menutup
// bypass praktis yang paling umum: sed -i, redirect >, rm/mv, tee, dsb.
// Cara kerja: jika command mengandung path yang bersinggungan dengan klaim
// milik sesi lain SEBAGAI TARGET operasi mutasi, blokir.
// Operasi baca (grep/cat/less) tidak tersentuh.
// ---------------------------------------------------------------------------

interface BashVerb {
  re: RegExp;
  /** true = hanya token path TERAKHIR yang dicek (cp/install/rsync: destinasinya) */
  lastOnly?: boolean;
  /** bila cocok pada segmen → verb ini diabaikan (mis. --staged tanpa --worktree) */
  skipIf?: RegExp;
}

const BASH_VERBS: BashVerb[] = [
  { re: /\brm\s+(--[a-z-]+\s+|-[a-z]+\s+)*/ }, // rm [-rf] <target...>
  { re: /\bmv\s+/ }, // mv: sumber ikut hilang → semua token dicek
  { re: /\bcp\s+(-\S+\s+)*/, lastOnly: true }, // cp: hanya destinasi (terakhir)
  { re: /\bsed\s+(?=[^;&|]*-i)/ }, // sed ... -i ... (in-place)
  { re: /\btee\s+(-a\s+)?/ }, // tee menulis ke semua argumen
  { re: /\binstall\s+/, lastOnly: true }, // install: hanya destinasi
  { re: /\btruncate\s+(-s\s+\S+\s+)?/ },
  { re: /\btouch\b/ }, // touch: mengubah metadata file
  { re: /\bchmod\b/ }, // chmod: mengubah permission file
  { re: /\bperl\s+(?=[^;&|]*-i)/ }, // perl -i -pe ... (in-place, seperti sed -i)
  { re: /\bdd\s+(?=[^;&|]*\bof=)/ },
  // git checkout/restore: dengan `--`, atau path ber-ekstensi / bare `.` (tanpa --).
  // `git checkout main`, `git checkout -b x`, `git restore --staged` (tanpa --worktree) lolos.
  {
    re: /\bgit\s+(checkout|restore)\b(?=[^;&|]*--\s|[^;&|]*\.(?:\w|$|\s))/,
    skipIf: /--staged\b(?![^;&|]*--worktree)/,
  },
  { re: /\bcurl\b/ }, // curl -o <path> — URL tidak akan overlap path lokal
  { re: /\bwget\b/ }, // wget -O <path>
  { re: /\brsync\b/, lastOnly: true }, // rsync <src...> <dest>
  { re: /\bln\s+/ }, // ln -sf <src> <dest>: menimpa dest juga dihitung
];

/**
 * Pecah command menjadi segmen perintah. Daerah ber-quote dihapus dulu agar
 * `grep "patch"` / `git commit -m "patch: x"` tidak terbaca sebagai command.
 */
function commandSegments(cmd: string): { head: string; tokens: string[]; text: string }[] {
  const dequoted = cmd.replace(/(["'])(?:(?!\1|\\).|\\.)*\1/g, "");
  return dequoted
    .split(/[;&|\n()]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((text) => {
      const tokens = text.split(/\s+/).filter((t) => t.length > 0);
      let head = (tokens[0] || "").toLowerCase();
      let rest = tokens.slice(1);
      if (head === "sudo" && rest.length > 0) {
        head = (rest[0] || "").toLowerCase();
        rest = rest.slice(1);
      }
      return { head, tokens: rest, text };
    });
}

/**
 * Perintah yang target tulisnya tidak bisa ditentukan dari string command
 * (isi archive, isi diff, pola -delete, git plumbing destruktif). Hanya
 * dikenali bila muncul di posisi command (head segmen) — bukan substring
 * di argumen seperti `grep "patch"`. Diblokir konservatif bila ada klaim
 * milik sesi lain.
 */
function opaqueHit(cmd: string): string | null {
  for (const { head, tokens, text } of commandSegments(cmd)) {
    if (head === "patch") return "patch";
    if (head === "git") {
      const sub = (tokens[0] || "").toLowerCase();
      if (sub === "apply") return "git apply";
      if (sub === "clean" && /-[a-z]*f/.test(tokens[1] || "")) return "git clean -f";
      if (sub === "stash" && ["pop", "apply"].includes((tokens[1] || "").toLowerCase())) {
        return "git stash pop/apply";
      }
      if (sub === "reset" && tokens.includes("--hard")) return "git reset --hard";
    }
    if (head === "tar") {
      const flags = tokens[0] || "";
      if (/^--extract\b/.test(flags) || /^-?[a-zA-Z]*x/.test(flags)) return "tar -x (extract)";
    }
    if (head === "unzip" && !/\s-l\b/.test(text)) return "unzip";
    if (head === "find" && /-delete\b/.test(text)) return "find -delete";
  }
  return null;
}

/** xargs + verb destruktif, mis. `... | xargs rm -f`. */
const XARGS_DESTRUCTIVE = /\bxargs\b[^|]*\b(rm|mv|unlink|shred|tee)\b/;

/** Interpreter inline, mis. `python -c "..."`, `node -e "..."`. */
const INTERP_RUN = /\b(python3?|node|ruby|php|perl)\b[^;&|]*?\s-[cer]\b/;
const INTERP_WRITE_KW = /\bopen\s*\(|writeFile|write_text|file_put_contents|\bos\.(remove|unlink)|shutil|\bunlink\s*\(|\bfopen\s*\(/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pecah segmen command menjadi token, buang flag dan kutip pembungkus. */
function shellTokens(seg: string): string[] {
  return seg
    .split(/\s+/)
    .map((t) => t.replace(/^["']|["']$/g, ""))
    .filter((t) => t.length > 0 && !t.startsWith("-"));
}

/** true bila token path (absolut/relatif thd cwd) bersinggungan dengan klaim. */
function tokenHitsClaim(tok: string, claimPath: string, cwd?: string): boolean {
  const t = tok.replace(/^of=/, ""); // dd of=<path>
  if (!isAbsolute(t) && !cwd) return false;
  const abs = norm(isAbsolute(t) ? t : resolve(cwd as string, t));
  return overlaps(abs, claimPath);
}

/** Cek verb mutasi: apakah ada token targetnya yang mengenai klaim? */
function verbTargetsClaim(cmd: string, claimPath: string, cwd?: string): boolean {
  for (const { re, lastOnly, skipIf } of BASH_VERBS) {
    const m = re.exec(cmd);
    if (!m) continue;
    const seg = cmd.slice(m.index + m[0].length, m.index + m[0].length + 300).split(/[;&|]/)[0];
    if (skipIf && skipIf.test(seg)) continue;
    let toks = shellTokens(seg);
    if (lastOnly) toks = toks.slice(-1);
    if (toks.some((t) => tokenHitsClaim(t, claimPath, cwd))) return true;
  }
  return false;
}

/** Cek redirect tulis (`>` / `>>` / `&>`) yang targetnya mengenai klaim. */
function redirectTargetsClaim(cmd: string, claimPath: string, cwd?: string): boolean {
  const re = /(^|[^>])&?>{1,2}\s*(["']?)([^\s;"'|]+)\2/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) {
    if (tokenHitsClaim(m[3], claimPath, cwd)) return true;
  }
  return false;
}

/**
 * Guard heuristic untuk tool `bash`. Blokir bila command mencoba
 * menulis/menghapus path yang diklaim sesi lain.
 *
 * Bukan parsing shell yang sempurna: menutup bypass yang tidak disengaja
 * dan pola umum, bukan adversary yang berniat mengakali (path ter-obfuscate
 * di dalam python -c, dsb. — untuk itu tetap andalkan disiplin worker).
 */
export function guardBashWrite(
  command: string,
  sessionID: string | undefined,
  reg: ClaimRegistry,
  cwd?: string,
): GuardVerdict {
  if (!command || !sessionID) return {};
  const others = reg.list().filter((c) => c.sessionID !== sessionID);
  if (others.length === 0) return {};
  const shown = (p: string) => (cwd ? rel(cwd, p) : p);
  const owners = others.map((o) => `"${o.owner}"`).join(", ");

  // 1. Perintah opaque (target tulis tak bisa ditentukan statis) → blokir konservatif.
  // Hanya bila muncul di posisi command, bukan substring di argumen.
  const opaque = opaqueHit(command);
  if (opaque) {
    return {
      blocked:
        `⛔ Orkestra: "${opaque}" berpotensi menulis banyak file sekaligus sementara ` +
        `ada klaim aktif milik tugas lain (${owners}). ` +
        `Pastikan tidak menimpa file mereka, atau lakukan via tool write/edit.`,
    };
  }

  for (const c of others) {
    // 2. xargs destruktif: cek apakah path klaim disebut di segmen pipa sebelumnya.
    if (XARGS_DESTRUCTIVE.test(command)) {
      const before = command.slice(0, command.search(/\bxargs\b/));
      if (mentionsClaim(before, c.path, cwd)) {
        return {
          blocked:
            `⛔ Orkestra: perintah xargs ini menarget "${shown(c.path)}" ` +
            `yang diklaim oleh tugas "${c.owner}" (sesi lain).`,
        };
      }
      // Path tidak terlihat di teks (mis. dari find) → tetap blokir konservatif.
      return {
        blocked:
          `⛔ Orkestra: xargs destruktif sementara ada klaim aktif milik tugas lain (${owners}). ` +
          `Pastikan tidak menimpa file mereka, atau lakukan via tool write/edit.`,
      };
    }

    // 3. Interpreter inline: path klaim + keyword operasi tulis di dalam skrip.
    if (interpTargetsClaim(command, c.path, cwd)) {
      return {
        blocked:
          `⛔ Orkestra: skrip inline ini menulis ke "${shown(c.path)}" ` +
          `yang diklaim oleh tugas "${c.owner}" (sesi lain). ` +
          `Tulis file hanya via tool write/edit.`,
      };
    }

    // 4. Verb mutasi + redirect dengan target path yang jelas.
    if (redirectTargetsClaim(command, c.path, cwd) || verbTargetsClaim(command, c.path, cwd)) {
      return {
        blocked:
          `⛔ Orkestra: perintah shell ini mencoba menulis/menghapus "${shown(c.path)}" ` +
          `yang diklaim oleh tugas "${c.owner}" (sesi lain). ` +
          `Tulis file hanya via tool write/edit, atau minta mandor realokasi via orkestra_release.`,
      };
    }
  }
  return {};
}

/** true bila teks menyebut path klaim (absolut atau relatif thd cwd). */
function mentionsClaim(text: string, claimPath: string, cwd?: string): boolean {
  if (text.includes(claimPath)) return true;
  if (cwd) {
    const r = relative(cwd, claimPath);
    if (r && !r.startsWith("..") && !isAbsolute(r) && text.includes(r)) return true;
  }
  return false;
}

/** true bila skrip inline interpreter menyebut path klaim + keyword operasi tulis. */
function interpTargetsClaim(cmd: string, claimPath: string, cwd?: string): boolean {
  const m = INTERP_RUN.exec(cmd);
  if (!m) return false;
  const script = cmd.slice(m.index + m[0].length);
  return mentionsClaim(script, claimPath, cwd) && INTERP_WRITE_KW.test(script);
}
