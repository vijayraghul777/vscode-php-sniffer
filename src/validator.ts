/**
 * @file
 * Contains the validator class.
 */

import {
  CancellationToken,
  CancellationTokenSource,
  ConfigurationChangeEvent,
  DiagnosticCollection,
  Disposable,
  languages,
  TextDocument,
  TextDocumentChangeEvent,
  Uri,
  window,
  workspace,
} from 'vscode';
import { debounce } from 'lodash';
import { SpawnOptions } from 'child_process';
import { reportFlatten, PHPCSReport } from './phpcs-report';
import { mapToCliArgs, executeCommand, CliCommandError } from './cli';
import { WorkspaceConfigurationReadable } from './config';

const enum runConfig {
  save = 'onSave',
  type = 'onType',
}

/**
 * Returns a function that will clear a given text document's diagnostics.
 *
 * @param diagnostics
 *   The diagnostic collection to operate on.
 * @return
 *   The clearer function.
 */
const diagnosticsClearer = (diagnostics: DiagnosticCollection) => ({ uri }: TextDocument): void => {
  diagnostics.delete(uri);
};

/**
 * High-order function that runs each function over the arguments.
 */
const parallel = <T extends any[]>(
  ...funcs: Function[]
) => (...args: T): void => funcs.forEach(func => func(...args));

/**
 * Validates text with PHPCS.
 *
 * @param text
 *   The text of the document to validate.
 * @param token
 *   A token to cancel validation.
 * @param config
 *   The configuration to run the validation.
 * @param filePath
 *   The path to the file, for possible path-dependent sniffs/config.
 * @param cwd
 *   The current working directory to use.
 * @return
 *   The report from PHPCS or `null` if cancelled.
 */
export async function validate(
  text: string,
  token: CancellationToken,
  config: WorkspaceConfigurationReadable,
  filePath: string = '',
  cwd: string | undefined = undefined,
): Promise<PHPCSReport | null> {
  const args = new Map([
    ['report', 'json'],
    ['standard', config.get('standard', '')],
    ['stdin-path', filePath],
  ]);

  const shell = process.platform === 'win32';

  const result = await executeCommand({
    command: `${config.get('executablesFolder', '')}phpcs`,
    token,
    stdin: text,
    args: [
      ...mapToCliArgs(args, shell),
      // Exit with 0 code even if there are sniff warnings or errors so we can
      // use error callback for actual execution errors.
      '--runtime-set', 'ignore_warnings_on_exit', '1',
      '--runtime-set', 'ignore_errors_on_exit', '1',
      // Ensure quiet output to override any output settings from config.
      // Ensures we get JSON only.
      '-q',
      // Read stdin.
      '-',
    ],
    spawnOptions: { cwd, shell },
  });

  return result ? JSON.parse(result) : null;
}

export class Validator {
  private diagnosticCollection: DiagnosticCollection = languages.createDiagnosticCollection('php');

  /**
   * The active validator listener.
   */
  private validatorListener?: Disposable;

  /**
   * Token to cancel a current validation runs.
   */
  private runnerCancellations: Map<Uri, CancellationTokenSource> = new Map();

  constructor(subscriptions: Disposable[]) {
    workspace.onDidChangeConfiguration(this.onConfigChange, this, subscriptions);
    workspace.onDidOpenTextDocument(this.validate, this, subscriptions);
    workspace.onDidCloseTextDocument(
      parallel(
        diagnosticsClearer(this.diagnosticCollection),
        this.cancelRun,
      ),
      this,
      subscriptions,
    );
    workspace.onDidChangeWorkspaceFolders(this.refresh, this, subscriptions);

    this.refresh();
    this.setValidatorListener();
  }

  /**
   * Dispose this object.
   */
  public dispose(): void {
    this.diagnosticCollection.clear();
    this.diagnosticCollection.dispose();
  }

  /**
   * Reacts on configuration change.
   *
   * @param event
   *   The configuration change event.
   */
  protected onConfigChange(event: ConfigurationChangeEvent): void {
    if (!event.affectsConfiguration('phpSniffer')) {
      return;
    }

    if (event.affectsConfiguration('phpSniffer.run') || event.affectsConfiguration('phpSniffer.onTypeDelay')) {
      this.setValidatorListener();
    }

    this.refresh();
  }

  /**
   * Sets the validation event listening.
   */
  protected setValidatorListener(): void {
    if (this.validatorListener) {
      this.validatorListener.dispose();
    }

    const config = workspace.getConfiguration('phpSniffer');
    const run: runConfig = config.get('run', runConfig.save);
    const delay: number = config.get('onTypeDelay', 250);

    if (run === runConfig.type as string) {
      const validator = debounce(
        ({ document }: TextDocumentChangeEvent): void => { this.validate(document); },
        delay,
      );
      this.validatorListener = workspace.onDidChangeTextDocument(validator);
    } else {
      this.validatorListener = workspace.onDidSaveTextDocument(this.validate, this);
    }
  }

  /**
   * Refreshes validation on any open documents.
   */
  protected refresh(): void {
    this.diagnosticCollection!.clear();

    workspace.textDocuments
      .filter(({ isClosed }) => !isClosed)
      .forEach(this.validate, this);
  }

  /**
   * Cancels a validation run for a document.
   *
   * @param document
   *   The document to cancel a validation run for.
   */
  protected cancelRun({ uri }: TextDocument): void {
    const runner = this.runnerCancellations.get(uri);
    if (runner) {
      runner.cancel();
      runner.dispose();
      this.runnerCancellations.delete(uri);
    }
  }

  /**
   * Lints a document.
   *
   * @param document
   *   The document to lint.
   */
  protected validate(document: TextDocument): void {
    if (document.languageId !== 'php' || document.isClosed) {
      return;
    }

    // Cancel any old run of this same document.
    this.cancelRun(document);

    const runner = new CancellationTokenSource();
    this.runnerCancellations.set(document.uri, runner);

    const resultPromise = validate(
      document.getText(),
      runner.token,
      workspace.getConfiguration('phpSniffer', document.uri),
      document.uri.scheme === 'file' ? document.uri.fsPath : '',
      workspace.workspaceFolders && workspace.workspaceFolders[0].uri.scheme === 'file'
        ? workspace.workspaceFolders[0].uri.fsPath
        : undefined,
    );

    resultPromise
      .then(result => {
        if (document.isClosed) {
          // Clear diagnostics on a closed document.
          this.diagnosticCollection.delete(document.uri);
          // If the command was not cancelled.
        } else if (result !== null) {
          this.diagnosticCollection.set(document.uri, reportFlatten(result));
        }
      })
      .catch(error => {
        if (error instanceof CliCommandError) {
          window.showErrorMessage(error.message);
        }

        // Reset diagnostics for the document if there was an error.
        this.diagnosticCollection.delete(document.uri);
      });

    window.setStatusBarMessage('PHP Sniffer: validating…', resultPromise);
  }
}
