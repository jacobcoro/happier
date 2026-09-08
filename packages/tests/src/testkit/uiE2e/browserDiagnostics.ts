import type { Page } from '@playwright/test';

export function appendBrowserDiagnostics(error: unknown, diagnostics: string): Error {
  if (!(error instanceof Error)) {
    return new Error(`${String(error)}\n\n${diagnostics}`);
  }

  const originalStack = error.stack ?? `${error.name}: ${error.message}`;
  error.message = `${error.message}\n\n${diagnostics}`;
  error.stack = `${originalStack}\n\n${diagnostics}`;
  return error;
}

export function collectBrowserDiagnostics(params: Readonly<{ page: Page }>): () => string {
  const pageConsole: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const responseErrors: string[] = [];

  params.page.on('console', (message) => pageConsole.push(`[${message.type()}] ${message.text()}`));
  params.page.on('pageerror', (error) => pageErrors.push(String(error)));
  params.page.on('requestfailed', (request) => {
    const failure = request.failure();
    requestFailures.push(`${request.method()} ${request.url()} ${failure ? `-> ${failure.errorText}` : ''}`.trim());
  });
  params.page.on('response', (response) => {
    const status = response.status();
    if (status >= 400) responseErrors.push(`${status} ${response.request().method()} ${response.url()}`);
  });

  return () =>
    `# Browser diagnostics\n\n`
    + `## Console\n\n${pageConsole.length ? pageConsole.join('\n') : '(none)'}\n\n`
    + `## Page errors\n\n${pageErrors.length ? pageErrors.join('\n') : '(none)'}\n\n`
    + `## Request failures\n\n${requestFailures.length ? requestFailures.join('\n') : '(none)'}\n\n`
    + `## Response errors\n\n${responseErrors.length ? responseErrors.join('\n') : '(none)'}\n`;
}
