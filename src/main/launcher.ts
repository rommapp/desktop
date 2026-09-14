import { type Session } from "electron";
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
import {
  applyCorePreference,
  emulatorLabel,
  resolveLaunch,
} from "./emulator/resolve.ts";
import { createProgressGate, createRateMeter } from "./progress.ts";
import { ensureRom } from "./rom-cache.ts";
import { resolveSavePaths } from "./saves/paths.ts";
import { assertSeparateRoots, resolveLibraryRom } from "./safety.ts";

interface ActiveLaunch {
  controller: AbortController;
  child: ChildProcess | null;
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
      // A core that is not installed but can be is reported as supported, so
      // the frontend offers the launch that will fetch it. The alternative is a
      // button that stays hidden and a core that therefore never arrives.
      const installable = describeInstallableCore(
        config,
        query.platformSlug,
        cores,
      );
      if (installable) return { supported: true, emulator: installable };

      const launchError = toLaunchError(error);
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

  async launch(
    request: LaunchRequest,
    session: Session,
  ): Promise<LaunchResult> {
    if (this.active.has(request.romId)) {
      throw new LaunchError(
        "already-running",
        `${request.name ?? "This game"} is already running.`,
      );
    }

    const controller = new AbortController();
    const entry: ActiveLaunch = { controller, child: null };
    this.active.set(request.romId, entry);

    try {
      const config = await loadConfig();
      assertSeparateRoots(config);
      const savePaths = resolveSavePaths(
        config.saveDataPath,
        request.romId,
        request.fileName,
      );

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
