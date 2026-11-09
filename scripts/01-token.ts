// Step 1: prove the client id/secret work by fetching an OAuth token from the sandbox.
import { getAccessToken, isMain, preview, tokenExpiresIn } from "./lib/paypal.ts";

export async function runToken(): Promise<boolean> {
  const token = await getAccessToken();
  console.log(`OK, token starts with ${preview(token)}, expires in ${tokenExpiresIn()} seconds`);
  return true;
}

if (isMain(import.meta.url)) {
  runToken().catch(() => process.exit(1));
}
