// Plain-node unit-test only: serve a minimal fake 'vscode' module so classes
// that transitively import vscode (e.g. via Logger) can be required under
// mocha. Real vscode-run tests (vscode-test harness) are unaffected because
// they don't load this file.
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    const outputChannel = () => ({
      appendLine: () => {},
      append: () => {},
      clear: () => {},
      show: () => {},
      hide: () => {},
      dispose: () => {},
      name: 'test-output-channel',
    });
    // Fake command registry shared with CompanionRecorder tests. The companion
    // bridge drives the local recorder purely by command id, so the shim must
    // let tests register and execute those commands.
    const reg = (globalThis.__acpTestCommands ||= new Map());
    const commands = {
      registerCommand: (id, fn) => {
        reg.set(id, fn);
        return { dispose: () => reg.delete(id) };
      },
      executeCommand: (id, ...args) => {
        const fn = reg.get(id);
        if (!fn) {
          return Promise.reject(new Error(`Command not found: ${id}`));
        }
        return Promise.resolve(fn(...args));
      },
      getCommands: async () => [...reg.keys()],
    };
    return {
      workspace: {
        getConfiguration: (section) => ({
          get: (key, def) => ({
            'acp.voice': { windowsRecorder: 'auto' },
          })[section]?.[key] ?? def,
        }),
        openTextDocument: async () => ({ getText: () => '' }),
      },
      window: {
        showInformationMessage: () => undefined,
        showErrorMessage: () => undefined,
        createOutputChannel: outputChannel,
        createDiagnosticCollection: () => ({ set: () => {}, dispose: () => {} }),
      },
      commands,
      env: { remoteName: undefined, clipboard: { writeText: async () => {} } },
      EventEmitter: class { event(){}; fire(){}; dispose(){} },
      Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }), parse: (s) => ({ toString: () => s }) },
      Disposable: class { dispose(){} },
    };
  }
  return originalLoad.apply(this, arguments);
};
