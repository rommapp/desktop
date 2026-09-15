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

  const BUTTON = [
    "width:100%", "padding:9px", "border:0", "border-radius:7px",
    "font:inherit", "font-weight:600", "cursor:pointer",
  ].join(";");

  const button = document.createElement("button");
  button.textContent = "Launch";
  button.disabled = true;
  button.style.cssText = BUTTON + ";background:#5a67f2;color:#fff";

  const cancel = document.createElement("button");
  cancel.textContent = "Cancel download";
  cancel.hidden = true;
  cancel.style.cssText = BUTTON + ";background:#3a2b38;color:#f1a7bb";

  const settings = document.createElement("button");
  settings.textContent = "Edit settings";
  settings.style.cssText = [
    "display:block", "margin:8px auto 0", "padding:0", "border:0",
    "background:none", "color:#8b93ad", "font:inherit", "font-size:11px",
    "text-decoration:underline", "cursor:pointer",
  ].join(";");
  settings.addEventListener("click", () => {
    void window.rommNative.openSettings();
  });

  panel.append(title, body, button, cancel, settings);
  document.body.appendChild(panel);

  let rom = null;
  let romId = null;
  // A cancelled download surfaces as a failed launch, so remember that we asked
  // for it and report it as a cancellation rather than an error.
  let cancelling = false;

  const say = (html) => { body.innerHTML = html; };

  const size = (n) => {
    if (n === undefined || n === null) return "";
    const units = ["B", "KB", "MB", "GB"];
    let value = n, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return (unit === 0 ? Math.round(value) : value.toFixed(1)) + " " + units[unit];
  };

  const eta = (seconds) => {
    if (!isFinite(seconds) || seconds <= 0) return "";
    if (seconds < 60) return Math.round(seconds) + "s";
    return Math.floor(seconds / 60) + "m " + Math.round(seconds % 60) + "s";
  };
  // Only one of the two buttons is ever useful, so swap rather than stack.
  const showCancel = (on) => { cancel.hidden = !on; button.hidden = on; };

  window.rommNative.onLaunchState((s) => {
    if (!rom || s.romId !== rom.id) return;
    if (s.status === "downloading") {
      const pct = s.progress === undefined ? "" : " " + Math.round(s.progress * 100) + "%";
      // Speed and remaining time are the whole point of watching a big
      // transfer, so show them rather than a bare percentage.
      const parts = [];
      if (s.received !== undefined) {
        parts.push(size(s.received) + (s.total ? " of " + size(s.total) : ""));
      }
      if (s.bytesPerSecond) parts.push(size(s.bytesPerSecond) + "/s");
      if (s.bytesPerSecond && s.total !== undefined && s.received !== undefined) {
        const left = eta((s.total - s.received) / s.bytesPerSecond);
        if (left) parts.push(left + " left");
      }
      // A core install, an emulator install, a firmware sync and each file of a
      // multi-disc set are all reported as downloads, and all are worth naming:
      // the wait is otherwise unexplained, and a disc set would read as one
      // transfer restarting at zero. The emulator stage covers two different waits -- fetching
      // the file, then the user installing it -- and the missing byte count is
      // what tells them apart, because nothing here can see inside their
      // installer.
      const named = s.emulator || "the emulator";
      const what = s.stage === "core"
        ? "Installing core" + (s.core ? " " + s.core : "")
        : s.stage === "firmware"
          ? "Fetching firmware" + (s.firmware ? " " + s.firmware : "")
        : s.stage === "emulator"
          ? (s.received === undefined
            ? "Waiting for " + named + " to be installed. Your game starts by itself"
            : "Downloading " + named)
        : s.file
          ? "Downloading " + s.file + " (" + s.fileIndex + " of " + s.fileCount + ")"
        : "Downloading";
      say(what + pct + "..."
        + (parts.length ? "<br><span style='opacity:.65'>" + parts.join(" &middot; ") + "</span>" : ""));
      button.disabled = true;
      cancel.disabled = false;
      showCancel(true);
    } else if (s.status === "running") {
      say("<b>Running.</b> Emulator has the game.");
      showCancel(false);
    } else if (s.status === "exited") {
      say("Emulator exited (code " + s.exitCode + ").");
      button.disabled = false;
      showCancel(false);
    } else if (s.status === "failed") {
      say(cancelling ? "Cancelled." : "<b>Failed:</b> " + (s.error ? s.error.message : "unknown"));
      button.disabled = false;
      showCancel(false);
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
    cancelling = false;
    showCancel(false);
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
    cancelling = false;
    say("Starting...");
    try {
      await window.rommNative.launch({
        romId: rom.id,
        downloadPath: "/api/roms/" + rom.id + "/content/" + rom.fs_name,
        fileName: rom.fs_name,
        platformSlug: rom.platform_slug,
        cores: CORES[rom.platform_slug] || [],
        name: rom.name || rom.fs_name,
        serverPath: rom.full_path,
        fileSize: rom.fs_size_bytes,
      });
    } catch (e) {
      // launch() also rejects when we cancelled it; the state handler already
      // said so, so do not overwrite that with an error.
      if (!cancelling) say("<b>Failed:</b> " + (e && e.message ? e.message : e));
      button.disabled = false;
      showCancel(false);
    }
  });

  cancel.addEventListener("click", async () => {
    if (!rom) return;
    cancelling = true;
    cancel.disabled = true;
    say("Cancelling...");
    try {
      await window.rommNative.cancel(rom.id);
    } catch (e) {
      cancelling = false;
      cancel.disabled = false;
      say("<b>Cancel failed:</b> " + (e && e.message ? e.message : e));
    }
  });

  // The SPA swaps routes without reloading, so poll rather than wiring into
  // its router.
  refresh();
  setInterval(refresh, 600);
  return "injected";
})();`;
}
