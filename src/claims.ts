/**
 * claims.ts — jantung anti-tabrakan Orkestra.
 *
 * Ide sederhana: sebelum sebuah agen (sesi) menulis file, ia harus MENGKLAIM
 * file itu atas nama tugasnya. Klaim dicatat per sesi. Hook
 * `tool.execute.before` menolak setiap write/edit ke path yang diklaim oleh
 * sesi lain. Satu file = satu penulis dalam satu waktu.
 *
 * Modul ini murni (tidak bergantung API opencode) supaya bisa di-unit-test.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export type ClaimResult = { ok: true } | { ok: false; conflict: Claim };

export class ClaimRegistry {
  private claims = new Map<string, Claim>();

  constructor(private persistPath?: string) {
    this.load();
  }

  /** Klaim satu atau beberapa path untuk sebuah tugas. Path relatif di-resolve terhadap cwd. */
  claim(paths: string[], owner: string, sessionID: string, cwd?: string): ClaimResult {
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
  release(target: string, sessionID: string, force = false): number {
    let n = 0;
    const absTarget = norm(isAbsolute(target) ? target : resolve(process.cwd(), target));
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
    const p = norm(absPath);
    for (const c of this.claims.values()) {
      if (c.sessionID !== sessionID && overlaps(c.path, p)) return c;
    }
    return null;
  }

  list(): Claim[] {
    return [...this.claims.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  private load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, "utf8")) as Claim[];
      for (const c of raw) {
        if (c && typeof c.path === "string") this.claims.set(norm(c.path), { ...c, path: norm(c.path) });
      }
    } catch {
      /* file korup = mulai dari kosong */
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(this.list(), null, 2));
    } catch {
      /* persist best-effort; registry in-memory tetap jalan */
    }
  }
}

export interface GuardVerdict {
  blocked?: string;
}

/**
 * Keputusan murni untuk hook `tool.execute.before`.
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
