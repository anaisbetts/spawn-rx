/* eslint-disable @typescript-eslint/no-explicit-any */
import * as path from "path";
import * as net from "net";
import * as sfs from "fs";

import type { Observer, Subject } from "rxjs";
import { Observable, Subscription, AsyncSubject, of, merge } from "rxjs";
import { map, reduce } from "rxjs/operators";
import { spawn as spawnOg, SpawnOptions } from "child_process";
import Debug from "debug";

const isWindows = process.platform === "win32";

const d = Debug("spawn-rx"); // tslint:disable-line:no-var-requires

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
    d(`Found executable in currect directory: ${target}`);

    // XXX: Some very Odd programs decide to use args[0] as a parameter
    // to determine what to do, and also symlink themselves, so we can't
    // use realpathSync here like we used to
    return target;
  }

  const haystack = process.env.PATH!.split(isWindows ? ";" : ":");
  for (const p of haystack) {
    const needle = path.join(p, exe);
    if (statSyncNoException(needle)) {
      // NB: Same deal as above
      return needle;
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
    const cmd = path.join(
      process.env.SYSTEMROOT!,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "PowerShell.exe",
    );
    const psargs = [
      "-ExecutionPolicy",
      "Unrestricted",
      "-NoLogo",
      "-NonInteractive",
      "-File",
      exe,
    ];

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
};

export type OutputLine = {
  source: "stdout" | "stderr";
  text: string;
};

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
    return spawn(
      cmd,
      args,
      Object.assign({}, opts || {}, { detached: true }) as any,
    );
  }

  const newParams = [cmd].concat(args);

  const target = path.join(
    __dirname,
    "..",
    "..",
    "vendor",
    "jobber",
    "Jobber.exe",
  );
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
  const spawnObs: Observable<OutputLine> = new Observable(
    (subj: Observer<OutputLine>) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { stdin, jobber, split, encoding, ...spawnOpts } = opts;
      const { cmd, args } = findActualExecutable(exe, params);
      d(
        `spawning process: ${cmd} ${args.join()}, ${JSON.stringify(spawnOpts)}`,
      );

      const proc = spawnOg(cmd, args, spawnOpts);

      const bufHandler =
        (source: "stdout" | "stderr") => (b: string | Buffer) => {
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
          ret.add(
            opts.stdin.subscribe({
              next: (x: any) => proc.stdin.write(x),
              error: subj.error.bind(subj),
              complete: () => proc.stdin.end(),
            }),
          );
        } else {
          subj.error(
            new Error(
              `opts.stdio conflicts with provided spawn opts.stdin observable, 'pipe' is required`,
            ),
          );
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
        subj.error(e);
      });

      proc.on("close", (code: number) => {
        noClose = true;
        const pipesClosed = merge(stdoutCompleted!, stderrCompleted!).pipe(
          reduce((acc) => acc, true),
        );

        if (code === 0) {
          pipesClosed.subscribe(() => subj.complete());
        } else {
          pipesClosed.subscribe(() => {
            const e: any = new Error(`Failed with exit code: ${code}`);
            e.exitCode = code;
            e.code = code;

            subj.error(e);
          });
        }
      });

      ret.add(
        new Subscription(() => {
          if (noClose) {
            return;
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
    },
  );

  return opts.split ? spawnObs : spawnObs.pipe(map((x: any) => x?.text));
}

function wrapObservableInPromise(obs: Observable<string>) {
  return new Promise<string>((res, rej) => {
    let out = "";

    obs.subscribe({
      next: (x) => (out += x),
      error: (e) => {
        const err: any = new Error(`${out}\n${e.message}`);
        if ("exitCode" in e) {
          err.exitCode = e.exitCode;
          err.code = e.exitCode;
        }
        rej(err);
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
      next: (x) => (x.source === "stdout" ? (out += x.text) : (err += x.text)),
      error: (e) => {
        const error: any = new Error(`${out}\n${e.message}`);

        if ("exitCode" in e) {
          error.exitCode = e.exitCode;
          error.code = e.exitCode;
          error.stdout = out;
          error.stderr = err;
        }
        rej(error);
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
    return wrapObservableInSplitPromise(
      spawnDetached(exe, params, { ...(opts ?? {}), split: true }),
    );
  } else {
    return wrapObservableInPromise(
      spawnDetached(exe, params, { ...(opts ?? {}), split: false }),
    );
  }
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
export function spawnPromise(
  exe: string,
  params: string[],
  opts?: SpawnOptions & SpawnRxExtras,
): Promise<string>;

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
    return wrapObservableInSplitPromise(
      spawn(exe, params, { ...(opts ?? {}), split: true }),
    );
  } else {
    return wrapObservableInPromise(
      spawn(exe, params, { ...(opts ?? {}), split: false }),
    );
  }
}
