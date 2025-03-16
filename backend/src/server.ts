import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import cors from "cors";
import { z } from "zod";
import { config } from "dotenv";

// Load environment variables
config();

const server = new McpServer({
  name: "Brave Search Server",
  version: "1.0.0",
});

// Add an addition tool
server.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
  content: [{ type: "text", text: String(a + b) }],
}));

server.tool(
  "search",
  { query: z.string(), count: z.number().optional() },
  async ({ query, count = 5 }: { query: string; count?: number }) => {
    console.log("query==========>", query, count, process.env.BRAVE_API_KEY);
    if (!process.env.BRAVE_API_KEY) {
      throw new Error("BRAVE_API_KEY environment variable is not set");
    }

    const response = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
        query
      )}&count=${count}`,
      {
        headers: {
          "X-Subscription-Token": process.env.BRAVE_API_KEY,
          Accept: "application/json",
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Brave search failed: ${response.statusText}`);
    }

    const data = await response.json();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data.web?.results || [], null, 2),
        },
      ],
    };
  }
);

// TODO: Add prompts

// Create Express app
const app = express();

// Apply middlewares
app.use(cors());
app.use(express.json());

// Define a type-safe Map for transports
const transports = new Map<string, SSEServerTransport>();

// Root route handler
app.get("/", (req, res) => {
  res.json({
    status: "online",
    name: "MCP SSE Example Server",
    endpoints: {
      sse: "/sse",
      messages: "/messages",
    },
    docs: "https://modelcontextprotocol.io/docs",
  });
});

// Debug endpoint
app.get("/debug", (req, res) => {
  res.json({
    headers: req.headers,
    method: req.method,
    url: req.url,
    query: req.query,
  });
});

// SSE route handler - improved for proxy compatibility
app.get("/sse", (req, res) => {
  // Set headers required for SSE with proxies
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // Flush headers immediately to establish connection
  res.flushHeaders();

  // Send an initial keepalive comment to help proxies
  res.write(":keepalive\n\n");

  // Create transport
  const transport = new SSEServerTransport("/messages", res);
  const sessionId = transport.sessionId;
  console.log(`New SSE connection established: ${sessionId}`);

  // Store with correct sessionId
  transports.set(sessionId, transport);

  // Implement a keepalive ping every 30 seconds
  const keepAliveInterval = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(keepAliveInterval);
      return;
    }
    res.write(":ping\n\n");
    console.log(`Sending keepalive ping for ${sessionId}`);
  }, 30000);

  // Clean up on connection close
  req.on("close", () => {
    console.log(`Connection closed: ${sessionId}`);
    clearInterval(keepAliveInterval);
    transports.delete(sessionId);
  });

  // Connect to server
  server
    .connect(transport)
    .then(() => {
      console.log(`Server connected to transport: ${sessionId}`);
    })
    .catch((error: any) => {
      console.error(`Error connecting server to transport: ${error.message}`);
      clearInterval(keepAliveInterval);
      res.end();
    });
});

// Messages route handler
// @ts-expect-error
app.post("/messages", (req, res) => {
  // Get the session ID parameter - note we're checking both sessionId (standard)
  // and connectionId (your custom implementation)
  const sessionId =
    (req.query.sessionId as string) || (req.query.connectionId as string);

  console.log(`Received message request with sessionId: ${sessionId}`);
  console.log(`Message body:`, JSON.stringify(req.body));
  console.log(`Available sessions:`, Array.from(transports.keys()));

  // If no sessionId provided, try to use the first available transport
  let transport;
  if (sessionId) {
    transport = transports.get(sessionId);
  } else if (transports.size > 0) {
    // Fallback to first available transport
    transport = transports.values().next().value;
    console.log(
      `No sessionId provided, using first available: ${
        Array.from(transports.keys())[0]
      }`
    );
  }

  if (!transport) {
    console.error(`No transport found for session: ${sessionId || "any"}`);
    return res.status(400).json({ error: "No active SSE connection found" });
  }

  // Handle the message
  transport.handlePostMessage(req, res).catch((error) => {
    console.error(`Error processing message: ${error.message}`);
    res.status(500).json({ error: error.message });
  });
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`MCP SSE Server running on port ${PORT}`);
});
