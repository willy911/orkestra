/**
 * Orkestra — adaptor plugin API opencode V2.
 *
 * V2 memakai API plugin yang sama sekali berbeda dari V1
 * (`@opencode/plugin`, bukan `@opencode-ai/plugin`):
 * - entrypoint: default export `{ id, setup(ctx) }`
 * - tools: `ctx.tool.transform(e => e.add({ name, input: <JSON Schema>, execute }))`
 * - guard: `ctx.tool.hook("execute.before", ...)` — `throw` untuk memblokir
 * - events: `ctx.event.subscribe()` (async iterator)
 * - agen & command: didaftarkan sebagai file definisi markdown
 *   (`~/.config/opencode/agents/*.md`, `~/.config/opencode/commands/*.md`);
 *   definisi milik user (sudah terdaftar) selalu menang dan tidak ditimpa.
 *
 * Modul ini hanya memakai `import type` dari `@opencode/plugin` (dihapus saat
 * build) + Node built-ins, sehingga aman dijalankan di Bun embedded opencode
 * tanpa install dependensi.
 */
import type { Plugin } from "@opencode/plugin";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  ClaimRegistry,
  DEFAULT_CLAIM_TTL_MS,
  guardBashWrite,
  guardWrite,
  isWriteTool,
  rel,
} from "./claims.js";
import { PERINTAH_ORKESTRA, PROMPT_MANDOR, PROMPT_TUKANG } from "./prompts.gen.js";

export const ORKESTRA_PLUGIN_ID = "opencode-orkestra";

/** Nama tool shell yang diawasi guard (opencode memakai "bash"; sisanya jaga-jaga). */
const SHELL_TOOLS = new Set(["bash", "sh", "powershell", "pwsh", "run_command"]);

type V2Context = Plugin.Context;

function configDir(): string {
  const base = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return join(base, "opencode");
}

/** Umur klaim dalam format ringkas, mis. "3m", "2j". */
function ageShort(at: number): string {
  const m = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}j`;
}

const CLAIM_INPUT = {
  type: "object",
  properties: {
    tugas: { type: "string", description: "Nama tugas persis seperti di brief mandor, mis. 'auth-login'" },
    files: { type: "array", description: "Daftar file/direktori yang akan ditulis", items: { type: "string" } },
  },
  required: ["tugas", "files"],
  additionalProperties: false,
} as const;

const RELEASE_INPUT = {
  type: "object",
  properties: {
    target: { type: "string", description: "Path file/direktori ATAU nama tugas yang klaimnya dilepas" },
    force: { type: "boolean", description: "true = mandor boleh melepas klaim milik sesi lain" },
  },
  required: ["target"],
  additionalProperties: false,
} as const;

const STATUS_INPUT = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

interface AgentDef {
  id: string;
  description: string;
  mode: "primary" | "subagent";
  color: string;
  prompt: string;
}

const AGENT_DEFS: AgentDef[] = [
  {
    id: "mandor",
    description:
      "Orkestrator multi-agent: memecah tugas besar menjadi unit independen, men-spawn worker paralel, dan memverifikasi hasilnya.",
    mode: "primary",
    color: "#F97316",
    prompt: PROMPT_MANDOR,
  },
  {
    id: "tukang",
    description:
      "Worker satu unit kerja untuk mandor: mengklaim file, mengerjakan sesuai brief, dan melaporkan hasil + verifikasi.",
    mode: "subagent",
    color: "#22C55E",
    prompt: PROMPT_TUKANG,
  },
];

function agentMarkdown(def: AgentDef): string {
  return `---\ndescription: ${def.description}\nmode: ${def.mode}\ncolor: "${def.color}"\n---\n\n${def.prompt}\n`;
}

function commandMarkdown(): string {
  return `---\ndescription: Jalankan workflow orkestrasi multi-agent (pecah → klaim → spawn paralel → verifikasi → integrasi).\nagent: mandor\n---\n\n${PERINTAH_ORKESTRA}\n`;
}

/**
 * Pastikan definisi agen `mandor`/`tukang` dan command `/orkestra` tersedia.
 * Hanya menulis file bila id/nama belum terdaftar — definisi milik user
 * (di opencode.json maupun file markdown-nya sendiri) selalu menang.
 */
async function ensureDefinitions(ctx: V2Context): Promise<void> {
  try {
    const cfg = configDir();
    const agentsDir = join(cfg, "agents");
    const commandsDir = join(cfg, "commands");

    try {
      await ctx.agent.reload();
    } catch {
      /* abaikan */
    }
    let registeredAgents = new Set<string>();
    try {
      const list = await ctx.agent.list();
      registeredAgents = new Set((list.data ?? []).map((a) => a.id));
    } catch {
      /* abaikan */
    }
    let wroteAgent = false;
    for (const def of AGENT_DEFS) {
      if (registeredAgents.has(def.id)) continue;
      const file = join(agentsDir, `${def.id}.md`);
      if (!existsSync(file)) {
        mkdirSync(agentsDir, { recursive: true });
        writeFileSync(file, agentMarkdown(def));
        wroteAgent = true;
      }
    }
    if (wroteAgent) {
      try {
        await ctx.agent.reload();
      } catch {
        /* abaikan */
      }
    }

    try {
      await ctx.command.reload();
    } catch {
      /* abaikan */
    }
    let hasCommand = false;
    try {
      const list = await ctx.command.list();
      hasCommand = (list.data ?? []).some((c) => c.name === "orkestra");
    } catch {
      /* abaikan */
    }
    if (!hasCommand) {
      const file = join(commandsDir, "orkestra.md");
      if (!existsSync(file)) {
        mkdirSync(commandsDir, { recursive: true });
        writeFileSync(file, commandMarkdown());
        try {
          await ctx.command.reload();
        } catch {
          /* abaikan */
        }
      }
    }
  } catch {
    /* definisi gagal dipastikan — plugin tetap jalan (tools + guard aktif) */
  }
}

export async function setupV2(ctx: V2Context): Promise<(() => void) | void> {
  const locationDir = ctx.location.directory;
  // Direktori proyek -> registry (satu claims.json per proyek, seperti V1).
  const registries = new Map<string, ClaimRegistry>();
  // sessionID -> direktori kerja sesi (untuk resolve path relatif di guard).
  const sessionDirs = new Map<string, string>();

  const registryFor = (dir: string): ClaimRegistry => {
    let r = registries.get(dir);
    if (!r) {
      r = new ClaimRegistry(resolve(dir, ".opencode", "orkestra", "claims.json"), DEFAULT_CLAIM_TTL_MS);
      registries.set(dir, r);
    }
    return r;
  };

  const dirOf = async (sessionID?: string): Promise<string> => {
    if (sessionID) {
      const cached = sessionDirs.get(sessionID);
      if (cached) return cached;
      try {
        const info = await ctx.session.get({ sessionID });
        const d = info?.location?.directory;
        if (d) {
          sessionDirs.set(sessionID, d);
          return d;
        }
      } catch {
        /* abaikan, pakai locationDir */
      }
    }
    return locationDir;
  };

  // --- tools ---
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "orkestra_claim",
      description:
        "Klaim kepemilikan file sebelum menulis. WAJIB dipanggil tukang sebelum write/edit. " +
        "Menulis ke file yang diklaim tugas lain akan DITOLAK sistem.",
      input: CLAIM_INPUT as never,
      async execute(raw, call) {
        const args = raw as { tugas: string; files: string[] };
        const dir = await dirOf(call.sessionID);
        sessionDirs.set(call.sessionID, dir);
        const files = Array.isArray(args.files) ? args.files.filter((f) => typeof f === "string") : [];
        const res = registryFor(dir).claim(files, String(args.tugas ?? ""), call.sessionID, dir);
        if (!res.ok) {
          const c = res.conflict!;
          return {
            content:
              `GAGAL klaim: "${rel(dir, c.path)}" sudah diklaim tugas "${c.owner}". ` +
              `Jangan tulis file itu. Laporkan ke mandor agar pembagian file diperbaiki.`,
          };
        }
        return {
          content:
            `OK: ${files.length} path diklaim untuk tugas "${args.tugas}". ` +
            `Klaim: ${files.map((f) => rel(dir, f)).join(", ")}. ` +
            `Lepas dengan orkestra_release setelah selesai.`,
        };
      },
    });

    editor.add({
      name: "orkestra_release",
      description:
        "Lepas klaim file setelah tugas selesai (atau bila pembagian file berubah). " +
        "Bisa melepas per path atau seluruh klaim milik sebuah nama tugas.",
      input: RELEASE_INPUT as never,
      async execute(raw, call) {
        const args = raw as { target: string; force?: boolean };
        const dir = await dirOf(call.sessionID);
        const n = registryFor(dir).release(String(args.target ?? ""), call.sessionID, args.force === true, dir);
        return {
          content:
            n > 0
              ? `OK: ${n} klaim dilepas untuk "${args.target}".`
              : `Tidak ada klaim yang cocok dengan "${args.target}" milik sesimu.` +
                (args.force ? "" : " (tambah force:true bila kamu mandor dan ingin melepas klaim sesi lain)"),
        };
      },
    });

    editor.add({
      name: "orkestra_status",
      description: "Lihat semua klaim file yang sedang aktif (tugas apa memegang file apa).",
      input: STATUS_INPUT as never,
      async execute(_raw, call) {
        const dir = await dirOf(call.sessionID);
        const list = registryFor(dir).list();
        if (list.length === 0) return { content: "Tidak ada klaim aktif. Semua file bebas ditulis." };
        return {
          content:
            `Klaim aktif (${list.length}, kedaluwarsa otomatis ${DEFAULT_CLAIM_TTL_MS / 3600000} jam):\n` +
            list
              .map(
                (c) =>
                  `- ${rel(dir, c.path)} → tugas "${c.owner}" (${ageShort(c.at)})` +
                  (c.sessionID === call.sessionID ? " (milikmu)" : ""),
              )
              .join("\n"),
        };
      },
    });
  });

  // --- guard: tolak write/edit ke file yang diklaim sesi lain ---
  await ctx.tool.hook("execute.before", async (e) => {
    const dir = await dirOf(e.sessionID);
    const reg = registryFor(dir);
    const input = (e.input ?? {}) as Record<string, unknown>;
    if (SHELL_TOOLS.has(e.tool)) {
      // Heuristic: cegah bypass lewat shell (sed -i, redirect >, rm, ...).
      const v = guardBashWrite(String(input["command"] ?? ""), e.sessionID, reg, dir);
      if (v.blocked) throw new Error(v.blocked);
    } else {
      const verdict = guardWrite(e.tool, input, e.sessionID, reg, dir);
      if (verdict.blocked) throw new Error(verdict.blocked);
    }
    // Sliding TTL: sesi yang masih aktif menulis tidak kehilangan klaimnya.
    if (e.sessionID && (SHELL_TOOLS.has(e.tool) || isWriteTool(e.tool))) {
      reg.touch(e.sessionID);
    }
  });

  // --- agen + command (file definisi; milik user tidak ditimpa) ---
  await ensureDefinitions(ctx);

  // --- events: catat direktori sesi; lepas klaim sesi yang mati ---
  const ac = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: ac.signal })) {
        const data = (event as unknown as { data?: Record<string, unknown> }).data;
        if (event.type === "session.created") {
          const sid = data?.["sessionID"];
          const loc = data?.["location"] as { directory?: string } | undefined;
          if (typeof sid === "string" && loc?.directory) sessionDirs.set(sid, loc.directory);
        } else if (event.type === "session.deleted") {
          const sid = data?.["sessionID"];
          if (typeof sid === "string") {
            for (const r of registries.values()) r.releaseSession(sid);
            sessionDirs.delete(sid);
          }
        }
      }
    } catch {
      /* subscribe berakhir (abort) */
    }
  })();

  return () => ac.abort();
}
