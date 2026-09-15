import { type BrowserWindow, type Session } from "electron";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { toLaunchError } from "../shared/ipc.ts";
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
import {
  canInstallCore,
  firstInstallableCore,
  planCoreInstall,
} from "./emulator/buildbot.ts";
import { installCore } from "./emulator/install.ts";
import { offerStandaloneInstall } from "./emulator/standalone-install.ts";
import { syncPlatformFirmware } from "./firmware/sync.ts";
import { RELEASE_SOURCES } from "./emulator/standalone-release.ts";
import {
  emulatorForPlatform,
  standaloneIsInstalled,
  standaloneLabel,
} from "./emulator/standalone.ts";
import {
  applyCorePreference,
  emulatorLabel,
  emulatorReadsPlaylist,
  findPreferredCores,
  hasPlatformSpecificEmulator,
  resolveLaunch,
} from "./emulator/resolve.ts";
import { syncDiscSet } from "./discs/sync.ts";
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
    return this.supportFor(await loadConfig(), query);
  }

  /**
   * getPlatformSupport for a whole library, keyed by platform slug. The config
   * is read once for the batch, which is the difference that matters: a
   * renderer marking every tile it shows would otherwise reload it per
   * platform. Repeated slugs collapse onto one answer.
   */
  async getPlatformSupportAll(
    queries: PlatformSupportQuery[],
  ): Promise<Record<string, PlatformSupport>> {
    const config = await loadConfig();
    // Null prototype: a slug of "constructor" or "toString" would otherwise
    // find an inherited property here, and ??= would skip the one platform it
    // was asked about.
    const answers: Record<string, PlatformSupport> = Object.create(
      null,
    ) as Record<string, PlatformSupport>;
    for (const query of queries) {
      answers[query.platformSlug] ??= this.supportFor(config, query);
    }
    return answers;
  }

  private supportFor(
    config: DesktopConfig,
    query: PlatformSupportQuery,
  ): PlatformSupport {
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

  /** Emulators being set up right now, so a second game of the same platform
   *  joins that wait instead of being told the emulator is missing. Held as a
   *  flag rather than a promise: the join is the same poll for the same file,
   *  and sharing the poll rather than the promise keeps each launch's own
   *  cancel and timeout its own. */
  private readonly settingUp = new Set<string>();

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
   *
   * That wait is the answer for every hand-off the emulator could come back
   * from, including the one where nothing could be fetched and the user was
   * sent to a download page: they still come back with PCSX2 installed where
   * everyone installs it. Only an emulator that is a file they keep somewhere
   * of their own choosing is beyond it.
   */
  private async offerMissingEmulator(
    config: DesktopConfig,
    request: LaunchRequest,
    parent: BrowserWindow | null,
    entry: ActiveLaunch,
  ): Promise<void> {
    if (!config.offerStandaloneInstall) return;
    const emulatorId = emulatorForPlatform(request.platformSlug);
    if (!emulatorId) return;
    // Nothing to offer when the shell would not use the result: with detection
    // switched off, an emulator in its usual place is one this launch still
    // cannot reach, and downloading a second copy would not change that.
    if (!config.useDetectedEmulators) return;
    // Only when nothing specific to this platform covers it. Not
    // emulatorIsPresent: that says yes for every platform once RetroArch is
    // installed, which is the normal case and not an answer for PS2.
    if (hasPlatformSpecificEmulator(config, request.platformSlug)) return;

    const label = standaloneLabel(emulatorId) ?? emulatorId;
    const signal = entry.controller.signal;

    // Whatever happens below belongs to the window that asked for the game: on
    // macOS closing it does not quit the app, and nothing else would stop a
    // wait that runs for half an hour. Wired before the two paths divide,
    // because a launch that joins someone else's install waits just as long as
    // the one that started it.
    const abort = () => entry.controller.abort();
    parent?.once("closed", abort);
    const release = () => {
      entry.installing = null;
      if (parent && !parent.isDestroyed()) parent.off("closed", abort);
    };

    // Someone is already installing this one. Pressing Play on a second PS2
    // game should join that wait, not be told PCSX2 is missing while it is
    // being fetched -- and asking a second time would be asking about a
    // download already in progress.
    if (this.settingUp.has(emulatorId)) {
      entry.installing = label;
      try {
        await this.awaitEmulator(request, emulatorId, label, signal, () =>
          this.settingUp.has(emulatorId),
        );
      } finally {
        release();
      }
      return;
    }
    if (this.offered.has(emulatorId)) {
      release();
      return;
    }

    this.offered.add(emulatorId);
    this.settingUp.add(emulatorId);
    entry.installing = label;
    try {
      const shouldReport = createProgressGate();
      const { handedOff, mayAppear } = await offerStandaloneInstall({
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
      if (!mayAppear) {
        // An AppImage or a portable archive: the emulator is a file the user
        // keeps where they like, and detection only ever looks in the places an
        // install puts one. Waiting would be half an hour of pretending, so
        // this is the one ending that has to ask them to come back.
        //
        // It says why first. Read on its own, at the end of a download someone
        // just sat through, an instruction to go and edit settings is a chore;
        // the same sentence with the reason in front of it is the shell saying
        // what it cannot do for them.
        throw new LaunchError(
          "emulator-not-found",
          `RomM Desktop cannot guess where ${label} ends up, so it has to be told. Point at it under "emulators" in the settings, then press Play again.`,
        );
      }
      await this.awaitEmulator(request, emulatorId, label, signal);
    } finally {
      this.settingUp.delete(emulatorId);
      release();
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
    /** Whether the install this is waiting on is still happening. A launch that
     *  joined someone else's wait stops when they stop, rather than polling for
     *  half an hour for an install that was declined or failed. */
    stillHappening?: () => boolean,
  ): Promise<void> {
    const deadline = Date.now() + INSTALL_WAIT_MS;
    for (;;) {
      throwIfCancelled(signal);
      // Drops the detection memo as it goes, so the launch that follows this
      // sees what was just installed rather than the answer from before it.
      if (standaloneIsInstalled(emulatorId)) return;
      // Returning rather than throwing: this launch then fails the way it would
      // have without the wait, which is the honest answer once nobody is
      // installing anything.
      if (stillHappening && !stillHappening()) return;
      if (Date.now() >= deadline) {
        // Half an hour of looking, so "not yet" is no longer the likely story:
        // either the install was never finished or it went somewhere detection
        // does not look. Both are worth saying, because a message that only
        // offers the first leaves the user who did install it pressing Play
        // forever with nothing else to try.
        throw new LaunchError(
          "emulator-not-found",
          `${label} has not turned up where RomM Desktop looks for it. Finish installing it and press Play again, or if it went somewhere unusual, point at it under "emulators" in the settings.`,
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
      const plan = planCoreInstall(
        config,
        request.platformSlug,
        cores,
        findPreferredCores(config, request.platformSlug),
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
        // Only when nothing else could play this. A preference being fetched
        // over a working fallback has a real core to validate against already.
        assumeMissingCoreInstalled: plan?.required ?? false,
      });

      if (plan) {
        try {
          await this.ensureCore(config, request, plan.cores, controller.signal);
        } catch (error) {
          // A preference that turns out not to be published for this machine
          // falls through to the core that is already installed, which is what
          // the config's documentation promises. A required core does not.
          if (plan.required) throw error;
          throwIfCancelled(controller.signal);
        }
      }
      // Extracting and writing a core is not itself interruptible, so a cancel
      // landing during it is only observed here.
      throwIfCancelled(controller.signal);

      // A disc set is fetched as the individual discs the server holds,
      // because the archive the content endpoint would otherwise hand over is
      // not something any emulator can boot a multi-disc game out of. Returns
      // null for everything else, including a server that would not answer, and
      // the ordinary download below runs.
      // One gate and one meter per file, not per set: both read the byte count
      // of the transfer in front of them, and the next file starting over at
      // zero would otherwise measure as a transfer running backwards.
      let staging = 0;
      let shouldReportFile = createProgressGate();
      let fileRateOf = createRateMeter();
      const discs = await syncDiscSet({
        config,
        session,
        romId: request.romId,
        signal: controller.signal,
        playlist: emulatorReadsPlaylist(config, request.platformSlug),
        onProgress: (fileName, received, total, index, count) => {
          if (index !== staging) {
            staging = index;
            shouldReportFile = createProgressGate();
            fileRateOf = createRateMeter();
          }
          const progress = total ? received / total : undefined;
          if (!shouldReportFile(progress)) return;
          this.emit({
            romId: request.romId,
            status: "downloading",
            stage: "rom",
            // Named, and placed in the set, so four discs read as four
            // transfers rather than one that keeps restarting at zero.
            file: fileName,
            fileIndex: index,
            fileCount: count,
            progress,
            received,
            total: total ?? undefined,
            bytesPerSecond: fileRateOf(received),
          });
        },
      });
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
      if (discs) {
        romPath = discs;
      } else if (inLibrary) {
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

      // The firmware RomM already holds, brought down beside the game. After
      // the ROM rather than before it: most platforms have none, so this is
      // usually two small requests that find nothing to do, and putting it
      // ahead of the transfer would delay every launch for the exception.
      // Nothing here can fail a launch -- a platform with no firmware and a
      // server that will not answer are the same outcome, which is the launch
      // the shell would have performed anyway.
      try {
        const shouldReport = createProgressGate();
        await syncPlatformFirmware({
          config,
          session,
          platformSlug: request.platformSlug,
          signal: controller.signal,
          onProgress: (fileName, received, total) => {
            const progress = total ? received / total : undefined;
            if (!shouldReport(progress)) return;
            this.emit({
              romId: request.romId,
              status: "downloading",
              stage: "firmware",
              // Named, so a 200MB PS3 PUP reads as a transfer of something
              // rather than a hung launch.
              firmware: fileName,
              progress,
              received,
              total: total ?? undefined,
            });
          },
        });
      } catch {
        // Except a cancel, which is the user's and belongs to the launch.
        throwIfCancelled(controller.signal);
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
