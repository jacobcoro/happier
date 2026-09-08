import { retargetPendingTerminalConnectToServerUrl as retargetPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';

export function retargetPendingTerminalConnectToServerUrl(serverUrl: string): void {
    retargetPendingTerminalConnect(serverUrl);
}
