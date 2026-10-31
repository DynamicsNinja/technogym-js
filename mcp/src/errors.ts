import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  TechnogymApiError,
  TechnogymAuthError,
  TechnogymHttpError,
  TechnogymRateLimitError,
} from "technogym-js";
import { NotLoggedInError } from "./session.js";

export const LOGIN_HINT =
  "run `technogym-mcp login` in a terminal, or set TECHNOGYM_EMAIL and TECHNOGYM_PASSWORD in the server's environment";

/** Plain-language text for a failure. Library messages never carry the token or password. */
export function describeError(error: unknown, hint: string = LOGIN_HINT): string {
  if (error instanceof NotLoggedInError) {
    return error.reason
      ? `Not logged in to mywellness (${error.reason}): ${hint}.`
      : `Not logged in to mywellness: ${hint}.`;
  }
  if (error instanceof TechnogymAuthError) {
    return `mywellness session expired or was rejected (${error.message}): ${hint}.`;
  }
  if (error instanceof TechnogymRateLimitError) {
    const wait = error.retryAfter !== undefined ? `; retry after ${error.retryAfter} s` : "";
    return `mywellness is rate limiting requests${wait}. ${error.message}`;
  }
  if (error instanceof TechnogymHttpError) return `mywellness returned HTTP ${error.status}: ${error.message}`;
  if (error instanceof TechnogymApiError) return `mywellness refused the call: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function errorResult(error: unknown, hint?: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: describeError(error, hint) }] };
}
