// TEMPORARY: throwaway harness for evaluating whether native launching is
// worth building properly. Enabled with --spike.
//
// A stock RomM server does not ship the "Play natively" button, so this
// injects a standalone one into the page instead. That makes the idea
// testable against an unmodified server. Delete this file, its import in
// window.ts, and the --spike branch once the question is answered.

/**
 * A slice of RomM's own platform/core map, copied because a stock server's
 * bundle does not expose it. The real integration reads the full map from the
 * frontend, so this list only needs to cover what a spike would try.
 */
const SPIKE_CORES: Record<string, string[]> = {
  dos: ["dosbox_pure"],
  gamegear: ["genesis_plus_gx"],
  gb: ["gambatte", "mgba"],
  gba: ["mgba"],
  gbc: ["gambatte", "mgba"],
  genesis: ["genesis_plus_gx"],
  n64: ["mupen64plus_next", "parallel_n64"],
  nds: ["melonds", "desmume", "desmume2015"],
  nes: ["fceumm", "nestopia"],
  psx: ["pcsx_rearmed", "mednafen_psx_hw"],
  segacd: ["genesis_plus_gx", "picodrive"],
  sms: ["genesis_plus_gx"],
  snes: ["snes9x"],
};

export function isSpikeMode(argv: string[] = process.argv): boolean {
  return argv.includes("--spike");
}

/**
 * Runs in the page's main world, where the preload has already exposed
 * window.rommNative. Idempotent, so re-running it after a navigation is safe.
 */
export function spikeScript(): string {
  return `(() => {
  const CORES = ${JSON.stringify(SPIKE_CORES)};
  const ID = "romm-desktop-spike";
  if (document.getElementById(ID)) return "already-injected";
  if (!window.rommNative) return "no-bridge";

  const panel = document.createElement("div");
  panel.id = ID;
  panel.style.cssText = [
    "position:fixed", "right:16px", "bottom:16px", "z-index:2147483647",
    "width:280px", "padding:12px 14px", "border-radius:10px",
    "background:rgba(16,18,26,.96)", "color:#e8eaf2", "font:13px/1.45 system-ui,sans-serif",
    "box-shadow:0 8px 32px rgba(0,0,0,.5)", "border:1px solid #2b3040",
  ].join(";");

  const title = document.createElement("div");
  title.textContent = "Native launch (spike)";
  title.style.cssText = "font-weight:600;margin-bottom:8px;font-size:12px;opacity:.7;letter-spacing:.04em;text-transform:uppercase";

  const body = document.createElement("div");
  body.style.cssText = "margin-bottom:10px;min-height:2.9em";

  const button = document.createElement("button");
  button.textContent = "Launch";
  button.disabled = true;
  button.style.cssText = [
    "width:100%", "padding:9px", "border:0", "border-radius:7px",
    "background:#5a67f2", "color:#fff", "font:inherit", "font-weight:600", "cursor:pointer",
  ].join(";");

  panel.append(title, body, button);
  document.body.appendChild(panel);

  let rom = null;
  let romId = null;

  const say = (html) => { body.innerHTML = html; };

  window.rommNative.onLaunchState((s) => {
    if (!rom || s.romId !== rom.id) return;
    if (s.status === "downloading") {
      const pct = s.progress === undefined ? "" : " " + Math.round(s.progress * 100) + "%";
      say("Downloading" + pct + "...");
      button.disabled = true;
    } else if (s.status === "running") {
      say("<b>Running.</b> Emulator has the game.");
    } else if (s.status === "exited") {
      say("Emulator exited (code " + s.exitCode + ").");
      button.disabled = false;
    } else if (s.status === "failed") {
      say("<b>Failed:</b> " + (s.error ? s.error.message : "unknown"));
      button.disabled = false;
    }
  });

  async function refresh() {
    const match = location.pathname.match(/\\/rom\\/(\\d+)/);
    if (!match) {
      romId = null; rom = null;
      say("Open a game to test.");
      button.disabled = true;
      return;
    }
    if (match[1] === romId) return;
    romId = match[1];
    say("Loading game...");
    button.disabled = true;
    try {
      const res = await fetch("/api/roms/" + romId, { credentials: "same-origin" });
      if (!res.ok) throw new Error("API " + res.status);
      rom = await res.json();
      const cores = CORES[rom.platform_slug] || [];
      const support = await window.rommNative.getPlatformSupport({
        platformSlug: rom.platform_slug, cores,
      });
      if (!support.supported) {
        say("<b>" + rom.platform_slug + "</b> not launchable.<br>"
          + (support.detail || support.reason)
          + (cores.length ? "" : "<br>(no core in the spike map)"));
        button.disabled = true;
        return;
      }
      say("<b>" + (rom.name || rom.fs_name) + "</b><br>via " + support.emulator);
      button.disabled = !rom.has_file_on_disk;
      if (!rom.has_file_on_disk) say("No file on disk for this game.");
    } catch (e) {
      say("<b>Error:</b> " + e.message);
      button.disabled = true;
    }
  }

  button.addEventListener("click", async () => {
    if (!rom) return;
    button.disabled = true;
    say("Starting...");
    try {
      await window.rommNative.launch({
        romId: rom.id,
        downloadPath: "/api/roms/" + rom.id + "/content/" + rom.fs_name,
        fileName: rom.fs_name,
        platformSlug: rom.platform_slug,
        cores: CORES[rom.platform_slug] || [],
        name: rom.name || rom.fs_name,
      });
    } catch (e) {
      say("<b>Failed:</b> " + (e && e.message ? e.message : e));
      button.disabled = false;
    }
  });

  // The SPA swaps routes without reloading, so poll rather than wiring into
  // its router.
  refresh();
  setInterval(refresh, 600);
  return "injected";
})();`;
}
