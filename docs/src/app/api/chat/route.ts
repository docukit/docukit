import { ProvideLinksToolSchema } from "../../../lib/inkeep-qa-schema";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { convertToModelMessages, streamText } from "ai";
import { env } from "@/env";

// Using edge runtime for better performance with external APIs
export const runtime = "edge";

// Configure AI provider
// By default uses Groq (free tier). Add GROQ_API_KEY to .env to enable
const groq = createOpenAICompatible({
  name: "groq",
  apiKey: env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

// Load documentation context once (cached in memory)
let docsContext: string | undefined;
async function getDocsContext(baseUrl: string): Promise<string> {
  if (docsContext) return docsContext;

  // Fetch the full documentation from /llms-full.txt
  const response = await fetch(`${baseUrl}/llms-full.txt`);
  if (!response.ok) {
    throw new Error("Failed to load documentation");
  }

  docsContext = await response.text();
  return docsContext;
}

export async function POST(req: Request) {
  // Return friendly error if API key is not configured
  if (!env.GROQ_API_KEY) {
    return new Response(
      JSON.stringify({
        error:
          "AI search is not configured. Add GROQ_API_KEY to your environment variables. Get a free API key at https://console.groq.com",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const reqJson = await req.json();

  // Get base URL for internal fetch
  const url = new URL(req.url);
  const baseUrl = `${url.protocol}//${url.host}`;

  // Load the documentation context
  const docs = await getDocsContext(baseUrl);

  const result = streamText({
    // Using Llama 3.3 70B - one of the best available models on Groq
    // Alternative options: "llama-3.1-8b-instant" (faster), "mixtral-8x7b-32768"
    model: groq("llama-3.3-70b-versatile"),
    system: `You are a helpful AI assistant for DocNode documentation.

DocNode is a library for building collaborative documents with operational transformation.

Use the following documentation to answer questions. If the answer is not in the documentation, say so clearly.
Always provide accurate information based on the docs below, and cite relevant sections when possible.

DOCUMENTATION:
${docs}

When answering:
- Be concise and helpful
- Reference specific sections of the docs
- Provide code examples when relevant
- If something is not documented, be honest about it`,
    tools: {
      provideLinks: {
        inputSchema: ProvideLinksToolSchema,
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
    messages: await convertToModelMessages(reqJson.messages, {
      ignoreIncompleteToolCalls: true,
    }),
    toolChoice: "auto",
  });

  return result.toUIMessageStreamResponse();
}
