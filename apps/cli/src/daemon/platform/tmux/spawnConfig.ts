import { buildHappyCliSubprocessLaunchSpec, type HappyCliSubprocessLaunchOptions } from '@/utils/spawnHappyCLI';
import type { CatalogAgentId } from '@/backends/types';
import { buildCgroupSelfMigratingHappyCliLaunchSpec } from '../linux/buildCgroupSelfMigratingHappyCliLaunchSpec';

type TmuxSpawnAgentId = CatalogAgentId | 'acp-catalog';

export function buildTmuxWindowEnv(
  daemonEnv: NodeJS.ProcessEnv,
  extraEnv: Record<string, string>,
): Record<string, string> {
  const essentialKeys = [
    'PATH',
    'HOME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'TMPDIR',
    'TSX_TSCONFIG_PATH',
    'USER',
    'LOGNAME',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR',
  ] as const;

  const filteredDaemonEnv = Object.fromEntries(
    essentialKeys
      .map((key) => [key, daemonEnv[key]] as const)
      .filter(([, value]) => typeof value === 'string' && value.length > 0),
  ) as Record<string, string>;

  return { ...filteredDaemonEnv, ...extraEnv };
}

export async function buildTmuxSpawnConfig(params: {
  agent: TmuxSpawnAgentId;
  directory: string;
  extraEnv: Record<string, string>;
  tmuxCommandEnv?: Record<string, string>;
  extraArgs?: string[];
  launchOptions?: HappyCliSubprocessLaunchOptions;
}): Promise<{
  commandTokens: string[];
  tmuxEnv: Record<string, string>;
  tmuxCommandEnv: Record<string, string>;
  directory: string;
}> {
  const args = [
    params.agent,
    '--happy-starting-mode',
    'remote',
    '--started-by',
    'daemon',
    ...(params.extraArgs ?? []),
  ];

  const launchSpec = buildHappyCliSubprocessLaunchSpec(args, params.launchOptions);
  const tmuxEnv = buildTmuxWindowEnv(process.env, { ...params.extraEnv, ...(launchSpec.env ?? {}) });
  const scopedLaunchSpec = process.platform === 'linux'
    ? await buildCgroupSelfMigratingHappyCliLaunchSpec({ launchSpec, environment: tmuxEnv })
    : null;
  const effectiveLaunchSpec = scopedLaunchSpec ?? launchSpec;
  const commandTokens = [effectiveLaunchSpec.filePath, ...effectiveLaunchSpec.args];

  const tmuxCommandEnv: Record<string, string> = { ...(params.tmuxCommandEnv ?? {}) };
  const tmuxTmpDir = tmuxCommandEnv.TMUX_TMPDIR;
  if (typeof tmuxTmpDir !== 'string' || tmuxTmpDir.length === 0) {
    delete tmuxCommandEnv.TMUX_TMPDIR;
  }

  return {
    commandTokens,
    tmuxEnv: { ...tmuxEnv, ...(effectiveLaunchSpec.env ?? {}) },
    tmuxCommandEnv,
    directory: params.directory,
  };
}
