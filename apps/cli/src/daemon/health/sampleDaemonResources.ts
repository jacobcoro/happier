import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import type { DaemonResourceSample } from './daemonHealthMonitor';

const execFileAsync = promisify(execFile);

function parseLinuxMeminfo(text: string): Readonly<{ usedBytes: number; totalBytes: number }> | null {
  const values = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_]+):\s+(\d+)\s+kB$/.exec(line.trim());
    if (match) values.set(match[1]!, Number(match[2]) * 1024);
  }
  const totalBytes = values.get('SwapTotal');
  const freeBytes = values.get('SwapFree');
  if (totalBytes === undefined || freeBytes === undefined) return null;
  return { usedBytes: Math.max(0, totalBytes - freeBytes), totalBytes };
}

function parseByteUnit(value: string, unit: string): number | null {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const multiplier = unit.toUpperCase() === 'G'
    ? 1024 ** 3
    : unit.toUpperCase() === 'M'
      ? 1024 ** 2
      : unit.toUpperCase() === 'K'
        ? 1024
        : 1;
  return Math.round(amount * multiplier);
}

function parseDarwinSwapUsage(text: string): Readonly<{ usedBytes: number; totalBytes: number }> | null {
  const total = /total\s*=\s*([0-9.]+)([KMG]?)/i.exec(text);
  const used = /used\s*=\s*([0-9.]+)([KMG]?)/i.exec(text);
  if (!total || !used) return null;
  const totalBytes = parseByteUnit(total[1]!, total[2]!);
  const usedBytes = parseByteUnit(used[1]!, used[2]!);
  return totalBytes === null || usedBytes === null ? null : { usedBytes, totalBytes };
}

async function sampleSwap(): Promise<Readonly<{
  usedBytes: number | null;
  totalBytes: number | null;
  source: string;
}>> {
  try {
    if (process.platform === 'linux') {
      const parsed = parseLinuxMeminfo(await readFile('/proc/meminfo', 'utf8'));
      return parsed
        ? { usedBytes: parsed.usedBytes, totalBytes: parsed.totalBytes, source: 'linux_proc_meminfo' }
        : { usedBytes: null, totalBytes: null, source: 'linux_proc_meminfo_malformed' };
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { timeout: 2_000 });
      const parsed = parseDarwinSwapUsage(stdout);
      return parsed
        ? { usedBytes: parsed.usedBytes, totalBytes: parsed.totalBytes, source: 'darwin_sysctl' }
        : { usedBytes: null, totalBytes: null, source: 'darwin_sysctl_malformed' };
    }
    if (process.platform === 'win32') {
      const script = '$p=Get-CimInstance Win32_PageFileUsage; $t=($p|Measure-Object AllocatedBaseSize -Sum).Sum; $u=($p|Measure-Object CurrentUsage -Sum).Sum; @{totalBytes=[int64]$t*1MB;usedBytes=[int64]$u*1MB}|ConvertTo-Json -Compress';
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 4_000 });
      const parsed = JSON.parse(stdout) as { usedBytes?: unknown; totalBytes?: unknown };
      if (typeof parsed.usedBytes === 'number' && typeof parsed.totalBytes === 'number') {
        return { usedBytes: parsed.usedBytes, totalBytes: parsed.totalBytes, source: 'windows_pagefile_cim' };
      }
      return { usedBytes: null, totalBytes: null, source: 'windows_pagefile_cim_malformed' };
    }
  } catch {
    // Health remains available with an explicit local diagnostic instead of failing the endpoint.
  }
  return { usedBytes: null, totalBytes: null, source: `${process.platform}_unavailable` };
}

async function sampleWorkerRssBytes(workerPids: readonly number[]): Promise<number | null> {
  if (workerPids.length === 0) return 0;
  try {
    if (process.platform === 'linux') {
      const samples = await Promise.all(workerPids.map(async (pid) => {
        try {
          const status = await readFile(`/proc/${pid}/status`, 'utf8');
          const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
          return match ? Number(match[1]) * 1024 : 0;
        } catch {
          return 0;
        }
      }));
      return samples.reduce((total, value) => total + value, 0);
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('/bin/ps', [
        '-o',
        'rss=',
        '-p',
        workerPids.join(','),
      ], { timeout: 2_000 });
      return stdout.split(/\s+/).reduce((total, value) => {
        const kib = Number(value);
        return total + (Number.isFinite(kib) ? kib * 1024 : 0);
      }, 0);
    }
    if (process.platform === 'win32') {
      const ids = workerPids.join(',');
      const script = `$p=Get-Process -Id ${ids} -ErrorAction SilentlyContinue; ($p|Measure-Object WorkingSet64 -Sum).Sum`;
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 4_000 });
      const bytes = Number(stdout.trim());
      return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
    }
  } catch {
    return null;
  }
  return null;
}

export async function sampleDaemonResources(workerPids: readonly number[]): Promise<DaemonResourceSample> {
  const workerRssBytes = await sampleWorkerRssBytes(workerPids);
  const swap = await sampleSwap();
  return {
    controllerRssBytes: process.memoryUsage().rss,
    workerRssBytes,
    swapUsedBytes: swap.usedBytes,
    swapTotalBytes: swap.totalBytes,
    swapSource: swap.source,
  };
}
