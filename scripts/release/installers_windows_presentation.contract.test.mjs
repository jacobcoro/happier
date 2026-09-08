import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const installerPath = join(resolve(here, '..', '..'), 'scripts', 'release', 'installers', 'install.ps1');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name} {`);
  assert.notEqual(start, -1, `expected ${name} to exist`);
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test('install.ps1 presents the compact branded header and truthful install stages', async () => {
  const [source, bashSource] = await Promise.all([
    readFile(installerPath, 'utf8'),
    readFile(join(dirname(installerPath), 'install.sh'), 'utf8'),
  ]);
  const header = extractFunction(source, 'Write-InstallerHeader');

  const powershellRowsBlock = header.match(/\$rows\s*=\s*@\(([\s\S]*?)\n\s*\)/)?.[1];
  const bashRowsBlock = bashSource.match(/HAPPIER_INSTALLER_ART_ROWS=\(([\s\S]*?)\n\)/)?.[1];
  assert.ok(powershellRowsBlock, 'expected PowerShell artwork rows');
  assert.ok(bashRowsBlock, 'expected Bash artwork rows');
  const powershellRows = [...powershellRowsBlock.matchAll(/^\s*"([^"]*)",?$/gm)].map((match) => match[1]);
  const bashRows = [...bashRowsBlock.matchAll(/^\s*'([^']*)'$/gm)].map((match) => match[1]);
  assert.equal(powershellRows.length, 9);
  assert.deepEqual(powershellRows, bashRows, 'expected PowerShell and Bash installers to share one visual identity');
  assert.match(header, /Happier/);
  assert.match(header, /Secure installer/);
  assert.match(header, /Download -> Verify -> Install/);
  assert.match(header, /Test-InstallerRichHeaderAvailable/);
  assert.match(header, /Write-Host "Happier"/);
  assert.match(header, /\[1m/);
  assert.match(header, /\$rows\[\$index\]\.PadRight\(24\)/, 'expected labels to start at one fixed column');
  assert.doesNotMatch(header, /Dark(?:Red|Blue|Magenta|Cyan|Yellow)/, 'expected readable colors on dark terminals');

  const richOutput = extractFunction(source, 'Test-InstallerRichHeaderAvailable');
  assert.match(richOutput, /\[Console\]::IsOutputRedirected/);
  assert.match(richOutput, /\$env:TERM\s*-eq\s*"dumb"/i);
  assert.match(richOutput, /WindowWidth\s*-ge\s*58/);
  assert.match(richOutput, /WindowHeight/);
  const bashWidthCheck = bashSource.match(/installer_terminal_is_wide\(\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(bashWidthCheck, 'expected Bash terminal-width owner');
  assert.match(bashWidthCheck, /\$\{columns\}\"\s*-ge\s*58/);

  const headerIndex = source.lastIndexOf('Write-InstallerHeader');
  const downloadIndex = source.indexOf('Write-InstallerStage -Name "Download"', headerIndex);
  const metadataIndex = source.indexOf('Fetching $tag release metadata', headerIndex);
  const verifyIndex = source.indexOf('Write-InstallerStage -Name "Verify"', downloadIndex);
  const installIndex = source.indexOf('Write-InstallerStage -Name "Install"', verifyIndex);
  assert.ok(headerIndex < downloadIndex && downloadIndex < metadataIndex);
  assert.ok(metadataIndex < verifyIndex && verifyIndex < installIndex);

  const webRequest = extractFunction(source, 'Invoke-InstallerWebRequestWithRetry');
  assert.match(webRequest, /HAPPIER_NO_ANIMATION/);
  assert.match(webRequest, /-not \(Test-InstallerRichHeaderAvailable\)/);
  assert.match(webRequest, /\$ProgressPreference\s*=\s*"SilentlyContinue"/);
  assert.match(webRequest, /finally\s*\{[\s\S]*\$ProgressPreference\s*=\s*\$previousProgressPreference/);
});

test('install.ps1 scopes the welcome marker to the setup child only', async () => {
  const source = await readFile(installerPath, 'utf8');
  const setup = extractFunction(source, 'Invoke-InstallerSetupCommand');

  assert.match(setup, /\$script:InstallerHeaderShown/);
  assert.match(setup, /\$env:HAPPIER_INSTALLER_WELCOME_SHOWN\s*=\s*"1"/);
  assert.match(setup, /finally\s*\{/);
  assert.match(setup, /Remove-Item Env:HAPPIER_INSTALLER_WELCOME_SHOWN/);
  assert.match(setup, /\$env:HAPPIER_INSTALLER_WELCOME_SHOWN\s*=\s*\$previousValue/);

  const postInstall = extractFunction(source, 'Invoke-PostInstallAction');
  assert.match(postInstall, /if\s*\(\$runValue\s*-eq\s*"setup"\)[\s\S]*Invoke-InstallerSetupCommand/);
});
