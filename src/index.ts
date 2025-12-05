import { type SpawnOptions, spawn as spawnOg } from "node:child_process";
import * as sfs from "node:fs";
import * as net from "node:net";
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as path from "node:path";
import Debug from "debug";
import type { Observer, Subject } from "rxjs";
import { AsyncSubject, merge, Observable, of, Subscription, timer } from "rxjs";
import { map, reduce, retry as rxRetry } from "rxjs/operators";

const isWindows = process.platform === "win32";

const d = Debug("spawn-rx"); // tslint:disable-line:no-var-requires

/**
 * Custom error class for spawn operations with additional metadata
 */
export class SpawnError extends Error {
  public readonly exitCode: number;
  public readonly code: number;
  public readonly stdout?: string;
  public readonly stderr?: string;
  public readonly command: string;
  public readonly args: string[];

  constructor(message: string, exitCode: number, command: string, args: string[], stdout?: string, stderr?: string) {
    super(message);
    this.name = "SpawnError";
    this.exitCode = exitCode;
    this.code = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
    this.command = command;
    this.args = args;

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((Error as any).captureStackTrace) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Error as any).captureStackTrace(this, SpawnError);
    }
  }
}

/**
 * Process metadata tracked during execution
 */
export interface ProcessMetadata {
  pid: number;
  startTime: number;
  command: string;
  args: string[];
}

/**
 * stat a file but don't throw if it doesn't exist
 *
 * @param  {string} file The path to a file
 * @return {Stats}       The stats structure
 *
 * @private
 */
function statSyncNoException(file: string): sfs.Stats | null {
  try {
    return sfs.statSync(file);
  } catch {
    return null;
  }
}

/**
 * Search PATH to see if a file exists in any of the path folders.
 *
 * @param  {string} exe The file to search for
 * @return {string}     A fully qualified path, or the original path if nothing
 *                      is found
 *
 * @private
 */
function runDownPath(exe: string): string {
  // NB: Windows won't search PATH looking for executables in spawn like
  // Posix does

  // Files with any directory path don't get this applied
  if (exe.match(/[\\/]/)) {
    d("Path has slash in directory, bailing");
    return exe;
  }

  const target = path.join(".", exe);
  if (statSyncNoException(target)) {
    d(`Found executable in current directory: ${target}`);

    // XXX: Some very Odd programs decide to use args[0] as a parameter
    // to determine what to do, and also symlink themselves, so we can't
    // use realpathSync here like we used to
    return target;
  }

  const haystack = process.env.PATH?.split(isWindows ? ";" : ":");
  if (haystack) {
    for (const p of haystack) {
      const needle = path.join(p, exe);
      if (statSyncNoException(needle)) {
        // NB: Same deal as above
        return needle;
      }
    }
  }

  d("Failed to find executable anywhere in path");
  return exe;
}

/**
 * Finds the actual executable and parameters to run on Windows. This method
 * mimics the POSIX behavior of being able to run scripts as executables by
 * replacing the passed-in executable with the script runner, for PowerShell,
 * CMD, and node scripts.
 *
 * This method also does the work of running down PATH, which spawn on Windows
 * also doesn't do, unlike on POSIX.
 *
 * @param  {string} exe           The executable to run
 * @param  {string[]} args   The arguments to run
 *
 * @return {Object}               The cmd and args to run
 * @property {string} cmd         The command to pass to spawn
 * @property {string[]} args The arguments to pass to spawn
 */
export function findActualExecutable(
  exe: string,
  args: string[],
): {
  cmd: string;
  args: string[];
} {
  // POSIX can just execute scripts directly, no need for silly goosery
  if (process.platform !== "win32") {
    return { cmd: runDownPath(exe), args: args };
  }

  if (!sfs.existsSync(exe)) {
    // NB: When you write something like `surf-client ... -- surf-build` on Windows,
    // a shell would normally convert that to surf-build.cmd, but since it's passed
    // in as an argument, it doesn't happen
    const possibleExts = [".exe", ".bat", ".cmd", ".ps1"];
    for (const ext of possibleExts) {
      const possibleFullPath = runDownPath(`${exe}${ext}`);

      if (sfs.existsSync(possibleFullPath)) {
        return findActualExecutable(possibleFullPath, args);
      }
    }
  }

  if (exe.match(/\.ps1$/i)) {
    const cmd = path.join(process.env.SYSTEMROOT!, "System32", "WindowsPowerShell", "v1.0", "PowerShell.exe");
    const psargs = ["-ExecutionPolicy", "Unrestricted", "-NoLogo", "-NonInteractive", "-File", exe];

    return { cmd: cmd, args: psargs.concat(args) };
  }

  if (exe.match(/\.(bat|cmd)$/i)) {
    const cmd = path.join(process.env.SYSTEMROOT!, "System32", "cmd.exe");
    const cmdArgs = ["/C", exe, ...args];

    return { cmd: cmd, args: cmdArgs };
  }

  if (exe.match(/\.(js)$/i)) {
    const cmd = process.execPath;
    const nodeArgs = [exe];

    return { cmd: cmd, args: nodeArgs.concat(args) };
  }

  // Dunno lol
  return { cmd: exe, args: args };
}

export type SpawnRxExtras = {
  stdin?: Observable<string>;
  echoOutput?: boolean;
  split?: boolean;
  jobber?: boolean;
  encoding?: BufferEncoding;
  /**
   * Timeout in milliseconds. If the process doesn't complete within this time,
   * it will be killed and the observable will error with a TimeoutError.
   */
  timeout?: number;
  /**
   * Number of retry attempts if the process fails (non-zero exit code).
   * Defaults to 0 (no retries).
   */
  retries?: number;
  /**
   * Delay in milliseconds between retry attempts. Defaults to 1000ms.
   */
  retryDelay?: number;
};

export type OutputLine = {
  source: "stdout" | "stderr";
  text: string;
};

/**
 * Utility type to extract the return type based on split option
 */
export type SpawnResult<T extends SpawnRxExtras> = T extends { split: true }
  ? Observable<OutputLine>
  : Observable<string>;

/**
 * Utility type to extract the promise return type based on split option
 */
export type SpawnPromiseResult<T extends SpawnRxExtras> = T extends {
  split: true;
}
  ? Promise<[string, string]>
  : Promise<string>;

/**
 * Helper function to create a spawn command with better type inference
 */
export function createSpawnCommand(exe: string, params: string[] = []) {
  return {
    exe,
    params,
    spawn: (opts?: SpawnOptions & SpawnRxExtras) => spawn(exe, params, opts as any),
    spawnDetached: (opts?: SpawnOptions & SpawnRxExtras) => spawnDetached(exe, params, opts as any),
    spawnPromise: (opts?: SpawnOptions & SpawnRxExtras) => spawnPromise(exe, params, opts as any),
    spawnDetachedPromise: (opts?: SpawnOptions & SpawnRxExtras) => spawnDetachedPromise(exe, params, opts as any),
  };
}

/**
 * Spawns a process but detached from the current process. The process is put
 * into its own Process Group that can be killed by unsubscribing from the
 * return Observable.
 *
 * @param  {string} exe               The executable to run
 * @param  {string[]} params     The parameters to pass to the child
 * @param  {SpawnOptions & SpawnRxExtras} opts              Options to pass to spawn.
 *
 * @return {Observable<OutputLine>}       Returns an Observable that when subscribed
 *                                    to, will create a detached process. The
 *                                    process output will be streamed to this
 *                                    Observable, and if unsubscribed from, the
 *                                    process will be terminated early. If the
 *                                    process terminates with a non-zero value,
 *                                    the Observable will terminate with onError.
 */
export function spawnDetached(
  exe: string,
  params: string[],
  opts: SpawnOptions & SpawnRxExtras & { split: true },
): Observable<OutputLine>;

/**
 * Spawns a process but detached from the current process. The process is put
 * into its own Process Group that can be killed by unsubscribing from the
 * return Observable.
 *
 * @param  {string} exe               The executable to run
 * @param  {string[]} params     The parameters to pass to the child
 * @param  {SpawnOptions & SpawnRxExtras} opts              Options to pass to spawn.
 *
 * @return {Observable<string>}       Returns an Observable that when subscribed
 *                                    to, will create a detached process. The
 *                                    process output will be streamed to this
 *                                    Observable, and if unsubscribed from, the
 *                                    process will be terminated early. If the
 *                                    process terminates with a non-zero value,
 *                                    the Observable will terminate with onError.
 */
export function spawnDetached(
  exe: string,
  params: string[],
  opts?: SpawnOptions & SpawnRxExtras & { split: false | undefined },
): Observable<string>;

/**
 * Spawns a process but detached from the current process. The process is put
 * into its own Process Group that can be killed by unsubscribing from the
 * return Observable.
 *
 * @param  {string} exe               The executable to run
 * @param  {string[]} params     The parameters to pass to the child
 * @param  {SpawnOptions & SpawnRxExtras} opts              Options to pass to spawn.
 *
 * @return {Observable<string>}       Returns an Observable that when subscribed
 *                                    to, will create a detached process. The
 *                                    process output will be streamed to this
 *                                    Observable, and if unsubscribed from, the
 *                                    process will be terminated early. If the
 *                                    process terminates with a non-zero value,
 *                                    the Observable will terminate with onError.
 */
export function spawnDetached(
  exe: string,
  params: string[],
  opts?: SpawnOptions & SpawnRxExtras,
): Observable<string> | Observable<OutputLine> {
  const { cmd, args } = findActualExecutable(exe, params ?? []);

  if (!isWindows) {
    return spawn(cmd, args, Object.assign({}, opts || {}, { detached: true }) as any);
  }

  const newParams = [cmd].concat(args);

  // Resolve Jobber.exe path relative to package root (works from both src/ and lib/src/)
  // Try multiple possible locations to handle both development and compiled scenarios
  let target = path.join(__dirname, "..", "..", "vendor", "jobber", "Jobber.exe");
  if (!sfs.existsSync(target)) {
    // Fallback: try resolving from current working directory (for tests/runtime)
    const cwdTarget = path.join(process.cwd(), "vendor", "jobber", "Jobber.exe");
    if (sfs.existsSync(cwdTarget)) {
      target = cwdTarget;
    } else {
      // Try one more level up (if running from test/ directory)
      const testTarget = path.join(process.cwd(), "..", "vendor", "jobber", "Jobber.exe");
      if (sfs.existsSync(testTarget)) {
        target = testTarget;
      }
    }
  }
  const options = {
    ...(opts ?? {}),
    detached: true,
    jobber: true,
  };

  d(`spawnDetached: ${target}, ${newParams}`);
  return spawn(target, newParams, options as any);
}

/**
 * Spawns a process attached as a child of the current process.
 *
 * @param  {string} exe               The executable to run
 * @param  {string[]} params     The parameters to pass to the child
 * @param  {SpawnOptions & SpawnRxExtras} opts              Options to pass to spawn.
 *
 * @return {Observable<OutputLine>}       Returns an Observable that when subscribed
 *                                    to, will create a child process. The
 *                                    process output will be streamed to this
 *                                    Observable, and if unsubscribed from, the
 *                                    process will be terminated early. If the
 *                                    process terminates with a non-zero value,
 *                                    the Observable will terminate with onError.
 */
export function spawn(
  exe: string,
  params: string[],
  opts: SpawnOptions & SpawnRxExtras & { split: true },
): Observable<OutputLine>;

/**
 * Spawns a process attached as a child of the current process.
 *
 * @param  {string} exe               The executable to run
 * @param  {string[]} params     The parameters to pass to the child
 * @param  {SpawnOptions & SpawnRxExtras} opts              Options to pass to spawn.
 *
 * @return {Observable<string>}       Returns an Observable that when subscribed
 *                                    to, will create a child process. The
 *                                    process output will be streamed to this
 *                                    Observable, and if unsubscribed from, the
 *                                    process will be terminated early. If the
 *                                    process terminates with a non-zero value,
 *                                    the Observable will terminate with onError.
 */
export function spawn(
  exe: string,
  params: string[],
  opts?: SpawnOptions & SpawnRxExtras & { split: false | undefined },
): Observable<string>;

/**
 * Spawns a process attached as a child of the current process.
 *
 * @param  {string} exe               The executable to run
 * @param  {string[]} params     The parameters to pass to the child
 * @param  {SpawnOptions & SpawnRxExtras} opts              Options to pass to spawn.
 *
 * @return {Observable<string>}       Returns an Observable that when subscribed
 *                                    to, will create a child process. The
 *                                    process output will be streamed to this
 *                                    Observable, and if unsubscribed from, the
 *                                    process will be terminated early. If the
 *                                    process terminates with a non-zero value,
 *                                    the Observable will terminate with onError.
 */
export function spawn(
  exe: string,
  params: string[],
  opts?: SpawnOptions & SpawnRxExtras,
): Observable<string> | Observable<OutputLine> {
  opts = opts ?? {};
  const spawnObs: Observable<OutputLine> = new Observable((subj: Observer<OutputLine>) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { stdin, jobber, split, encoding, timeout, retries, retryDelay, ...spawnOpts } = opts!;
    const { cmd, args } = findActualExecutable(exe, params);
    d(`spawning process: ${cmd} ${args.join()}, ${JSON.stringify(spawnOpts)}`);

    const proc = spawnOg(cmd, args, spawnOpts);
    // Process metadata is tracked but not currently exposed
    // Could be added to SpawnError or returned in a future enhancement
    // const _processMetadata: ProcessMetadata = {
    //   pid: proc.pid ?? 0,
    //   startTime: Date.now(),
    //   command: cmd,
    //   args: args,
    // };

    // Set up timeout if specified
    let timeoutHandle: NodeJS.Timeout | null = null;
    if (timeout && timeout > 0) {
      timeoutHandle = setTimeout(() => {
        d(`Process timeout reached: ${cmd} ${args.join()}`);
        if (!proc.killed) {
          proc.kill();
        }
        const error = new SpawnError(`Process timed out after ${timeout}ms`, -1, cmd, args);
        subj.error(error);
      }, timeout);
    }

    const bufHandler = (source: "stdout" | "stderr") => (b: string | Buffer) => {
      if (b.length < 1) {
        return;
      }

      if (opts.echoOutput) {
        (source === "stdout" ? process.stdout : process.stderr).write(b);
      }

      let chunk = "<< String sent back was too long >>";
      try {
        if (typeof b === "string") {
          chunk = b.toString();
        } else {
          chunk = b.toString(encoding || "utf8");
        }
      } catch {
        chunk = `<< Lost chunk of process output for ${exe} - length was ${b.length}>>`;
      }

      subj.next({ source: source, text: chunk });
    };

    const ret = new Subscription();

    if (opts.stdin) {
      if (proc.stdin) {
        const stdin = proc.stdin;
        ret.add(
          opts.stdin.subscribe({
            next: (x: any) => stdin.write(x),
            error: subj.error.bind(subj),
            complete: () => stdin.end(),
          }),
        );
      } else {
        subj.error(new Error(`opts.stdio conflicts with provided spawn opts.stdin observable, 'pipe' is required`));
      }
    }

    let stderrCompleted: Subject<boolean> | Observable<boolean> | null = null;
    let stdoutCompleted: Subject<boolean> | Observable<boolean> | null = null;
    let noClose = false;

    if (proc.stdout) {
      stdoutCompleted = new AsyncSubject<boolean>();
      proc.stdout.on("data", bufHandler("stdout"));
      proc.stdout.on("close", () => {
        (stdoutCompleted! as Subject<boolean>).next(true);
        (stdoutCompleted! as Subject<boolean>).complete();
      });
    } else {
      stdoutCompleted = of(true);
    }

    if (proc.stderr) {
      stderrCompleted = new AsyncSubject<boolean>();
      proc.stderr.on("data", bufHandler("stderr"));
      proc.stderr.on("close", () => {
        (stderrCompleted! as Subject<boolean>).next(true);
        (stderrCompleted! as Subject<boolean>).complete();
      });
    } else {
      stderrCompleted = of(true);
    }

    proc.on("error", (e: Error) => {
      noClose = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      subj.error(e);
    });

    proc.on("close", (code: number) => {
      noClose = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      const pipesClosed = merge(stdoutCompleted!, stderrCompleted!).pipe(reduce((_acc: boolean) => true, true));

      if (code === 0) {
        pipesClosed.subscribe(() => subj.complete());
      } else {
        pipesClosed.subscribe(() => {
          const error = new SpawnError(`Process failed with exit code: ${code}`, code, cmd, args);
          subj.error(error);
        });
      }
    });

    ret.add(
      new Subscription(() => {
        if (noClose) {
          return;
        }

        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        d(`Killing process: ${cmd} ${args.join()}`);
        if (opts.jobber) {
          // NB: Connecting to Jobber's named pipe will kill it
          net.connect(`\\\\.\\pipe\\jobber-${proc.pid}`);
          setTimeout(() => proc.kill(), 5 * 1000);
        } else {
          proc.kill();
        }
      }),
    );

    return ret;
  });

  let resultObs: Observable<OutputLine> = spawnObs;

  // Apply retry logic if specified
  if (opts.retries && opts.retries > 0) {
    const retryCount = opts.retries;
    const delay = opts.retryDelay ?? 1000;
    resultObs = resultObs.pipe(
      rxRetry({
        count: retryCount,
        delay: (error: unknown, retryIndex: number) => {
          // Only retry on SpawnError with non-zero exit codes
          if (error instanceof SpawnError && error.exitCode !== 0) {
            d(`Retrying process (attempt ${retryIndex + 1}/${retryCount}): ${exe}`);
            return timer(delay);
          }
          // Don't retry on other errors
          throw error;
        },
      }),
    );
  }

  return opts.split ? resultObs : resultObs.pipe(map((x: OutputLine) => x?.text));
}

function wrapObservableInPromise(obs: Observable<string>) {
  return new Promise<string>((res, rej) => {
    let out = "";

    obs.subscribe({
      next: (x: string) => {
        out += x;
      },
      error: (e: unknown) => {
        if (e instanceof SpawnError) {
          const err = new SpawnError(`${out}\n${e.message}`, e.exitCode, e.command, e.args, out, e.stderr);
          rej(err);
        } else {
          const err = new Error(`${out}\n${e instanceof Error ? e.message : String(e)}`);
          rej(err);
        }
      },
      complete: () => res(out),
    });
  });
}

function wrapObservableInSplitPromise(obs: Observable<OutputLine>) {
  return new Promise<[string, string]>((res, rej) => {
    let out = "";
    let err = "";

    obs.subscribe({
      next: (x: OutputLine) => {
        if (x.source === "stdout") {
          out += x.text;
        } else {
          err += x.text;
        }
      },
      error: (e: unknown) => {
        if (e instanceof SpawnError) {
          const error = new SpawnError(`${out}\n${e.message}`, e.exitCode, e.command, e.args, out, err);
          rej(error);
        } else {
          const error = new Error(`${out}\n${e instanceof Error ? e.message : String(e)}`);
          rej(error);
        }
      },
      complete: () => res([out, err]),
    });
  });
}

/**
 * Spawns a process but detached from the current process. The process is put
 * into its own Process Group.
 *
 * @param  {string} exe               The executable to run
 * @param  {string[]} params     The parameters to pass to the child
 * @param  {SpawnOptions & SpawnRxExtras} opts              Options to pass to spawn.
 *
 * @return {Promise<[string, string]>}       Returns an Promise that represents a detached
 *                                 process. The value returned is the process
 *                                 output. If the process terminates with a
 *                                 non-zero value, the Promise will resolve with
 *                                 an Error.
 */
export function spawnDetachedPromise(
  exe: string,
  params: string[],
  opts: SpawnOptions & SpawnRxExtras & { split: true },
): Promise<[string, string]>;

/**
 * Spawns a process but detached from the current process. The process is put
 * into its own Process Group.
 *
 * @param  {string} exe               The executable to run
 * @param  {string[]} params     The parameters to pass to the child
 * @param  {SpawnOptions & SpawnRxExtras} opts              Options to pass to spawn.
 *
 * @return {Promise<string>}       Returns an Promise that represents a detached
 *                                 process. The value returned is the process
 *                                 output. If the process terminates with a
 *                                 non-zero value, the Promise will resolve with
 *                                 an Error.
 */
export function spawnDetachedPromise(
  exe: string,
  params: string[],
  opts?: SpawnOptions & SpawnRxExtras & { split: false | undefined },
): Promise<string>;

/**
 * Spawns a process but detached from the current process. The process is put
 * into its own Process Group.
 *
 * @param  {string} exe               The executable to run
 * @param  {string[]} params     The parameters to pass to the child
 * @param  {Object} opts              Options to pass to spawn.
 *
 * @return {Promise<string>}       Returns an Promise that represents a detached
 *                                 process. The value returned is the process
 *                                 output. If the process terminates with a
 *                                 non-zero value, the Promise will resolve with
 *                                 an Error.
 */
export function spawnDetachedPromise(
  exe: string,
  params: string[],
  opts?: SpawnOptions & SpawnRxExtras,
): Promise<string> | Promise<[string, string]> {
  if (opts?.split) {
    return wrapObservableInSplitPromise(spawnDetached(exe, params, { ...(opts ?? {}), split: true }));
  }
  return wrapObservableInPromise(spawnDetached(exe, params, { ...(opts ?? {}), split: false }));
}

/**
 * Spawns a process as a child process.
 *
 * @param  {string} exe               The executable to run
 * @param  {string[]} params     The parameters to pass to the child
 * @param  {SpawnOptions & SpawnRxExtras} opts              Options to pass to spawn.
 *
 * @return {Promise<[string, string]>}       Returns an Promise that represents a child
 *                                 process. The value returned is the process
 *                                 output. If the process terminates with a
 *                                 non-zero value, the Promise will resolve with
 *                                 an Error.
 */
export function spawnPromise(
  exe: string,
  params: string[],
  opts: SpawnOptions & SpawnRxExtras & { split: true },
): Promise<[string, string]>;

/**
 * Spawns a process as a child process.
 *
 * @param  {string} exe               The executable to run
 * @param  {string[]} params     The parameters to pass to the child
 * @param  {SpawnOptions & SpawnRxExtras} opts              Options to pass to spawn.
 *
 * @return {Promise<string>}       Returns an Promise that represents a child
 *                                 process. The value returned is the process
 *                                 output. If the process terminates with a
 *                                 non-zero value, the Promise will resolve with
 *                                 an Error.
 */
export function spawnPromise(exe: string, params: string[], opts?: SpawnOptions & SpawnRxExtras): Promise<string>;

/**
 * Spawns a process as a child process.
 *
 * @param  {string} exe               The executable to run
 * @param  {string[]} params     The parameters to pass to the child
 * @param  {Object} opts              Options to pass to spawn.
 *
 * @return {Promise<string>}       Returns an Promise that represents a child
 *                                 process. The value returned is the process
 *                                 output. If the process terminates with a
 *                                 non-zero value, the Promise will resolve with
 *                                 an Error.
 */
export function spawnPromise(
  exe: string,
  params: string[],
  opts?: SpawnOptions & SpawnRxExtras,
): Promise<string> | Promise<[string, string]> {
  if (opts?.split) {
    return wrapObservableInSplitPromise(spawn(exe, params, { ...(opts ?? {}), split: true }));
  }
  return wrapObservableInPromise(spawn(exe, params, { ...(opts ?? {}), split: false }));
}
