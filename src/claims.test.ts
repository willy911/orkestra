/**
 * Unit test untuk jantung anti-tabrakan Orkestra (src/claims.ts).
 * Jalankan: bun test
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaimRegistry,
  extractWritePath,
  guardWrite,
  isWriteTool,
  overlaps,
} from "./claims";

const A = "sesi-A";
const B = "sesi-B";

describe("isWriteTool / extractWritePath", () => {
  test("mengenali tool tulis", () => {
    expect(isWriteTool("write")).toBe(true);
    expect(isWriteTool("edit")).toBe(true);
    expect(isWriteTool("patch")).toBe(true);
    expect(isWriteTool("read")).toBe(false);
    expect(isWriteTool("bash")).toBe(false);
    expect(isWriteTool("task")).toBe(false);
  });

  test("mengambil path dari berbagai nama argumen", () => {
    expect(extractWritePath("write", { filePath: "/x/a.ts" })).toBe("/x/a.ts");
    expect(extractWritePath("edit", { path: "/x/a.ts" })).toBe("/x/a.ts");
    expect(extractWritePath("write", { file: "/x/a.ts" })).toBe("/x/a.ts");
    expect(extractWritePath("read", { filePath: "/x/a.ts" })).toBeNull();
    expect(extractWritePath("write", {})).toBeNull();
    expect(extractWritePath("write", null)).toBeNull();
  });
});

describe("overlaps", () => {
  test("path sama = tabrakan", () => {
    expect(overlaps("/p/a.ts", "/p/a.ts")).toBe(true);
  });
  test("file di dalam direktori yang diklaim = tabrakan", () => {
    expect(overlaps("/p/auth", "/p/auth/login.ts")).toBe(true);
  });
  test("direktori yang menimpa file yang diklaim = tabrakan", () => {
    expect(overlaps("/p/auth/login.ts", "/p/auth")).toBe(true);
  });
  test("prefix nama yang mirip tapi beda direktori = BUKAN tabrakan", () => {
    expect(overlaps("/p/auth", "/p/auth-extra/x.ts")).toBe(false);
    expect(overlaps("/p/a.ts", "/p/a.ts.bak")).toBe(false);
  });
  test("cabang berbeda = BUKAN tabrakan", () => {
    expect(overlaps("/p/auth/a.ts", "/p/billing/b.ts")).toBe(false);
  });
});

function freshRegistry(): { reg: ClaimRegistry; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "orkestra-test-"));
  const reg = new ClaimRegistry(join(dir, "claims.json"));
  return { reg, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("ClaimRegistry", () => {
  test("klaim sukses lalu tulis sesi sendiri lolos guard", () => {
    const { reg, dir, cleanup } = freshRegistry();
    try {
      const r = reg.claim(["src/auth/login.ts"], "auth-login", A, dir);
      expect(r.ok).toBe(true);
      const v = guardWrite("write", { filePath: join(dir, "src/auth/login.ts") }, A, reg, dir);
      expect(v.blocked).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("sesi lain menulis file yang diklaim = DIBLOKIR", () => {
    const { reg, dir, cleanup } = freshRegistry();
    try {
      reg.claim(["src/auth/login.ts"], "auth-login", A, dir);
      const v = guardWrite("edit", { filePath: join(dir, "src/auth/login.ts") }, B, reg, dir);
      expect(v.blocked).toContain("auth-login");
      expect(v.blocked).toContain("⛔");
    } finally {
      cleanup();
    }
  });

  test("klaim direktori memblokir file di dalamnya dari sesi lain", () => {
    const { reg, dir, cleanup } = freshRegistry();
    try {
      reg.claim(["src/auth"], "auth-modul", A, dir);
      const v = guardWrite("write", { filePath: join(dir, "src/auth/token.ts") }, B, reg, dir);
      expect(v.blocked).toContain("auth-modul");
    } finally {
      cleanup();
    }
  });

  test("klaim file memblokir tulis direktori induknya dari sesi lain", () => {
    const { reg, dir, cleanup } = freshRegistry();
    try {
      reg.claim(["src/auth/login.ts"], "auth-login", A, dir);
      const v = guardWrite("write", { filePath: join(dir, "src/auth") }, B, reg, dir);
      expect(v.blocked).toBeDefined();
    } finally {
      cleanup();
    }
  });

  test("klaim yang tumpang tindih dari tugas berbeda = konflik", () => {
    const { reg, dir, cleanup } = freshRegistry();
    try {
      expect(reg.claim(["src/a.ts"], "tugas-1", A, dir).ok).toBe(true);
      const r = reg.claim(["src/a.ts"], "tugas-2", B, dir);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.conflict.owner).toBe("tugas-1");
    } finally {
      cleanup();
    }
  });

  test("file yang tidak diklaim bebas ditulis siapa pun", () => {
    const { reg, dir, cleanup } = freshRegistry();
    try {
      const v = guardWrite("write", { filePath: join(dir, "bebas/x.ts") }, B, reg, dir);
      expect(v.blocked).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("tool non-tulis tidak pernah diblokir", () => {
    const { reg, dir, cleanup } = freshRegistry();
    try {
      reg.claim(["src/a.ts"], "tugas-1", A, dir);
      const v = guardWrite("read", { filePath: join(dir, "src/a.ts") }, B, reg, dir);
      expect(v.blocked).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("path relatif di-resolve terhadap cwd dan dinormalisasi", () => {
    const { reg, dir, cleanup } = freshRegistry();
    try {
      reg.claim(["./src//a.ts"], "tugas-1", A, dir);
      // klaim via path absolut yang dinormalisasi tetap konflik
      const r = reg.claim([join(dir, "src", "a.ts")], "tugas-2", B, dir);
      expect(r.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("release melepas klaim, lalu sesi lain boleh menulis", () => {
    const { reg, dir, cleanup } = freshRegistry();
    try {
      reg.claim(["src/a.ts"], "tugas-1", A, dir);
      expect(reg.release("tugas-1", A)).toBe(1);
      const v = guardWrite("write", { filePath: join(dir, "src/a.ts") }, B, reg, dir);
      expect(v.blocked).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("release tanpa force tidak melepas klaim sesi lain; dengan force bisa", () => {
    const { reg, dir, cleanup } = freshRegistry();
    try {
      reg.claim(["src/a.ts"], "tugas-1", A, dir);
      expect(reg.release("tugas-1", B)).toBe(0);
      expect(reg.release("tugas-1", B, true)).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("releaseSession membersihkan klaim sesi yang mati", () => {
    const { reg, dir, cleanup } = freshRegistry();
    try {
      reg.claim(["src/a.ts"], "tugas-1", A, dir);
      reg.claim(["src/b.ts"], "tugas-2", B, dir);
      expect(reg.releaseSession(A)).toBe(1);
      expect(reg.list().map((c) => c.owner)).toEqual(["tugas-2"]);
    } finally {
      cleanup();
    }
  });

  test("klaim bertahan di file JSON antar instance registry", () => {
    const dir = mkdtempSync(join(tmpdir(), "orkestra-test-"));
    try {
      const persist = join(dir, "claims.json");
      const r1 = new ClaimRegistry(persist);
      r1.claim(["src/a.ts"], "tugas-1", A, dir);
      const r2 = new ClaimRegistry(persist);
      const v = guardWrite("write", { filePath: join(dir, "src/a.ts") }, B, r2, dir);
      expect(v.blocked).toContain("tugas-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("klaim ulang oleh owner yang sama dari sesi baru = pindah kepemilikan, bukan konflik", () => {
    const { reg, dir, cleanup } = freshRegistry();
    try {
      reg.claim(["src/a.ts"], "tugas-1", A, dir);
      const r = reg.claim(["src/a.ts"], "tugas-1", B, dir);
      expect(r.ok).toBe(true);
      // sesi lama sekarang diblokir
      const v = guardWrite("write", { filePath: join(dir, "src/a.ts") }, A, reg, dir);
      expect(v.blocked).toContain("tugas-1");
    } finally {
      cleanup();
    }
  });
});

describe("guardWrite edge cases", () => {
  test("tanpa sessionID = fail-open", () => {
    const { reg, dir, cleanup } = freshRegistry();
    try {
      reg.claim(["src/a.ts"], "tugas-1", A, dir);
      expect(guardWrite("write", { filePath: join(dir, "src/a.ts") }, undefined, reg, dir).blocked).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("path relatif tanpa cwd = fail-open (tidak bisa diverifikasi)", () => {
    const { reg, dir, cleanup } = freshRegistry();
    try {
      reg.claim(["src/a.ts"], "tugas-1", A, dir);
      expect(guardWrite("write", { filePath: "src/a.ts" }, B, reg, undefined).blocked).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("pesan blokir menyebut file dan pemilik", () => {
    const { reg, dir, cleanup } = freshRegistry();
    try {
      reg.claim([join(dir, "src", "a.ts")], "bayar-qris", A, dir);
      const v = guardWrite("edit", { filePath: join(dir, "src", "a.ts") }, B, reg, dir);
      expect(v.blocked).toContain("bayar-qris");
    } finally {
      cleanup();
    }
  });
});
