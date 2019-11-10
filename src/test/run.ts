import * as path from 'path';
import { runTests } from 'vscode-test';

async function test() {
  try {
    // The folder containing the Extension Manifest package.json
    // Passed to `--extensionDevelopmentPath`
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath: path.resolve(__dirname, './integration'),
      launchArgs: [path.resolve(__dirname, '../../src/test/integration/integration.code-workspace')],
    });

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath: path.resolve(__dirname, './functional'),
      launchArgs: [path.resolve(__dirname, '../../src/test/fixtures')],
    });
  } catch (err) {
    process.exit(1);
  }
}

test();
