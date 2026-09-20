// Who is playing, as the login page saved it. Accounts live in localStorage because the game has
// no account service yet; a guest is a name kept for the browser session only.

export type Account = { name: string; email: string; password: string };
export type CurrentPlayer = {
  name: string;
  guest: boolean;
  /** What this player's saved data (stats, loadout) is keyed by. */
  key: string;
};

export const ACCOUNT_STORAGE_KEY = "headshot.accounts";
export const SESSION_STORAGE_KEY = "headshot.current-account";
export const GUEST_STORAGE_KEY = "headshot.guest-name";

export function readAccounts(): Account[] {
  try {
    const accounts: unknown = JSON.parse(localStorage.getItem(ACCOUNT_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(accounts)) return [];
    return accounts.filter(
      (account): account is Account =>
        typeof account === "object" &&
        account !== null &&
        typeof account.name === "string" &&
        typeof account.email === "string" &&
        typeof account.password === "string",
    );
  } catch {
    return [];
  }
}

/** The logged-in account, else the session's guest, else null when nobody is signed in. */
export function currentPlayer(): CurrentPlayer | null {
  try {
    const email = localStorage.getItem(SESSION_STORAGE_KEY);
    const account = readAccounts().find((entry) => entry.email === email);
    if (account) return { name: account.name, guest: false, key: `account:${account.email}` };
    const guestName = sessionStorage.getItem(GUEST_STORAGE_KEY)?.trim() ?? "";
    return guestName ? { name: guestName, guest: true, key: `guest:${guestName}` } : null;
  } catch {
    return null;
  }
}
