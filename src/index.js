import _ from 'lodash';
import path from 'path';
import net from 'net';
import { Observable, Disposable, AsyncSubject } from 'rx';
import sfs from 'fs';

const spawnOg = require('child_process').spawn;
const isWindows = process.platform === 'win32';
const fs = require('pify')(sfs);

const d = require('debug')('surf:promise-array');

export function findActualExecutable(fullPath, args) {
  // POSIX can just execute scripts directly, no need for silly goosery
  if (process.platform !== 'win32') return { cmd: fullPath, args: args };
  
  if (!sfs.existsSync(fullPath)) {
    // NB: When you write something like `surf-client ... -- surf-build` on Windows,
    // a shell would normally convert that to surf-build.cmd, but since it's passed
    // in as an argument, it doesn't happen
    const possibleExts = ['.exe', '.bat', '.cmd', '.ps1'];
    for (let ext of possibleExts) {
      let possibleFullPath = runDownPath(`${fullPath}${ext}`);

      if (sfs.existsSync(possibleFullPath)) {
        return findActualExecutable(possibleFullPath, args);
      }
    }
  }
  
  if (fullPath.match(/\.ps1$/i)) {
    let cmd = path.join(process.env.SYSTEMROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'PowerShell.exe');
    let psargs = ['-ExecutionPolicy', 'Unrestricted', '-NoLogo', '-NonInteractive', '-File', fullPath];

    return { cmd: cmd, args: psargs.concat(args) };
  }

  if (fullPath.match(/\.(bat|cmd)$/i)) {
    let cmd = path.join(process.env.SYSTEMROOT, 'System32', 'cmd.exe');
    let cmdArgs = ['/C', fullPath];

    return { cmd: cmd, args: cmdArgs.concat(args) };
  }

  if (fullPath.match(/\.(js)$/i)) {
    let cmd = process.execPath;
    let nodeArgs = [fullPath];

    return { cmd: cmd, args: nodeArgs.concat(args) };
  }

  // Dunno lol
  return { cmd: fullPath, args: args };
}

export function asyncMap(array, selector, maxConcurrency=4) {
  return Observable.from(array)
    .map((k) =>
      Observable.defer(() =>
        Observable.fromPromise(selector(k))
          .map((v) => ({ k, v }))))
    .merge(maxConcurrency)
    .reduce((acc, kvp) => {
      acc[kvp.k] = kvp.v;
      return acc;
    }, {})
    .toPromise();
}

export async function asyncReduce(array, selector, seed) {
  let acc = seed;
  for (let x of array) {
    acc = await selector(acc, x);
  }

  return acc;
}

export function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function retryPromise(func) {
  return Observable.defer(() => 
      Observable.fromPromise(func()))
    .retry(3)
    .toPromise();
}

export async function statNoException(file) {
  try {
    return await fs.stat(file);
  } catch (e) {
    return null;
  }
}

export function statSyncNoException(file) {
  try {
    return sfs.statSync(file);
  } catch (e) {
    return null;
  }
}

export async function readdirRecursive(dir) {
  let acc = [];

  for (let entry of await fs.readdir(dir)) {
    let target = path.resolve(dir, entry);
    let stat = await statNoException(target);

    if (stat && stat.isDirectory()) {
      let entries = await readdirRecursive(target);
      _.each(entries, (x) => acc.push(x));
    } else {
      acc.push(target);
    }
  }

  return acc;
}

function runDownPath(exe) {
  // NB: Windows won't search PATH looking for executables in spawn like
  // Posix does

  // Files with any directory path don't get this applied
  if (exe.match(/[\\\/]/)) {
    d('Path has slash in directory, bailing');
    return exe;
  }

  let target = path.join('.', exe);
  if (statSyncNoException(target)) {
    d(`Found executable in currect directory: ${target}`);
    return target;
  }

  let haystack = process.env.PATH.split(isWindows ? ';' : ':');
  for (let p of haystack) {
    let needle = path.join(p, exe);
    if (statSyncNoException(needle)) return needle;
  }

  d('Failed to find executable anywhere in path');
  return exe;
}

export function spawnDetached(exe, params, opts=null) {
  if (!isWindows) return spawn(exe, params, _.assign({}, opts || {}, {detached: true }));
  const newParams = [exe].concat(params);

  let target = path.join(__dirname, '..', 'vendor', 'jobber', 'jobber.exe');
  let options = _.assign({}, opts || {}, { detached: true, jobber: true });

  d(`spawnDetached: ${target}, ${newParams}`);
  return spawn(target, newParams, options);
}

export function spawn(exe, params=[], opts=null) {
  let spawnObs = Observable.create((subj) => {
    let proc = null;

    let { cmd, args } = findActualExecutable(exe, params);
    if (!opts) {
      d(`spawning process: ${cmd} ${args.join()}`);
      proc = spawnOg(cmd, args);
    } else {
      d(`spawning process: ${cmd} ${args.join()}, ${JSON.stringify(opts)}`);
      proc = spawnOg(cmd, args, _.omit(opts, 'jobber'));
    }
  
    let bufHandler = (b) => {
      if (b.length < 1) return;
      let chunk = "<< String sent back was too long >>";
      try {
        chunk = b.toString();
      } catch (e) {
        chunk = `<< Lost chunk of process output for ${exe} - length was ${b.length}>>`;
      }

      subj.onNext(chunk);
    };
    
    let stderrCompleted = null;
    let stdoutCompleted = null;
    let noClose = false;
    
    if (proc.stdout) {
      stdoutCompleted = new AsyncSubject();
      proc.stdout.on('data', bufHandler);
      proc.stdout.on('close', () => { stdoutCompleted.onNext(true); stdoutCompleted.onCompleted(); });
    } else {
      stdoutCompleted = Observable.just(true);
    }
    
    if (proc.stderr) {
      stderrCompleted = new AsyncSubject();
      proc.stderr.on('data', bufHandler);
      proc.stderr.on('close', () => { stderrCompleted.onNext(true); stderrCompleted.onCompleted(); });
    } else {
      stderrCompleted = Observable.just(true);
    }
    
    proc.stderr.on('data', bufHandler);
    proc.on('error', (e) => {
      noClose = true;
      subj.onError(e);
    });

    proc.on('close', (code) => {
      noClose = true;
      let pipesClosed = Observable.merge(stdoutCompleted, stderrCompleted)
        .reduce((acc) => acc, true);
      
      if (code === 0) {
        pipesClosed.subscribe(() => subj.onCompleted());
      } else {
        pipesClosed.subscribe(() => subj.onError(new Error(`Failed with exit code: ${code}`)));
      }
    });

    return Disposable.create(() => {
      if (noClose) return;

      d(`Killing process: ${cmd} ${args.join()}`);
      if (!opts.jobber) {
        proc.kill();
        return;
      }

      // NB: Connecting to Jobber's named pipe will kill it
      net.connect(`\\\\.\\pipe\\jobber-${proc.pid}`);
      setTimeout(() => proc.kill(), 5*1000);
    });
  });

  return spawnObs.publish().refCount();
}

export function spawnPromise(exe, params, opts=null) {
  return spawn(exe, params, opts).toPromise();
}

export function spawnDetachedPromise(exe, params, opts=null) {
  return spawnDetached(exe, params, opts).toPromise();
}
