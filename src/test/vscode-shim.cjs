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
    return {
      workspace: {
        getConfiguration: () => ({ get: () => undefined }),
        openTextDocument: async () => ({ getText: () => '' }),
      },
      window: {
        showInformationMessage: () => undefined,
        showErrorMessage: () => undefined,
        createOutputChannel: outputChannel,
        createDiagnosticCollection: () => ({ set: () => {}, dispose: () => {} }),
      },
      EventEmitter: class { event(){}; fire(){}; dispose(){} },
      Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }), parse: (s) => ({ toString: () => s }) },
      Disposable: class { dispose(){} },
    };
  }
  return originalLoad.apply(this, arguments);
};
