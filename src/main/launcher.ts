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
  emulatorIsPresent,
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

/**
 * Name the emulator a launch would use when the only thing missing is a core
 * the buildbot can supply, or null when the launch would fail for some other
 * reason. The emulator has to be present: a download cannot conjure one, and
 * reporting support for a machine with no RetroArch would just move the failure
 * later.
 */
function describeInstallableCore(
  config: DesktopConfig,
  query: PlatformSupportQuery,
): string | null {
  if (!canInstallCore(config, query.platformSlug, query.cores)) return null;
  if (!emulatorIsPresent(config, query.platformSlug)) return null;
  const core = firstInstallableCore(query.cores);
  if (!core) return null;
  return `${emulatorLabel(config, query.platformSlug)} (installs ${core})`;
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
    try {
      assertSeparateRoots(config);
      const launch = resolveLaunch({
        config,
        platformSlug: query.platformSlug,
        cores: query.cores,
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
      const installable = describeInstallableCore(config, query);
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

  /**
   * Install a libretro core the launch needs and the user does not have.
   *
   * A no-op unless every condition in canInstallCore holds, so a platform with
   * its core already in place, a standalone emulator, or a user who has turned
   * the feature off never reaches the network.
   */
  private async ensureCore(
    config: DesktopConfig,
    request: LaunchRequest,
    signal: AbortSignal,
  ): Promise<void> {
    if (!config.retroarchCoresPath) return;
    if (!canInstallCore(config, request.platformSlug, request.cores)) return;
    if (!emulatorIsPresent(config, request.platformSlug)) return;

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
      cores: request.cores,
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

      // Fetch a missing core first, so the resolve below sees it. Doing it
      // before the ROM means a core that cannot be had fails in seconds rather
      // than after a multi-gigabyte transfer.
      await this.ensureCore(config, request, controller.signal);

      // Resolve the emulator before downloading: a missing core should fail
      // immediately rather than after a multi-gigabyte transfer.
      resolveLaunch({
        config,
        platformSlug: request.platformSlug,
        cores: request.cores,
        romPath: "",
        savePaths,
      });

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

      const launch = resolveLaunch({
        config,
        platformSlug: request.platformSlug,
        cores: request.cores,
        romPath,
        savePaths,
      });

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
