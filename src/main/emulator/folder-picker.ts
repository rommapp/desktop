// Let the user point at a frontend's emulator folder from the dialog that
// needs one.
//
// The moment a launch cannot find an emulator is the only moment anyone has a
// reason to care where theirs are, so the choice is offered there rather than
// as a setup step: detection already handles everyone whose frontend is at its
// default root, and asking them up front would be a question with no point.
//
// The folder comes from the operating system's own picker, in the main
// process. Nothing the renderer sends ever names it, so it adds nothing to
// what has to be validated on the way in over IPC.
//
// A folder that holds nothing recognisable is refused at once, with what was
// looked for, rather than saved as a setting that silently finds nothing.

import { BrowserWindow, dialog } from "electron";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { updateConfig } from "../config.ts";
import { emulatorsInFolder } from "./frontends.ts";
import { resetStandaloneDetection, standaloneLabel } from "./standalone.ts";

/** The button's label, shared so both dialogs offer it in the same words. */
export const CHOOSE_FOLDER_BUTTON = "Choose an emulator folder…";

/** Whether this system has a frontend layout to choose. Only Windows does;
 *  see frontends.ts. */
export function canChooseEmulatorFolder(): boolean {
  return process.platform === "win32";
}

function labelOf(emulatorId: string): string {
  return emulatorId === "retroarch"
    ? "RetroArch"
    : (standaloneLabel(emulatorId) ?? emulatorId);
}

/**
 * Ask for a frontend's emulator folder and save it as `emulatorsBasePath`.
 *
 * True only when a folder was saved, which means the emulator asked for (or,
 * with none asked for, at least one emulator) is in it. Cancelling, or
 * choosing a folder without it, saves nothing and returns false, so the caller
 * carries on exactly as if the user had said "Not now".
 */
export async function chooseEmulatorFolder(
  parent: BrowserWindow | null,
  wanted: string | null,
): Promise<boolean> {
  const options: Electron.OpenDialogOptions = {
    title: wanted
      ? `Choose the folder that has ${labelOf(wanted)}`
      : "Choose your emulator folder",
    buttonLabel: "Use this folder",
    properties: ["openDirectory"],
  };
  const { canceled, filePaths } = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  const folder = filePaths[0];
  if (canceled || !folder) return false;

  const found = emulatorsInFolder(
    folder,
    process.platform,
    homedir(),
    process.env,
    existsSync,
  );
  const usable = wanted ? found.includes(wanted) : found.length > 0;
  if (!usable) {
    const missing = wanted ? labelOf(wanted) : "an emulator";
    const message = {
      type: "warning" as const,
      title: "Nothing to use in that folder",
      message: `RomM Desktop found no ${wanted ? labelOf(wanted) : "emulator"} in ${folder}.`,
      detail: `${found.length > 0 ? `It has ${found.map(labelOf).join(", ")}, but not ${missing}. ` : ""}Choose the folder RetroBat, ES-DE or EmuDeck keeps its emulators in, or the emulator's own folder.`,
    };
    if (parent) await dialog.showMessageBox(parent, message);
    else await dialog.showMessageBox(message);
    return false;
  }

  await updateConfig({ emulatorsBasePath: folder });
  // The memo is keyed on the folder already; this only makes the next lookup
  // a fresh one rather than relying on that.
  resetStandaloneDetection();
  console.info(
    `[emulators] using ${folder}, which has ${found.map(labelOf).join(", ")}`,
  );
  return true;
}
