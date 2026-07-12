export function answerGitCredentialPrompt(prompt: string, token: string): string | null {
  const normalized = prompt.toLowerCase();
  if (normalized.includes('username')) return 'x-access-token';
  if (normalized.includes('password')) return token;
  return null;
}
