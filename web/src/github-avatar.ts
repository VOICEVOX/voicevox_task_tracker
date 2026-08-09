/** GitHubのloginからアバター画像のURLを作る。 */
export function createGitHubAvatarUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=48`;
}
