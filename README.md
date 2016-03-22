# spawn-rx: A better version of spawn

`spawn-rx` is a package that fixes some deficiencies in `spawn` that come up 
especially on Windows.

## Examples

spawn-as-promise:

```js
// Will run down path to find C:\Windows\System32\wmic.exe, whereas normal 
// 'spawn' would require an absolute path.
let result = await spawnPromise('wmic', []);
console.log(result);
```

Handle failed processes as errors:

```js
try {
  await spawnPromise('exit', ['-1']);
} catch (e) {
  console.log("Processes that return non-zero exit codes throw")
}
```

Kill running process trees:

```js
let disp = spawnDetached('takesALongTime', []).subscribe();
await Promise.delay(1000);

// Kill the process and its children by unsubscribing.
disp.dispose();
```

Stream process output:

```js
spawn('ls', ['-r'])
  .subscribe(
    (x) => console.log(x), 
    (e) => console.log("Process exited with an error"));
```

## Methods

```js
/**
 * Spawns a process attached as a child of the current process. 
 * 
 * @param  {string} exe               The executable to run
 * @param  {Array<string>} params     The parameters to pass to the child
 * @param  {Object} opts              Options to pass to spawn.
 *
 * @return {Observable<string>}       Returns an Observable that when subscribed
 *                                    to, will create a child process. The
 *                                    process output will be streamed to this
 *                                    Observable, and if unsubscribed from, the
 *                                    process will be terminated early. If the
 *                                    process terminates with a non-zero value,
 *                                    the Observable will terminate with onError.
 */
function spawn(exe, params=[], opts=null)
```

```js
/**
 * Spawns a process but detached from the current process. The process is put 
 * into its own Process Group that can be killed by unsubscribing from the 
 * return Observable.
 * 
 * @param  {string} exe               The executable to run
 * @param  {Array<string>} params     The parameters to pass to the child
 * @param  {Object} opts              Options to pass to spawn.
 *
 * @return {Observable<string>}       Returns an Observable that when subscribed
 *                                    to, will create a detached process. The
 *                                    process output will be streamed to this
 *                                    Observable, and if unsubscribed from, the
 *                                    process will be terminated early. If the
 *                                    process terminates with a non-zero value,
 *                                    the Observable will terminate with onError.
 */
function spawnDetached(exe, params, opts=null)
```

```js
/**
 * Spawns a process as a child process.
 * 
 * @param  {string} exe               The executable to run
 * @param  {Array<string>} params     The parameters to pass to the child
 * @param  {Object} opts              Options to pass to spawn.
 *
 * @return {Promise<string>}       Returns an Promise that represents a child
 *                                 process. The value returned is the process 
 *                                 output. If the process terminates with a 
 *                                 non-zero value, the Promise will resolve with 
 *                                 an Error.
 */
function spawnPromise(exe, params, opts=null)
```

```js
/**
 * Spawns a process but detached from the current process. The process is put 
 * into its own Process Group.
 * 
 * @param  {string} exe               The executable to run
 * @param  {Array<string>} params     The parameters to pass to the child
 * @param  {Object} opts              Options to pass to spawn.
 *
 * @return {Promise<string>}       Returns an Promise that represents a detached 
 *                                 process. The value returned is the process 
 *                                 output. If the process terminates with a 
 *                                 non-zero value, the Promise will resolve with 
 *                                 an Error.
 */
function spawnDetachedPromise(exe, params, opts=null)
```

```js
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
 * @param  {Array<string>} args   The arguments to run
 *
 * @return {Object}               The cmd and args to run
 * @property {string} cmd         The command to pass to spawn
 * @property {Array<string>} args The arguments to pass to spawn
 */
function findActualExecutable(exe, args)
```
