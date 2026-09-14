import { type BrowserWindow, type Session } from "electron";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import {
  type DesktopConfig,
  type LaunchRequest,
  type LaunchResult,
  type LaunchState,
  LaunchError,
  type PlatformSupport,
  type PlatformSupportQuery,
} from "../shared/types.ts";
import { loadConfig } from "./config.ts";
import { canInstallCore, firstInstallableCore } from "./emulator/buildbot.ts";
import { installCore } from "./emulator/install.ts";
import { offerStandaloneInstall } from "./emulator/standalone-install.ts";
import { RELEASE_SOURCES } from "./emulator/standalone-release.ts";
import {
  emulatorForPlatform,
  standaloneIsInstalled,
  standaloneLabel,
} from "./emulator/standalone.ts";
import {
  applyCorePreference,
  emulatorLabel,
  hasPlatformSpecificEmulator,
  resolveLaunch,
} from "./emulator/resolve.ts";
import { createProgressGate, createRateMeter } from "./progress.ts";
import { ensureRom } from "./rom-cache.ts";
import { resolveSavePaths } from "./saves/paths.ts";
import { assertSeparateRoots, resolveLibraryRom } from "./safety.ts";

interface ActiveLaunch {
  controller: AbortController;
  child: ChildProcess | null;
  /** The emulator being set up, from the moment the offer is raised until it
   *  has been downloaded, installed and found. Null at every other moment. */
  installing: string | null;
}

/** How long to keep waiting for an emulator the user is installing. Generous:
 *  a Windows installer with a UAC prompt behind another window is slow, and the
 *  wait costs nothing but a directory scan and can be cancelled. */
const INSTALL_WAIT_MS = 30 * 60 * 1000;

/** Between two scans of the places an emulator installs to. */
const INSTALL_POLL_MS = 1500;

/** Sleep, or wake early when the launch is cancelled. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    // Both callers of done are registered at or after this line, so neither can
    // reach timer before it exists.
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function toLaunchError(error: unknown): LaunchError {
  if (error instanceof LaunchError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new LaunchError("launch-failed", message);
}

/** A launch that was cancelled should stop, not carry on to the emulator. */
function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new LaunchError("download-failed", "Launch cancelled");
  }
}

/**
 * Name the emulator a launch would use when the only thing missing is a core
 * the buildbot can supply, or null when the launch would fail for some other
 * reason.
 */
function describeInstallableCore(
  config: DesktopConfig,
  platformSlug: string,
  cores: string[],
): string | null {
  if (!canInstallCore(config, platformSlug, cores)) return null;
  const core = firstInstallableCore(cores);
  if (!core) return null;

  // Every other precondition has to hold too. Overlapping cache and save roots,
  // or a mapping naming {saves} with no saveDataPath, are failures no download
  // can fix, and reporting support for one of those would only move the error
  // to the launch. So re-resolve with the core assumed present and believe the
  // answer.
  try {
    assertSeparateRoots(config);
    resolveLaunch({
      config,
      platformSlug,
      cores,
      romPath: "",
      savePaths: resolveSavePaths(config.saveDataPath, 0, "probe"),
      assumeMissingCoreInstalled: true,
    });
  } catch {
    return null;
  }
  return `${emulatorLabel(config, platformSlug)} (installs ${core})`;
}

/**
 * Name the standalone emulator this platform needs but does not have, when the
 * shell could offer to fetch it.
 *
 * The probe has to answer this, not just the launch. A frontend hides the Play
 * button for a platform it is told is unsupported, and the launch is the only
 * thing that raises the offer -- so reporting the truth here would make the
 * offer unreachable in exactly the case it exists for. Same bargain as an
 * installable core: say yes, and let pressing Play be what sets it up.
 */
function describeInstallableEmulator(
  config: DesktopConfig,
  platformSlug: string,
): string | null {
  if (!config.offerStandaloneInstall) return null;
  // Must agree with offerMissingEmulator, or the frontend shows a Play button
  // that leads nowhere.
  if (!config.useDetectedEmulators) return null;
  const emulatorId = emulatorForPlatform(platformSlug);
  if (!emulatorId) return null;
  if (hasPlatformSpecificEmulator(config, platformSlug)) return null;
  const label = RELEASE_SOURCES[emulatorId]?.label;
  return label ? `${label} (to install)` : null;
}

export class Launcher {
  private readonly active = new Map<number, ActiveLaunch>();
  private readonly emit: (state: LaunchState) => void;

  constructor(emit: (state: LaunchState) => void) {
    this.emit = emit;
  }

  /** Whether the platform would launch, without downloading anything to find
   *  out. A platform whose only gap is a core that can be fetched counts as
   *  supported: the fetch then happens on the launch itself. */
  async getPlatformSupport(
    query: PlatformSupportQuery,
  ): Promise<PlatformSupport> {
    const config = await loadConfig();
    // The user's preference is applied once, here, so the probe and the launch
    // never disagree about which core they are talking about.
    const cores = applyCorePreference(config, query.platformSlug, query.cores);
    try {
      assertSeparateRoots(config);
      const launch = resolveLaunch({
        config,
        platformSlug: query.platformSlug,
        cores,
        // A probe never runs, so the ROM path only has to be non-empty. The
        // save paths do have to be shaped like a real launch's, since a mapping
        // naming {saves} without a saveDataPath is part of what is being probed.
        romPath: "",
        savePaths: resolveSavePaths(config.saveDataPath, 0, "probe"),
      });
      return { supported: true, emulator: launch.label };
    } catch (error) {
      const launchError = toLaunchError(error);
      // A core that is not installed but can be is reported as supported, so
      // the frontend offers the launch that will fetch it. The alternative is a
      // button that stays hidden and a core that therefore never arrives.
      //
      // Not when the config itself is what failed, though: overlapping cache
      // and save roots stop every launch on this machine, and no download
      // changes that, so reporting either answer would be a Play button that
      // cannot work.
      const installable =
        launchError.code === "invalid-request"
          ? null
          : (describeInstallableCore(config, query.platformSlug, cores) ??
            // A platform whose emulator is not a core at all, so no amount of
            // core resolution above could have found it.
            describeInstallableEmulator(config, query.platformSlug));
      if (installable) return { supported: true, emulator: installable };

      switch (launchError.code) {
        case "unsupported-platform":
        case "no-emulator-configured":
        case "emulator-not-found":
          return {
            supported: false,
            reason: launchError.code,
            detail: launchError.message,
          };
        default:
          return {
            supported: false,
            reason: "no-emulator-configured",
            detail: launchError.message,
          };
      }
    }
  }

  /** Install a libretro core the launch needs and the user does not have. */
  private async ensureCore(
    config: DesktopConfig,
    request: LaunchRequest,
    cores: string[],
    signal: AbortSignal,
  ): Promise<void> {
    // Whether to install at all is the caller's decision, made before the
    // launch was validated; this only needs somewhere to put it.
    if (!config.retroarchCoresPath) return;

    // Reported as an ordinary download, distinguished only by the optional
    // stage, so a frontend that has never heard of core installation still
    // shows the wait rather than sitting silent.
    this.emit({
      romId: request.romId,
      status: "downloading",
      stage: "core",
      progress: 0,
    });
    const shouldReport = createProgressGate();
    await installCore({
      coresPath: config.retroarchCoresPath,
      cores,
      signal,
      onProgress: ({ core, received, total }) => {
        const progress = total ? received / total : undefined;
        if (!shouldReport(progress)) return;
        this.emit({
          romId: request.romId,
          status: "downloading",
          stage: "core",
          core,
          progress,
          received,
          total: total ?? undefined,
        });
      },
    });
  }

  /** Emulators already offered this run, so a decline is not re-asked on the
   *  next game of the same platform. */
  private readonly offered = new Set<string>();

  /**
   * Offer a standalone emulator this platform needs and the machine lacks, and
   * see the install through.
   *
   * Declining is free: the launch carries on exactly as it would have, so this
   * never breaks one that would have worked. Accepting means a download, then
   * an install the user performs themselves -- and then this waits for the
   * emulator to appear rather than ending the launch. Telling someone who just
   * installed PCSX2 to go and press Play again is a worse ending than simply
   * starting their game.
   */
  private async offerMissingEmulator(
    config: DesktopConfig,
    request: LaunchRequest,
    parent: BrowserWindow | null,
    entry: ActiveLaunch,
  ): Promise<void> {
    if (!config.offerStandaloneInstall) return;
    const emulatorId = emulatorForPlatform(request.platformSlug);
    if (!emulatorId || this.offered.has(emulatorId)) return;
    // Nothing to offer when the shell would not use the result: with detection
    // switched off, an emulator in its usual place is one this launch still
    // cannot reach, and downloading a second copy would not change that.
    if (!config.useDetectedEmulators) return;
    // Only when nothing specific to this platform covers it. Not
    // emulatorIsPresent: that says yes for every platform once RetroArch is
    // installed, which is the normal case and not an answer for PS2.
    if (hasPlatformSpecificEmulator(config, request.platformSlug)) return;

    this.offered.add(emulatorId);
    const label = standaloneLabel(emulatorId) ?? emulatorId;
    const signal = entry.controller.signal;
    entry.installing = label;
    // The download and the wait that follows it are one span, and both belong
    // to the window that asked for the game: on macOS closing it does not quit
    // the app, and nothing else would stop this polling for half an hour.
    // Wired here rather than around the download alone, which was the same bug
    // one step earlier.
    const abort = () => entry.controller.abort();
    parent?.once("closed", abort);
    try {
      const shouldReport = createProgressGate();
      const { handedOff, detectable } = await offerStandaloneInstall({
        emulatorId,
        parent,
        signal,
        onProgress: (received, total) => {
          const progress = total ? received / total : undefined;
          if (!shouldReport(progress)) return;
          this.emit({
            romId: request.romId,
            status: "downloading",
            stage: "emulator",
            emulator: label,
            progress,
            received,
            total: total ?? undefined,
          });
        },
      });
      if (!handedOff) return;
      if (!detectable) {
        // A portable archive, or a download page: what happens next is the
        // user's to do, and where it lands is not something detection can
        // guess, so this is the one ending that has to ask them to come back.
        throw new LaunchError(
          "emulator-not-found",
          `Point at ${label} under "emulators" in the settings, then press Play again.`,
        );
      }
      await this.awaitEmulator(request, emulatorId, label, signal);
    } finally {
      entry.installing = null;
      if (parent && !parent.isDestroyed()) parent.off("closed", abort);
    }
  }

  /**
   * Wait for an emulator the user is installing to turn up.
   *
   * Polled rather than watched: the three hand-offs land in three different
   * places -- an installer's own target directory, /Applications, a Flatpak
   * root -- and detection already knows all of them, so asking it again is
   * both simpler and exactly as correct as watching would be.
   */
  private async awaitEmulator(
    request: LaunchRequest,
    emulatorId: string,
    label: string,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + INSTALL_WAIT_MS;
    for (;;) {
      throwIfCancelled(signal);
      // Drops the detection memo as it goes, so the launch that follows this
      // sees what was just installed rather than the answer from before it.
      if (standaloneIsInstalled(emulatorId)) return;
      if (Date.now() >= deadline) {
        throw new LaunchError(
          "emulator-not-found",
          `${label} has not appeared yet. Finish installing it, then press Play again.`,
        );
      }
      // No progress and no byte counts: the install is the user's, and how far
      // along it is only they can see. The absence is the signal a frontend
      // reads to tell the wait apart from the download before it.
      this.emit({
        romId: request.romId,
        status: "downloading",
        stage: "emulator",
        emulator: label,
      });
      await delay(INSTALL_POLL_MS, signal);
    }
  }

  async launch(
    request: LaunchRequest,
    session: Session,
    parent: BrowserWindow | null = null,
  ): Promise<LaunchResult> {
    const running = this.active.get(request.romId);
    if (running) {
      // Pressing Play again is the natural thing to do the moment an installer
      // finishes, so say what is actually happening rather than claiming the
      // game is running.
      throw new LaunchError(
        "already-running",
        running.installing
          ? `${running.installing} is still being set up. Your game starts on its own as soon as it is ready.`
          : `${request.name ?? "This game"} is already running.`,
      );
    }

    const controller = new AbortController();
    const entry: ActiveLaunch = { controller, child: null, installing: null };
    this.active.set(request.romId, entry);

    try {
      const config = await loadConfig();
      assertSeparateRoots(config);
      const savePaths = resolveSavePaths(
        config.saveDataPath,
        request.romId,
        request.fileName,
      );

      // Before anything else touches the network: a platform that needs a
      // standalone emulator nobody has is a launch that cannot work, and the
      // moment someone pressed Play is the moment they have shown they want it.
      // This returns once the emulator is there, so the launch below simply
      // finds it.
      await this.offerMissingEmulator(config, request, parent, entry);

      // Applied before anything consults the list, so validation, installation
      // and the spawn all agree on which core this launch is about.
      const cores = applyCorePreference(
        config,
        request.platformSlug,
        request.cores,
      );

      // Decided before validating, so the validation can account for it.
      const installingCore = canInstallCore(
        config,
        request.platformSlug,
        cores,
      );

      // Resolve the emulator before downloading anything: a launch that cannot
      // work should fail in milliseconds rather than after a multi-gigabyte
      // transfer. The core is assumed present exactly when it is about to be
      // fetched, so a mapping that also names a {saves} path it does not have
      // still fails here rather than after the core has been downloaded and
      // written for a launch that was never going to start.
      resolveLaunch({
        config,
        platformSlug: request.platformSlug,
        cores,
        romPath: "",
        savePaths,
        assumeMissingCoreInstalled: installingCore,
      });

      if (installingCore) {
        await this.ensureCore(config, request, cores, controller.signal);
      }
      // Extracting and writing a core is not itself interruptible, so a cancel
      // landing during it is only observed here.
      throwIfCancelled(controller.signal);

      // When the server runs on this machine the file is already on local disk,
      // so copying it into the cache would mean holding a second multi-gigabyte
      // copy and waiting for a transfer that never needed to happen.
      const inLibrary = resolveLibraryRom(
        config.libraryPath,
        request.serverPath,
        request.fileSize,
      );

      let romPath: string;
      if (inLibrary) {
        romPath = inLibrary;
      } else {
        this.emit({
          romId: request.romId,
          status: "downloading",
          stage: "rom",
          progress: 0,
        });
        // ensureRom reports every chunk. Sending all of them would cost more
        // than the download itself on a large ROM, so rate limit before the
        // IPC hop.
        const shouldReport = createProgressGate();
        const rateOf = createRateMeter();
        const rom = await ensureRom({
          config,
          session,
          romId: request.romId,
          fileName: request.fileName,
          downloadPath: request.downloadPath,
          signal: controller.signal,
          onProgress: (received, total) => {
            const progress = total ? received / total : undefined;
            if (!shouldReport(progress)) return;
            this.emit({
              romId: request.romId,
              status: "downloading",
              stage: "rom",
              progress,
              received,
              total: total ?? undefined,
              bytesPerSecond: rateOf(received),
            });
          },
        });
        romPath = rom.path;
      }

      if (savePaths) {
        await mkdir(savePaths.saveDir, { recursive: true });
        await mkdir(savePaths.stateDir, { recursive: true });
      }

      // Resolved again, and this time strictly: the validation above may have
      // assumed a core that had yet to be downloaded, and nothing is spawned
      // from an assumption.
      const launch = resolveLaunch({
        config,
        platformSlug: request.platformSlug,
        cores,
        romPath,
        savePaths,
      });

      // A launch cancelled while the ROM came out of the local library never
      // passed through an interruptible transfer, so without this the emulator
      // would still start after the cancel was reported.
      throwIfCancelled(controller.signal);

      // argv form, never a shell string, so a path containing shell
      // metacharacters stays a single argument.
      const child = spawn(launch.command, launch.args, {
        stdio: "ignore",
        windowsHide: false,
      });
      entry.child = child;

      child.on("error", (error) => {
        this.active.delete(request.romId);
        this.emit({
          romId: request.romId,
          status: "failed",
          error: { code: "launch-failed", message: error.message },
        });
      });

      child.on("exit", (code) => {
        this.active.delete(request.romId);
        this.emit({ romId: request.romId, status: "exited", exitCode: code });
      });

      this.emit({ romId: request.romId, status: "running" });
      return { romId: request.romId, emulator: launch.label };
    } catch (error) {
      this.active.delete(request.romId);
      const launchError = toLaunchError(error);
      this.emit({
        romId: request.romId,
        status: "failed",
        error: { code: launchError.code, message: launchError.message },
      });
      throw launchError;
    }
  }

  /** Abort an in-flight download. A running emulator is left alone. */
  cancel(romId: number): void {
    const entry = this.active.get(romId);
    if (!entry || entry.child) return;
    entry.controller.abort();
    this.active.delete(romId);
  }

  /** Stop tracking on shutdown so pending downloads do not outlive the window. */
  dispose(): void {
    for (const entry of this.active.values()) {
      if (!entry.child) entry.controller.abort();
    }
    this.active.clear();
  }
}
