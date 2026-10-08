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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, normalize, resolve, sep } from "node:path";

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
    this.refresh();
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
  }

  /**
   * Lepas klaim. `target` bisa berupa path (melepas klaim yang bersinggungan)
   * atau nama owner. Mengembalikan jumlah klaim yang dilepas.
   */
  release(target: string, sessionID: string, force = false, cwd?: string): number {
    this.refresh();
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
  }

  /** Lepas semua klaim milik sebuah sesi (dipanggil saat sesi dihapus). */
  releaseSession(sessionID: string): number {
    this.refresh();
    let n = 0;
    for (const [k, c] of this.claims) {
      if (c.sessionID === sessionID) {
        this.claims.delete(k);
        n++;
      }
    }
    if (n > 0) this.save();
    return n;
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
  /** true = hanya token path TERAKHIR yang dicek (cp/install: destinasinya) */
  lastOnly?: boolean;
}

const BASH_VERBS: BashVerb[] = [
  { re: /\brm\s+(--[a-z-]+\s+|-[a-z]+\s+)*/ }, // rm [-rf] <target...>
  { re: /\bmv\s+/ }, // mv: sumber ikut hilang → semua token dicek
  { re: /\bcp\s+(-\S+\s+)*/, lastOnly: true }, // cp: hanya destinasi (terakhir)
  { re: /\bsed\s+(?=[^;&|]*-i)/ }, // sed ... -i ... (in-place)
  { re: /\btee\s+(-a\s+)?/ }, // tee menulis ke semua argumen
  { re: /\binstall\s+/, lastOnly: true }, // install: hanya destinasi
  { re: /\btruncate\s+(-s\s+\S+\s+)?/ },
  { re: /\bdd\s+(?=[^;&|]*\bof=)/ },
  { re: /\bgit\s+(checkout|restore)\s+(?=[^;&|]*--\s)/ }, // git checkout -- <path>
];

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
  if (!isAbsolute(tok) && !cwd) return false;
  const abs = norm(isAbsolute(tok) ? tok : resolve(cwd as string, tok));
  return overlaps(abs, claimPath);
}

/** Cek verb mutasi: apakah ada token targetnya yang mengenai klaim? */
function verbTargetsClaim(cmd: string, claimPath: string, cwd?: string): boolean {
  for (const { re, lastOnly } of BASH_VERBS) {
    const m = re.exec(cmd);
    if (!m) continue;
    const seg = cmd.slice(m.index + m[0].length, m.index + m[0].length + 300).split(/[;&|]/)[0];
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
  for (const c of others) {
    if (redirectTargetsClaim(command, c.path, cwd) || verbTargetsClaim(command, c.path, cwd)) {
      const shown = cwd ? rel(cwd, c.path) : c.path;
      return {
        blocked:
          `⛔ Orkestra: perintah shell ini mencoba menulis/menghapus "${shown}" ` +
          `yang diklaim oleh tugas "${c.owner}" (sesi lain). ` +
          `Tulis file hanya via tool write/edit, atau minta mandor realokasi via orkestra_release.`,
      };
    }
  }
  return {};
}
