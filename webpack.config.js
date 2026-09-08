//@ts-check
'use strict';

const path = require('path');

/** @type {import('webpack').Configuration} */
const extensionConfig = {
  target: 'node',
  mode: 'none',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
  },
  externals: {
    vscode: 'commonjs vscode',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{ loader: 'ts-loader' }],
      },
    ],
  },
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: 'log',
  },
};

/**
 * Companion extension that runs in the UI (client) extension host so dictation
 * can reach the local microphone from a Remote SSH / WSL / container window.
 * Built from the same AudioRecorder source as the main extension; its own
 * tsconfig widens rootDir so the shared import resolves.
 */
const companionRoot = path.resolve(__dirname, 'companion/acp-voice-local');

/** @type {import('webpack').Configuration} */
const companionConfig = {
  target: 'node',
  mode: 'none',
  entry: path.join(companionRoot, 'src/extension.ts'),
  output: {
    path: path.join(companionRoot, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
  },
  externals: {
    vscode: 'commonjs vscode',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
            options: { configFile: path.join(companionRoot, 'tsconfig.json') },
          },
        ],
      },
    ],
  },
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: 'log',
  },
};

module.exports = [extensionConfig, companionConfig];
