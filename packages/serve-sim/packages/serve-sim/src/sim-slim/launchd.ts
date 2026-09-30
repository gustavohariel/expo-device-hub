// Applies a slim profile to a booted simulator through `simctl spawn launchctl`.
//
// Services are switched off with `launchctl disable`, which persists across
// reboots on iOS 18.5 and later, and unloaded with `launchctl bootout`, without a
// reboot. Only the needed change is made: a label that is already disabled is not
// disabled again, and only loaded services are booted out. A disabled service that
// stays loaded can still start on demand, so a loaded one is booted out even when it
// is not running. Every function takes the `simctl` runner, so tests pass a fake.
import { execFile } from "child_process";
import { promisify } from "util";
import { simctl } from "../simctl";
import { DEFAULT_SLIM_CATEGORIES, SLIM_CATEGORIES, type SlimCategory, type SlimProfile } from "./catalog";

const execFileAsync = promisify(execFile);

type Run = (args: string[]) => Promise<string>;

/**
 * `simctl` under the utility QoS clamp, which `xcrun` and `simctl` inherit. A slim that runs while
 * a stream starts uses it to yield the CPU to the startup.
 */
export async function simctlLowPriority(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("taskpolicy", ["-c", "utility", "xcrun", "simctl", ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return stdout.trim();
}

type Failure = { label: string; error: string };

/** Labels `launchctl print-disabled` reports as disabled (`=> disabled` or `=> true`). */
export function parseDisabled(output: string): Set<string> {
  const disabled = new Set<string>();
  for (const match of output.matchAll(/"([^"]+)"\s*=>\s*(disabled|true)\b/g)) disabled.add(match[1]!);
  return disabled;
}

/** Labels `launchctl list` reports, that is, loaded: with a PID when running, `-` when not. */
export function parseLoaded(output: string): Set<string> {
  const loaded = new Set<string>();
  for (const line of output.split("\n")) {
    const [pid, , label] = line.trim().split(/\s+/);
    if (label && /^(\d+|-)$/.test(pid ?? "")) loaded.add(label);
  }
  return loaded;
}

async function readServices(udid: string, run: Run): Promise<{ disabled: Set<string>; loaded: Set<string> }> {
  const [disabled, loaded] = await Promise.all([
    run(["spawn", udid, "launchctl", "print-disabled", "system"]),
    run(["spawn", udid, "launchctl", "list"]),
  ]);
  return { disabled: parseDisabled(disabled), loaded: parseLoaded(loaded) };
}

/**
 * Runs `launchctl <verb> system/<label>` for each label, `workers` at a time. CoreSimulator
 * serializes `simctl spawn` at about 0.1 s each, so more than four at a time gains nothing.
 */
async function launchctlEach(udid: string, verb: string, labels: string[], run: Run, workers = 4): Promise<{ done: string[]; failed: Failure[] }> {
  const done: string[] = [];
  const failed: Failure[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(workers, labels.length) }, async () => {
    while (next < labels.length) {
      const label = labels[next++]!;
      try {
        await run(["spawn", udid, "launchctl", verb, `system/${label}`]);
        done.push(label);
      } catch (error) {
        const stderr = (error as { stderr?: unknown }).stderr;
        failed.push({ label, error: String(stderr || error).trim().split("\n")[0]!.slice(0, 200) });
      }
    }
  }));
  return { done: done.sort(), failed };
}

export interface SlimResult {
  /** Newly disabled in this call. */
  disabled: string[];
  /** Were loaded and are now booted out, which stops the running ones. */
  unloaded: string[];
  failed: Failure[];
}

/**
 * Switches the profile's services off in the booted simulator `udid`. When a
 * label was disabled, the services are read again: a `disable` that exits 0 but
 * does not show in `print-disabled` is reported as failed, and its service is not
 * booted out. The second read also sees services that loaded while the labels were
 * disabled, for example for an app launched next to the slim, so they are booted
 * out too. A service that loads after that read stays loaded until the next run.
 * `workers` is how many `launchctl` calls run at a time.
 */
export async function slimSimulator(udid: string, profile: SlimProfile, run: Run = simctl, workers = 4): Promise<SlimResult> {
  const before = await readServices(udid, run);
  const disable = await launchctlEach(udid, "disable", profile.labels.filter((l) => !before.disabled.has(l)), run, workers);
  const after = disable.done.length ? await readServices(udid, run) : before;
  const missing = disable.done.filter((l) => !after.disabled.has(l));
  disable.done = disable.done.filter((l) => after.disabled.has(l));
  disable.failed.push(...missing.map((label) => ({ label, error: "disable did not take: not in print-disabled" })));
  const failedToDisable = new Set(disable.failed.map((f) => f.label));
  const stop = await launchctlEach(udid, "bootout",
    profile.labels.filter((l) => after.loaded.has(l) && !failedToDisable.has(l)), run, workers);
  return { disabled: disable.done, unloaded: stop.done, failed: [...disable.failed, ...stop.failed] };
}

/** Switches the profile's services back on. launchd starts them on demand or at the next boot. */
export async function restoreSimulator(udid: string, profile: SlimProfile, run: Run = simctl): Promise<{ enabled: string[]; failed: Failure[] }> {
  const { disabled } = await readServices(udid, run);
  const enable = await launchctlEach(udid, "enable", profile.labels.filter((l) => disabled.has(l)), run);
  return { enabled: enable.done, failed: enable.failed };
}

export interface SlimCategoryStatus {
  category: SlimCategory;
  inDefault: boolean;
  /** How many of the category's services are disabled and not loaded on the device. */
  off: number;
  /** How many are disabled but still loaded: launchd can still start them on demand. */
  disabledButLoaded: number;
}

export async function slimStatus(udid: string, run: Run = simctl): Promise<SlimCategoryStatus[]> {
  const { disabled, loaded } = await readServices(udid, run);
  return SLIM_CATEGORIES.map((category) => ({
    category,
    inDefault: DEFAULT_SLIM_CATEGORIES.includes(category.id),
    off: category.labels.filter((l) => disabled.has(l) && !loaded.has(l)).length,
    disabledButLoaded: category.labels.filter((l) => disabled.has(l) && loaded.has(l)).length,
  }));
}

export function describeSlim(udid: string, profile: SlimProfile, result: SlimResult): string {
  const failed = result.failed.length ? `, ${result.failed.length} failed` : "";
  return `[slim] ${udid}: ${profile.categories.join(",")}: ${result.disabled.length} disabled, ` +
    `${result.unloaded.length} unloaded${failed}`;
}
