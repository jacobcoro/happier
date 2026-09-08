// Use only for Git arguments parsed as pathspecs; keep filename identities unchanged.
export function toLiteralPathspec(path: string): string {
    return `:(literal)${path}`;
}

export function toRepoRootLiteralPathspec(path: string): string {
    return `:(top,literal)${path}`;
}
