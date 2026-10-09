import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fakeCtx(dir: string, events: unknown[] = []) {
  const tools = new Map<string, { execute: (raw: unknown, call: any) => Promise<{ content: string }> }>();
  const hooks = new Map<string, (e: any) => Promise<void> | void>();
  const ctx: any = {
    location: { directory: dir },
    tool: {
      transform: async (cb: (e: any) => void) => {
        cb({ add: (t: any) => tools.set(t.name, t) });
      },
      hook: async (name: string, cb: (e: any) => Promise<void> | void) => {
        hooks.set(name, cb);
      },
    },
    command: {
      reload: async () => {},
      list: async () => ({ data: [{ name: "orkestra" }] }),
    },
    agent: {
      reload: async () => {},
      list: async () => ({ data: [{ id: "mandor" }, { id: "tukang" }] }),
    },
    session: {
      get: async (_q: { sessionID: string }) => ({ location: { directory: dir } }),
    },
    event: {
      subscribe: () => {
        async function* gen() {
          for (const ev of events) {
            // kirim event SETELAH klaim dibuat (simulasi urutan nyata)
            await new Promise((r) => setTimeout(r, 200));
            yield ev;
          }
        }
        return gen();
      },
    },
  };
  return { ctx, tools, hooks };
}

describe("v2 setup — registrasi tools + guard hook", () => {
  test("3 tools terdaftar; alur claim → blokir (write & apply_patch) → release jalan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orkestra-v2-"));
    try {
      const { setupV2 } = await import("./v2");
      const { ctx, tools, hooks } = fakeCtx(dir);
      const cleanup = await setupV2(ctx);
      try {
        expect(tools.has("orkestra_claim")).toBe(true);
        expect(tools.has("orkestra_release")).toBe(true);
        expect(tools.has("orkestra_status")).toBe(true);
        expect(hooks.has("execute.before")).toBe(true);

        const callA = { sessionID: "A" };
        const r1 = await tools.get("orkestra_claim")!.execute({ tugas: "t1", files: ["src/a.ts"] }, callA);
        expect(r1.content.startsWith("OK")).toBe(true);

        const before = hooks.get("execute.before")!;
        let blocked = false;
        try {
          await before({ tool: "write", sessionID: "B", input: { filePath: "src/a.ts" } });
        } catch (e: any) {
          blocked = String(e?.message ?? "").includes("Orkestra");
        }
        expect(blocked).toBe(true);

        blocked = false;
        try {
          await before({
            tool: "apply_patch",
            sessionID: "B",
            input: { patchText: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** End Patch" },
          });
        } catch (e: any) {
          blocked = String(e?.message ?? "").includes("Orkestra");
        }
        expect(blocked).toBe(true);

        // bash bypass juga diblokir
        blocked = false;
        try {
          await before({ tool: "bash", sessionID: "B", input: { command: `rm ${join(dir, "src/a.ts")}` } });
        } catch (e: any) {
          blocked = String(e?.message ?? "").includes("Orkestra");
        }
        expect(blocked).toBe(true);

        // pemilik klaim tidak diblokir
        await before({ tool: "write", sessionID: "A", input: { filePath: "src/a.ts" } });

        const r2 = await tools.get("orkestra_release")!.execute({ target: "src/a.ts" }, callA);
        expect(r2.content).toContain("1 klaim");

        const r3 = await tools.get("orkestra_status")!.execute({}, callA);
        expect(r3.content).toContain("Tidak ada klaim aktif");
      } finally {
        if (typeof cleanup === "function") cleanup();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session.deleted melepaskan klaim sesi yang mati", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orkestra-v2-"));
    try {
      const { setupV2 } = await import("./v2");
      const { ctx, tools } = fakeCtx(dir, [{ type: "session.deleted", data: { sessionID: "A" } }]);
      const cleanup = await setupV2(ctx);
      try {
        const callA = { sessionID: "A" };
        await tools.get("orkestra_claim")!.execute({ tugas: "t1", files: ["src/a.ts"] }, callA);
        // beri waktu loop event memproses session.deleted
        await new Promise((r) => setTimeout(r, 100));
        const r = await tools.get("orkestra_status")!.execute({}, callA);
        expect(r.content).toContain("Tidak ada klaim aktif");
      } finally {
        if (typeof cleanup === "function") cleanup();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("v2 — skema input JSON Schema valid", () => {
  test("orkestra_claim.files bertipe array; semua skema punya required yang benar", async () => {
    // baca skema langsung dari source v2.ts via pendaftaran tool
    const tools = new Map<string, any>();
    const ctx: any = {
      location: { directory: "/tmp" },
      tool: {
        transform: async (cb: (e: any) => void) => {
          cb({ add: (t: any) => tools.set(t.name, t) });
        },
        hook: async () => {},
      },
      command: { reload: async () => {}, list: async () => ({ data: [] }) },
      agent: { reload: async () => {}, list: async () => ({ data: [] }) },
      session: { get: async () => ({}) },
      event: { subscribe: () => (async function* () {})() },
    };
    const { setupV2 } = await import("./v2");
    const cleanup = await setupV2(ctx);
    try {
      const claim = tools.get("orkestra_claim")!;
      expect(claim.input.properties.files.type).toBe("array");
      expect(claim.input.required).toEqual(["tugas", "files"]);
      const release = tools.get("orkestra_release")!;
      expect(release.input.required).toEqual(["target"]);
      expect(release.input.properties.force.type).toBe("boolean");
    } finally {
      if (typeof cleanup === "function") (cleanup as any)();
    }
  });
});
