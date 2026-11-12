// Command-line flags the shell understands. Kept free of Electron imports so
// the parsing stays unit-testable outside a running app.

/**
 * Force the setup window even when a server is already configured. Without
 * this there is no way to correct a mistyped address short of editing
 * desktop-config.json by hand.
 */
export function isSetupMode(argv: string[] = process.argv): boolean {
  return argv.includes("--setup");
}

/** Pairing is deliberately explicit and never prompted merely by browsing. */
export function pairingAction(argv: string[] = process.argv): "pair" | "unpair" | null {
  if (argv.includes("--unpair")) return "unpair";
  return argv.includes("--pair") ? "pair" : null;
}
