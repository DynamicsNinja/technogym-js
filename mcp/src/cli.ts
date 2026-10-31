/**
 * `technogym-mcp`         start the MCP server on stdio (Claude Desktop runs this)
 * `technogym-mcp login`   sign in once and save the session
 * `technogym-mcp logout`  delete the saved session
 *
 * stdout carries MCP protocol frames only; everything human-readable goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileSessionStore, TechnogymClient } from "technogym-js";
import { describeError } from "./errors.js";
import { askCredentials, terminalIo } from "./login.js";
import { createServer } from "./server.js";
import { fileSession, loadConfig } from "./session.js";

const version = __MCP_VERSION__;
const USAGE = `technogym-mcp ${version}

  technogym-mcp          start the MCP server (stdio)
  technogym-mcp login    sign in to mywellness once and save the session
  technogym-mcp logout   delete the saved session
`;

const config = loadConfig();
const command = process.argv[2];
try {
  if (command === "login") {
    const { email, password } = await askCredentials(terminalIo());
    const client = new TechnogymClient({ sessionStore: new FileSessionStore(config.sessionDir) });
    const session = await client.login(email, password);
    const facilities = session.user.facilities.map((f) => f.name || f.url).join(", ") || "none";
    console.error(`Logged in as ${session.user.firstName} ${session.user.lastName} (facilities: ${facilities}).`);
    console.error(`Session saved to ${config.sessionDir}.`);
  } else if (command === "logout") {
    await new FileSessionStore(config.sessionDir).clear();
    console.error(`Removed the session in ${config.sessionDir}.`);
  } else if (command === undefined) {
    const session = fileSession(config.sessionDir, { credentials: config.credentials, facility: config.facility });
    await createServer(session, version).connect(new StdioServerTransport());
  } else {
    console.error(USAGE);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(describeError(error));
  process.exitCode = 1;
}
