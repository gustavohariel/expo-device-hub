// Opt-in simulator slimming. A booted simulator runs about 400 launchd services;
// most serve the phone's owner, not an app under test or a stream. Switching some
// of them off saves memory and processes on every simulator, and in an isolated VM
// it stops the push daemon's endless TLS retries.
//
// This is the whole surface serve-sim's CLI uses; see docs/simulator-slimming.md.
// catalog.ts holds the data, launchd.ts applies it, and cli.ts wires both into the
// CLI. Slimming never blocks the stream: `startSlimInBackground` returns at once.
export { SLIM_OPTION, parseSlimOption, registerSlimCommand, startSlimInBackground } from "./cli";
