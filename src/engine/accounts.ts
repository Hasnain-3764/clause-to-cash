// Payout allow-list from config/accounts.json (sandbox emails only, no secrets).
import accountsFile from "../../config/accounts.json";

export interface Account {
  role: string;
  label: string;
  country: string;
  email: string;
}

export const accounts: Account[] = accountsFile.accounts;

/** Emails we may pay: every non-business sandbox account. */
export function allowedRecipients(list: readonly Account[] = accounts): Set<string> {
  return new Set(list.filter((a) => a.role !== "business" && a.email.endsWith(".example.com")).map((a) => a.email));
}

export function accountByRole(role: string, list: readonly Account[] = accounts): Account | undefined {
  return list.find((a) => a.role === role);
}
