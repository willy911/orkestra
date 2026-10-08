/**
 * Orkestra — plugin orkestrasi multi-agent untuk opencode.
 *
 * Yang didaftarkan plugin ini:
 * - Agen `mandor` (primary): perencana + pengawas. Jalankan via `/orkestra`
 *   atau ganti agen ke `mandor`.
 * - Agen `tukang` (subagent): worker satu unit kerja, di-spawn mandor via `task`.
 * - Command `/orkestra <tugas>`: menjalankan workflow orkestrasi.
 * - Tools: `orkestra_claim`, `orkestra_release`, `orkestra_status`.
 * - Guard `tool.execute.before`: menolak write/edit ke file yang diklaim sesi lain,
 *   termasuk upaya bypass lewat shell (heuristic: sed -i, redirect >, rm/mv/tee).
 * - Event `session.deleted`: klaim sesi yang mati otomatis dilepas.
 * - Klaim kedaluwarsa otomatis (TTL 6 jam) agar tidak menggantung bila crash.
 */
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { resolve } from "node:path";
import { ClaimRegistry, DEFAULT_CLAIM_TTL_MS, guardBashWrite, guardWrite, rel } from "./claims.js";
import { PERINTAH_ORKESTRA, PROMPT_MANDOR, PROMPT_TUKANG } from "./prompts.gen.js";

const ORKESTRA_DIRNAME = "orkestra";

/** Umur klaim dalam format ringkas, mis. "3m", "2j". */
function ageShort(at: number): string {
  const m = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}j`;
}

export const OrkestraPlugin: Plugin = async (ctx) => {
  const projectDir = ctx.directory || process.cwd();
  const persistPath = resolve(projectDir, ".opencode", ORKESTRA_DIRNAME, "claims.json");
  const registry = new ClaimRegistry(persistPath, DEFAULT_CLAIM_TTL_MS);
  // sessionID -> direktori kerja sesi (untuk resolve path relatif di guard)
  const sessionDirs = new Map<string, string>();

  const dirOf = (sessionID?: string): string =>
    (sessionID && sessionDirs.get(sessionID)) || projectDir;

  return {
    config: async (config) => {
      config.agent = config.agent ?? {};
      if (!config.agent["mandor"]) {
        config.agent["mandor"] = {
          mode: "primary",
          description: "Orkestrator multi-agent: memecah tugas besar menjadi unit independen, men-spawn worker paralel, dan memverifikasi hasilnya.",
          prompt: PROMPT_MANDOR,
          color: "#F97316",
        };
      }
      if (!config.agent["tukang"]) {
        config.agent["tukang"] = {
          mode: "subagent",
          description: "Worker satu unit kerja untuk mandor: mengklaim file, mengerjakan sesuai brief, dan melaporkan hasil + verifikasi.",
          prompt: PROMPT_TUKANG,
          color: "#22C55E",
        };
      }
      config.command = config.command ?? {};
      if (!config.command["orkestra"]) {
        config.command["orkestra"] = {
          template: PERINTAH_ORKESTRA,
          description: "Jalankan workflow orkestrasi multi-agent (pecah → klaim → spawn paralel → verifikasi → integrasi).",
          agent: "mandor",
        };
      }
    },

    tool: {
      orkestra_claim: tool({
        description:
          "Klaim kepemilikan file sebelum menulis. WAJIB dipanggil tukang sebelum write/edit. " +
          "Menulis ke file yang diklaim tugas lain akan DITOLAK sistem.",
        args: {
          tugas: tool.schema.string().describe("Nama tugas persis seperti di brief mandor, mis. 'auth-login'"),
          files: tool.schema.array(tool.schema.string()).describe("Daftar file/direktori yang akan ditulis"),
        },
        async execute(args, tctx) {
          const root = tctx.worktree || tctx.directory || projectDir;
          sessionDirs.set(tctx.sessionID, tctx.directory || projectDir);
          const res = registry.claim(args.files, args.tugas, tctx.sessionID, root);
          if (!res.ok) {
            const c = res.conflict;
            return (
              `GAGAL klaim: "${rel(root, c.path)}" sudah diklaim tugas "${c.owner}". ` +
              `Jangan tulis file itu. Laporkan ke mandor agar pembagian file diperbaiki.`
            );
          }
          return (
            `OK: ${args.files.length} path diklaim untuk tugas "${args.tugas}". ` +
            `Klaim: ${args.files.map((f) => rel(root, f)).join(", ")}. ` +
            `Lepas dengan orkestra_release setelah selesai.`
          );
        },
      }),

      orkestra_release: tool({
        description:
          "Lepas klaim file setelah tugas selesai (atau bila pembagian file berubah). " +
          "Bisa melepas per path atau seluruh klaim milik sebuah nama tugas.",
        args: {
          target: tool.schema.string().describe("Path file/direktori ATAU nama tugas yang klaimnya dilepas"),
          force: tool.schema.boolean().optional().describe("true = mandor boleh melepas klaim milik sesi lain"),
        },
        async execute(args, tctx) {
          const cwd = tctx.directory || tctx.worktree || projectDir;
          const n = registry.release(args.target, tctx.sessionID, args.force === true, cwd);
          return n > 0
            ? `OK: ${n} klaim dilepas untuk "${args.target}".`
            : `Tidak ada klaim yang cocok dengan "${args.target}" milik sesimu.` +
              (args.force ? "" : " (tambah force:true bila kamu mandor dan ingin melepas klaim sesi lain)");
        },
      }),

      orkestra_status: tool({
        description: "Lihat semua klaim file yang sedang aktif (tugas apa memegang file apa).",
        args: {},
        async execute(_args, tctx) {
          const root = tctx.worktree || tctx.directory || projectDir;
          const list = registry.list();
          if (list.length === 0) return "Tidak ada klaim aktif. Semua file bebas ditulis.";
          return (
            `Klaim aktif (${list.length}, kedaluwarsa otomatis ${DEFAULT_CLAIM_TTL_MS / 3600000} jam):\n` +
            list
              .map(
                (c) =>
                  `- ${rel(root, c.path)} → tugas "${c.owner}" (${ageShort(c.at)})` +
                  (c.sessionID === tctx.sessionID ? " (milikmu)" : ""),
              )
              .join("\n")
          );
        },
      }),
    },

    "tool.execute.before": async (input, output) => {
      const cwd = dirOf(input.sessionID);
      if (input.tool === "bash") {
        // Heuristic: cegah bypass lewat shell (sed -i, redirect >, rm, ...).
        const v = guardBashWrite(String(output.args?.command ?? ""), input.sessionID, registry, cwd);
        if (v.blocked) throw new Error(v.blocked);
        return;
      }
      const verdict = guardWrite(input.tool, output.args ?? {}, input.sessionID, registry, cwd);
      if (verdict.blocked) throw new Error(verdict.blocked);
    },

    event: async ({ event }) => {
      const info = (event.properties as { info?: { id?: string; directory?: string } } | undefined)?.info;
      if (event.type === "session.created" || event.type === "session.updated") {
        if (info?.id) sessionDirs.set(info.id, info.directory || projectDir);
      } else if (event.type === "session.deleted") {
        if (info?.id) {
          registry.releaseSession(info.id);
          sessionDirs.delete(info.id);
        }
      }
    },
  };
};
